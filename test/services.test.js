'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createServices, maskPhone } = require('../src/services');

// Monday 2026-10-05, 09:00 local time
const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';

let svc, db, clock, drA, drB;
const setClock = (date, hhmm = '09:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  clock = new Date(y, m - 1, d, h, min);
};
const patient = (n = 1) => ({ name: `Patient ${n}`, phone: `98765432${String(n).padStart(2, '0')}`, age: 30 + n });
const book = (slot, n = 1, date = MON, doctor = drA) => svc.bookAppointment({ doctorId: doctor.id, date, slot, patient: patient(n) });
const status = (err) => (e) => e.status === err;

beforeEach(() => {
  db = openDb(':memory:');
  setClock(MON);
  svc = createServices(db, { now: () => clock });
  drA = svc.createDoctor({
    name: 'Dr. A',
    department: 'Cardiology',
    duration_min: 15,
    schedules: [
      ...[1, 3, 5].map((weekday) => ({ weekday, start_time: '10:00', end_time: '13:00' })),
      ...[2, 4].map((weekday) => ({ weekday, start_time: '16:00', end_time: '19:00' })),
    ],
  });
  drB = svc.createDoctor({
    name: 'Dr. B',
    department: 'Pediatrics',
    duration_min: 10,
    schedules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: '09:00', end_time: '11:00' })),
  });
});

describe('booking', () => {
  test('booking a free slot succeeds and the slot shows as booked', () => {
    const a = book('10:15');
    assert.equal(a.status, 'booked');
    assert.equal(a.slot_start, '10:15');
    const slot = svc.getSlots(drA.id, MON).slots.find((s) => s.start === '10:15');
    assert.equal(slot.status, 'booked');
  });

  test('double-booking the same slot is refused with 409', () => {
    book('10:15', 1);
    assert.throws(() => book('10:15', 2), status(409));
  });

  test('the same time with a different doctor is fine', () => {
    book('10:00', 1, MON, drA);
    assert.doesNotThrow(() => book('10:00', 2, MON, drB));
  });

  test('the database itself refuses a duplicate live slot', () => {
    const a = book('10:15', 1);
    assert.throws(
      () => db.prepare("INSERT INTO appointments (doctor_id, patient_id, date, slot_start, status, created_at) VALUES (?, ?, ?, ?, 'booked', 'x')").run(drA.id, a.patient_id, MON, '10:15'),
      /UNIQUE/
    );
  });

  test('cannot book a past date', () => {
    assert.throws(() => book('10:00', 1, '2026-10-02'), /past/);
  });

  test('cannot book a slot earlier today that has already started', () => {
    setClock(MON, '10:20');
    assert.throws(() => book('10:15'), /past/);
    assert.doesNotThrow(() => book('10:30'));
  });

  test('cannot book on a leave day', () => {
    svc.addLeave(drA.id, { start_date: WED, end_date: WED });
    assert.throws(() => book('10:00', 1, WED), /leave/);
  });

  test('cannot book outside the schedule or off the slot grid', () => {
    assert.throws(() => book('14:00'), /not a valid slot/); // after hours
    assert.throws(() => book('10:07'), /not a valid slot/); // off-grid
    assert.throws(() => book('16:00'), /not a valid slot/); // that's Tuesday's block
  });

  test('patient details are validated', () => {
    const base = { doctorId: drA.id, date: MON, slot: '10:00' };
    assert.throws(() => svc.bookAppointment({ ...base, patient: { name: 'X', phone: '9876543210', age: 5 } }), /name/);
    assert.throws(() => svc.bookAppointment({ ...base, patient: { name: 'Asha', phone: '12345', age: 5 } }), /Phone/);
    assert.throws(() => svc.bookAppointment({ ...base, patient: { name: 'Asha', phone: '9876543210', age: 150 } }), /Age/);
  });

  test('returning patients (same name + phone) are reused', () => {
    const a = book('10:00', 1);
    const b = book('10:15', 1);
    assert.equal(a.patient_id, b.patient_id);
  });
});

describe('cancel & reschedule', () => {
  test('cancelling frees the slot immediately', () => {
    const a = book('10:15', 1);
    svc.cancelAppointment(a.id);
    assert.equal(svc.getSlots(drA.id, MON).slots.find((s) => s.start === '10:15').status, 'available');
    assert.doesNotThrow(() => book('10:15', 2));
  });

  test('cannot cancel twice or cancel a checked-in patient', () => {
    const a = book('10:15', 1);
    svc.cancelAppointment(a.id);
    assert.throws(() => svc.cancelAppointment(a.id), status(409));
    const b = book('10:30', 2);
    svc.checkIn(b.id);
    assert.throws(() => svc.cancelAppointment(b.id), status(409));
  });

  test('next three free slots skip booked slots, leave days and past times', () => {
    setClock(MON, '12:20');
    book('12:30', 1);
    svc.addLeave(drA.id, { start_date: TUE, end_date: TUE });
    const next = svc.nextFreeSlots(drA.id);
    assert.deepEqual(next.map((s) => `${s.date} ${s.start}`), [
      `${MON} 12:45`, // 12:30 is booked, 12:15 already started
      `${WED} 10:00`, // Tuesday is leave
      `${WED} 10:15`,
    ]);
  });

  test('reschedule moves the appointment and frees the old slot', () => {
    const a = book('10:15', 1);
    const moved = svc.reschedule(a.id, { date: WED, slot: '11:00' });
    assert.equal(moved.date, WED);
    assert.equal(moved.slot_start, '11:00');
    assert.equal(svc.getSlots(drA.id, MON).slots.find((s) => s.start === '10:15').status, 'available');
    assert.equal(svc.getSlots(drA.id, WED).slots.find((s) => s.start === '11:00').status, 'booked');
  });

  test('reschedule into a taken slot is refused and nothing changes', () => {
    const a = book('10:15', 1);
    book('10:30', 2);
    assert.throws(() => svc.reschedule(a.id, { date: MON, slot: '10:30' }), status(409));
    assert.equal(svc.getAppointment(a.id).slot_start, '10:15');
  });
});

describe('walk-ins & check-in', () => {
  test('walk-ins join today\'s queue without a slot', () => {
    const w = svc.addWalkIn({ doctorId: drA.id, patient: patient(1) });
    assert.equal(w.kind, 'walkin');
    assert.equal(w.slot_start, null);
    assert.equal(w.token, 1);
    assert.equal(svc.getQueue(drA.id).next.token, 1);
  });

  test('walk-ins are refused on a leave day', () => {
    svc.addLeave(drA.id, { start_date: MON });
    assert.throws(() => svc.addWalkIn({ doctorId: drA.id, patient: patient(1) }), /leave/);
  });

  test('check-in hands out tokens in arrival order, not slot order', () => {
    const late = book('12:00', 1);
    const early = book('10:00', 2);
    assert.equal(svc.checkIn(late.id).token, 1);
    assert.equal(svc.checkIn(early.id).token, 2);
    const w = svc.addWalkIn({ doctorId: drA.id, patient: patient(3) });
    assert.equal(w.token, 3);
  });

  test('check-in only on the appointment day', () => {
    const a = book('10:00', 1, WED);
    assert.throws(() => svc.checkIn(a.id), /appointment day/);
    setClock(WED);
    assert.equal(svc.checkIn(a.id).token, 1);
  });

  test('cannot check in twice or check in a cancelled appointment', () => {
    const a = book('10:00', 1);
    svc.checkIn(a.id);
    assert.throws(() => svc.checkIn(a.id), status(409));
    const b = book('10:15', 2);
    svc.cancelAppointment(b.id);
    assert.throws(() => svc.checkIn(b.id), /cancelled/);
  });

  test('tokens restart at 1 each day and are separate per doctor', () => {
    const a1 = book('10:00', 1);
    const a2 = book('10:15', 2);
    const b1 = book('09:30', 3, MON, drB);
    assert.equal(svc.checkIn(a1.id).token, 1);
    assert.equal(svc.checkIn(a2.id).token, 2);
    assert.equal(svc.checkIn(b1.id).token, 1); // other doctor starts at 1 too

    const t1 = book('16:00', 4, TUE);
    setClock(TUE);
    assert.equal(svc.checkIn(t1.id).token, 1); // new day starts at 1 again
  });

  test('leave added after booking blocks check-in and is reported as affected', () => {
    const a = book('10:00', 1);
    const leave = svc.addLeave(drA.id, { start_date: MON });
    assert.deepEqual(leave.affected.map((x) => x.id), [a.id]);
    assert.throws(() => svc.checkIn(a.id), /leave/);
  });
});

describe('queue flow', () => {
  function checkedIn(n) {
    const slots = ['10:00', '10:15', '10:30', '10:45', '11:00'];
    return slots.slice(0, n).map((s, i) => svc.checkIn(book(s, i + 1).id));
  }

  test('done moves to the next token and updates the appointment', () => {
    const [a] = checkedIn(3);
    svc.callNext(drA.id);
    const q = svc.markDone(drA.id);
    assert.equal(q.serving.token, 2);
    assert.equal(q.next.token, 3);
    assert.equal(svc.getAppointment(a.id).status, 'done');
  });

  test('skipped twice -> no-show on the appointment', () => {
    const [a] = checkedIn(2);
    svc.callNext(drA.id); // serving 1
    let q = svc.skip(drA.id); // 1 to the back, serving 2
    assert.equal(q.serving.token, 2);
    assert.equal(q.next.token, 1);
    q = svc.markDone(drA.id); // serving 1 again
    assert.equal(q.serving.token, 1);
    q = svc.skip(drA.id);
    assert.equal(q.serving, null);
    assert.equal(svc.getAppointment(a.id).status, 'no_show');
  });

  test('queue actions on an empty queue return a clear 409', () => {
    assert.throws(() => svc.markDone(drA.id), status(409));
    assert.throws(() => svc.skip(drA.id), status(409));
  });

  test('a failed queue action leaves the stored queue untouched', () => {
    checkedIn(1);
    svc.callNext(drA.id);
    const before = JSON.stringify(svc.getQueue(drA.id));
    assert.throws(() => svc.callNext(drA.id), status(409));
    assert.equal(JSON.stringify(svc.getQueue(drA.id)), before);
  });
});

describe('daily report', () => {
  test('counts booked, seen, no-shows and averages the wait', () => {
    const at = (hhmm) => setClock(MON, hhmm);
    const a = book('10:00', 1);
    const b = book('10:15', 2);
    const c = book('10:30', 3);
    const d = book('10:45', 4); // never arrives
    const e = book('11:00', 5);
    svc.cancelAppointment(e.id);

    at('09:50'); svc.checkIn(a.id);
    at('09:55'); svc.checkIn(b.id);
    at('09:58'); svc.checkIn(c.id);
    at('10:00'); svc.callNext(drA.id); // a waited 10 min
    at('10:15'); svc.markDone(drA.id); // b called, waited 20 min
    at('10:30'); svc.skip(drA.id); // b skipped -> c called (waited 32 min)
    at('10:45'); svc.markDone(drA.id); // c done -> b called again
    at('10:46'); svc.skip(drA.id); // b no-show

    const r = svc.getReport(MON).find((x) => x.doctor_id === drA.id);
    assert.equal(r.booked, 4);
    assert.equal(r.cancelled, 1);
    assert.equal(r.checked_in, 3);
    assert.equal(r.seen, 2);
    assert.equal(r.no_shows, 1);
    assert.equal(r.not_arrived, 1);
    assert.equal(r.avg_wait_min, 21); // (10 + 32) / 2 — only patients actually seen
    assert.equal(d.status, 'booked');
  });

  test('a doctor with no activity reports zeros and null averages', () => {
    const r = svc.getReport(MON).find((x) => x.doctor_id === drB.id);
    assert.equal(r.booked, 0);
    assert.equal(r.avg_wait_min, null);
  });
});

describe('doctors & schedule validation', () => {
  const base = { name: 'Dr. C', department: 'ENT', duration_min: 15 };
  test('overlapping blocks on the same day are rejected', () => {
    assert.throws(
      () => svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '12:00' }, { weekday: 1, start_time: '11:00', end_time: '13:00' }] }),
      /overlapping/
    );
  });

  test('touching blocks are allowed', () => {
    assert.doesNotThrow(() =>
      svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '12:00' }, { weekday: 1, start_time: '12:00', end_time: '13:00' }] })
    );
  });

  test('end before start (overnight) and too-short blocks are rejected', () => {
    assert.throws(() => svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '22:00', end_time: '02:00' }] }), /end must be after start/);
    assert.throws(() => svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '10:10' }] }), /shorter/);
  });

  test('overlapping leave ranges are rejected', () => {
    svc.addLeave(drA.id, { start_date: MON, end_date: WED });
    assert.throws(() => svc.addLeave(drA.id, { start_date: TUE }), status(409));
  });

  test('changing duration keeps existing bookings blocked', () => {
    book('10:15', 1);
    svc.updateDoctor(drA.id, { duration_min: 20 });
    const s = Object.fromEntries(svc.getSlots(drA.id, MON).slots.map((x) => [x.start, x.status]));
    assert.equal(s['10:00'], 'booked');
    assert.equal(s['10:20'], 'booked');
    assert.equal(s['10:40'], 'available');
  });
});

describe('notifications', () => {
  test('phone numbers are masked', () => {
    assert.equal(maskPhone('9876543210'), '98xxxxxx10');
  });

  test('check-in logs an SMS with the token', () => {
    svc.checkIn(book('10:00', 1).id);
    const [latest] = svc.listNotifications();
    assert.match(latest.message, /^SMS sent to 98xxxxxx01: .*token is 1/);
  });
});
