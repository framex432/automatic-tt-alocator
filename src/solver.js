// ---------------------------------------------------------------------------
// Local timetable solver - fills a class's grid WITHOUT any API call.
//
// Why this exists: the LLM path had to receive the whole college's bookings in
// one prompt, so it got slower / bigger with every class you added, and it hit
// token + time limits. A timetable is a constraint problem, not a language
// problem - a plain greedy solver with random restarts does it in well under a
// second, offline, and can generate every section of a department in ONE click
// and ONE database insert.
//
// Hard rules (never violated):
//   - a class has one subject per (day, period)
//   - a faculty teaches one class per (day, period) - EXCEPT a "combined class"
//     (same common subject, same faculty, different departments, same slot)
//   - a room hosts one class per (day, period) (same combined-class exception)
//   - faculty must be available that weekday (Faculty.availability)
//   - faculty total periods <= maxWeeklyHours
//   - never exceed a subject's weeklyHours
//   - a lab subject is placed in CONSECUTIVE periods (2, or 3 for odd hours)
//   - a theory subject appears at most twice on one day
// Soft rules (scored): spread subjects over the week, balance days, keep one
// faculty per subject per class, avoid 4+ back-to-back periods for a teacher,
// avoid labs straddling a break, align common subjects across departments.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  maxAttempts: 40,        // random restarts (attempt 0 is fully deterministic)
  minAttemptsWhenPerfect: 6,
  timeBudgetMs: 800,
  softMaxFacultyPerDay: 4,
  maxTheoryPerDay: 2,
};

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------- helpers ---

// Subjects that a class section actually studies: offered by its department AND
// belonging to its year. (Before, every subject of the department - all 4 years -
// was offered to every class, so III-year grids got I-year subjects.)
export function subjectsForClassSection(state, cs) {
  return state.subjects.filter(
    (s) => (s.departmentIds || []).includes(cs.departmentId) && (!s.year || !cs.year || s.year === cs.year),
  );
}

// What a class section actually studies + WHO teaches it, per section.
//  * If the section has class allocations (state.classAssignments: "CSE-III-A ->
//    Data Structures -> Mrs. X, 5h") those are the source of truth. This is how
//    section A and section B can have different staff for the same subject, and
//    how a common subject can have a different teacher in every department.
//  * Otherwise fall back to the old behaviour: department + year subjects, any
//    eligible faculty (subject.facultyIds).
export function planForClassSection(state, cs) {
  const subjectsById = new Map(state.subjects.map((s) => [s.id, s]));
  const rows = (state.classAssignments || []).filter((a) => a.classSectionId === cs.id);
  if (rows.length) {
    return rows
      .map((a) => {
        const subject = subjectsById.get(a.subjectId);
        if (!subject) return null;
        return {
          subject,
          facultyIds: a.facultyId ? [a.facultyId] : (subject.facultyIds || []),
          weeklyHours: Number(a.weeklyHours) || Number(subject.weeklyHours) || 0,
          fixed: !!a.facultyId,
          assignmentId: a.id,
        };
      })
      .filter(Boolean);
  }
  return subjectsForClassSection(state, cs).map((subject) => ({
    subject, facultyIds: subject.facultyIds || [], weeklyHours: Number(subject.weeklyHours) || 0, fixed: false,
  }));
}

// Entries whose subject or faculty no longer exists (subject deleted / re-created,
// faculty removed). They render as blank boxes in the grid, still occupy the cell,
// and are counted as nothing - so the class looked "full" but was missing periods.
export function findOrphanEntries(state, classSectionIds = null) {
  const subjectIds = new Set(state.subjects.map((s) => s.id));
  const facultyIds = new Set(state.faculty.map((f) => f.id));
  const only = classSectionIds ? new Set(classSectionIds) : null;
  return state.timetableEntries.filter(
    (e) => (!only || only.has(e.classSectionId)) && (!subjectIds.has(e.subjectId) || !facultyIds.has(e.facultyId)),
  );
}

// A "combined class": one common (multi-department) subject, taught by the same
// faculty to two different departments in the same slot. That is ONE lecture, not
// a double-booking, so conflict checks must not flag it.
export function isCombinedPair(a, b, subjectsById) {
  if (!a || !b || a.classSectionId === b.classSectionId) return false;
  if (a.subjectId !== b.subjectId || !a.facultyId || a.facultyId !== b.facultyId) return false;
  if (a.departmentId === b.departmentId) return false;
  const s = subjectsById.get(a.subjectId);
  return !!s && (s.departmentIds || []).length > 1;
}

const isLabSubject = (s) => s.type === 'Lab' || s.labRequired === true;

function splitLabHours(h) {
  if (h <= 0) return [];
  if (h === 1) return [1];
  const out = [];
  if (h % 2 === 1) { out.push(3); h -= 3; }
  while (h > 0) { out.push(2); h -= 2; }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function facultyAvailableOn(f, day) {
  if (!Array.isArray(f.availability)) return true;
  return f.availability.includes(day.actualDay);
}

// ----------------------------------------------------- static lookups (once) ---

function prepare(state) {
  const periodSlots = state.periods.filter((p) => p.type === 'period');
  // gapAfter[i] === true when a break/lunch row sits between period i and i+1.
  const gapAfter = periodSlots.map((p, i) => {
    const next = periodSlots[i + 1];
    if (!next) return false;
    const a = state.periods.findIndex((x) => x.id === p.id);
    const b = state.periods.findIndex((x) => x.id === next.id);
    return b - a > 1;
  });
  return {
    state,
    days: state.dayOrders,
    periodSlots,
    gapAfter,
    facultyById: new Map(state.faculty.map((f) => [f.id, f])),
    subjectsById: new Map(state.subjects.map((s) => [s.id, s])),
    roomsById: new Map([...state.classrooms, ...state.labs].map((r) => [r.id, r])),
  };
}

// ------------------------------------------------ mutable occupancy index ----

function newIndex() {
  return {
    slot: new Map(),        // 'd|p' -> entries booked in that slot (all classes)
    clsCell: new Set(),     // 'cls|d|p'
    facSlots: new Map(),    // facultyId -> Set('d|p')  (distinct slots => real load)
    facDay: new Map(),      // 'fac|d' -> distinct periods that day
    clsSubj: new Map(),     // 'cls|subj' -> count
    clsSubjDay: new Map(),  // 'cls|subj|d' -> count
    clsDay: new Map(),      // 'cls|d' -> count
    subjEntries: new Map(), // subjectId -> entries (for common-subject alignment)
  };
}

const inc = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);

function addEntry(idx, e) {
  const sk = e.dayOrderId + '|' + e.periodId;
  if (!idx.slot.has(sk)) idx.slot.set(sk, []);
  idx.slot.get(sk).push(e);
  idx.clsCell.add(e.classSectionId + '|' + sk);
  inc(idx.clsSubj, e.classSectionId + '|' + e.subjectId);
  inc(idx.clsSubjDay, e.classSectionId + '|' + e.subjectId + '|' + e.dayOrderId);
  inc(idx.clsDay, e.classSectionId + '|' + e.dayOrderId);
  if (!idx.subjEntries.has(e.subjectId)) idx.subjEntries.set(e.subjectId, []);
  idx.subjEntries.get(e.subjectId).push(e);
  if (e.facultyId) {
    if (!idx.facSlots.has(e.facultyId)) idx.facSlots.set(e.facultyId, new Set());
    const set = idx.facSlots.get(e.facultyId);
    if (!set.has(sk)) {
      set.add(sk);
      inc(idx.facDay, e.facultyId + '|' + e.dayOrderId);
    }
  }
}

const facLoad = (idx, fid) => (idx.facSlots.get(fid) ? idx.facSlots.get(fid).size : 0);

// Faculty check for one cell. Returns null when clashing, else { combined }.
function facultyCell(ctx, idx, sk, fid, probe) {
  const list = idx.slot.get(sk);
  let combined = null;
  if (list) {
    for (const e of list) {
      if (e.facultyId !== fid) continue;
      if (isCombinedPair(e, probe, ctx.subjectsById)) combined = e;
      else return null;
    }
  }
  return { combined };
}

function roomFreeAt(ctx, idx, sk, roomId, probe) {
  const list = idx.slot.get(sk);
  if (!list) return true;
  for (const e of list) {
    if (e.roomId !== roomId) continue;
    if (!isCombinedPair(e, probe, ctx.subjectsById)) return false;
  }
  return true;
}

function facultyBusyAt(idx, fid, d, p) {
  const s = idx.facSlots.get(fid);
  return !!s && s.has(d + '|' + p);
}

function consecutiveRun(ctx, idx, fid, dayId, i, L) {
  let run = L;
  for (let j = i - 1; j >= 0 && facultyBusyAt(idx, fid, dayId, ctx.periodSlots[j].id); j--) run++;
  for (let j = i + L; j < ctx.periodSlots.length && facultyBusyAt(idx, fid, dayId, ctx.periodSlots[j].id); j++) run++;
  return run;
}

// ----------------------------------------------------------- room selection ---

function pickRoom(ctx, idx, cs, subject, cellKeys, probe, combinedEntries) {
  // Combined class: sit in the same hall as the department already teaching it.
  if (combinedEntries.length === cellKeys.length && combinedEntries.length > 0) {
    return { roomId: combinedEntries[0].roomId || null, roomsExist: true };
  }
  const { classrooms, labs } = ctx.state;
  let pool;
  if (isLabSubject(subject)) {
    pool = labs.filter((r) => r.departmentId === cs.departmentId);
  } else {
    pool = [];
    const own = cs.roomId && ctx.roomsById.get(cs.roomId);
    if (own) pool.push(own);
    classrooms.filter((r) => r.departmentId === cs.departmentId && r.id !== cs.roomId).forEach((r) => pool.push(r));
  }
  for (const room of pool) {
    if (cellKeys.every((sk) => roomFreeAt(ctx, idx, sk, room.id, probe))) return { roomId: room.id, roomsExist: true };
  }
  return { roomId: null, roomsExist: pool.length > 0 };
}

// --------------------------------------------------------- faculty selection --

function eligibleFacultyOf(ctx, subject) {
  return (subject.facultyIds || []).map((id) => ctx.facultyById.get(id)).filter(Boolean);
}

function choosePrimary(ctx, idx, cs, subject, eligible) {
  if (!eligible.length) return null;
  const mine = ctx.state.timetableEntries.filter((e) => e.classSectionId === cs.id && e.subjectId === subject.id);
  if (mine.length && ctx.facultyById.get(mine[0].facultyId)) return mine[0].facultyId;
  // Common subject already scheduled for another department -> reuse that
  // faculty so the two classes can be combined into one lecture.
  if ((subject.departmentIds || []).length > 1) {
    const other = (idx.subjEntries.get(subject.id) || []).find(
      (e) => e.departmentId !== cs.departmentId && eligible.some((f) => f.id === e.facultyId),
    );
    if (other) return other.facultyId;
  }
  const ratio = (f) => facLoad(idx, f.id) / (Number(f.maxWeeklyHours) || 1e9);
  return eligible.slice().sort((a, b) => ratio(a) - ratio(b))[0].id;
}

// ---------------------------------------------------------- one class, one go --

function diagnose(ctx, idx, subject, eligible) {
  if (!eligible.length) return 'No faculty assigned to this subject';
  const anyAvail = eligible.filter((f) => ctx.days.some((d) => facultyAvailableOn(f, d)));
  if (!anyAvail.length) return 'Eligible faculty are unavailable on every working day';
  const withCap = anyAvail.filter((f) => facLoad(idx, f.id) < (Number(f.maxWeeklyHours) || Infinity));
  if (!withCap.length) return 'All eligible faculty are at their max weekly hours';
  return isLabSubject(subject)
    ? 'No free run of consecutive periods (class grid / faculty / lab clashes)'
    : 'No free slot left (class grid / faculty clashes)';
}

function buildTasks(ctx, idx, cs, plan, rand, jitter) {
  const labTasks = [];
  const theoryOrder = [];
  const unplaced = [];
  const primaries = new Map();

  for (const item of plan) {
    const subject = item.subject;
    const scheduled = idx.clsSubj.get(cs.id + '|' + subject.id) || 0;
    const remaining = item.weeklyHours - scheduled;
    if (remaining <= 0) continue;
    const eligible = item.facultyIds.map((id) => ctx.facultyById.get(id)).filter(Boolean);
    if (!eligible.length) {
      unplaced.push({
        classSectionId: cs.id, subjectId: subject.id, missing: remaining,
        reason: item.fixed ? 'The staff allocated to this class no longer exists' : 'No faculty assigned to this subject',
      });
      continue;
    }
    primaries.set(subject.id, choosePrimary(ctx, idx, cs, subject, eligible));
    theoryOrder.push({ subject, weekly: item.weeklyHours, remaining, eligible, key: eligible.length * 100 - remaining + (jitter ? rand() * 3 : 0) });
  }

  theoryOrder.sort((a, b) => a.key - b.key);

  for (const t of theoryOrder) {
    if (isLabSubject(t.subject)) splitLabHours(t.remaining).forEach((L) => labTasks.push({ ...t, L }));
  }
  labTasks.sort((a, b) => b.L - a.L);

  const theory = theoryOrder.filter((t) => !isLabSubject(t.subject));
  const maxRem = theory.reduce((m, t) => Math.max(m, t.remaining), 0);
  const theoryTasks = [];
  for (let r = 0; r < maxRem; r++) {
    for (const t of theory) if (r < t.remaining) theoryTasks.push({ ...t, L: 1 });
  }
  return { tasks: [...labTasks, ...theoryTasks], unplaced, primaries };
}

function placeTask(ctx, idx, cs, task, primaryId, opt, rand, jitter) {
  const { subject, eligible, L } = task;
  const lab = isLabSubject(subject);
  const common = (subject.departmentIds || []).length > 1;
  const nPeriods = ctx.periodSlots.length;
  const otherDeptEntries = common
    ? (idx.subjEntries.get(subject.id) || []).filter((e) => e.departmentId !== cs.departmentId)
    : [];
  const weekly = task.weekly;
  const have = idx.clsSubj.get(cs.id + '|' + subject.id) || 0;
  if (have + L > weekly) return null;
  const forbid = opt.forbidSet;

  let best = null;

  for (const day of ctx.days) {
    if (forbid && forbid.has(cs.id + '|' + subject.id + '|' + day.id + '|*')) continue;
    if (!lab && (idx.clsSubjDay.get(cs.id + '|' + subject.id + '|' + day.id) || 0) >= opt.maxTheoryPerDay) continue;
    for (let i = 0; i + L <= nPeriods; i++) {
      const cells = ctx.periodSlots.slice(i, i + L);
      if (cells.some((p) => idx.clsCell.has(cs.id + '|' + day.id + '|' + p.id))) continue;
      if (forbid && cells.some((p) => forbid.has(cs.id + '|' + subject.id + '|' + day.id + '|' + p.id))) continue;
      const cellKeys = cells.map((p) => day.id + '|' + p.id);

      for (const f of eligible) {
        if (!facultyAvailableOn(f, day)) continue;
        const probe = { classSectionId: cs.id, departmentId: cs.departmentId, subjectId: subject.id, facultyId: f.id };
        let clash = false;
        const combinedEntries = [];
        for (const sk of cellKeys) {
          const r = facultyCell(ctx, idx, sk, f.id, probe);
          if (!r) { clash = true; break; }
          if (r.combined) combinedEntries.push(r.combined);
        }
        if (clash) continue;
        const newLoad = L - combinedEntries.length;
        const cap = Number(f.maxWeeklyHours);
        if (Number.isFinite(cap) && facLoad(idx, f.id) + newLoad > cap) continue;

        const room = pickRoom(ctx, idx, cs, subject, cellKeys, probe, combinedEntries);

        // ---- soft score (lower = better)
        let score = 0;
        score += 2 * (idx.clsDay.get(cs.id + '|' + day.id) || 0);
        score += (lab ? 10 : 6) * (idx.clsSubjDay.get(cs.id + '|' + subject.id + '|' + day.id) || 0);
        for (let k = i; k < i + L - 1; k++) if (ctx.gapAfter[k]) { score += 3; break; }
        if (primaryId && f.id !== primaryId) score += 8;
        score += 2 * (facLoad(idx, f.id) / (cap || 1e9));
        const fd = (idx.facDay.get(f.id + '|' + day.id) || 0) + newLoad;
        if (fd > opt.softMaxFacultyPerDay) score += 4 * (fd - opt.softMaxFacultyPerDay);
        const run = consecutiveRun(ctx, idx, f.id, day.id, i, L);
        if (run > 3) score += 5 * (run - 3);
        if (combinedEntries.length === L) score -= 12;
        else if (otherDeptEntries.length && !combinedEntries.length) score += 4;
        if (!room.roomId && room.roomsExist) score += 6;
        score += lab ? -0.1 * i : 0.1 * i;
        if (jitter) score += rand() * 1.5;

        if (!best || score < best.score) best = { score, day, i, cells, f, room, combinedEntries };
      }
    }
  }

  if (!best) return null;
  const out = best.cells.map((p) => ({
    id: 'TT-' + Math.random().toString(36).slice(2, 9),
    departmentId: cs.departmentId,
    classSectionId: cs.id,
    dayOrderId: best.day.id,
    periodId: p.id,
    subjectId: subject.id,
    facultyId: best.f.id,
    roomId: best.room.roomId,
    type: lab ? 'lab' : 'theory',
  }));
  return { entries: out, score: best.score };
}

function runAttempt(ctx, classSections, attempt, opt, planOf) {
  const rand = mulberry32(1337 + attempt * 7919);
  const jitter = attempt > 0;
  const idx = newIndex();
  ctx.state.timetableEntries.forEach((e) => addEntry(idx, e));

  const order = jitter ? shuffle(classSections, rand) : classSections;
  const placed = [];
  const unplaced = [];
  let penalty = 0;

  for (const cs of order) {
    const { tasks, unplaced: noFaculty, primaries } = buildTasks(ctx, idx, cs, planOf(cs), rand, jitter);
    unplaced.push(...noFaculty);
    const missByCls = new Map();
    const eligibleBy = new Map();

    for (const task of tasks) {
      const res = placeTask(ctx, idx, cs, task, primaries.get(task.subject.id), opt, rand, jitter);
      if (!res) {
        missByCls.set(task.subject.id, (missByCls.get(task.subject.id) || 0) + task.L);
        eligibleBy.set(task.subject.id, task.eligible);
        continue;
      }
      res.entries.forEach((e) => { addEntry(idx, e); placed.push(e); });
      penalty += res.score;
    }
    for (const [subjectId, missing] of missByCls) {
      unplaced.push({ classSectionId: cs.id, subjectId, missing, reason: diagnose(ctx, idx, ctx.subjectsById.get(subjectId), eligibleBy.get(subjectId)) });
    }
  }
  const unplacedHours = unplaced.reduce((s, u) => s + u.missing, 0);
  return { entries: placed, unplaced, unplacedHours, penalty };
}

// ------------------------------------------------------------------ public ----

/**
 * Fill the empty cells of one or many class sections. Pure function: does not
 * touch state, returns the NEW entries (ready to append to timetableEntries).
 *
 * @returns {{ entries, unplaced: {classSectionId, subjectId, missing, reason}[], stats }}
 */
export function generateForClasses({ state: rawState, classSections, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const t0 = nowMs();

  // Broken entries of the target classes are treated as EMPTY cells and reported
  // back (removeEntryIds) so the caller deletes them in the same save.
  const orphans = findOrphanEntries(rawState, classSections.map((c) => c.id));
  const orphanIds = new Set(orphans.map((e) => e.id));
  const state = orphanIds.size ? { ...rawState, timetableEntries: rawState.timetableEntries.filter((e) => !orphanIds.has(e.id)) } : rawState;

  if (opt.forbid && opt.forbid.length) {
    opt.forbidSet = new Set(opt.forbid.map((r) => r.classSectionId + '|' + r.subjectId + '|' + r.dayOrderId + '|' + (r.periodId || '*')));
  }

  const ctx = prepare(state);
  const planOf = (cs) => planForClassSection(state, cs);

  let required = 0;
  const preScheduled = new Map();
  state.timetableEntries.forEach((e) => preScheduled.set(e.classSectionId + '|' + e.subjectId, (preScheduled.get(e.classSectionId + '|' + e.subjectId) || 0) + 1));
  classSections.forEach((cs) => planOf(cs).forEach((item) => {
    required += Math.max(0, item.weeklyHours - (preScheduled.get(cs.id + '|' + item.subject.id) || 0));
  }));

  let best = null;
  let attempts = 0;
  for (; attempts < opt.maxAttempts; attempts++) {
    const res = runAttempt(ctx, classSections, attempts, opt, planOf);
    if (!best || res.unplacedHours < best.unplacedHours || (res.unplacedHours === best.unplacedHours && res.penalty < best.penalty)) best = res;
    if (best.unplacedHours === 0 && attempts + 1 >= opt.minAttemptsWhenPerfect) { attempts++; break; }
    if (nowMs() - t0 > opt.timeBudgetMs) { attempts++; break; }
  }

  return {
    entries: best.entries,
    removeEntryIds: [...orphanIds],
    unplaced: best.unplaced,
    stats: {
      attempts,
      ms: Math.round(nowMs() - t0),
      requiredHours: required,
      placedHours: best.entries.length,
      unplacedHours: best.unplacedHours,
      orphansRemoved: orphanIds.size,
    },
  };
}

// Required vs scheduled periods per subject for one class (drives the "coverage"
// strip under the grid). Also surfaces STRAY periods (a subject placed in this class
// that is not part of its plan) and BROKEN periods (subject/faculty deleted), which
// used to be invisible - the grid looked full while the counts didn't add up.
export function coverageForClass(state, cs) {
  const plan = planForClassSection(state, cs);
  const mine = state.timetableEntries.filter((e) => e.classSectionId === cs.id);
  const subjectsById = new Map(state.subjects.map((s) => [s.id, s]));
  const rows = plan.map((item) => ({
    subjectId: item.subject.id,
    name: item.subject.name,
    required: item.weeklyHours,
    scheduled: mine.filter((e) => e.subjectId === item.subject.id).length,
  }));
  const planned = new Set(plan.map((p) => p.subject.id));
  const strayCount = new Map();
  let broken = 0;
  mine.forEach((e) => {
    if (!subjectsById.has(e.subjectId)) { broken++; return; }
    if (!planned.has(e.subjectId)) strayCount.set(e.subjectId, (strayCount.get(e.subjectId) || 0) + 1);
  });
  strayCount.forEach((n, id) => rows.push({ subjectId: id, name: subjectsById.get(id).name, required: 0, scheduled: n, stray: true }));
  if (broken) rows.push({ subjectId: '__broken', name: 'Broken entries (subject deleted)', required: 0, scheduled: broken, broken: true });
  return rows;
}