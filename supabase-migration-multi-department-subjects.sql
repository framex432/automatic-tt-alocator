-- ---------------------------------------------------------------------------
-- Migration: allow one subject to belong to MULTIPLE departments.
--
-- Why: a subject like "Mathematics II" is genuinely the same subject taught
-- to II-year CSE, AIDS and IT students alike, in real timetabling terms.
-- The old schema forced `department_id` to a single value, so the same
-- subject had to be duplicated once per department. This migration replaces
-- that single column with a `department_ids text[]` array column.
--
-- Run this once in your Supabase project's SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
-- Safe to re-run: every step is guarded with IF [NOT] EXISTS / idempotent.
-- ---------------------------------------------------------------------------

-- 1. Add the new array column (nullable for now, so this doesn't fail on
--    existing rows).
alter table public.subjects
  add column if not exists department_ids text[];

-- 2. Backfill: every existing subject keeps exactly the one department it had.
update public.subjects
  set department_ids = array[department_id]
  where department_ids is null
    and department_id is not null;

-- Any stray rows with neither value get an empty array instead of NULL, so
-- the app's `.includes(...)` filters never blow up on a null array.
update public.subjects
  set department_ids = '{}'::text[]
  where department_ids is null;

-- 3. Make it required and give it a sane default going forward.
alter table public.subjects
  alter column department_ids set not null,
  alter column department_ids set default '{}'::text[];

-- 4. Drop the old single-department foreign key + column now that
--    department_ids has taken over. If you'd rather keep it around for a
--    while as a safety net, comment this block out - the app no longer
--    reads or writes department_id either way.
alter table public.subjects
  drop constraint if exists subjects_department_id_fkey;

alter table public.subjects
  drop column if exists department_id;

-- 5. Optional but recommended: a GIN index makes "which subjects does
--    department X offer" (`department_ids @> array['CSE']` /
--    the app's client-side `.includes()` equivalent) fast even as the
--    subjects table grows.
create index if not exists subjects_department_ids_gin
  on public.subjects using gin (department_ids);
