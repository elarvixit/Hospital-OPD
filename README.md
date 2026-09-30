# Elarvix OPD — Queue & Appointments

An outpatient department system: the front desk books slots with doctors, checks patients in, and runs a live token queue. Doctors see their own queue and mark patients done.

**Stack:** Node.js 22.9+ · Express · **Supabase (Postgres)** · vanilla HTML/CSS/JS · `node:test` · deployable on **Vercel**.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # 84 tests (no database needed)
```

With no `.env` file, `npm start` uses an **in-memory database with demo data**. That's handy for a quick demo, but the data is lost on restart. To use Supabase locally, copy `.env.example` to `.env` and fill in the values.

- **Main app:** http://localhost:3000. Use the dropdown at the top right to switch between **Front desk** and **Doctor**.
- **Waiting-area screen:** http://localhost:3000/display.html. It refreshes every 10 s and chimes when a token changes. It shows token numbers only, never patient names.

## Deploy: Supabase + Vercel

1. **Supabase:** Dashboard → **SQL Editor** → New query → paste [supabase/schema.sql](supabase/schema.sql) → **Run**. It's safe to run again later.
   All tables, views and functions are prefixed `ganesh_hospitalopd_`.
2. **Vercel:** import the GitHub repo (Framework preset: *Other*; no build command needed; `vercel.json` sets everything). Add these under **Project → Settings → Environment Variables**:

   | Name | Value | Where to find it |
   |---|---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Supabase → Project Settings → API (or Data API) → Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key (or the new **secret** key, `sb_secret_…`) | Supabase → Project Settings → API Keys |
   | `APP_TIMEZONE` | `Asia/Kolkata` | The hospital's timezone. Vercel servers run on UTC, so this decides what "today" and "past slot" mean |

   Redeploy after adding them.
3. **Demo data (optional):** with the same values in a local `.env`, run `npm run seed`. This adds 4 doctors plus bookings and queues relative to today. It does nothing if doctors already exist.

**Security:** the browser only ever calls this app's `/api`, never Supabase directly. The service-role key stays on the server. RLS is enabled on every table with no policies, and the public `anon` key has no privileges, so a leaked anon key can't read patient data. Never put the service-role key in frontend code or give it a `NEXT_PUBLIC_`/`VITE_` style prefix.

## Features

| Requirement | Where |
|---|---|
| Doctors: department, duration, weekly schedule, leaves | **Doctors** tab (add/edit, schedule builder, add/remove leave) |
| Slot generation | `src/core/slots.js`, a pure function |
| Book, refuse double-booking, walk-ins | **Book** tab |
| Check-in → token per doctor per day | **Appointments** tab → *Check in* |
| Live queue: Now serving / Next / Waiting | **Live queue** (desk), **My queue** (doctor) |
| No-show handling | *Skip* button; state machine in `src/core/queue.js` |
| Daily report | **Daily report** tab |
| Stretch: auto-refreshing waiting screen (10 s) | `display.html`; the queue tabs also poll every 10 s |
| Stretch: notification log | **SMS log** tab: `SMS sent to 98xxxxxx10: …` |
| Stretch: reschedule with next 3 free slots | **Appointments** → *Reschedule* |

## Project layout

```
api/index.js         Vercel serverless entry (all /api/* requests)
src/
  core/time.js       date/time helpers, timezone-aware ('YYYY-MM-DD' dates, 'HH:MM' times)
  core/slots.js      slot generation — pure, no DB
  core/queue.js      queue state machine — pure, no DB
  services.js        business rules (validation, booking, check-in, reports…)
  repo/supabase.js   data access via supabase-js (tables, views, RPC functions)
  repo/memory.js     same interface + same constraints, in memory (tests & local demo)
  app.js             Express routes          server.js   local dev server
  seed.js            demo data               scripts/seed.js   npm run seed → Supabase
supabase/schema.sql  run once in the Supabase SQL editor
public/              frontend (index.html, app.js, styles.css, display.html)
test/                slots.test.js, queue.test.js, services.test.js
```

The two core modules are pure functions that take `now` as a parameter. That makes the tricky logic testable without a database or a real clock. `services.js` takes a repository and an injectable clock, so the integration tests run against the in-memory repository. That repository enforces the same constraints as the Postgres schema.

### Consistency without transactions in the client

supabase-js can't run multi-statement transactions, so the operations that must be atomic are Postgres functions called with `rpc`:

- `ganesh_hospitalopd_save_doctor` saves a doctor and replaces their weekly schedule in one step.
- `ganesh_hospitalopd_apply_queue` writes the queue changes computed by `core/queue.js` in one step, using **optimistic locking**. Each doctor-day has a `version` in `queue_days`. If another screen changed the queue since it was read, the call fails with SQLSTATE 40001 and the API returns 409.
  - Check-ins retry automatically, so the second person simply gets the next token.
  - Done/Skip do **not** retry. Two screens pressing Done at the same moment advance the queue only once.

Double-booking and overlapping leave are stopped by database constraints (a partial unique index and an exclusion constraint), not just by application checks.

## Slot generation rules

For a doctor and a date:

1. Take that weekday's schedule blocks. **Merge any that overlap or touch**, so a split shift or `10:00–12:00` + `12:00–13:00` gives one continuous grid with no duplicate slots.
2. Step through each block in `duration` increments. **Only whole slots count.** A 10:00–10:50 block at 15 min gives 10:00, 10:15, 10:30. It does not give 10:45.
3. **A leave day returns no slots at all.** Leave is stored as an inclusive `start_date..end_date` range.
4. A slot is **booked** if it overlaps any non-cancelled appointment. The check is overlap, not an exact start-time match. So if a doctor's duration changes from 15 to 20 min, an existing 10:15 booking still blocks both 10:00 and 10:20.
5. A slot is **past** if its date is before today, or if it is today and it has already started. A slot starting at exactly *now* counts as past.

Weekdays are worked out from the date string using UTC, so timezone and DST changes can't shift a Monday to a Sunday.

## Queue state machine (one doctor, one day)

```
            callNext               done
 waiting ─────────────► serving ─────────► done
    ▲                      │
    │  1st skip: to end    │ 2nd skip
    └──────────────────────┘ ─────────────► no_show
```

- The **token** is assigned at check-in: `max(token) + 1` for that doctor on that date. It **restarts at 1** each day for each doctor, and the DB enforces `UNIQUE(doctor_id, date, token)`.
- Line order uses a separate `seq` field, so a skipped patient **keeps their token number** but moves to the back of the line. Patients who arrive after the skip queue up behind them.
- **Done** marks the current patient done and calls the next one. **Skip** does the same, but it never instantly re-calls the patient who was just skipped. If they're the only one left, the doctor presses *Call next* when ready.
- Tokens follow **arrival order**, not slot order. Whoever checks in first gets the lower token.

## Other business rules

- Past dates, earlier slots today, leave days, non-working days and off-grid times (e.g. `10:07`) are all refused.
- Double-booking is checked in code **and** by a partial unique index in Postgres: `UNIQUE(doctor_id, date, slot_start) WHERE status <> 'cancelled'`. Because cancelled rows are excluded from that index, **cancelling frees the slot immediately**.
- Check-in is only allowed on the appointment day, and only for `booked` appointments. It is refused if the doctor has since gone on leave.
- Adding a leave returns the booked appointments that fall inside it, so the desk can reschedule them.
- Walk-ins get no slot and go straight into today's queue. They are refused on a leave day.
- Schedule validation: end must be after start (overnight shifts aren't supported), a block must fit at least one consultation, and blocks on the same day can't overlap.
- **Average wait** = time from check-in until the patient is called in. It is averaged only over patients who were actually seen.

## API (summary)

```
GET  /api/doctors                     POST /api/doctors            PUT /api/doctors/:id
POST /api/doctors/:id/leaves          DELETE /api/leaves/:id
GET  /api/doctors/:id/slots?date=     GET  /api/doctors/:id/next-free?count=3
GET  /api/appointments?date=&doctorId=
POST /api/appointments                POST /api/walkins
POST /api/appointments/:id/checkin    /cancel    /reschedule
GET  /api/queue                       GET  /api/doctors/:id/queue
POST /api/doctors/:id/queue/next      /done      /skip
GET  /api/reports/daily?date=         GET  /api/notifications
```

Errors come back as `{ "error": "message" }` with 400 (invalid), 404 (not found) or 409 (conflict, e.g. a double booking).

## UI touches

Staggered card entrances, hover lifts, ripple on button press, a sliding tab indicator, slot chips that pop in, a pulsing "Now serving" card with a flip animation when the token changes, animated toasts and modals, count-up report numbers, animated progress bars, loading skeletons, and an animated ECG logo. All motion is turned off when the OS "reduce motion" setting is on.

## Not done (out of scope)

Login is replaced by the role dropdown, as the brief allows for the core version. SMS messages are logged, not actually sent. There is one timezone for the whole hospital (`APP_TIMEZONE`).
