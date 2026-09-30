-- =====================================================================
-- Elarvix Hospital OPD — dummy doctors
-- Run in Supabase: SQL Editor → New query → paste → Run  (after schema.sql).
-- Safe to re-run: doctors that already exist (same name) are skipped.
-- Weekdays: 0 = Sunday, 1 = Monday … 6 = Saturday. Times are 24-hour 'HH:MM'.
-- =====================================================================

do $$
declare
  d record;
begin
  for d in
    select * from (values
      ('Dr. Ananya Rao', 'Cardiology', 15, '101',
       '[{"weekday":1,"start_time":"10:00","end_time":"13:00"},
         {"weekday":3,"start_time":"10:00","end_time":"13:00"},
         {"weekday":5,"start_time":"10:00","end_time":"13:00"},
         {"weekday":2,"start_time":"16:00","end_time":"19:00"},
         {"weekday":4,"start_time":"16:00","end_time":"19:00"}]'),

      ('Dr. Vikram Mehta', 'Orthopedics', 20, '204',
       '[{"weekday":1,"start_time":"09:00","end_time":"12:00"},
         {"weekday":2,"start_time":"09:00","end_time":"12:00"},
         {"weekday":3,"start_time":"09:00","end_time":"12:00"},
         {"weekday":4,"start_time":"09:00","end_time":"12:00"},
         {"weekday":5,"start_time":"09:00","end_time":"12:00"},
         {"weekday":6,"start_time":"09:00","end_time":"12:00"}]'),

      ('Dr. Priya Nair', 'Pediatrics', 10, '112',
       '[{"weekday":1,"start_time":"09:00","end_time":"11:00"},{"weekday":1,"start_time":"17:00","end_time":"19:00"},
         {"weekday":2,"start_time":"09:00","end_time":"11:00"},{"weekday":2,"start_time":"17:00","end_time":"19:00"},
         {"weekday":3,"start_time":"09:00","end_time":"11:00"},{"weekday":3,"start_time":"17:00","end_time":"19:00"},
         {"weekday":4,"start_time":"09:00","end_time":"11:00"},{"weekday":4,"start_time":"17:00","end_time":"19:00"},
         {"weekday":5,"start_time":"09:00","end_time":"11:00"},{"weekday":5,"start_time":"17:00","end_time":"19:00"}]'),

      ('Dr. Arjun Singh', 'Dermatology', 30, '310',
       '[{"weekday":0,"start_time":"10:00","end_time":"14:00"},
         {"weekday":3,"start_time":"15:00","end_time":"18:00"},
         {"weekday":6,"start_time":"10:00","end_time":"14:00"}]'),

      -- Works every day, including evenings — handy for testing at any time.
      ('Dr. Kavitha Iyer', 'General Medicine', 15, '105',
       '[{"weekday":0,"start_time":"10:00","end_time":"13:00"},
         {"weekday":1,"start_time":"09:00","end_time":"13:00"},{"weekday":1,"start_time":"16:00","end_time":"21:00"},
         {"weekday":2,"start_time":"09:00","end_time":"13:00"},{"weekday":2,"start_time":"16:00","end_time":"21:00"},
         {"weekday":3,"start_time":"09:00","end_time":"13:00"},{"weekday":3,"start_time":"16:00","end_time":"21:00"},
         {"weekday":4,"start_time":"09:00","end_time":"13:00"},{"weekday":4,"start_time":"16:00","end_time":"21:00"},
         {"weekday":5,"start_time":"09:00","end_time":"13:00"},{"weekday":5,"start_time":"16:00","end_time":"21:00"},
         {"weekday":6,"start_time":"09:00","end_time":"13:00"},{"weekday":6,"start_time":"16:00","end_time":"21:00"}]'),

      ('Dr. Rahul Verma', 'ENT', 20, '208',
       '[{"weekday":1,"start_time":"15:00","end_time":"18:00"},
         {"weekday":2,"start_time":"11:00","end_time":"14:00"},
         {"weekday":3,"start_time":"15:00","end_time":"18:00"},
         {"weekday":4,"start_time":"11:00","end_time":"14:00"},
         {"weekday":5,"start_time":"15:00","end_time":"18:00"},
         {"weekday":6,"start_time":"11:00","end_time":"14:00"}]'),

      ('Dr. Sneha Kulkarni', 'Gynecology', 20, '215',
       '[{"weekday":1,"start_time":"10:00","end_time":"14:00"},
         {"weekday":3,"start_time":"10:00","end_time":"14:00"},
         {"weekday":5,"start_time":"10:00","end_time":"14:00"},
         {"weekday":6,"start_time":"16:00","end_time":"19:00"}]'),

      ('Dr. Mohammed Faisal', 'Neurology', 30, '320',
       '[{"weekday":2,"start_time":"10:00","end_time":"13:00"},
         {"weekday":4,"start_time":"10:00","end_time":"13:00"},
         {"weekday":3,"start_time":"17:00","end_time":"20:00"}]')
    ) as t(name, department, duration_min, room, schedules)
  loop
    if not exists (select 1 from ganesh_hospitalopd_doctors where lower(name) = lower(d.name)) then
      perform ganesh_hospitalopd_save_doctor(null, d.name, d.department, d.duration_min, d.room, d.schedules::jsonb);
    end if;
  end loop;
end $$;

-- A few leave days so the "on leave" rules can be tried out.
insert into ganesh_hospitalopd_leaves (doctor_id, start_date, end_date, reason)
select id, current_date + 1, current_date + 1, 'Conference'
  from ganesh_hospitalopd_doctors d
 where d.name = 'Dr. Arjun Singh'
   and not exists (select 1 from ganesh_hospitalopd_leaves l where l.doctor_id = d.id);

insert into ganesh_hospitalopd_leaves (doctor_id, start_date, end_date, reason)
select id, current_date + 7, current_date + 9, 'Personal'
  from ganesh_hospitalopd_doctors d
 where d.name = 'Dr. Vikram Mehta'
   and not exists (select 1 from ganesh_hospitalopd_leaves l where l.doctor_id = d.id);

-- Show what's there now.
select d.name, d.department, d.duration_min as minutes, d.room,
       count(s.id) as schedule_blocks
  from ganesh_hospitalopd_doctors d
  left join ganesh_hospitalopd_schedules s on s.doctor_id = d.id
 group by d.id
 order by d.name;
