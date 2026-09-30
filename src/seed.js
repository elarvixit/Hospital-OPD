'use strict';

const { createServices } = require('./services');
const { addDays, localDate, toMinutes } = require('./core/time');

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

function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM doctors').get().n > 0) return false;

  const realNow = new Date();
  let clock = realNow;
  const svc = createServices(db, { now: () => clock });
  const at = (date, hhmm) => {
    const [y, m, d] = date.split('-').map(Number);
    const mins = toMinutes(hhmm);
    return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  };
  const plus = (date, mins) => new Date(date.getTime() + mins * 60000);

  const doctors = DOCTORS.map((d) => svc.createDoctor(d));
  const today = localDate(realNow);
  const yesterday = addDays(today, -1);

  // Leaves: Dr. Arjun is off tomorrow, Dr. Vikram takes a 3-day break next week
  svc.addLeave(doctors[3].id, { start_date: addDays(today, 1), reason: 'Conference' });
  svc.addLeave(doctors[1].id, { start_date: addDays(today, 7), end_date: addDays(today, 9), reason: 'Personal' });

  let p = 0;
  const nextPatient = () => {
    const [name, age] = PATIENTS[p % PATIENTS.length];
    const phone = String(9000000000 + ((p * 7919 + 1234567) % 999999999)).slice(0, 10);
    p++;
    return { name, age, phone };
  };

  const bookFirstSlots = (doctor, date, n) => {
    clock = at(date, '00:01');
    const slots = svc.getSlots(doctor.id, date).slots.filter((s) => s.status === 'available').slice(0, n);
    return slots.map((s) => svc.bookAppointment({ doctorId: doctor.id, date, slot: s.start, patient: nextPatient() }));
  };

  for (const doctor of doctors) {
    // Yesterday: a finished day so the daily report has history
    const past = bookFirstSlots(doctor, yesterday, 6);
    if (past.length === 6) {
      const firstSlot = at(yesterday, past[0].slot_start);
      past.forEach((a, i) => {
        clock = plus(firstSlot, -15 + i * 4);
        svc.checkIn(a.id);
      });
      clock = firstSlot;
      svc.callNext(doctor.id);
      // token 3 is skipped (sent to the back), called again at the end, skipped again -> no-show
      for (const action of ['markDone', 'markDone', 'skip', 'markDone', 'markDone', 'markDone', 'skip']) {
        clock = plus(clock, doctor.duration_min + (action === 'skip' ? -doctor.duration_min + 2 : 3));
        try { svc[action](doctor.id); } catch { /* queue ran out early */ }
      }
    }

    // Today: some patients checked in, one being seen, a walk-in, and a few still to arrive
    const todays = bookFirstSlots(doctor, today, 5);
    if (todays.length === 5) {
      todays.slice(0, 3).forEach((a, i) => {
        clock = plus(realNow, -50 + i * 5);
        svc.checkIn(a.id);
      });
      clock = plus(realNow, -30);
      svc.addWalkIn({ doctorId: doctor.id, patient: nextPatient() });
      clock = plus(realNow, -25);
      svc.callNext(doctor.id);
      clock = plus(realNow, -8);
      svc.markDone(doctor.id);
    }

    // Tomorrow: a couple of advance bookings
    bookFirstSlots(doctor, addDays(today, 1), 2);
  }
  return true;
}

module.exports = { seedIfEmpty };
