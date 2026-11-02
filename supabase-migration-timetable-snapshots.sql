-- ---------------------------------------------------------------------------
-- Migration: timetable snapshots (ADDITIVE ONLY - creates one new table).
--
-- Why: a class's timetable is just its rows in `timetable_entries`, and the grids
-- look the subject's name / code / type up in Master Data. Without a snapshot,
-- editing a subject (e.g. Theory -> Theory + Lab) would change how an already
-- generated timetable is read and how auto-fill tops it up. This table keeps, per
-- (class section, subject), the subject configuration the timetable was generated
-- with. Newly generated timetables write a fresh snapshot from the latest Master Data.
--
-- What it does NOT do: it does not alter, move or delete any existing table or row
-- (subjects, timetable_entries, faculty, auth ... are untouched). There are no foreign
-- keys on purpose, so a snapshot can never block deleting a subject / class section.
--
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run (every step is IF NOT EXISTS / guarded).
-- ---------------------------------------------------------------------------

create table if not exists public.timetable_snapshots (
  id               text primary key,          -- 'SNAP-<class_section_id>-<subject_id>'
  class_section_id text not null,
  subject_id       text not null,
  code             text,
  name             text,
  type             text,                      -- 'Theory' | 'Lab' | 'Theory + Lab' (as at generation)
  weekly_hours     integer not null default 0,
  theory_hours     integer not null default 0,
  lab_hours        integer not null default 0,
  faculty_ids      text[] not null default '{}',
  source           text not null default 'generation',   -- 'generation' | 'before-edit'
  created_at       timestamptz not null default now()
);

create index if not exists timetable_snapshots_class_idx
  on public.timetable_snapshots (class_section_id);

-- Same security model as every other table: public read, signed-in staff write.
alter table public.timetable_snapshots enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'timetable_snapshots' and policyname = 'timetable_snapshots_read') then
    create policy timetable_snapshots_read on public.timetable_snapshots
      for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'timetable_snapshots' and policyname = 'timetable_snapshots_write') then
    create policy timetable_snapshots_write on public.timetable_snapshots
      for all to authenticated using (true) with check (true);
  end if;
end $$;
