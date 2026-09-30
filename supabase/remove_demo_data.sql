-- =====================================================================
-- Elarvix Hospital OPD — remove the demo data loaded by seed_demo_data.sql
-- Deletes ONLY demo patients (phones 9000000001–9000000040), their bookings,
-- queue entries and SMS log lines. Doctors and your own bookings stay.
-- =====================================================================

delete from ganesh_hospitalopd_notifications
 where phone between '9000000001' and '9000000040';

delete from ganesh_hospitalopd_queue_entries
 where appointment_id in (
   select a.id from ganesh_hospitalopd_appointments a
     join ganesh_hospitalopd_patients p on p.id = a.patient_id
    where p.phone between '9000000001' and '9000000040');

delete from ganesh_hospitalopd_appointments
 where patient_id in (select id from ganesh_hospitalopd_patients where phone between '9000000001' and '9000000040');

delete from ganesh_hospitalopd_patients
 where phone between '9000000001' and '9000000040';

select 'Demo data removed' as result;
