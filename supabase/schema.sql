-- =====================================================================
-- Elarvix Hospital OPD — Supabase schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Every table, view and function is prefixed with  ganesh_hospitalopd_
-- The script is safe to re-run (it uses IF NOT EXISTS / OR REPLACE).
-- =====================================================================

-- Needed for the "no overlapping leave" exclusion constraint.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.ganesh_hospitalopd_doctors (
  id            bigint generated always as identity primary key,
  name          text    not null check (length(trim(name)) >= 2),
  department    text    not null check (length(trim(department)) >= 1),
  duration_min  integer not null check (duration_min between 5 and 120),
  room          text,
  created_at    timestamptz not null default now()
);
alter table public.ganesh_hospitalopd_doctors enable row level security;

create table if not exists public.ganesh_hospitalopd_schedules (
  id          bigint generated always as identity primary key,
  doctor_id   bigint   not null references public.ganesh_hospitalopd_doctors(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),          -- 0 = Sunday … 6 = Saturday
  start_time  text     not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),  -- 'HH:MM'
  end_time    text     not null check (end_time   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  constraint ganesh_hospitalopd_schedules_order check (end_time > start_time)
);
alter table public.ganesh_hospitalopd_schedules enable row level security;
create index if not exists ganesh_hospitalopd_schedules_doctor_idx on public.ganesh_hospitalopd_schedules (doctor_id);

create table if not exists public.ganesh_hospitalopd_leaves (
  id          bigint generated always as identity primary key,
  doctor_id   bigint not null references public.ganesh_hospitalopd_doctors(id) on delete cascade,
  start_date  date   not null,
  end_date    date   not null,
  reason      text,
  constraint ganesh_hospitalopd_leaves_order check (end_date >= start_date),
  -- A doctor can't have two leave ranges that overlap.
  constraint ganesh_hospitalopd_leaves_no_overlap
    exclude using gist (doctor_id with =, daterange(start_date, end_date, '[]') with &&)
);
alter table public.ganesh_hospitalopd_leaves enable row level security;

create table if not exists public.ganesh_hospitalopd_patients (
  id          bigint generated always as identity primary key,
  name        text    not null,
  phone       text    not null check (phone ~ '^[6-9][0-9]{9}$'),
  age         integer not null check (age between 0 and 120),
  created_at  timestamptz not null default now(),
  constraint ganesh_hospitalopd_patients_phone_name_key unique (phone, name)
);
alter table public.ganesh_hospitalopd_patients enable row level security;
create index if not exists ganesh_hospitalopd_patients_phone_idx on public.ganesh_hospitalopd_patients (phone text_pattern_ops);

create table if not exists public.ganesh_hospitalopd_appointments (
  id            bigint generated always as identity primary key,
  doctor_id     bigint not null references public.ganesh_hospitalopd_doctors(id),
  patient_id    bigint not null references public.ganesh_hospitalopd_patients(id),
  date          date   not null,
  slot_start    text   check (slot_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),   -- NULL for walk-ins
  kind          text   not null default 'scheduled' check (kind in ('scheduled', 'walkin')),
  status        text   not null default 'booked'
                check (status in ('booked', 'checked_in', 'done', 'no_show', 'cancelled')),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  -- Scheduled appointments always have a slot; walk-ins never do.
  constraint ganesh_hospitalopd_appointments_kind_slot check ((kind = 'walkin') = (slot_start is null))
);
alter table public.ganesh_hospitalopd_appointments enable row level security;
-- Last line of defence against double-booking: one live appointment per doctor/date/slot.
-- Cancelled rows are excluded, so cancelling frees the slot immediately.
create unique index if not exists ganesh_hospitalopd_appointments_slot_uniq
  on public.ganesh_hospitalopd_appointments (doctor_id, date, slot_start)
  where status <> 'cancelled' and slot_start is not null;
create index if not exists ganesh_hospitalopd_appointments_date_idx on public.ganesh_hospitalopd_appointments (date, doctor_id);

-- One row per doctor per day. `version` is bumped on every queue change so two screens
-- can't overwrite each other's changes (optimistic locking).
create table if not exists public.ganesh_hospitalopd_queue_days (
  doctor_id  bigint  not null references public.ganesh_hospitalopd_doctors(id) on delete cascade,
  date       date    not null,
  version    integer not null default 0,
  primary key (doctor_id, date)
);
alter table public.ganesh_hospitalopd_queue_days enable row level security;

create table if not exists public.ganesh_hospitalopd_queue_entries (
  id              bigint generated always as identity primary key,
  appointment_id  bigint  not null unique references public.ganesh_hospitalopd_appointments(id) on delete cascade,
  doctor_id       bigint  not null references public.ganesh_hospitalopd_doctors(id),
  date            date    not null,
  token           integer not null check (token > 0),
  seq             integer not null,
  state           text    not null check (state in ('waiting', 'serving', 'done', 'no_show')),
  skips           integer not null default 0 check (skips between 0 and 2),
  checked_in_at   timestamptz not null,
  called_at       timestamptz,
  served_at       timestamptz,
  -- Tokens restart at 1 each day for each doctor.
  constraint ganesh_hospitalopd_queue_entries_token_key unique (doctor_id, date, token)
);
alter table public.ganesh_hospitalopd_queue_entries enable row level security;
create index if not exists ganesh_hospitalopd_queue_entries_day_idx on public.ganesh_hospitalopd_queue_entries (date, doctor_id);

create table if not exists public.ganesh_hospitalopd_notifications (
  id          bigint generated always as identity primary key,
  phone       text not null,
  message     text not null,
  created_at  timestamptz not null default now()
);
alter table public.ganesh_hospitalopd_notifications enable row level security;
create index if not exists ganesh_hospitalopd_notifications_created_idx on public.ganesh_hospitalopd_notifications (created_at desc);

-- ---------------------------------------------------------------------
-- Views (read-only joins used by the API)
-- ---------------------------------------------------------------------

create or replace view public.ganesh_hospitalopd_appointment_details
with (security_invoker = true) as
select a.*,
       p.name  as patient_name,
       p.phone as patient_phone,
       p.age   as patient_age,
       d.name  as doctor_name,
       d.department,
       d.duration_min,
       q.token,
       q.state as queue_state,
       q.skips
from public.ganesh_hospitalopd_appointments a
join public.ganesh_hospitalopd_patients p on p.id = a.patient_id
join public.ganesh_hospitalopd_doctors  d on d.id = a.doctor_id
left join public.ganesh_hospitalopd_queue_entries q on q.appointment_id = a.id;

create or replace view public.ganesh_hospitalopd_queue_details
with (security_invoker = true) as
select q.*,
       p.name  as patient_name,
       p.age   as patient_age,
       p.phone as patient_phone,
       a.kind,
       a.slot_start
from public.ganesh_hospitalopd_queue_entries q
join public.ganesh_hospitalopd_appointments a on a.id = q.appointment_id
join public.ganesh_hospitalopd_patients     p on p.id = a.patient_id;

-- ---------------------------------------------------------------------
-- Functions (called from the API with supabase.rpc — each runs as one transaction)
-- ---------------------------------------------------------------------

-- Create or update a doctor together with their weekly schedule, atomically.
-- p_id NULL = create. p_schedules NULL = leave the schedule unchanged.
create or replace function public.ganesh_hospitalopd_save_doctor(
  p_id bigint, p_name text, p_department text, p_duration_min integer, p_room text, p_schedules jsonb
) returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_id is null then
    insert into ganesh_hospitalopd_doctors (name, department, duration_min, room)
    values (p_name, p_department, p_duration_min, p_room)
    returning id into v_id;
  else
    update ganesh_hospitalopd_doctors
       set name = p_name, department = p_department, duration_min = p_duration_min, room = p_room
     where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'DOCTOR_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  if p_schedules is not null then
    delete from ganesh_hospitalopd_schedules where doctor_id = v_id;
    insert into ganesh_hospitalopd_schedules (doctor_id, weekday, start_time, end_time)
    select v_id, (s->>'weekday')::smallint, s->>'start_time', s->>'end_time'
      from jsonb_array_elements(p_schedules) as s;
  end if;

  return v_id;
end;
$$;

-- Apply queue changes computed by the app's queue state machine, atomically.
-- Fails with SQLSTATE 40001 if someone else changed this doctor's queue since it was read
-- (p_version no longer matches), so two screens can't both press "Done" on the same patient.
create or replace function public.ganesh_hospitalopd_apply_queue(
  p_doctor_id bigint, p_date date, p_version integer, p_entries jsonb, p_appointment_updates jsonb
) returns integer
language plpgsql
set search_path = public
as $$
declare
  v_version integer;
  e jsonb;
  u jsonb;
begin
  insert into ganesh_hospitalopd_queue_days (doctor_id, date) values (p_doctor_id, p_date)
  on conflict (doctor_id, date) do nothing;

  select version into v_version
    from ganesh_hospitalopd_queue_days
   where doctor_id = p_doctor_id and date = p_date
     for update;

  if v_version <> p_version then
    raise exception 'QUEUE_CONFLICT' using errcode = '40001';
  end if;

  for e in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if (e->>'id') is null then
      insert into ganesh_hospitalopd_queue_entries
        (appointment_id, doctor_id, date, token, seq, state, skips, checked_in_at, called_at, served_at)
      values
        ((e->>'appointment_id')::bigint, p_doctor_id, p_date, (e->>'token')::int, (e->>'seq')::int, e->>'state',
         (e->>'skips')::int, (e->>'checked_in_at')::timestamptz, (e->>'called_at')::timestamptz, (e->>'served_at')::timestamptz);
    else
      update ganesh_hospitalopd_queue_entries
         set token = (e->>'token')::int,
             seq = (e->>'seq')::int,
             state = e->>'state',
             skips = (e->>'skips')::int,
             checked_in_at = (e->>'checked_in_at')::timestamptz,
             called_at = (e->>'called_at')::timestamptz,
             served_at = (e->>'served_at')::timestamptz
       where id = (e->>'id')::bigint and doctor_id = p_doctor_id and date = p_date;
    end if;
  end loop;

  for u in select value from jsonb_array_elements(coalesce(p_appointment_updates, '[]'::jsonb)) loop
    update ganesh_hospitalopd_appointments set status = u->>'status' where id = (u->>'id')::bigint;
  end loop;

  update ganesh_hospitalopd_queue_days set version = version + 1
   where doctor_id = p_doctor_id and date = p_date;

  return v_version + 1;
end;
$$;

-- ---------------------------------------------------------------------
-- Security: the browser never talks to Supabase directly. Only the API (using the
-- secret / service_role key, which bypasses RLS) can read or write.
-- RLS is enabled on every table above with no policies, so the public anon key gets nothing.
-- ---------------------------------------------------------------------

revoke execute on function public.ganesh_hospitalopd_save_doctor(bigint, text, text, integer, text, jsonb) from public, anon, authenticated;
revoke execute on function public.ganesh_hospitalopd_apply_queue(bigint, date, integer, jsonb, jsonb)      from public, anon, authenticated;
grant  execute on function public.ganesh_hospitalopd_save_doctor(bigint, text, text, integer, text, jsonb) to service_role;
grant  execute on function public.ganesh_hospitalopd_apply_queue(bigint, date, integer, jsonb, jsonb)      to service_role;

-- Belt and braces: the public keys get no table or view privileges at all.
revoke all on
  public.ganesh_hospitalopd_doctors, public.ganesh_hospitalopd_schedules, public.ganesh_hospitalopd_leaves,
  public.ganesh_hospitalopd_patients, public.ganesh_hospitalopd_appointments, public.ganesh_hospitalopd_queue_days,
  public.ganesh_hospitalopd_queue_entries, public.ganesh_hospitalopd_notifications,
  public.ganesh_hospitalopd_appointment_details, public.ganesh_hospitalopd_queue_details
from anon, authenticated;
