// ---------------------------------------------------------------------------
// AI-assisted timetable generation - turns one click into a filled grid.
//
// ROOT CAUSE OF THE HTTP 401 THIS FILE USED TO PRODUCE:
// This code has always called Groq's endpoint (api.groq.com) and a
// Groq-hosted model (openai/gpt-oss-120b) - it does NOT call x.ai's actual
// Grok API (api.x.ai). But every comment, error message, and the "Grok"
// naming told you to get and check your key on console.x.ai. console.x.ai
// keys and api.groq.com are two completely unrelated services with
// incompatible key formats - a key from console.x.ai will be rejected by
// Groq's server with HTTP 401 every single time, no matter how valid or
// active that x.ai key is. That mismatch - not the key's validity - was the
// actual bug. The fix below keeps the working endpoint/model (Groq, which is
// what this code has always actually talked to) and corrects every place
// that pointed you at the wrong provider's console.
//
// Groq exposes an OpenAI-compatible Chat Completions endpoint, so this is a
// plain fetch() call, no SDK needed. The API key is read from
// `VITE_GROK_API_KEY` (see .env.local / .env.example) - Vite only exposes env
// vars prefixed with VITE_ to client code, same pattern already used for the
// Supabase keys in src/supabaseClient.js. (The variable is still named
// VITE_GROK_API_KEY, not VITE_GROQ_API_KEY, only to avoid touching every
// other file/env reference that already uses that name - it holds a Groq
// key from console.groq.com/keys.)
//
// NOTE on security: like the Supabase anon key, this key ends up in the
// browser bundle for anyone to read. That's an acceptable trade-off for a
// small internal staff tool (same trade-off the README already documents for
// auth), but if this app is ever exposed publicly, move this fetch behind a
// small server/edge function that holds the real key instead.
// ---------------------------------------------------------------------------

const GROK_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROK_MODEL = 'openai/gpt-oss-120b';

// Groq's free tier caps tokens-per-minute (not requests-per-minute) - clicking
// "Generate with AI" a few times in a row across departments can burn through
// that budget and get a 429 back, even though the key/request are both fine.
// Rather than surfacing that as a hard failure, retry automatically: Groq's
// 429 body tells us almost exactly how long to wait ("Please try again in
// 2.7375s"), so parse that (falling back to a Retry-After header, then a
// plain default) and try again a few times before giving up for real.
const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_MS = 5000;
const MAX_RETRY_MS = 20000;

async function fetchWithRetry(url, options, onRetry, attempt = 0) {
  const response = await fetch(url, options);
  if (response.status !== 429 || attempt >= MAX_429_RETRIES) return response;

  let waitMs = DEFAULT_RETRY_MS;
  const retryAfterHeader = response.headers.get('retry-after');
  if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
    waitMs = Math.ceil(Number(retryAfterHeader) * 1000);
  } else {
    // Read the body from a clone - the original response still needs to be
    // readable by the normal error-handling path below if this was the last
    // attempt, and a Response body can only be consumed once.
    try {
      const body = await response.clone().json();
      const msg = body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || '';
      const match = msg.match(/try again in ([\d.]+)s/i);
      if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000);
    } catch { /* not JSON, or no hint in it - use the default */ }
  }
  waitMs = Math.min(waitMs, MAX_RETRY_MS) + 300; // small buffer so we don't race Groq's own clock

  onRetry?.(attempt + 1, waitMs);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return fetchWithRetry(url, options, onRetry, attempt + 1);
}

function apiKey() {
  return import.meta.env.VITE_GROK_API_KEY;
}

export function isGrokConfigured() {
  return Boolean(apiKey());
}

// ---------------------------------------------------------------------------
// Builds the instructions + the exact slice of master data Grok needs to fill
// one class section's grid: its subjects (with weekly-hour targets and which
// faculty are eligible to teach each one), the day-order/period layout, the
// rooms it can use, and every OTHER timetable entry already on the books
// (any department) so Grok doesn't double-book a faculty member or a room.
// ---------------------------------------------------------------------------
function buildPrompt({ state, departmentId, classSection, deptSubjects, periodSlots, existingEntriesForClass, allOtherEntries }) {
  const subjectsPayload = deptSubjects.map((s) => {
    const eligibleFaculty = state.faculty.filter((f) => s.facultyIds.includes(f.id));
    return {
      subjectId: s.id,
      name: s.name,
      type: s.type, // 'Theory' | 'Lab'
      weeklyHours: s.weeklyHours,
      alreadyScheduledHours: existingEntriesForClass.filter((e) => e.subjectId === s.id).length,
      eligibleFaculty: eligibleFaculty.map((f) => ({ facultyId: f.id, name: f.name, maxWeeklyHours: f.maxWeeklyHours, availability: f.availability })),
    };
  }).filter((s) => s.eligibleFaculty.length > 0); // can't schedule a subject with nobody to teach it

  const rooms = [...state.classrooms, ...state.labs]
    .filter((r) => r.departmentId === departmentId)
    .map((r) => ({ roomId: r.id, name: r.name, type: r.type }));

  const dayOrders = state.dayOrders.map((d) => ({ dayOrderId: d.id, label: d.label, actualDay: d.actualDay }));
  const periods = periodSlots.map((p) => ({ periodId: p.id, label: p.label }));

  const busy = allOtherEntries.map((e) => ({
    dayOrderId: e.dayOrderId, periodId: e.periodId, facultyId: e.facultyId, roomId: e.roomId,
  }));

  const alreadyFilled = existingEntriesForClass.map((e) => ({ dayOrderId: e.dayOrderId, periodId: e.periodId }));

  const system = `You are a university timetable scheduling engine. You ONLY output strict JSON, nothing else - no markdown fences, no commentary, no explanations before or after.

Given a class section's subjects, the day-order/period grid, the rooms available, and a list of slots that are already busy elsewhere in the college, produce a JSON array of timetable entries that fills EVERY empty (dayOrderId, periodId) cell for this class section.

Hard rules:
1. Never assign a (dayOrderId, periodId) pair that already appears in "alreadyFilled" - those cells are taken by an existing manual entry and must be left alone (do not include them in your output at all).
2. Never assign a facultyId or roomId to a (dayOrderId, periodId) that already appears in "busyElsewhere" with that same facultyId or roomId - that faculty member or room is already teaching another class at that exact time.
3. Never output two of your own entries with the same (dayOrderId, periodId) - one subject per period for this class.
4. Only use a facultyId that is listed under that subject's "eligibleFaculty".
5. Try to hit each subject's "weeklyHours" total (counting "alreadyScheduledHours" already on the books) as closely as possible across the whole week, spread across different day orders rather than stacked back-to-back on one day, but NEVER exceed it.
6. type: "Lab" subjects should use a room whose type is "lab" when one is available; type: "Theory" subjects should use a room whose type is "classroom" when one is available. If no room of the matching type exists in the given room list, pick any available room from the list rather than skip the subject.
7. NEVER invent a roomId, facultyId, or subjectId that is not present in the lists given to you. A room is OPTIONAL: if the "rooms" list is empty, or none of the available rooms are free at that slot, set "roomId" to null and still place the entry (subject/faculty scheduling must never be blocked by a missing room) - do not guess or invent a roomId under any circumstances.
8. It is fine, and expected, to leave a cell empty (omit it) if no subject/faculty combination can be legally placed there (e.g. no eligible faculty is free).

Output format - a JSON array only, each item exactly:
{"dayOrderId": string, "periodId": string, "subjectId": string, "facultyId": string, "roomId": string | null, "type": "theory" | "lab"}`;

  const user = JSON.stringify({
    department: departmentId,
    classSection: { year: classSection.year, section: classSection.section, batch: classSection.batch },
    dayOrders,
    periods,
    rooms,
    subjects: subjectsPayload,
    alreadyFilled,
    busyElsewhere: busy,
  });

  return { system, user };
}

function extractJsonArray(text) {
  // Grok is instructed to return raw JSON, but strip ```json fences defensively
  // in case the model wraps it anyway.
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Grok did not return a JSON array.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Calls Grok and returns a validated list of NEW timetable entries (ready to
// merge into state.timetableEntries) for one class section. Throws with a
// human-readable message on any failure - the caller is expected to toast it.
// ---------------------------------------------------------------------------
export async function generateTimetableWithAI({ state, departmentId, classSection, deptSubjects, periodSlots, onRetry }) {
  const key = apiKey();
  if (!key) {
    throw new Error('No Groq API key found. Add VITE_GROK_API_KEY to .env.local (get a key at console.groq.com/keys - this calls Groq, not x.ai) and restart the dev server.');
  }

  const existingEntriesForClass = state.timetableEntries.filter((e) => e.classSectionId === classSection.id);
  const allOtherEntries = state.timetableEntries.filter((e) => e.classSectionId !== classSection.id);

  const { system, user } = buildPrompt({ state, departmentId, classSection, deptSubjects, periodSlots, existingEntriesForClass, allOtherEntries });

  let response;
  try {
    response = await fetchWithRetry(GROK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: GROK_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }, onRetry);
  } catch (err) {
    throw new Error('Could not reach Grok (' + (err?.message || 'network error') + ').');
  }

  if (!response.ok) {
    // Groq's error body isn't always shaped like OpenAI's `{ error: { message } }` -
    // it's often flat: `{ code: "...", error: "some string" }`. Try every shape
    // instead of assuming one, so the real reason actually reaches the toast.
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || body?.message || '';
      if (!detail && body) detail = JSON.stringify(body).slice(0, 300);
      // eslint-disable-next-line no-console
      console.error('Groq API error response:', body);
    } catch { /* body wasn't JSON at all */ }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Groq rejected the API key (HTTP ' + response.status + '). This calls console.groq.com, not x.ai/console.x.ai \u2014 make sure VITE_GROK_API_KEY in .env.local is a key generated at console.groq.com/keys, is pasted without extra spaces/quotes, and is active, then restart the dev server.');
    }
    if (response.status === 404) {
      throw new Error('Groq model "' + GROK_MODEL + '" was not found for this account (HTTP 404). ' + (detail || 'Check the model is available on your Groq plan at console.groq.com.'));
    }
    if (response.status === 429) {
      throw new Error('Groq is still rate-limited after ' + MAX_429_RETRIES + ' automatic retries. Wait a bit longer and try again, or reduce how often "Generate with AI" is clicked back-to-back across departments.');
    }
    throw new Error('Groq API error ' + response.status + (detail ? ': ' + detail : ' (no further detail in the response body).'));
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Grok returned an empty response.');

  let raw;
  try {
    raw = extractJsonArray(text);
  } catch {
    throw new Error('Could not parse Grok\u2019s response as JSON.');
  }

  // --- Validate every entry against real master data before it ever touches
  // state - an AI response is untrusted input, same as a form submission.
  const validPeriodIds = new Set(periodSlots.map((p) => p.id));
  const validDayOrderIds = new Set(state.dayOrders.map((d) => d.id));
  const subjectsById = new Map(deptSubjects.map((s) => [s.id, s]));
  const facultyById = new Map(state.faculty.map((f) => [f.id, f]));
  const roomById = new Map([...state.classrooms, ...state.labs].map((r) => [r.id, r]));
  const filledCells = new Set(existingEntriesForClass.map((e) => e.dayOrderId + '|' + e.periodId));

  const busyFaculty = new Set(allOtherEntries.map((e) => e.dayOrderId + '|' + e.periodId + '|' + e.facultyId));
  const busyRoom = new Set(allOtherEntries.map((e) => e.dayOrderId + '|' + e.periodId + '|' + e.roomId));

  const seenCells = new Set();
  const skipped = [];
  const entries = [];

  for (const item of Array.isArray(raw) ? raw : []) {
    const { dayOrderId, periodId, subjectId, facultyId, type } = item || {};
    // Room is optional: treat any falsy value (null, undefined, '', 0) as "no room
    // assigned" rather than a roomId to look up - only validate it as a real room
    // reference when Grok actually gave us one.
    const roomId = item && item.roomId ? item.roomId : null;
    const cellKey = dayOrderId + '|' + periodId;
    const subject = subjectsById.get(subjectId);
    const faculty = facultyById.get(facultyId);
    const room = roomId ? roomById.get(roomId) : null;

    const reasons = [];
    if (!validDayOrderIds.has(dayOrderId) || !validPeriodIds.has(periodId)) reasons.push('unknown day/period');
    if (filledCells.has(cellKey)) reasons.push('cell already filled');
    if (seenCells.has(cellKey)) reasons.push('duplicate cell from Grok');
    if (!subject) reasons.push('unknown subject');
    if (!faculty || !subject?.facultyIds.includes(facultyId)) reasons.push('faculty not eligible for subject');
    if (roomId && !room) reasons.push('unknown room');
    if (busyFaculty.has(dayOrderId + '|' + periodId + '|' + facultyId)) reasons.push('faculty double-booked');
    if (roomId && busyRoom.has(dayOrderId + '|' + periodId + '|' + roomId)) reasons.push('room double-booked');

    if (reasons.length) {
      skipped.push({ item, reasons });
      continue;
    }

    seenCells.add(cellKey);
    entries.push({
      id: 'TT-' + Math.random().toString(36).slice(2, 9),
      departmentId, classSectionId: classSection.id,
      dayOrderId, periodId, subjectId, facultyId, roomId,
      type: type === 'lab' ? 'lab' : 'theory',
    });
  }

  return { entries, skipped };
}