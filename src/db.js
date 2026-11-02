import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// One source of truth for how each in-app collection maps to a real Postgres
// table + column names. Keeping this in one place means every mutation site
// in TimeSyncAI.jsx can stay exactly as it was (addRecord('subjects', ...),
// updateRecord('faculty', id, patch), etc.) - only `persist` underneath needs
// to know how to translate that into SQL.
// ---------------------------------------------------------------------------
const TABLE_BY_KEY = {
  departments: 'departments',
  dayOrders: 'day_orders',
  periods: 'periods',
  faculty: 'faculty',
  subjects: 'subjects',
  classrooms: 'classrooms',
  labs: 'labs',
  classSections: 'class_sections',
  // who teaches which subject in which section (see supabase-migration-class-assignments.sql)
  classAssignments: 'class_assignments',
  timetableEntries: 'timetable_entries',
  activityLog: 'activity_log',
  // per-class copy of the subject configuration a timetable was generated with
  // (see supabase-migration-timetable-snapshots.sql). Optional: see SNAPSHOT_KEY below.
  timetableSnapshots: 'timetable_snapshots',
};

// The snapshot table is additive. Until its migration has been run it does not exist, and that
// must neither stop the app loading nor make a timetable save fail - snapshot read/write errors
// are tolerated and reported back to the caller (see syncDiff) instead of thrown.
const SNAPSHOT_KEY = 'timetableSnapshots';

// camelCase JS field -> snake_case DB column, per collection. Fields not listed
// here are assumed to already match (e.g. id, name, type, capacity).
const FIELD_MAP = {
  faculty: { departmentId: 'department_id', maxWeeklyHours: 'max_weekly_hours' },
  // A subject can now be offered by more than one department in the same year
  // (e.g. a common Maths paper taken by CSE, AIDS and IT II-year students), so
  // `departmentIds` is a real Postgres text[] column - see supabase-migration.sql.
  subjects: { departmentIds: 'department_ids', weeklyHours: 'weekly_hours', labRequired: 'lab_required' },
  classrooms: { departmentId: 'department_id' },
  labs: { departmentId: 'department_id' },
  classSections: { departmentId: 'department_id', roomId: 'room_id' },
  classAssignments: { classSectionId: 'class_section_id', subjectId: 'subject_id', facultyId: 'faculty_id', weeklyHours: 'weekly_hours' },
  timetableEntries: {
    departmentId: 'department_id', classSectionId: 'class_section_id', dayOrderId: 'day_order_id',
    periodId: 'period_id', subjectId: 'subject_id', facultyId: 'faculty_id', roomId: 'room_id',
  },
  dayOrders: { actualDay: 'actual_day' },
  periods: { start: 'start_time', end: 'end_time' },
  activityLog: { entityType: 'entity_type', entityId: 'entity_id' },
  timetableSnapshots: {
    classSectionId: 'class_section_id', subjectId: 'subject_id', weeklyHours: 'weekly_hours',
    theoryHours: 'theory_hours', labHours: 'lab_hours', facultyIds: 'faculty_ids', createdAt: 'created_at',
  },
};

// Columns that don't exist as real DB columns for a table - derived instead
// (subjects.facultyIds / faculty.subjectIds come from the subject_faculty
// junction table, not a column).
const DERIVED_FIELDS = {
  subjects: ['facultyIds'],
  faculty: ['subjectIds'],
};

function toRow(key, record) {
  const map = FIELD_MAP[key] || {};
  const skip = DERIVED_FIELDS[key] || [];
  const row = {};
  for (const [field, value] of Object.entries(record)) {
    if (skip.includes(field)) continue;
    row[map[field] || field] = value;
  }
  // activity_log.ts is a real Postgres `timestamptz` column, but the app keeps `ts` as
  // a plain JS epoch-millisecond number in memory (Date.now()). Postgres can't cast a
  // bare number like that into a timestamp, so convert to an ISO string on the way out.
  if (key === 'activityLog' && typeof record.ts === 'number') {
    row.ts = new Date(record.ts).toISOString();
  }
  return row;
}

function fromRow(key, row) {
  const map = FIELD_MAP[key] || {};
  const reverse = Object.fromEntries(Object.entries(map).map(([js, db]) => [db, js]));
  const obj = {};
  for (const [col, value] of Object.entries(row)) {
    obj[reverse[col] || col] = value;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Supabase/PostgREST silently caps every SELECT at 1000 rows. A college with
// several departments x years x sections easily has >1000 timetable_entries
// (36 cells per class), so a plain select('*') quietly returned only the first
// 1000 - the rest of the timetable "vanished" and conflicts against those
// missing rows were never detected. Page through with .range() instead.
// ---------------------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchAll(table, orderCols) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase.from(table).select('*');
    for (const col of orderCols) q = q.order(col);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

// Postgres returns rows in physical order, and an UPDATE moves a row to the end -
// so after editing one period or day-order the grid columns/rows came back
// shuffled. Always sort these two explicitly.
export function timeToMinutes(str) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(str || '');
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = Number(m[1]) % 12;
  if ((m[3] || '').toUpperCase() === 'PM') h += 12;
  else if (!m[3]) h = Number(m[1]);
  return h * 60 + Number(m[2]);
}
export function sortPeriods(list) {
  return [...list].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}
export function sortDayOrders(list) {
  return [...list].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Load the whole app state from Supabase, shaped exactly like the old
// localStorage blob so the rest of TimeSyncAI.jsx doesn't need to change.
// ---------------------------------------------------------------------------
export async function loadState() {
  const [
    { data: departments, error: eDept },
    { data: dayOrdersRaw, error: eDay },
    { data: periodsRaw, error: ePeriod },
    { data: facultyRaw, error: eFac },
    { data: subjectsRaw, error: eSub },
    { data: classrooms, error: eRoom },
    { data: labs, error: eLab },
    { data: classSectionsRaw, error: eCls },
    { data: timetableEntriesRaw, error: eTT },
    { data: activityLogRaw, error: eAct },
    { data: subjectFaculty, error: eJoin },
    { data: collegeRows, error: eCollege },
  ] = await Promise.all([
    supabase.from('departments').select('*').order('name'),
    supabase.from('day_orders').select('*'),
    supabase.from('periods').select('*'),
    fetchAll('faculty', ['name', 'id']),
    fetchAll('subjects', ['name', 'id']),
    supabase.from('classrooms').select('*').order('name'),
    supabase.from('labs').select('*').order('name'),
    fetchAll('class_sections', ['id']),
    fetchAll('timetable_entries', ['id']),
    supabase.from('activity_log').select('*').order('ts', { ascending: false }).limit(300),
    fetchAll('subject_faculty', ['subject_id', 'faculty_id']),
    supabase.from('college_settings').select('*').eq('id', 1).maybeSingle(),
  ]);

  const firstError = eDept || eDay || ePeriod || eFac || eSub || eRoom || eLab || eCls || eTT || eAct || eJoin || eCollege;
  if (firstError) throw firstError;

  // class_assignments is loaded separately: if the migration hasn't been run yet the
  // table doesn't exist, and that must not take the whole app down.
  let classAssignments = [];
  const { data: caRows, error: eCA } = await fetchAll('class_assignments', ['id']);
  if (eCA) {
    // eslint-disable-next-line no-console
    console.warn('class_assignments not available yet (run supabase-migration-class-assignments.sql):', eCA.message);
  } else {
    classAssignments = (caRows || []).map((r) => fromRow('classAssignments', r));
  }

  // timetable_snapshots is loaded separately for the same reason: missing table => no history yet.
  let timetableSnapshots = [];
  const { data: snapRows, error: eSnap } = await fetchAll('timetable_snapshots', ['id']);
  if (eSnap) {
    // eslint-disable-next-line no-console
    console.warn('timetable_snapshots not available yet (run supabase-migration-timetable-snapshots.sql):', eSnap.message);
  } else {
    timetableSnapshots = (snapRows || []).map((r) => fromRow('timetableSnapshots', r));
  }

  const facultyIdsBySubject = {};
  const subjectIdsByFaculty = {};
  (subjectFaculty || []).forEach(({ subject_id, faculty_id }) => {
    (facultyIdsBySubject[subject_id] ||= []).push(faculty_id);
    (subjectIdsByFaculty[faculty_id] ||= []).push(subject_id);
  });

  const faculty = (facultyRaw || []).map((r) => ({
    ...fromRow('faculty', r),
    subjectIds: subjectIdsByFaculty[r.id] || [],
  }));
  const subjects = (subjectsRaw || []).map((r) => {
    const mapped = fromRow('subjects', r);
    // Backward-compatible: older/un-migrated databases only have a single
    // `department_id` column, not the `department_ids` array (see
    // supabase-migration-multi-department-subjects.sql). Until that migration
    // runs, `department_ids` won't come back from Supabase at all, so fall
    // back to wrapping the old single value - this keeps the app from
    // crashing on `.includes(...)` calls against an undefined array.
    const departmentIds = Array.isArray(mapped.departmentIds) && mapped.departmentIds.length > 0
      ? mapped.departmentIds
      : (r.department_id ? [r.department_id] : []);
    return {
      ...mapped,
      departmentIds,
      facultyIds: facultyIdsBySubject[r.id] || [],
    };
  });

  const college = collegeRows
    ? {
        name: collegeRows.name,
        academicYear: collegeRows.academic_year,
        workingDays: collegeRows.working_days,
        numPeriods: collegeRows.num_periods,
      }
    : { name: '', academicYear: '', workingDays: '', numPeriods: 6 };

  return {
    college,
    departments: departments || [],
    dayOrders: sortDayOrders((dayOrdersRaw || []).map((r) => fromRow('dayOrders', r))),
    periods: sortPeriods((periodsRaw || []).map((r) => fromRow('periods', r))),
    faculty,
    subjects,
    // classrooms/labs must go through fromRow() same as every other collection -
    // without it, `department_id` never becomes `departmentId` on reload, so a
    // classroom/lab's department (and a lab's location) silently disappears the
    // moment the page refreshes even though the row is saved correctly in Supabase.
    classrooms: (classrooms || []).map((r) => fromRow('classrooms', r)),
    labs: (labs || []).map((r) => fromRow('labs', r)),
    classSections: (classSectionsRaw || []).map((r) => fromRow('classSections', r)),
    classAssignments,
    timetableSnapshots,
    timetableEntries: (timetableEntriesRaw || []).map((r) => fromRow('timetableEntries', r)),
    activityLog: (activityLogRaw || []).map((r) => ({
      ...fromRow('activityLog', r),
      ts: new Date(r.ts).getTime(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Diff-based sync: TimeSyncAI.jsx builds a `next` state object the same way
// it always has (spread + array map/filter) and hands both `prev` and `next`
// to persist(). This walks each collection, works out exactly which rows
// were added / changed / removed, and issues the minimum Supabase calls.
//
// What changed vs. the old version (this is what removes the "too many API
// calls / timeout" problem on big saves):
//   * diff is computed on the DB ROW (toRow), not the in-memory record, so
//     derived fields (faculty.subjectIds) no longer trigger fake updates
//   * updates are sent as batched upserts (one request per ~500 rows) instead of
//     one awaited request PER ROW
//   * inserts / deletes are chunked so URLs and payloads stay small
//   * writes run in FK-safe order: all inserts/updates parent -> child first,
//     then all deletes child -> parent (previously a faculty delete could run
//     before its subject_faculty rows were removed)
// ---------------------------------------------------------------------------
const WRITE_ORDER = Object.keys(TABLE_BY_KEY);          // parents first
const DELETE_ORDER = [...WRITE_ORDER].reverse();        // children first
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 200;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// PostgREST bulk upsert takes the UNION of keys and NULLs the ones a row lacks -
// group rows by identical key set so a partial row can never wipe another column.
function groupBySignature(rows) {
  const groups = new Map();
  for (const row of rows) {
    const sig = Object.keys(row).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(row);
  }
  return [...groups.values()];
}

function planCollection(key, prevList, nextList) {
  const prevById = new Map((prevList || []).map((r) => [r.id, r]));
  const nextById = new Map((nextList || []).map((r) => [r.id, r]));
  const inserts = [];
  const updates = [];
  for (const [id, record] of nextById) {
    const prevRecord = prevById.get(id);
    if (!prevRecord) inserts.push(record);
    else if (JSON.stringify(toRow(key, prevRecord)) !== JSON.stringify(toRow(key, record))) updates.push(record);
  }
  const deletedIds = [...prevById.keys()].filter((id) => !nextById.has(id));
  return { inserts, updates, deletedIds, prevById };
}

// Upsert a batch. Moving/swapping timetable periods can transiently violate a UNIQUE
// constraint such as (class_section_id, day_order_id, period_id): in one statement,
// "A moves onto B's cell" is checked before "B moves away" (Postgres error 23505).
// Fall back to delete-then-insert of just those rows, which is always valid, and put
// the old rows back if that insert fails so nothing is lost.
async function upsertRows(key, table, rows, plan) {
  // Subjects ask Postgres to hand the saved rows back (.select()) so the caller can verify what was
  // ACTUALLY stored instead of assuming the update worked. Other tables are unchanged.
  const query = supabase.from(table).upsert(rows, { onConflict: 'id' });
  const { data, error } = await (key === 'subjects' ? query.select() : query);
  if (!error) return data || null;
  // The delete-then-insert retry below exists ONLY for timetable periods moving/swapping cells.
  // It must never run for any other table: for a subject it would DELETE the subject (and then be
  // refused by every timetable row that still depends on it). Any other error is reported as-is.
  if (key !== 'timetableEntries' || error.code !== '23505') throw error;
  const ids = rows.map((r) => r.id);
  for (const part of chunk(ids, DELETE_CHUNK)) {
    const { error: eDel } = await supabase.from(table).delete().in('id', part);
    if (eDel) throw eDel;
  }
  const { error: eIns } = await supabase.from(table).insert(rows);
  if (eIns) {
    const previous = ids.map((id) => plan.prevById.get(id)).filter(Boolean).map((r) => toRow(key, r));
    if (previous.length) await supabase.from(table).insert(previous);
    throw eIns;
  }
}

async function writeCollection(key, plan) {
  const table = TABLE_BY_KEY[key];
  const saved = [];
  for (const part of chunk(plan.inserts, INSERT_CHUNK)) {
    const { error } = await supabase.from(table).insert(part.map((r) => toRow(key, r)));
    if (error) throw error;
  }
  for (const group of groupBySignature(plan.updates.map((r) => toRow(key, r)))) {
    for (const part of chunk(group, INSERT_CHUNK)) {
      const returned = await upsertRows(key, table, part, plan);
      if (key === 'subjects') {
        // Verify against the record Supabase returned. An UPDATE that matched no row (or was
        // filtered out by row-level security) comes back with NO error and NO row - that must not
        // be treated as success.
        const byId = new Map((returned || []).map((r) => [r.id, r]));
        for (const sent of part) {
          const got = byId.get(sent.id);
          if (!got) throw new Error('Supabase did not return the updated subject (' + sent.id + ') - the update was not saved.');
          if (got.type !== sent.type || Number(got.weekly_hours) !== Number(sent.weekly_hours)) {
            throw new Error('Supabase saved subject ' + sent.id + ' as "' + got.type + '" / ' + got.weekly_hours + ' h, not "' + sent.type + '" / ' + sent.weekly_hours + ' h.');
          }
          saved.push(fromRow('subjects', got));
        }
      }
    }
  }

  // subjects own the editable end of the faculty<->subject relationship (see
  // SubjectsTab's "Faculty who can teach this" picker), so re-sync the
  // junction table whenever a subject's facultyIds changed.
  if (key === 'subjects') {
    const toAddAll = [];
    for (const record of [...plan.inserts, ...plan.updates]) {
      const prevIds = new Set(plan.prevById.get(record.id)?.facultyIds || []);
      const nextIds = new Set(record.facultyIds || []);
      for (const faculty_id of nextIds) if (!prevIds.has(faculty_id)) toAddAll.push({ subject_id: record.id, faculty_id });
      const toRemove = [...prevIds].filter((id) => !nextIds.has(id));
      if (toRemove.length) {
        const { error } = await supabase.from('subject_faculty').delete().eq('subject_id', record.id).in('faculty_id', toRemove);
        if (error) throw error;
      }
    }
    for (const part of chunk(toAddAll, INSERT_CHUNK)) {
      const { error } = await supabase.from('subject_faculty').insert(part);
      if (error) throw error;
    }
  }
  return saved;
}

async function deleteCollection(key, plan) {
  if (!plan.deletedIds.length) return;
  const table = TABLE_BY_KEY[key];
  if (key === 'subjects') {
    // Junction rows must go BEFORE the subject rows (works with or without
    // ON DELETE CASCADE on subject_faculty).
    for (const part of chunk(plan.deletedIds, DELETE_CHUNK)) {
      const { error } = await supabase.from('subject_faculty').delete().in('subject_id', part);
      if (error) throw error;
    }
  }
  for (const part of chunk(plan.deletedIds, DELETE_CHUNK)) {
    const { error } = await supabase.from(table).delete().in('id', part);
    if (error) throw error;
  }
}

async function syncCollege(prevCollege, nextCollege) {
  if (JSON.stringify(prevCollege) === JSON.stringify(nextCollege)) return;
  const { error } = await supabase
    .from('college_settings')
    .update({
      name: nextCollege.name,
      academic_year: nextCollege.academicYear,
      working_days: nextCollege.workingDays,
      num_periods: nextCollege.numPeriods,
    })
    .eq('id', 1);
  if (error) throw error;
}

export async function syncDiff(prevState, nextState) {
  await syncCollege(prevState.college, nextState.college);
  const plans = {};
  for (const key of WRITE_ORDER) plans[key] = planCollection(key, prevState[key], nextState[key]);
  // Snapshots are written LAST and never throw: a failure there must not roll back the timetable
  // change that triggered it. The caller is told so it can warn the user.
  let snapshotError = null;
  let savedSubjects = [];
  for (const key of WRITE_ORDER) {
    if (key === SNAPSHOT_KEY) continue;
    const saved = await writeCollection(key, plans[key]);
    if (key === 'subjects') savedSubjects = saved;
  }
  for (const key of DELETE_ORDER) if (key !== SNAPSHOT_KEY) await deleteCollection(key, plans[key]);
  try {
    await writeCollection(SNAPSHOT_KEY, plans[SNAPSHOT_KEY]);
    await deleteCollection(SNAPSHOT_KEY, plans[SNAPSHOT_KEY]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Could not save timetable snapshots:', err);
    snapshotError = err?.message || 'unknown error';
  }
  return { snapshotError, savedSubjects };
}
// Turns a failed sync into the message the user sees. The old catch-all treated ANY error containing
// the word "violates" as "something still depends on it" - but a CHECK-constraint rejection (for
// example subjects.type not allowing 'Theory + Lab') also says "violates", so a rejected type change
// was reported as a dependency problem. Only real foreign-key errors get the dependency message.
export function describeSyncError(err) {
  const msg = err?.message || '';
  const code = err?.code;
  if (/class_assignments/i.test(msg) && /find the table|does not exist|schema cache/i.test(msg)) {
    return 'The class-allocation table is missing. Run supabase-migration-class-assignments.sql in the Supabase SQL editor, then reload.';
  }
  if (/subjects/i.test(msg) && (code === '23514' || /check constraint/i.test(msg) || (code === '22P02' && /enum/i.test(msg)))) {
    return 'The subject type could not be saved: ' + msg + '. The database does not accept this subject type yet - run supabase-migration-subject-type-theory-lab.sql in the Supabase SQL editor, then try again. Nothing was changed.';
  }
  if (code === '23503' || /foreign key/i.test(msg)) {
    return 'That can\u2019t be removed while other records still depend on it. Reassign or delete those first, then try again.';
  }
  return 'Change could not be saved: ' + (msg || 'unknown error') + '. Nothing was changed.';
}
