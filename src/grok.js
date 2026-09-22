// ---------------------------------------------------------------------------
// OPTIONAL AI helper - now only a *second opinion* for cells the local solver
// (src/solver.js) could not place. The primary generator makes zero API calls.
//
// This file talks to Groq (api.groq.com, OpenAI-compatible endpoint), NOT x.ai.
// Get the key at console.groq.com/keys and put it in VITE_GROK_API_KEY
// (name kept so existing .env files keep working).
//
// What was wrong before (and is fixed here):
//   1. The prompt contained EVERY other booking in the college (`busyElsewhere`,
//      ~40 tokens each). 30 classes x 36 cells = ~40k tokens -> blew Groq's
//      tokens-per-minute cap / context and took ages. Now only the bookings of
//      the *eligible faculty and rooms*, at the *still-empty cells*, are sent.
//   2. Names, labels and repeated JSON keys were sent for every row. Now the
//      payload is short ids, and the model answers with compact arrays.
//   3. gpt-oss-120b is a reasoning model: with no limits it burned thousands of
//      hidden tokens. We now cap output and set reasoning_effort: 'low'.
//   4. fetch() had no timeout - a slow response froze the button. Every attempt
//      now aborts after REQUEST_TIMEOUT_MS.
//   5. The response validator now also enforces weeklyHours, faculty weekday
//      availability, faculty maxWeeklyHours and combined classes (before, only
//      the prompt "asked" for those and nothing checked).
//
// NOTE on security: the key ships in the browser bundle. Fine for an internal
// staff tool; for anything public move this fetch into a Supabase Edge Function.
// ---------------------------------------------------------------------------
import { isCombinedPair, planForClassSection } from './solver.js';

const GROK_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROK_MODEL = 'openai/gpt-oss-120b';

const REQUEST_TIMEOUT_MS = 45000;
const MAX_429_RETRIES = 2;
const DEFAULT_RETRY_MS = 5000;
const MAX_RETRY_MS = 15000;
const MAX_OUTPUT_TOKENS = 4000;

function apiKey() {
  return import.meta.env.VITE_GROK_API_KEY;
}

export function isGrokConfigured() {
  return Boolean(apiKey());
}

async function fetchOnce(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('timed out after ' + REQUEST_TIMEOUT_MS / 1000 + 's');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options, onRetry, attempt = 0) {
  const response = await fetchOnce(url, options);
  if (response.status !== 429 || attempt >= MAX_429_RETRIES) return response;

  let waitMs = DEFAULT_RETRY_MS;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && !Number.isNaN(Number(retryAfter))) {
    waitMs = Math.ceil(Number(retryAfter) * 1000);
  } else {
    try {
      const body = await response.clone().json();
      const msg = body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || '';
      const match = msg.match(/try again in ([\d.]+)s/i);
      if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000);
    } catch { /* no hint - use default */ }
  }
  waitMs = Math.min(waitMs, MAX_RETRY_MS) + 300;
  onRetry?.(attempt + 1, waitMs);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return fetchWithRetry(url, options, onRetry, attempt + 1);
}

// ---------------------------------------------------------------------------
// Compact prompt: only what the model needs to fill THIS class's empty cells.
// ---------------------------------------------------------------------------
export function buildPrompt({ state, departmentId, classSection, deptSubjects, periodSlots, existingEntriesForClass, allOtherEntries }) {
  const cell = (d, p) => d + ':' + p;
  const filled = new Set(existingEntriesForClass.map((e) => cell(e.dayOrderId, e.periodId)));
  const free = [];
  for (const d of state.dayOrders) for (const p of periodSlots) if (!filled.has(cell(d.id, p.id))) free.push(cell(d.id, p.id));
  const freeSet = new Set(free);

  // distinct booked slots per faculty across the whole college (real weekly load)
  const loadOf = new Map();
  [...existingEntriesForClass, ...allOtherEntries].forEach((e) => {
    if (!e.facultyId) return;
    if (!loadOf.has(e.facultyId)) loadOf.set(e.facultyId, new Set());
    loadOf.get(e.facultyId).add(cell(e.dayOrderId, e.periodId));
  });

  const subjects = [];
  const facultyIds = new Set();
  for (const s of deptSubjects) {
    const done = existingEntriesForClass.filter((e) => e.subjectId === s.id).length;
    const need = (Number(s.weeklyHours) || 0) - done;
    const fac = (s.facultyIds || []).filter((id) => state.faculty.some((f) => f.id === id));
    if (need <= 0 || fac.length === 0) continue; // nothing to place / nobody to teach it
    fac.forEach((id) => facultyIds.add(id));
    subjects.push({ id: s.id, t: s.type === 'Lab' ? 'L' : 'T', need, fac });
  }

  const faculty = state.faculty.filter((f) => facultyIds.has(f.id)).map((f) => {
    const off = state.dayOrders.filter((d) => Array.isArray(f.availability) && !f.availability.includes(d.actualDay)).map((d) => d.id);
    const cap = Number(f.maxWeeklyHours);
    return {
      id: f.id,
      left: Number.isFinite(cap) ? Math.max(0, cap - (loadOf.get(f.id)?.size || 0)) : 99,
      ...(off.length ? { off } : {}),
    };
  });

  const rooms = [...state.classrooms, ...state.labs]
    .filter((r) => r.departmentId === departmentId)
    .map((r) => ({ id: r.id, t: r.type === 'lab' ? 'lab' : 'room' }));
  const roomIds = new Set(rooms.map((r) => r.id));

  // Only bookings that can actually clash: eligible faculty / this dept's rooms,
  // and only at cells that are still empty for this class.
  const busyF = {};
  const busyR = {};
  for (const e of allOtherEntries) {
    const c = cell(e.dayOrderId, e.periodId);
    if (!freeSet.has(c)) continue;
    if (e.facultyId && facultyIds.has(e.facultyId)) (busyF[e.facultyId] ||= []).push(c);
    if (e.roomId && roomIds.has(e.roomId)) (busyR[e.roomId] ||= []).push(c);
  }

  const system = `You are a timetable scheduling engine. Reply with ONE JSON array and nothing else (no markdown, no prose).
Each item: ["<cell>","<subjectId>","<facultyId>","<roomId or null>"]
"<cell>" must be copied EXACTLY, character-for-character, from the "free" list below (e.g. "${free[0] || 'DO1:P1'}") \u2014 never split it into two fields, never reformat it, never invent your own.
Rules:
1. Use only cells listed in "free", each at most once.
2. A subject may be placed at most "need" times. subject.fac lists the only allowed faculty. Prefer ONE faculty per subject.
3. Never use a faculty at a cell listed for them in busyF, never a room at a cell listed in busyR, never a faculty on a day in their "off" list.
4. A faculty can be used at most "left" times in total.
5. Subjects with t="L" (lab) need 2 (or 3) CONSECUTIVE periods on the same day, in a room with t="lab" if any. Theory subjects use t="room" rooms. If no room fits, use null.
6. Spread each subject over different days. Leaving cells empty is fine. Never invent ids.
Example item using a real free cell from this request: ["${free[0] || 'DO1:P1'}","<subjectId>","<facultyId>",null]`;

  const user = JSON.stringify({
    cls: departmentId + '-' + classSection.year + '-' + classSection.section,
    free, subjects, faculty, rooms, busyF, busyR,
  });
  return { system, user };
}

// One place for the HTTP call + friendly errors, shared by every AI feature.
async function callChat({ system, user, maxTokens, onRetry }) {
  const key = apiKey();
  if (!key) {
    throw new Error('No Groq API key found. Add VITE_GROK_API_KEY to .env.local (key from console.groq.com/keys) and restart the dev server.');
  }
  let response;
  try {
    response = await fetchWithRetry(GROK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: GROK_MODEL,
        temperature: 0.1,
        max_completion_tokens: maxTokens,
        reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }, onRetry);
  } catch (err) {
    throw new Error('Could not reach the AI service (' + (err?.message || 'network error') + ').');
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || body?.message || '';
      if (!detail && body) detail = JSON.stringify(body).slice(0, 300);
      // eslint-disable-next-line no-console
      console.error('Groq API error response:', body);
    } catch { /* not JSON */ }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Groq rejected the API key (HTTP ' + response.status + '). Use a key from console.groq.com/keys (not x.ai), no extra spaces/quotes, then restart the dev server.');
    }
    if (response.status === 404) throw new Error('Groq model "' + GROK_MODEL + '" not found for this account (HTTP 404). ' + detail);
    if (response.status === 413) throw new Error('Request too large for the AI service (HTTP 413). Use the local Auto-fill instead.');
    if (response.status === 429) throw new Error('Groq is still rate-limited after ' + MAX_429_RETRIES + ' retries. Wait a minute and try again.');
    throw new Error('Groq API error ' + response.status + (detail ? ': ' + detail : ''));
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('The AI returned an empty response (it may have run out of output tokens).');
  return text;
}

function extractJsonArray(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON array in response.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// The model is asked for the compact 4-field tuple ["cell","subjectId","facultyId","roomId"]
// where "cell" is one of the exact "DAY:PERIOD" strings from the prompt's "free" list. This
// also accepts the older 5-field split tuple ["day","period","subjectId","facultyId","roomId"],
// and self-heals the specific mistake seen in practice - the model pasting the whole "DAY:PERIOD"
// cell string into slot 0 of what it thinks is the split form, which used to silently shift every
// field over by one and made every row fail as "unknown day/period" + "unknown subject".
function splitCell(cell) {
  if (typeof cell !== 'string') return null;
  const i = cell.indexOf(':');
  return i === -1 ? null : [cell.slice(0, i), cell.slice(i + 1)];
}

function normalizeItem(item) {
  if (Array.isArray(item)) {
    if (item.length <= 4) {
      const [cell, subjectId, facultyId, roomId] = item;
      const split = splitCell(cell);
      const [dayOrderId, periodId] = split || [cell, undefined];
      return { dayOrderId, periodId, subjectId, facultyId, roomId };
    }
    const [a, b, subjectId, facultyId, roomId] = item;
    const split = splitCell(a);
    return split ? { dayOrderId: split[0], periodId: split[1], subjectId, facultyId, roomId } : { dayOrderId: a, periodId: b, subjectId, facultyId, roomId };
  }
  if (item && typeof item === 'object') {
    const split = splitCell(item.cell);
    if (split) return { dayOrderId: split[0], periodId: split[1], subjectId: item.subjectId, facultyId: item.facultyId, roomId: item.roomId ?? null };
    return item;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Calls the model and returns validated NEW entries for one class section.
// Same signature as before. Throws with a human-readable message on failure.
// ---------------------------------------------------------------------------
export async function generateTimetableWithAI({ state, departmentId, classSection, deptSubjects, periodSlots, onRetry }) {
  const key = apiKey();
  if (!key) {
    throw new Error('No Groq API key found. Add VITE_GROK_API_KEY to .env.local (key from console.groq.com/keys) and restart the dev server.');
  }

  const existingEntriesForClass = state.timetableEntries.filter((e) => e.classSectionId === classSection.id);
  const allOtherEntries = state.timetableEntries.filter((e) => e.classSectionId !== classSection.id);
  const { system, user } = buildPrompt({ state, departmentId, classSection, deptSubjects, periodSlots, existingEntriesForClass, allOtherEntries });

  const text = await callChat({ system, user, maxTokens: MAX_OUTPUT_TOKENS, onRetry });

  let raw;
  try { raw = extractJsonArray(text); } catch { throw new Error('Could not parse the AI response as JSON.'); }

  // ---- validate every item against real master data (AI output is untrusted input)
  const validPeriodIds = new Set(periodSlots.map((p) => p.id));
  const dayById = new Map(state.dayOrders.map((d) => [d.id, d]));
  const subjectsById = new Map(deptSubjects.map((s) => [s.id, s]));
  const allSubjectsById = new Map(state.subjects.map((s) => [s.id, s]));
  const facultyById = new Map(state.faculty.map((f) => [f.id, f]));
  const roomById = new Map([...state.classrooms, ...state.labs].map((r) => [r.id, r]));
  const filledCells = new Set(existingEntriesForClass.map((e) => e.dayOrderId + '|' + e.periodId));

  const slotEntries = new Map(); // 'd|p' -> entries booked elsewhere
  allOtherEntries.forEach((e) => {
    const k = e.dayOrderId + '|' + e.periodId;
    if (!slotEntries.has(k)) slotEntries.set(k, []);
    slotEntries.get(k).push(e);
  });
  const facSlots = new Map();
  [...existingEntriesForClass, ...allOtherEntries].forEach((e) => {
    if (!e.facultyId) return;
    if (!facSlots.has(e.facultyId)) facSlots.set(e.facultyId, new Set());
    facSlots.get(e.facultyId).add(e.dayOrderId + '|' + e.periodId);
  });
  const hoursDone = new Map();
  existingEntriesForClass.forEach((e) => hoursDone.set(e.subjectId, (hoursDone.get(e.subjectId) || 0) + 1));

  const seenCells = new Set();
  const skipped = [];
  const entries = [];

  for (const rawItem of Array.isArray(raw) ? raw : []) {
    const { dayOrderId, periodId, subjectId, facultyId } = normalizeItem(rawItem);
    const roomId = normalizeItem(rawItem).roomId || null;
    const cellKey = dayOrderId + '|' + periodId;
    const subject = subjectsById.get(subjectId);
    const faculty = facultyById.get(facultyId);
    const day = dayById.get(dayOrderId);
    const probe = { classSectionId: classSection.id, departmentId, subjectId, facultyId };

    const reasons = [];
    if (!day || !validPeriodIds.has(periodId)) reasons.push('unknown day/period');
    if (filledCells.has(cellKey)) reasons.push('cell already filled');
    if (seenCells.has(cellKey)) reasons.push('duplicate cell from AI');
    if (!subject) reasons.push('unknown subject');
    if (!faculty || !subject?.facultyIds.includes(facultyId)) reasons.push('faculty not eligible for subject');
    if (roomId && !roomById.has(roomId)) reasons.push('unknown room');
    if (subject && (hoursDone.get(subjectId) || 0) >= (Number(subject.weeklyHours) || 0)) reasons.push('subject weekly hours exceeded');
    if (faculty && day && Array.isArray(faculty.availability) && !faculty.availability.includes(day.actualDay)) reasons.push('faculty unavailable that day');
    if (faculty) {
      const cap = Number(faculty.maxWeeklyHours);
      const used = facSlots.get(facultyId);
      if (Number.isFinite(cap) && !(used && used.has(cellKey)) && (used ? used.size : 0) >= cap) reasons.push('faculty max weekly hours reached');
    }
    for (const e of slotEntries.get(cellKey) || []) {
      const combined = isCombinedPair(e, probe, allSubjectsById);
      if (e.facultyId === facultyId && !combined) reasons.push('faculty double-booked');
      if (roomId && e.roomId === roomId && !combined) reasons.push('room double-booked');
    }

    if (reasons.length) { skipped.push({ item: rawItem, reasons: [...new Set(reasons)] }); continue; }

    seenCells.add(cellKey);
    hoursDone.set(subjectId, (hoursDone.get(subjectId) || 0) + 1);
    if (!facSlots.has(facultyId)) facSlots.set(facultyId, new Set());
    facSlots.get(facultyId).add(cellKey);
    entries.push({
      id: 'TT-' + Math.random().toString(36).slice(2, 9),
      departmentId, classSectionId: classSection.id,
      dayOrderId, periodId, subjectId, facultyId, roomId,
      type: subject.type === 'Lab' ? 'lab' : 'theory',
    });
  }

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// "Comment box": turn a sentence (English / Tamil / Tanglish) into structured
// change operations for ONE class. ONE small API call (~600 tokens); executing
// and validating the operations is done locally by editor.js.
// ---------------------------------------------------------------------------
export function buildChangePrompt({ state, classSection, text }) {
  const periodSlots = state.periods.filter((p) => p.type === 'period');
  const plan = planForClassSection(state, classSection);
  const entries = state.timetableEntries.filter((e) => e.classSectionId === classSection.id);

  // short aliases keep the prompt tiny and stop the model inventing long random ids
  const dayAlias = new Map(state.dayOrders.map((d, i) => [d.id, 'D' + (i + 1)]));
  const perAlias = new Map(periodSlots.map((p, i) => [p.id, 'P' + (i + 1)]));
  const subjIds = [...new Set([...plan.map((i) => i.subject.id), ...entries.map((e) => e.subjectId)])].filter((id) => state.subjects.some((s) => s.id === id));
  const subAlias = new Map(subjIds.map((id, i) => [id, 'S' + (i + 1)]));

  const maps = {
    day: new Map([...dayAlias].map(([id, a]) => [a, id])),
    period: new Map([...perAlias].map(([id, a]) => [a, id])),
    subject: new Map([...subAlias].map(([id, a]) => [a, id])),
  };

  const system = `You convert a college timetable change request (English, Tamil or Tanglish) into JSON operations for ONE class.
Reply with ONE JSON object only: {"ops":[...],"note":"<only when something cannot be expressed>"}.
Use ONLY the ids given (D#=day order, P#=period, S#=subject). Never invent ids.
Operations:
{"op":"move","subject":"S1","from":{"day":"D1","period":null},"to":{"day":"D3","period":null},"fillVacated":true}
   move a period of a subject to another day/period (null period = any). fillVacated=true when the user wants ANOTHER subject to take the vacated slot ("instead", "vera subject potu", "replace").
{"op":"swap","a":{"subject":"S1","day":"D1","period":"P1"},"b":{"subject":"S2","day":"D3","period":"P2"}}
{"op":"remove","subject":"S1","day":"D1","period":null,"forbid":true}   forbid=true when the subject must not come back there.
{"op":"set","subject":"S4","day":"D2","period":"P3"}   put a subject into a specific cell (replaces what is there).
"Day 1 / first day order" = the day labelled I; a weekday name means the day with that weekday. Several requests in one sentence = several ops, in order.
If the request is unclear or impossible, return {"ops":[],"note":"<short reason>"}.`;

  const user = JSON.stringify({
    request: text,
    days: state.dayOrders.map((d) => ({ id: dayAlias.get(d.id), label: d.label, weekday: d.actualDay })),
    periods: periodSlots.map((p) => ({ id: perAlias.get(p.id), label: p.label })),
    subjects: subjIds.map((id) => { const s = state.subjects.find((x) => x.id === id); return { id: subAlias.get(id), name: s.name, code: s.code }; }),
    grid: entries.map((e) => dayAlias.get(e.dayOrderId) + ':' + perAlias.get(e.periodId) + '=' + (subAlias.get(e.subjectId) || '?')),
  });
  return { system, user, maps };
}

// Map the model's aliases back to real ids and drop anything that does not exist.
export function normalizeOps(rawOps, maps) {
  const dropped = [];
  const D = (a) => (a == null ? undefined : maps.day.get(a));
  const P = (a) => (a == null ? undefined : maps.period.get(a));
  const S = (a) => (a == null ? undefined : maps.subject.get(a));
  const ok = (v, given) => given == null || v !== undefined; // a given alias must resolve
  const ops = [];
  for (const o of Array.isArray(rawOps) ? rawOps : []) {
    if (!o || typeof o !== 'object') continue;
    if (o.op === 'move') {
      const subjectId = S(o.subject);
      if (!subjectId || !ok(D(o.from?.day), o.from?.day) || !ok(P(o.from?.period), o.from?.period) || !D(o.to?.day) || !ok(P(o.to?.period), o.to?.period)) { dropped.push('move'); continue; }
      ops.push({ op: 'move', subjectId, from: { dayOrderId: D(o.from?.day), periodId: P(o.from?.period) }, to: { dayOrderId: D(o.to.day), periodId: P(o.to?.period) }, fillVacated: !!o.fillVacated });
    } else if (o.op === 'swap') {
      const a = { subjectId: S(o.a?.subject), dayOrderId: D(o.a?.day), periodId: P(o.a?.period) };
      const b = { subjectId: S(o.b?.subject), dayOrderId: D(o.b?.day), periodId: P(o.b?.period) };
      if (!a.subjectId || !b.subjectId || !ok(a.dayOrderId, o.a?.day) || !ok(b.dayOrderId, o.b?.day) || !ok(a.periodId, o.a?.period) || !ok(b.periodId, o.b?.period)) { dropped.push('swap'); continue; }
      ops.push({ op: 'swap', a, b });
    } else if (o.op === 'remove') {
      const subjectId = S(o.subject);
      if ((o.subject != null && !subjectId) || !ok(D(o.day), o.day) || !ok(P(o.period), o.period) || (!subjectId && o.day == null && o.period == null)) { dropped.push('remove'); continue; }
      ops.push({ op: 'remove', subjectId, dayOrderId: D(o.day), periodId: P(o.period), forbid: !!o.forbid });
    } else if (o.op === 'set') {
      const subjectId = S(o.subject);
      if (!subjectId || !D(o.day) || !P(o.period)) { dropped.push('set'); continue; }
      ops.push({ op: 'set', subjectId, dayOrderId: D(o.day), periodId: P(o.period) });
    } else dropped.push(String(o.op));
  }
  return { ops, dropped };
}

export async function parseChangeRequest({ state, classSection, text, onRetry }) {
  const { system, user, maps } = buildChangePrompt({ state, classSection, text });
  const reply = await callChat({ system, user, maxTokens: 1200, onRetry });
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(reply.slice(start, end + 1)); } catch { throw new Error('Could not understand the AI reply. Try rephrasing the change.'); }
  const { ops, dropped } = normalizeOps(parsed.ops, maps);
  let note = typeof parsed.note === 'string' ? parsed.note : '';
  if (dropped.length && !ops.length) note = note || 'The request referred to a day, period or subject that is not in this class.';
  return { ops, note, dropped };
}