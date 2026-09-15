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
  timetableEntries: 'timetable_entries',
  activityLog: 'activity_log',
};

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
  timetableEntries: {
    departmentId: 'department_id', classSectionId: 'class_section_id', dayOrderId: 'day_order_id',
    periodId: 'period_id', subjectId: 'subject_id', facultyId: 'faculty_id', roomId: 'room_id',
  },
  dayOrders: { actualDay: 'actual_day' },
  periods: { start: 'start_time', end: 'end_time' },
  activityLog: { entityType: 'entity_type', entityId: 'entity_id' },
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
    supabase.from('faculty').select('*').order('name'),
    supabase.from('subjects').select('*').order('name'),
    supabase.from('classrooms').select('*').order('name'),
    supabase.from('labs').select('*').order('name'),
    supabase.from('class_sections').select('*'),
    supabase.from('timetable_entries').select('*'),
    supabase.from('activity_log').select('*').order('ts', { ascending: false }).limit(300),
    supabase.from('subject_faculty').select('*'),
    supabase.from('college_settings').select('*').eq('id', 1).maybeSingle(),
  ]);

  const firstError = eDept || eDay || ePeriod || eFac || eSub || eRoom || eLab || eCls || eTT || eAct || eJoin || eCollege;
  if (firstError) throw firstError;

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
    dayOrders: (dayOrdersRaw || []).map((r) => fromRow('dayOrders', r)),
    periods: (periodsRaw || []).map((r) => fromRow('periods', r)),
    faculty,
    subjects,
    // classrooms/labs must go through fromRow() same as every other collection -
    // without it, `department_id` never becomes `departmentId` on reload, so a
    // classroom/lab's department (and a lab's location) silently disappears the
    // moment the page refreshes even though the row is saved correctly in Supabase.
    classrooms: (classrooms || []).map((r) => fromRow('classrooms', r)),
    labs: (labs || []).map((r) => fromRow('labs', r)),
    classSections: (classSectionsRaw || []).map((r) => fromRow('classSections', r)),
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
// were added / changed / removed, and issues the minimum Supabase calls -
// no call site elsewhere in the app needs to know it's now talking to SQL.
// ---------------------------------------------------------------------------
async function syncCollection(key, prevList, nextList) {
  const table = TABLE_BY_KEY[key];
  if (!table) return;
  const prevById = new Map((prevList || []).map((r) => [r.id, r]));
  const nextById = new Map((nextList || []).map((r) => [r.id, r]));

  const inserts = [];
  const updates = [];
  for (const [id, record] of nextById) {
    const prevRecord = prevById.get(id);
    if (!prevRecord) inserts.push(record);
    else if (JSON.stringify(prevRecord) !== JSON.stringify(record)) updates.push(record);
  }
  const deletedIds = [...prevById.keys()].filter((id) => !nextById.has(id));

  if (inserts.length) {
    const { error } = await supabase.from(table).insert(inserts.map((r) => toRow(key, r)));
    if (error) throw error;
  }
  for (const record of updates) {
    const { error } = await supabase.from(table).update(toRow(key, record)).eq('id', record.id);
    if (error) throw error;
  }
  if (deletedIds.length) {
    const { error } = await supabase.from(table).delete().in('id', deletedIds);
    if (error) throw error;
  }

  // subjects own the editable end of the faculty<->subject relationship (see
  // SubjectsTab's "Faculty who can teach this" picker), so re-sync the
  // junction table whenever a subject's facultyIds changed.
  if (key === 'subjects') {
    for (const record of [...inserts, ...updates]) {
      const prevIds = new Set(prevById.get(record.id)?.facultyIds || []);
      const nextIds = new Set(record.facultyIds || []);
      const toAdd = [...nextIds].filter((id) => !prevIds.has(id));
      const toRemove = [...prevIds].filter((id) => !nextIds.has(id));
      if (toAdd.length) {
        const { error } = await supabase
          .from('subject_faculty')
          .insert(toAdd.map((faculty_id) => ({ subject_id: record.id, faculty_id })));
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await supabase
          .from('subject_faculty')
          .delete()
          .eq('subject_id', record.id)
          .in('faculty_id', toRemove);
        if (error) throw error;
      }
    }
    if (deletedIds.length) {
      // ON DELETE CASCADE on subject_faculty.subject_id already cleans these up,
      // this is just belt-and-braces for clarity.
      await supabase.from('subject_faculty').delete().in('subject_id', deletedIds);
    }
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
  for (const key of Object.keys(TABLE_BY_KEY)) {
    await syncCollection(key, prevState[key], nextState[key]);
  }
}