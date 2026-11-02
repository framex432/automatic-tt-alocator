-- ---------------------------------------------------------------------------
-- Migration: allow the subject type 'Theory + Lab' (NON-DESTRUCTIVE).
--
-- Why: the app now saves subjects.type = 'Theory + Lab'. If your `subjects.type` column was created
-- with a CHECK constraint (type in ('Theory','Lab')) or as a Postgres ENUM, Supabase rejects the
-- UPDATE ("new row for relation \"subjects\" violates check constraint ..."), so the change is rolled
-- back and the subject stays Theory.
--
-- What it does: ONLY loosens validation on that one column.
--   * a CHECK constraint on subjects.type  -> replaced by one that also allows 'Theory + Lab'
--   * an ENUM type behind subjects.type    -> gets the extra value 'Theory + Lab'
--   * if neither exists, it changes nothing.
-- It never deletes or rewrites a subject, timetable entry, faculty row or snapshot.
--
-- Weekly hours are stored in the existing `weekly_hours` column. Theory hours (weekly - 2) and
-- lab hours (always 2) are DERIVED by the app from it, so there are no extra columns to add.
--
-- Run once: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- ---------------------------------------------------------------------------
do $$
declare
  c   record;
  col record;
begin
  select data_type, udt_name into col
  from information_schema.columns
  where table_schema = 'public' and table_name = 'subjects' and column_name = 'type';

  if col.data_type = 'USER-DEFINED' then
    -- type is a Postgres ENUM: add the new value (no-op if present).
    execute format('alter type %I add value if not exists %L', col.udt_name, 'Theory + Lab');
  else
    -- type is plain text: replace any CHECK constraint that restricts it.
    for c in
      select conname from pg_constraint
      where conrelid = 'public.subjects'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ~* '\mtype\M'
    loop
      execute format('alter table public.subjects drop constraint %I', c.conname);
    end loop;

    -- NOT VALID: new/updated rows are checked, existing rows are never rejected or rewritten.
    alter table public.subjects
      add constraint subjects_type_check
      check (type in ('Theory', 'Lab', 'Theory + Lab')) not valid;
  end if;
end $$;
