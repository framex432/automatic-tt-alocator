// ---------------------------------------------------------------------------
// Change-request executor. The AI's ONLY job is to turn a sentence such as
//   "Day 1 la Data Structures venaam, vera subject podu, DS ah Wednesday ku maathu"
// into a few structured operations (see grok.js -> parseChangeRequest). This file
// then performs those operations DETERMINISTICALLY and checks every rule again, so
// a wrong guess from the model can never create a double-booking:
//   - faculty free at the new time in EVERY department (combined classes excepted)
//   - faculty available that weekday
//   - room not double-booked (falls back to another free room, else no room)
//   - class has one subject per period
//   - lab blocks move as a whole (consecutive periods stay consecutive)
//
// Operations (normalised form):
//   { op:'move',   subjectId, from:{dayOrderId?,periodId?}, to:{dayOrderId,periodId?}, fillVacated? }
//   { op:'swap',   a:{subjectId,dayOrderId?,periodId?}, b:{subjectId,dayOrderId?,periodId?} }
//   { op:'remove', subjectId, dayOrderId?, periodId?, forbid? }
//   { op:'set',    subjectId, dayOrderId, periodId, facultyId? }
// ---------------------------------------------------------------------------
import { isCombinedPair, planForClassSection } from './solver.js';

const isLab = (s) => !!s && (s.type === 'Lab' || s.labRequired === true);

export function applyChangeOps({ state, classSection: cs, ops }) {
  const periodSlots = state.periods.filter((p) => p.type === 'period');
  const periodIdx = new Map(periodSlots.map((p, i) => [p.id, i]));
  const dayIdx = new Map(state.dayOrders.map((d, i) => [d.id, i]));
  const dayById = new Map(state.dayOrders.map((d) => [d.id, d]));
  const periodById = new Map(periodSlots.map((p) => [p.id, p]));
  const subjectsById = new Map(state.subjects.map((s) => [s.id, s]));
  const facultyById = new Map(state.faculty.map((f) => [f.id, f]));
  const sectionById = new Map(state.classSections.map((c) => [c.id, c]));
  const rooms = [...state.classrooms, ...state.labs];
  const plan = planForClassSection(state, cs);

  const work = state.timetableEntries.map((e) => ({ ...e }));
  const log = [];
  const forbid = [];
  let changes = 0;
  let needsRefill = false;

  const say = (ok, text) => log.push({ ok, text });
  const where = (dayId, periodId) => {
    const d = dayById.get(dayId);
    const p = periodById.get(periodId);
    return (d ? 'Day ' + d.label + ' (' + d.actualDay + ')' : dayId) + (p ? ' \u00b7 ' + p.label : '');
  };
  const nameOf = (subjectId) => subjectsById.get(subjectId)?.name || subjectId;
  const classLabel = (id) => { const c = sectionById.get(id); return c ? c.departmentId + ' ' + c.year + c.section : id; };

  const mineAt = (dayId, periodId, ignore) =>
    work.find((e) => e.classSectionId === cs.id && e.dayOrderId === dayId && e.periodId === periodId && !ignore.has(e.id));

  function find(ref) {
    return work
      .filter((e) => e.classSectionId === cs.id
        && (!ref.subjectId || e.subjectId === ref.subjectId)
        && (!ref.dayOrderId || e.dayOrderId === ref.dayOrderId)
        && (!ref.periodId || e.periodId === ref.periodId))
      .sort((a, b) => (dayIdx.get(a.dayOrderId) - dayIdx.get(b.dayOrderId)) || (periodIdx.get(a.periodId) - periodIdx.get(b.periodId)));
  }

  // Can `entry` sit at (dayId, periodId)? `ignore` = ids of entries that are moving away.
  function legalAt(entry, dayId, periodId, ignore) {
    const day = dayById.get(dayId);
    if (!day || !periodById.has(periodId)) return { ok: false, reason: 'unknown day/period' };
    const f = facultyById.get(entry.facultyId);
    if (f && Array.isArray(f.availability) && !f.availability.includes(day.actualDay)) {
      return { ok: false, reason: f.name + ' is not available on ' + day.actualDay };
    }
    let roomBusy = false;
    for (const e of work) {
      if (ignore.has(e.id) || e.id === entry.id) continue;
      if (e.dayOrderId !== dayId || e.periodId !== periodId) continue;
      if (e.classSectionId === entry.classSectionId) return { ok: false, reason: 'that period is already used by this class' };
      const combined = isCombinedPair(e, entry, subjectsById);
      if (e.facultyId === entry.facultyId && !combined) {
        return { ok: false, reason: (f ? f.name : 'The faculty') + ' is already teaching ' + classLabel(e.classSectionId) + ' at that time' };
      }
      if (entry.roomId && e.roomId === entry.roomId && !combined) roomBusy = true;
    }
    let roomId = entry.roomId || null;
    if (roomBusy) {
      const current = rooms.find((r) => r.id === entry.roomId);
      const alt = rooms.find((r) =>
        r.id !== entry.roomId && r.departmentId === cs.departmentId && (!current || r.type === current.type)
        && !work.some((e) => !ignore.has(e.id) && e.id !== entry.id && e.dayOrderId === dayId && e.periodId === periodId && e.roomId === r.id));
      roomId = alt ? alt.id : null;
    }
    return { ok: true, roomId };
  }

  const countOnDay = (subjectId, dayId, ignoreIds) =>
    work.filter((e) => e.classSectionId === cs.id && e.subjectId === subjectId && e.dayOrderId === dayId && !ignoreIds.has(e.id)).length;

  // ---------------------------------------------------------------- move
  function moveTheory(X, op) {
    const toDay = op.to?.dayOrderId || X.dayOrderId;
    const periods = op.to?.periodId ? [op.to.periodId] : periodSlots.map((p) => p.id);
    const oldDay = X.dayOrderId, oldPeriod = X.periodId;
    if (toDay === oldDay && op.to?.periodId === oldPeriod) { say(false, nameOf(X.subjectId) + ' is already at ' + where(oldDay, oldPeriod) + '.'); return; }

    const candidates = [];
    const reasons = [];
    for (const p of periods) {
      if (toDay === oldDay && p === oldPeriod) continue;
      const occupant = mineAt(toDay, p, new Set([X.id]));
      const spread = 3 * countOnDay(X.subjectId, toDay, new Set([X.id]));
      const tie = 0.01 * periodIdx.get(p);
      if (!occupant) {
        const r = legalAt(X, toDay, p, new Set([X.id]));
        if (r.ok) candidates.push({ kind: 'move', p, roomId: r.roomId, cost: (op.fillVacated ? 5 : 0) + spread + tie });
        else reasons.push(where(toDay, p) + ': ' + r.reason);
      } else {
        const ign = new Set([X.id, occupant.id]);
        const rx = legalAt(X, toDay, p, ign);
        const ry = legalAt(occupant, oldDay, oldPeriod, ign);
        if (rx.ok && ry.ok) {
          candidates.push({
            kind: 'swap', p, occupant, roomId: rx.roomId, roomIdY: ry.roomId,
            cost: (op.fillVacated ? 0 : 8) + spread + 3 * countOnDay(occupant.subjectId, oldDay, ign) + tie,
          });
        } else reasons.push(where(toDay, p) + ': ' + (rx.ok ? nameOf(occupant.subjectId) + ' cannot go to ' + where(oldDay, oldPeriod) + ' (' + ry.reason + ')' : rx.reason));
      }
    }
    if (!candidates.length) {
      say(false, 'Could not move ' + nameOf(X.subjectId) + ' to ' + where(toDay, op.to?.periodId) + '. ' + (reasons[0] || 'No free or swappable period.'));
      return;
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const c = candidates[0];
    X.dayOrderId = toDay; X.periodId = c.p; X.roomId = c.roomId;
    if (c.kind === 'swap') {
      c.occupant.dayOrderId = oldDay; c.occupant.periodId = oldPeriod; c.occupant.roomId = c.roomIdY;
      say(true, 'Moved ' + nameOf(X.subjectId) + ' from ' + where(oldDay, oldPeriod) + ' to ' + where(toDay, c.p) + ' and put ' + nameOf(c.occupant.subjectId) + ' in its old place.');
    } else {
      say(true, 'Moved ' + nameOf(X.subjectId) + ' from ' + where(oldDay, oldPeriod) + ' to ' + where(toDay, c.p) + ' (was empty).');
    }
    changes++;
  }

  function moveLabBlock(X, op) {
    const block = find({ subjectId: X.subjectId, dayOrderId: X.dayOrderId });
    const n = block.length;
    const toDay = op.to?.dayOrderId || X.dayOrderId;
    const ignore = new Set(block.map((e) => e.id));
    const starts = op.to?.periodId ? [periodIdx.get(op.to.periodId)] : periodSlots.map((_, i) => i);
    let lastReason = '';
    for (const s of starts) {
      if (s === undefined || s + n > periodSlots.length) continue;
      if (toDay === X.dayOrderId && s === periodIdx.get(block[0].periodId)) continue;
      const plan_ = [];
      let ok = true;
      for (let j = 0; j < n; j++) {
        const p = periodSlots[s + j].id;
        if (mineAt(toDay, p, ignore)) { ok = false; lastReason = 'the periods are not free'; break; }
        const r = legalAt(block[j], toDay, p, ignore);
        if (!r.ok) { ok = false; lastReason = r.reason; break; }
        plan_.push({ e: block[j], p, roomId: r.roomId });
      }
      if (!ok) continue;
      const from = where(X.dayOrderId, block[0].periodId);
      plan_.forEach(({ e, p, roomId }) => { e.dayOrderId = toDay; e.periodId = p; e.roomId = roomId; });
      say(true, 'Moved the ' + n + '-period lab ' + nameOf(X.subjectId) + ' from ' + from + ' to ' + where(toDay, periodSlots[s].id) + '.');
      changes++;
      return;
    }
    say(false, 'Could not move the ' + n + '-period lab ' + nameOf(X.subjectId) + (lastReason ? ': ' + lastReason + '.' : '. No run of free consecutive periods.'));
  }

  // ------------------------------------------------------------- dispatch
  for (const op of ops || []) {
    try {
      if (op.op === 'move') {
        const X = find({ subjectId: op.subjectId, dayOrderId: op.from?.dayOrderId, periodId: op.from?.periodId })[0];
        if (!X) { say(false, 'No ' + nameOf(op.subjectId) + ' period found' + (op.from?.dayOrderId ? ' on ' + where(op.from.dayOrderId, op.from.periodId) : '') + ' to move.'); continue; }
        if (isLab(subjectsById.get(X.subjectId))) moveLabBlock(X, op); else moveTheory(X, op);
      } else if (op.op === 'swap') {
        const A = find({ subjectId: op.a?.subjectId, dayOrderId: op.a?.dayOrderId, periodId: op.a?.periodId })[0];
        const B = find({ subjectId: op.b?.subjectId, dayOrderId: op.b?.dayOrderId, periodId: op.b?.periodId })[0];
        if (!A || !B) { say(false, 'Could not find both periods to swap.'); continue; }
        if (A.id === B.id) { say(false, 'Both sides of the swap are the same period.'); continue; }
        if (isLab(subjectsById.get(A.subjectId)) || isLab(subjectsById.get(B.subjectId))) { say(false, 'Swapping lab blocks is not supported - move the lab instead.'); continue; }
        const ign = new Set([A.id, B.id]);
        const ra = legalAt(A, B.dayOrderId, B.periodId, ign);
        const rb = legalAt(B, A.dayOrderId, A.periodId, ign);
        if (!ra.ok || !rb.ok) { say(false, 'Cannot swap ' + nameOf(A.subjectId) + ' and ' + nameOf(B.subjectId) + ': ' + (!ra.ok ? ra.reason : rb.reason) + '.'); continue; }
        const d = A.dayOrderId, p = A.periodId;
        A.dayOrderId = B.dayOrderId; A.periodId = B.periodId; A.roomId = ra.roomId;
        B.dayOrderId = d; B.periodId = p; B.roomId = rb.roomId;
        say(true, 'Swapped ' + nameOf(A.subjectId) + ' (now ' + where(A.dayOrderId, A.periodId) + ') with ' + nameOf(B.subjectId) + ' (now ' + where(B.dayOrderId, B.periodId) + ').');
        changes++;
      } else if (op.op === 'remove') {
        const hit = find({ subjectId: op.subjectId, dayOrderId: op.dayOrderId, periodId: op.periodId });
        if (!hit.length) { say(false, 'Nothing to remove: no ' + (op.subjectId ? nameOf(op.subjectId) : 'period') + ' found there.'); continue; }
        const ids = new Set(hit.map((e) => e.id));
        for (let i = work.length - 1; i >= 0; i--) if (ids.has(work[i].id)) work.splice(i, 1);
        if (op.forbid && op.subjectId && op.dayOrderId) forbid.push({ classSectionId: cs.id, subjectId: op.subjectId, dayOrderId: op.dayOrderId, periodId: op.periodId || null });
        needsRefill = true;
        say(true, 'Removed ' + hit.length + ' period(s) of ' + hit.map((e) => nameOf(e.subjectId))[0] + ' from ' + where(hit[0].dayOrderId, op.periodId ? hit[0].periodId : null) + '.');
        changes++;
      } else if (op.op === 'set') {
        const item = plan.find((i) => i.subject.id === op.subjectId);
        const subject = subjectsById.get(op.subjectId);
        if (!subject) { say(false, 'Unknown subject.'); continue; }
        const occupant = mineAt(op.dayOrderId, op.periodId, new Set());
        const eligible = (op.facultyId ? [op.facultyId] : (item ? item.facultyIds : subject.facultyIds || [])).filter((id) => facultyById.has(id));
        const room = occupant?.roomId ?? cs.roomId ?? null;
        let placed = null, why = '';
        for (const fid of eligible) {
          const cand = { id: 'TT-' + Math.random().toString(36).slice(2, 9), departmentId: cs.departmentId, classSectionId: cs.id, dayOrderId: op.dayOrderId, periodId: op.periodId, subjectId: op.subjectId, facultyId: fid, roomId: room, type: isLab(subject) ? 'lab' : 'theory' };
          const r = legalAt(cand, op.dayOrderId, op.periodId, new Set(occupant ? [occupant.id] : []));
          if (r.ok) { cand.roomId = r.roomId; placed = cand; break; }
          why = r.reason;
        }
        if (!placed) { say(false, 'Could not put ' + nameOf(op.subjectId) + ' at ' + where(op.dayOrderId, op.periodId) + (why ? ': ' + why + '.' : ': no faculty assigned.')); continue; }
        if (occupant) { work.splice(work.indexOf(occupant), 1); needsRefill = true; }
        work.push(placed);
        const have = work.filter((e) => e.classSectionId === cs.id && e.subjectId === op.subjectId).length;
        const need = item ? item.weeklyHours : Number(subject.weeklyHours) || 0;
        say(true, 'Placed ' + nameOf(op.subjectId) + ' at ' + where(op.dayOrderId, op.periodId) + (occupant ? ' (replaced ' + nameOf(occupant.subjectId) + ')' : '') + (need && have > need ? '. Note: it now has ' + have + ' periods but only ' + need + ' are planned.' : '.'));
        changes++;
      } else {
        say(false, 'Unsupported change: ' + (op.op || 'unknown'));
      }
    } catch (err) {
      say(false, 'Could not apply one change: ' + (err?.message || err));
    }
  }

  return { entries: work, forbid, log, changes, needsRefill };
}