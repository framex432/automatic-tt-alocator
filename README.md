# Time Sync AI

Academic timetable builder + conflict detection for Sir Issac Newton College of Engineering and Technology. React + Vite + Tailwind, backed by Supabase (Postgres).

## Run it locally

1. Open this folder in VS Code.
2. Open a terminal and run:

   ```
   npm install
   npm run dev
   ```

3. Vite prints a local URL, usually `http://localhost:5173`. Open that in your browser.

`.env.local` needs three values — copy `.env.example` to `.env.local` and fill them in:
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — from your Supabase project's **Settings → API**.
- `VITE_GROK_API_KEY` — from [console.x.ai](https://console.x.ai) (API Keys section). Only needed for the **Generate with AI** button; everything else works without it.

Restart `npm run dev` after editing `.env.local` — Vite only reads it on startup.

## Login

- **Viewing timetables needs no login** — anyone with the link can browse.
- **Adding, editing, or deleting anything requires signing in.** Click **Sign in** (top right) and enter the staff password.
- The login screen only asks for a password (no visible username/email) — this is intentional, see `STAFF_LOGIN_EMAIL` in `src/TimeSyncAI.jsx` for how it's wired to Supabase Auth.
- This is a stopgap: swap in Google/per-staff login later via Supabase Auth without touching the database security rules, which only check "logged in or not."

## How data works

- All data lives in Supabase (Postgres), not the browser — `src/db.js` handles loading and diff-syncing every change.
- Row Level Security is enabled on every table: reads are public, writes require an authenticated session.
- Deleting a department that still has faculty/subjects/classes assigned is blocked (both in the UI and at the database level) to prevent orphaned data.

## AI-generated timetables (Grok)

- On **Create Timetable**, once a class section is loaded, click **Generate with AI**.
- This sends that class's subjects (with weekly-hour targets and eligible faculty), the day-order/period grid, available rooms, and every *other* department's existing bookings to Grok (`grok-4-fast-non-reasoning` via the x.ai API, see `src/grok.js`), and asks it to fill every empty cell.
- It never touches cells you've already filled by hand, and every entry Grok returns is re-validated locally against real subjects/faculty/rooms and checked for double-booking before it's saved — an invalid or hallucinated entry is silently dropped rather than trusted.
- Needs `VITE_GROK_API_KEY` set (see above); without it the button is disabled with an inline hint.
- Like the Supabase anon key, the Grok key ships in the browser bundle — acceptable for a small internal tool, but move the call behind a server/edge function before exposing this app publicly.

## Subjects shared across departments

- A subject can now belong to **multiple departments** at once (e.g. a common "Mathematics II" paper taken by II-year CSE, AIDS and IT students) instead of being duplicated once per department.
- In **Master Data → Subjects**, pick every department that offers the subject when adding it; the "Faculty who can teach this" list updates to show faculty from all the departments you've selected.
- Existing Supabase projects need a one-time migration: run `supabase-migration-multi-department-subjects.sql` in your project's SQL editor (Dashboard → SQL Editor → New query → paste → Run) before pulling this update. It's idempotent, so it's safe to run more than once.

## Exporting timetables

- **Download PNG / Download PDF** render the timetable directly onto a canvas (see `drawTimetableCanvas` in `src/TimeSyncAI.jsx`) using your real Supabase data — no screenshot library involved, so it can't silently produce a blank image.
- **Print** uses the browser's native print dialog.

## Notifications

- Every add/edit/delete logs an activity entry, shown via the bell icon (top right).
- Entries older than 7 days are pruned automatically on load, from both the screen and the database.

## Deploying

`npm run build` produces a static production build in `dist/`, deployable to Vercel, Netlify, GitHub Pages, or any static host. Set the same two `VITE_SUPABASE_*` environment variables in your host's dashboard (don't rely on `.env.local` being deployed with the build).

## Known trade-offs (worth revisiting before wider rollout)

- One shared staff password rather than individual accounts — fine for a small team, but there's no way to tell *which* staff member made a change.
- The production JS bundle is ~1.2MB gzipped to ~370KB — works fine, but could be code-split further if load time ever becomes noticeable.
