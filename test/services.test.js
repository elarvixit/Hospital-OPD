'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('../src/repo/memory');
const { createServices, maskPhone } = require('../src/services');
const { SlotTakenError } = require('../src/errors');

// Monday 2026-10-05, 09:00 local time
const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';

let svc, repo, clock, drA, drB;
const setClock = (date, hhmm = '09:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  clock = new Date(y, m - 1, d, h, min);
};
const patient = (n = 1) => ({ name: `Patient ${n}`, phone: `98765432${String(n).padStart(2, '0')}`, age: 30 + n });
const book = (slot, n = 1, date = MON, doctor = drA) => svc.bookAppointment({ doctorId: doctor.id, date, slot, patient: patient(n) });
const status = (code) => (e) => e.status === code;
const slotStatus = async (doctor, date, start) => (await svc.getSlots(doctor.id, date)).slots.find((s) => s.start === start).status;

beforeEach(async () => {
  repo = createMemoryRepo();
  setClock(MON);
  svc = createServices(repo, { now: () => clock, timeZone: undefined });
  drA = await svc.createDoctor({
    name: 'Dr. A',
    department: 'Cardiology',
    duration_min: 15,
    schedules: [
      ...[1, 3, 5].map((weekday) => ({ weekday, start_time: '10:00', end_time: '13:00' })),
      ...[2, 4].map((weekday) => ({ weekday, start_time: '16:00', end_time: '19:00' })),
    ],
  });
  drB = await svc.createDoctor({
    name: 'Dr. B',
    department: 'Pediatrics',
    duration_min: 10,
    schedules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: '09:00', end_time: '11:00' })),
  });
});

describe('booking', () => {
  test('booking a free slot succeeds and the slot shows as booked', async () => {
    const a = await book('10:15');
    assert.equal(a.status, 'booked');
    assert.equal(a.slot_start, '10:15');
    assert.equal(await slotStatus(drA, MON, '10:15'), 'booked');
  });

  test('double-booking the same slot is refused with 409', async () => {
    await book('10:15', 1);
    await assert.rejects(book('10:15', 2), status(409));
  });

  test('two desks booking the same slot at the same moment: exactly one wins', async () => {
    const results = await Promise.allSettled([book('10:15', 1), book('10:15', 2)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  });

  test('the same time with a different doctor is fine', async () => {
    await book('10:00', 1, MON, drA);
    await assert.doesNotReject(book('10:00', 2, MON, drB));
  });

  test('the storage layer itself refuses a duplicate live slot', async () => {
    const a = await book('10:15', 1);
    await assert.rejects(
      repo.insertAppointment({ doctor_id: drA.id, patient_id: a.patient_id, date: MON, slot_start: '10:15', kind: 'scheduled', status: 'booked' }),
      SlotTakenError
    );
  });

  test('cannot book a past date', async () => {
    await assert.rejects(book('10:00', 1, '2026-10-02'), /past/);
  });

  test('cannot book a slot earlier today that has already started', async () => {
    setClock(MON, '10:20');
    await assert.rejects(book('10:15'), /past/);
    await assert.doesNotReject(book('10:30'));
  });

  test('cannot book on a leave day', async () => {
    await svc.addLeave(drA.id, { start_date: WED, end_date: WED });
    await assert.rejects(book('10:00', 1, WED), /leave/);
  });

  test('cannot book outside the schedule or off the slot grid', async () => {
    await assert.rejects(book('14:00'), /not a valid slot/); // after hours
    await assert.rejects(book('10:07'), /not a valid slot/); // off-grid
    await assert.rejects(book('16:00'), /not a valid slot/); // that's Tuesday's block
  });

  test('patient details are validated', async () => {
    const base = { doctorId: drA.id, date: MON, slot: '10:00' };
    await assert.rejects(svc.bookAppointment({ ...base, patient: { name: 'X', phone: '9876543210', age: 5 } }), /name/);
    await assert.rejects(svc.bookAppointment({ ...base, patient: { name: 'Asha', phone: '12345', age: 5 } }), /Phone/);
    await assert.rejects(svc.bookAppointment({ ...base, patient: { name: 'Asha', phone: '9876543210', age: 150 } }), /Age/);
  });

  test('returning patients (same name + phone) are reused', async () => {
    const a = await book('10:00', 1);
    const b = await book('10:15', 1);
    assert.equal(a.patient_id, b.patient_id);
  });
});

describe('cancel & reschedule', () => {
  test('cancelling frees the slot immediately', async () => {
    const a = await book('10:15', 1);
    await svc.cancelAppointment(a.id);
    assert.equal(await slotStatus(drA, MON, '10:15'), 'available');
    await assert.doesNotReject(book('10:15', 2));
  });

  test('cannot cancel twice or cancel a checked-in patient', async () => {
    const a = await book('10:15', 1);
    await svc.cancelAppointment(a.id);
    await assert.rejects(svc.cancelAppointment(a.id), status(409));
    const b = await book('10:30', 2);
    await svc.checkIn(b.id);
    await assert.rejects(svc.cancelAppointment(b.id), status(409));
  });

  test('next three free slots skip booked slots, leave days and past times', async () => {
    setClock(MON, '12:20');
    await book('12:30', 1);
    await svc.addLeave(drA.id, { start_date: TUE, end_date: TUE });
    const next = await svc.nextFreeSlots(drA.id);
    assert.deepEqual(next.map((s) => `${s.date} ${s.start}`), [
      `${MON} 12:45`, // 12:30 is booked, 12:15 already started
      `${WED} 10:00`, // Tuesday is leave
      `${WED} 10:15`,
    ]);
  });

  test('reschedule moves the appointment and frees the old slot', async () => {
    const a = await book('10:15', 1);
    const moved = await svc.reschedule(a.id, { date: WED, slot: '11:00' });
    assert.equal(moved.date, WED);
    assert.equal(moved.slot_start, '11:00');
    assert.equal(await slotStatus(drA, MON, '10:15'), 'available');
    assert.equal(await slotStatus(drA, WED, '11:00'), 'booked');
  });

  test('reschedule into a taken slot is refused and nothing changes', async () => {
    const a = await book('10:15', 1);
    await book('10:30', 2);
    await assert.rejects(svc.reschedule(a.id, { date: MON, slot: '10:30' }), status(409));
    assert.equal((await svc.getAppointment(a.id)).slot_start, '10:15');
  });
});

describe('walk-ins & check-in', () => {
  test("walk-ins join today's queue without a slot", async () => {
    const w = await svc.addWalkIn({ doctorId: drA.id, patient: patient(1) });
    assert.equal(w.kind, 'walkin');
    assert.equal(w.slot_start, null);
    assert.equal(w.token, 1);
    assert.equal((await svc.getQueue(drA.id)).next.token, 1);
  });

  test('walk-ins are refused on a leave day', async () => {
    await svc.addLeave(drA.id, { start_date: MON });
    await assert.rejects(svc.addWalkIn({ doctorId: drA.id, patient: patient(1) }), /leave/);
  });

  test('check-in hands out tokens in arrival order, not slot order', async () => {
    const late = await book('12:00', 1);
    const early = await book('10:00', 2);
    assert.equal((await svc.checkIn(late.id)).token, 1);
    assert.equal((await svc.checkIn(early.id)).token, 2);
    const w = await svc.addWalkIn({ doctorId: drA.id, patient: patient(3) });
    assert.equal(w.token, 3);
  });

  test('simultaneous check-ins get different tokens', async () => {
    const appts = [await book('10:00', 1), await book('10:15', 2), await book('10:30', 3)];
    const done = await Promise.all(appts.map((a) => svc.checkIn(a.id)));
    assert.deepEqual(done.map((a) => a.token).sort(), [1, 2, 3]);
  });

  test('the same patient checked in from two screens at once gets one token', async () => {
    const a = await book('10:00', 1);
    const results = await Promise.allSettled([svc.checkIn(a.id), svc.checkIn(a.id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await svc.getQueue(drA.id)).next.token, 1);
    assert.equal((await svc.getQueue(drA.id)).waiting.length, 0);
  });

  test('check-in only on the appointment day', async () => {
    const a = await book('10:00', 1, WED);
    await assert.rejects(svc.checkIn(a.id), /appointment day/);
    setClock(WED);
    assert.equal((await svc.checkIn(a.id)).token, 1);
  });

  test('cannot check in twice or check in a cancelled appointment', async () => {
    const a = await book('10:00', 1);
    await svc.checkIn(a.id);
    await assert.rejects(svc.checkIn(a.id), status(409));
    const b = await book('10:15', 2);
    await svc.cancelAppointment(b.id);
    await assert.rejects(svc.checkIn(b.id), /cancelled/);
  });

  test('tokens restart at 1 each day and are separate per doctor', async () => {
    const a1 = await book('10:00', 1);
    const a2 = await book('10:15', 2);
    const b1 = await book('09:30', 3, MON, drB);
    assert.equal((await svc.checkIn(a1.id)).token, 1);
    assert.equal((await svc.checkIn(a2.id)).token, 2);
    assert.equal((await svc.checkIn(b1.id)).token, 1); // other doctor starts at 1 too

    const t1 = await book('16:00', 4, TUE);
    setClock(TUE);
    assert.equal((await svc.checkIn(t1.id)).token, 1); // new day starts at 1 again
  });

  test('leave added after booking blocks check-in and is reported as affected', async () => {
    const a = await book('10:00', 1);
    const leave = await svc.addLeave(drA.id, { start_date: MON });
    assert.deepEqual(leave.affected.map((x) => x.id), [a.id]);
    await assert.rejects(svc.checkIn(a.id), /leave/);
  });
});

describe('queue flow', () => {
  async function checkedIn(n) {
    const slots = ['10:00', '10:15', '10:30', '10:45', '11:00'];
    const out = [];
    for (const [i, s] of slots.slice(0, n).entries()) out.push(await svc.checkIn((await book(s, i + 1)).id));
    return out;
  }

  test('done moves to the next token and updates the appointment', async () => {
    const [a] = await checkedIn(3);
    await svc.callNext(drA.id);
    const q = await svc.markDone(drA.id);
    assert.equal(q.serving.token, 2);
    assert.equal(q.next.token, 3);
    assert.equal((await svc.getAppointment(a.id)).status, 'done');
  });

  test('skipped twice -> no-show on the appointment', async () => {
    const [a] = await checkedIn(2);
    await svc.callNext(drA.id); // serving 1
    let q = await svc.skip(drA.id); // 1 to the back, serving 2
    assert.equal(q.serving.token, 2);
    assert.equal(q.next.token, 1);
    q = await svc.markDone(drA.id); // serving 1 again
    assert.equal(q.serving.token, 1);
    q = await svc.skip(drA.id);
    assert.equal(q.serving, null);
    assert.equal((await svc.getAppointment(a.id)).status, 'no_show');
  });

  test('two screens pressing Done at the same time only advance the queue once', async () => {
    await checkedIn(3);
    await svc.callNext(drA.id); // serving 1
    const results = await Promise.allSettled([svc.markDone(drA.id), svc.markDone(drA.id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    const q = await svc.getQueue(drA.id);
    assert.equal(q.serving.token, 2); // not 3
    assert.equal(q.done.length, 1);
  });

  test('queue actions on an empty queue return a clear 409', async () => {
    await assert.rejects(svc.markDone(drA.id), status(409));
    await assert.rejects(svc.skip(drA.id), status(409));
  });

  test('a failed queue action leaves the stored queue untouched', async () => {
    await checkedIn(1);
    await svc.callNext(drA.id);
    const before = JSON.stringify(await svc.getQueue(drA.id));
    await assert.rejects(svc.callNext(drA.id), status(409));
    assert.equal(JSON.stringify(await svc.getQueue(drA.id)), before);
  });

  test('getAllQueues returns every doctor for today', async () => {
    await checkedIn(2);
    const all = await svc.getAllQueues();
    assert.deepEqual(all.map((q) => q.doctor.name), ['Dr. A', 'Dr. B']);
    assert.equal(all[0].next.token, 1);
    assert.equal(all[1].next, null);
  });
});

describe('daily report', () => {
  test('counts booked, seen, no-shows and averages the wait', async () => {
    const at = (hhmm) => setClock(MON, hhmm);
    const a = await book('10:00', 1);
    const b = await book('10:15', 2);
    const c = await book('10:30', 3);
    await book('10:45', 4); // never arrives
    const e = await book('11:00', 5);
    await svc.cancelAppointment(e.id);

    at('09:50'); await svc.checkIn(a.id);
    at('09:55'); await svc.checkIn(b.id);
    at('09:58'); await svc.checkIn(c.id);
    at('10:00'); await svc.callNext(drA.id); // a waited 10 min
    at('10:15'); await svc.markDone(drA.id); // b called, waited 20 min
    at('10:30'); await svc.skip(drA.id); // b skipped -> c called (waited 32 min)
    at('10:45'); await svc.markDone(drA.id); // c done -> b called again
    at('10:46'); await svc.skip(drA.id); // b no-show

    const r = (await svc.getReport(MON)).find((x) => x.doctor_id === drA.id);
    assert.equal(r.booked, 4);
    assert.equal(r.cancelled, 1);
    assert.equal(r.checked_in, 3);
    assert.equal(r.seen, 2);
    assert.equal(r.no_shows, 1);
    assert.equal(r.not_arrived, 1);
    assert.equal(r.avg_wait_min, 21); // (10 + 32) / 2 — only patients actually seen
  });

  test('a doctor with no activity reports zeros and null averages', async () => {
    const r = (await svc.getReport(MON)).find((x) => x.doctor_id === drB.id);
    assert.equal(r.booked, 0);
    assert.equal(r.avg_wait_min, null);
  });
});

describe('doctors & schedule validation', () => {
  const base = { name: 'Dr. C', department: 'ENT', duration_min: 15 };
  test('overlapping blocks on the same day are rejected', async () => {
    await assert.rejects(
      svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '12:00' }, { weekday: 1, start_time: '11:00', end_time: '13:00' }] }),
      /overlapping/
    );
  });

  test('touching blocks are allowed', async () => {
    await assert.doesNotReject(
      svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '12:00' }, { weekday: 1, start_time: '12:00', end_time: '13:00' }] })
    );
  });

  test('end before start (overnight) and too-short blocks are rejected', async () => {
    await assert.rejects(svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '22:00', end_time: '02:00' }] }), /end must be after start/);
    await assert.rejects(svc.createDoctor({ ...base, schedules: [{ weekday: 1, start_time: '10:00', end_time: '10:10' }] }), /shorter/);
  });

  test('overlapping leave ranges are rejected', async () => {
    await svc.addLeave(drA.id, { start_date: MON, end_date: WED });
    await assert.rejects(svc.addLeave(drA.id, { start_date: TUE }), status(409));
  });

  test('changing duration keeps existing bookings blocked', async () => {
    await book('10:15', 1);
    await svc.updateDoctor(drA.id, { duration_min: 20 });
    const s = Object.fromEntries((await svc.getSlots(drA.id, MON)).slots.map((x) => [x.start, x.status]));
    assert.equal(s['10:00'], 'booked');
    assert.equal(s['10:20'], 'booked');
    assert.equal(s['10:40'], 'available');
  });

  test('updating without schedules keeps the existing schedule', async () => {
    const d = await svc.updateDoctor(drA.id, { room: '101' });
    assert.equal(d.room, '101');
    assert.equal(d.schedules.length, 5);
  });
});

describe('hospital timezone', () => {
  test('"today" and "past" follow APP_TIMEZONE, not the server clock', async () => {
    // 20:00 UTC on Sunday 4 Oct = 01:30 Monday 5 Oct in India.
    const tzRepo = createMemoryRepo();
    const tz = createServices(tzRepo, { now: () => new Date('2026-10-04T20:00:00Z'), timeZone: 'Asia/Kolkata' });
    assert.equal(tz.today(), MON);
    const doc = await tz.createDoctor({ name: 'Dr. T', department: 'ENT', duration_min: 30, schedules: [{ weekday: 1, start_time: '00:00', end_time: '03:00' }] });
    const slots = (await tz.getSlots(doc.id, MON)).slots;
    assert.deepEqual(slots.map((s) => `${s.start} ${s.status}`), ['00:00 past', '00:30 past', '01:00 past', '01:30 past', '02:00 available', '02:30 available']);
  });
});

describe('notifications', () => {
  test('phone numbers are masked', () => {
    assert.equal(maskPhone('9876543210'), '98xxxxxx10');
  });

  test('check-in logs an SMS with the token', async () => {
    await svc.checkIn((await book('10:00', 1)).id);
    const [latest] = await svc.listNotifications();
    assert.match(latest.message, /^SMS sent to 98xxxxxx01: .*token is 1/);
  });
});
