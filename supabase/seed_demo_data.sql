-- =====================================================================
-- Elarvix Hospital OPD — demo data (patients, bookings, queues, SMS log)
-- Run in Supabase: SQL Editor → New query → paste → Run.
-- Needs schema.sql and some doctors first (seed_doctors.sql).
--
-- Creates, relative to TODAY in India (Asia/Kolkata):
--   • yesterday: a finished day per doctor (5 seen, 1 no-show, 1 cancelled) → Daily report
--   • today:     a live queue per doctor (1 seen, 1 with the doctor, 2 waiting incl. a walk-in,
--                2 booked but not arrived, 1 cancelled)
--   • next 5 days: 2 upcoming bookings per doctor per working day
--   • an SMS log entry for every booking, check-in and cancellation
--
-- Only uses real slots from each doctor's schedule, skips leave days, never touches
-- existing bookings. Demo patients use phone numbers 9000000001–9000000040.
-- Safe to re-run: does nothing if the demo data is already there.
-- To remove it again: supabase/remove_demo_data.sql
-- =====================================================================

-- Helper: free slot start times ('HH:MM') for a doctor on a date, in order.
create or replace function public.ganesh_hospitalopd_demo_free_slots(p_doctor_id bigint, p_date date)
returns text[] language sql stable set search_path = public as $$
  select coalesce(array_agg(slot order by slot), '{}')
  from (
    select distinct to_char(time '00:00' + make_interval(mins => m), 'HH24:MI') as slot
    from ganesh_hospitalopd_schedules s
    join ganesh_hospitalopd_doctors d on d.id = s.doctor_id
    cross join lateral generate_series(
      split_part(s.start_time, ':', 1)::int * 60 + split_part(s.start_time, ':', 2)::int,
      split_part(s.end_time,   ':', 1)::int * 60 + split_part(s.end_time,   ':', 2)::int - d.duration_min,
      d.duration_min) as m
    where s.doctor_id = p_doctor_id
      and s.weekday = extract(dow from p_date)
      and not exists (select 1 from ganesh_hospitalopd_leaves l
                       where l.doctor_id = p_doctor_id and p_date between l.start_date and l.end_date)
  ) x
  where not exists (select 1 from ganesh_hospitalopd_appointments a
                     where a.doctor_id = p_doctor_id and a.date = p_date
                       and a.slot_start = x.slot and a.status <> 'cancelled');
$$;
revoke execute on function public.ganesh_hospitalopd_demo_free_slots(bigint, date) from public, anon, authenticated;

do $$
declare
  tz        constant text := 'Asia/Kolkata';
  v_now     timestamptz := now();
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  names     text[] := array[
    'Rahul Sharma','Sneha Iyer','Mohammed Irfan','Kavya Reddy','Suresh Kumar','Lakshmi Menon','Aditya Verma','Fatima Sheikh',
    'Rohan Das','Meera Pillai','Karthik Rajan','Divya Joshi','Arun Prakash','Pooja Gupta','Sanjay Patil','Nisha Bansal',
    'Vivek Anand','Ayesha Khan','Harish Rao','Priyanka Singh','Manoj Tiwari','Deepa Nair','Imran Qureshi','Swati Kulkarni',
    'Gopal Krishnan','Neha Agarwal','Ravi Teja','Sunita Devi','Abdul Rahman','Anjali Mehta','Kiran Kumar','Farhan Ali',
    'Bhavana Shetty','Naveen Chandra','Rekha Pandey','Siddharth Jain','Uma Maheshwari','Venkat Reddy','Zoya Mirza','Prakash Hegde'];
  ages      int[] := array[34,28,52,7,61,45,19,38,12,67,41,30,55,24,48,5,36,29,63,22,58,44,33,27,70,31,26,49,57,35,40,23,46,39,54,21,60,43,18,50];
  pids      bigint[] := '{}';
  pn        int := 0;
  doc       record;
  slots     text[];
  n         int;
  day       date;
  k         int;
  aid       bigint;
  pid       bigint;
  ph        text;
  t0        timestamptz;
  tok       int;
  sq        int;
  has_serving boolean;
  done_order int[];
  called    timestamptz;
  j         int;
  appt_ids  bigint[];
begin
  if exists (select 1 from ganesh_hospitalopd_patients where phone between '9000000001' and '9000000040') then
    raise notice 'Demo data is already loaded — nothing to do. Run remove_demo_data.sql first to reload it.';
    return;
  end if;
  if not exists (select 1 from ganesh_hospitalopd_doctors) then
    raise exception 'No doctors yet — run seed_doctors.sql (or add doctors in the app) first.';
  end if;

  -- Demo patients
  for k in 1..40 loop
    insert into ganesh_hospitalopd_patients (name, phone, age)
    values (names[k], '90000000' || lpad(k::text, 2, '0'), ages[k])
    returning id into pid;
    pids := pids || pid;
  end loop;

  for doc in select * from ganesh_hospitalopd_doctors order by id loop

    -- ---------------- Yesterday: a finished day ----------------
    day := v_today - 1;
    slots := ganesh_hospitalopd_demo_free_slots(doc.id, day);
    n := least(coalesce(array_length(slots, 1), 0), 7);
    if n >= 3 and not exists (select 1 from ganesh_hospitalopd_queue_entries where doctor_id = doc.id and date = day) then
      t0 := (day + slots[1]::time) at time zone tz;
      appt_ids := '{}';
      for k in 1..n loop
        pn := pn % 40 + 1; pid := pids[pn]; ph := '90000000' || lpad(pn::text, 2, '0');
        insert into ganesh_hospitalopd_appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at, cancelled_at)
        values (doc.id, pid, day, slots[k], 'scheduled',
                case when k = 7 then 'cancelled' else 'booked' end,
                t0 - interval '2 days' + k * interval '7 minutes',
                case when k = 7 then t0 - interval '1 day' end)
        returning id into aid;
        appt_ids := appt_ids || aid;
        insert into ganesh_hospitalopd_notifications (phone, message, created_at)
        values (ph, 'SMS sent to 90xxxxxx' || right(ph, 2) || ': Appointment confirmed with ' || doc.name || ' on ' || day || ' at ' || slots[k] || '.',
                t0 - interval '2 days' + k * interval '7 minutes');
      end loop;
      -- Everyone except the cancelled one checks in; token = arrival order.
      -- The 3rd patient is skipped twice → no-show. The rest are seen in token order.
      done_order := '{}';
      for k in 1..least(n, 6) loop
        if k <> 3 or n < 4 then done_order := done_order || k; end if;
      end loop;
      called := t0;
      for k in 1..least(n, 6) loop
        insert into ganesh_hospitalopd_queue_entries
          (appointment_id, doctor_id, date, token, seq, state, skips, checked_in_at, called_at, served_at)
        values (appt_ids[k], doc.id, day, k,
                case when k = 3 and n >= 4 then 99 else k end,
                case when k = 3 and n >= 4 then 'no_show' else 'done' end,
                case when k = 3 and n >= 4 then 2 else 0 end,
                t0 - interval '15 minutes' + (k - 1) * make_interval(mins => doc.duration_min),
                null, null);
        update ganesh_hospitalopd_appointments
           set status = case when k = 3 and n >= 4 then 'no_show' else 'done' end
         where id = appt_ids[k];
      end loop;
      -- called/served times, one after another
      foreach j in array done_order loop
        update ganesh_hospitalopd_queue_entries
           set called_at = greatest(called, checked_in_at + interval '4 minutes'),
               served_at = greatest(called, checked_in_at + interval '4 minutes') + make_interval(mins => doc.duration_min)
         where appointment_id = appt_ids[j];
        select served_at + interval '2 minutes' into called from ganesh_hospitalopd_queue_entries where appointment_id = appt_ids[j];
      end loop;
      if n = 7 then
        insert into ganesh_hospitalopd_notifications (phone, message, created_at)
        select p.phone, 'SMS sent to 90xxxxxx' || right(p.phone, 2) || ': Your appointment with ' || doc.name || ' on ' || day || ' at ' || a.slot_start || ' is cancelled.', a.cancelled_at
          from ganesh_hospitalopd_appointments a join ganesh_hospitalopd_patients p on p.id = a.patient_id where a.id = appt_ids[7];
      end if;
      insert into ganesh_hospitalopd_queue_days (doctor_id, date, version) values (doc.id, day, 1)
      on conflict (doctor_id, date) do update set version = ganesh_hospitalopd_queue_days.version + 1;
    end if;

    -- ---------------- Today: a live queue ----------------
    day := v_today;
    slots := ganesh_hospitalopd_demo_free_slots(doc.id, day);
    n := least(coalesce(array_length(slots, 1), 0), 6);
    if n >= 3 then
      select coalesce(max(token), 0), coalesce(max(seq), 0), coalesce(bool_or(state = 'serving'), false)
        into tok, sq, has_serving
        from ganesh_hospitalopd_queue_entries where doctor_id = doc.id and date = day;
      appt_ids := '{}';
      for k in 1..n loop
        pn := pn % 40 + 1; pid := pids[pn]; ph := '90000000' || lpad(pn::text, 2, '0');
        insert into ganesh_hospitalopd_appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at, cancelled_at)
        values (doc.id, pid, day, slots[k], 'scheduled',
                case when k <= 3 then 'checked_in' when k = 6 then 'cancelled' else 'booked' end,
                v_now - interval '1 day' + k * interval '5 minutes',
                case when k = 6 then v_now - interval '3 hours' end)
        returning id into aid;
        appt_ids := appt_ids || aid;
        insert into ganesh_hospitalopd_notifications (phone, message, created_at)
        values (ph, 'SMS sent to 90xxxxxx' || right(ph, 2) || ': Appointment confirmed with ' || doc.name || ' on ' || day || ' at ' || slots[k] || '.',
                v_now - interval '1 day' + k * interval '5 minutes');
        if k = 6 then
          insert into ganesh_hospitalopd_notifications (phone, message, created_at)
          values (ph, 'SMS sent to 90xxxxxx' || right(ph, 2) || ': Your appointment with ' || doc.name || ' on ' || day || ' at ' || slots[k] || ' is cancelled.', v_now - interval '3 hours');
        end if;
      end loop;

      -- Walk-in (no slot)
      pn := pn % 40 + 1; pid := pids[pn]; ph := '90000000' || lpad(pn::text, 2, '0');
      insert into ganesh_hospitalopd_appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at)
      values (doc.id, pid, day, null, 'walkin', 'checked_in', v_now - interval '30 minutes')
      returning id into aid;

      -- Queue: #1 seen, #2 with the doctor, #3 waiting, #4 walk-in waiting
      insert into ganesh_hospitalopd_queue_entries (appointment_id, doctor_id, date, token, seq, state, skips, checked_in_at, called_at, served_at) values
        (appt_ids[1], doc.id, day, tok + 1, sq + 1, 'done',    0, v_now - interval '55 minutes', v_now - interval '45 minutes', v_now - interval '28 minutes'),
        (appt_ids[2], doc.id, day, tok + 2, sq + 2, case when has_serving then 'waiting' else 'serving' end,
                                                      0, v_now - interval '48 minutes', case when has_serving then null else v_now - interval '26 minutes' end, null),
        (appt_ids[3], doc.id, day, tok + 3, sq + 3, 'waiting', 0, v_now - interval '40 minutes', null, null),
        (aid,         doc.id, day, tok + 4, sq + 4, 'waiting', 0, v_now - interval '30 minutes', null, null);
      update ganesh_hospitalopd_appointments set status = 'done' where id = appt_ids[1];

      insert into ganesh_hospitalopd_notifications (phone, message, created_at)
      select p.phone, 'SMS sent to 90xxxxxx' || right(p.phone, 2) || ': You are checked in for ' || doc.name || '. Your token is ' || q.token || '.', q.checked_in_at
        from ganesh_hospitalopd_queue_entries q
        join ganesh_hospitalopd_appointments a on a.id = q.appointment_id
        join ganesh_hospitalopd_patients p on p.id = a.patient_id
       where q.doctor_id = doc.id and q.date = day and q.appointment_id in (appt_ids[1], appt_ids[2], appt_ids[3], aid);

      insert into ganesh_hospitalopd_queue_days (doctor_id, date, version) values (doc.id, day, 1)
      on conflict (doctor_id, date) do update set version = ganesh_hospitalopd_queue_days.version + 1;
    end if;

    -- ---------------- Next 5 days: upcoming bookings ----------------
    for j in 1..5 loop
      day := v_today + j;
      slots := ganesh_hospitalopd_demo_free_slots(doc.id, day);
      n := coalesce(array_length(slots, 1), 0);
      if n >= 4 then
        foreach k in array array[2, 4] loop
          pn := pn % 40 + 1; pid := pids[pn]; ph := '90000000' || lpad(pn::text, 2, '0');
          insert into ganesh_hospitalopd_appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at)
          values (doc.id, pid, day, slots[k], 'scheduled', 'booked', v_now - make_interval(mins => 10 * k * j));
          insert into ganesh_hospitalopd_notifications (phone, message, created_at)
          values (ph, 'SMS sent to 90xxxxxx' || right(ph, 2) || ': Appointment confirmed with ' || doc.name || ' on ' || day || ' at ' || slots[k] || '.',
                  v_now - make_interval(mins => 10 * k * j));
        end loop;
      end if;
    end loop;
  end loop;

  raise notice 'Demo data loaded.';
end $$;

drop function public.ganesh_hospitalopd_demo_free_slots(bigint, date);

-- What was loaded, per doctor
select d.name as doctor,
       count(*) filter (where a.date = (now() at time zone 'Asia/Kolkata')::date - 1) as yesterday,
       count(*) filter (where a.date = (now() at time zone 'Asia/Kolkata')::date)     as today,
       count(*) filter (where a.date > (now() at time zone 'Asia/Kolkata')::date)     as upcoming
  from ganesh_hospitalopd_doctors d
  left join ganesh_hospitalopd_appointments a
         on a.doctor_id = d.id
        and a.patient_id in (select id from ganesh_hospitalopd_patients where phone between '9000000001' and '9000000040')
 group by d.id
 order by d.name;
