'use strict';

const { createServices } = require('./services');
const { addDays, localDate, zonedTimeToDate } = require('./core/time');

const DOCTORS = [
  {
    name: 'Dr. Ananya Rao',
    department: 'Cardiology',
    duration_min: 15,
    room: '101',
    // The example from the brief: Mon/Wed/Fri 10–13, Tue/Thu 16–19
    schedules: [
      ...[1, 3, 5].map((weekday) => ({ weekday, start_time: '10:00', end_time: '13:00' })),
      ...[2, 4].map((weekday) => ({ weekday, start_time: '16:00', end_time: '19:00' })),
    ],
  },
  {
    name: 'Dr. Vikram Mehta',
    department: 'Orthopedics',
    duration_min: 20,
    room: '204',
    schedules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '09:00', end_time: '12:00' })),
  },
  {
    name: 'Dr. Priya Nair',
    department: 'Pediatrics',
    duration_min: 10,
    room: '112',
    // Two blocks on the same day (split shift)
    schedules: [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, start_time: '09:00', end_time: '11:00' },
      { weekday, start_time: '17:00', end_time: '19:00' },
    ]),
  },
  {
    name: 'Dr. Arjun Singh',
    department: 'Dermatology',
    duration_min: 30,
    room: '310',
    schedules: [
      { weekday: 0, start_time: '10:00', end_time: '14:00' },
      { weekday: 3, start_time: '15:00', end_time: '18:00' },
      { weekday: 6, start_time: '10:00', end_time: '14:00' },
    ],
  },
];

const PATIENTS = [
  ['Rahul Sharma', 34], ['Sneha Iyer', 28], ['Mohammed Irfan', 52], ['Kavya Reddy', 7],
  ['Suresh Kumar', 61], ['Lakshmi Menon', 45], ['Aditya Verma', 19], ['Fatima Sheikh', 38],
  ['Rohan Das', 12], ['Meera Pillai', 67], ['Karthik Rajan', 41], ['Divya Joshi', 30],
  ['Arun Prakash', 55], ['Pooja Gupta', 24], ['Sanjay Patil', 48], ['Nisha Bansal', 5],
];

/** Load demo data relative to today. Does nothing if doctors already exist. */
async function seedDemo(repo, { timeZone } = {}) {
  if ((await repo.listDoctors()).length > 0) return false;

  const realNow = new Date();
  let clock = realNow;
  const svc = createServices(repo, { now: () => clock, timeZone });
  const at = (date, hhmm) => zonedTimeToDate(date, hhmm, timeZone);
  const plus = (date, mins) => new Date(date.getTime() + mins * 60000);

  const doctors = [];
  for (const d of DOCTORS) doctors.push(await svc.createDoctor(d));
  const today = localDate(realNow, timeZone);
  const yesterday = addDays(today, -1);

  // Leaves: Dr. Arjun is off tomorrow, Dr. Vikram takes a 3-day break next week
  await svc.addLeave(doctors[3].id, { start_date: addDays(today, 1), reason: 'Conference' });
  await svc.addLeave(doctors[1].id, { start_date: addDays(today, 7), end_date: addDays(today, 9), reason: 'Personal' });

  let p = 0;
  const nextPatient = () => {
    const [name, age] = PATIENTS[p % PATIENTS.length];
    const phone = String(9000000000 + ((p * 7919 + 1234567) % 999999999)).slice(0, 10);
    p++;
    return { name, age, phone };
  };

  const bookFirstSlots = async (doctor, date, n) => {
    clock = at(date, '00:01');
    const slots = (await svc.getSlots(doctor.id, date)).slots.filter((s) => s.status === 'available').slice(0, n);
    const out = [];
    for (const s of slots) out.push(await svc.bookAppointment({ doctorId: doctor.id, date, slot: s.start, patient: nextPatient() }));
    return out;
  };

  for (const doctor of doctors) {
    // Yesterday: a finished day so the daily report has history
    const past = await bookFirstSlots(doctor, yesterday, 6);
    if (past.length === 6) {
      const firstSlot = at(yesterday, past[0].slot_start);
      for (const [i, a] of past.entries()) {
        clock = plus(firstSlot, -15 + i * 4);
        await svc.checkIn(a.id);
      }
      clock = firstSlot;
      await svc.callNext(doctor.id);
      // token 3 is skipped (sent to the back), called again at the end, skipped again -> no-show
      for (const action of ['markDone', 'markDone', 'skip', 'markDone', 'markDone', 'markDone', 'skip']) {
        clock = plus(clock, doctor.duration_min + (action === 'skip' ? -doctor.duration_min + 2 : 3));
        try { await svc[action](doctor.id); } catch { /* queue ran out early */ }
      }
    }

    // Today: some patients checked in, one being seen, a walk-in, and a few still to arrive
    const todays = await bookFirstSlots(doctor, today, 5);
    if (todays.length === 5) {
      for (const [i, a] of todays.slice(0, 3).entries()) {
        clock = plus(realNow, -50 + i * 5);
        await svc.checkIn(a.id);
      }
      clock = plus(realNow, -30);
      await svc.addWalkIn({ doctorId: doctor.id, patient: nextPatient() });
      clock = plus(realNow, -25);
      await svc.callNext(doctor.id);
      clock = plus(realNow, -8);
      await svc.markDone(doctor.id);
    }

    // Tomorrow: a couple of advance bookings
    await bookFirstSlots(doctor, addDays(today, 1), 2);
  }
  return true;
}

module.exports = { seedDemo };
