'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateDaySlots, availableSlots, mergeIntervals, isOnLeave } = require('../src/core/slots');
const { weekdayOf, isValidDate, addDays } = require('../src/core/time');

// 2026-10-05 is a Monday. "now" defaults to a week earlier so nothing is in the past.
const MON = '2026-10-05';
const TUE = '2026-10-06';
const EARLIER = new Date(2026, 8, 28, 9, 0);

const monWedFri = [1, 3, 5].map((weekday) => ({ weekday, start_time: '10:00', end_time: '13:00' }));
const tueThu = [2, 4].map((weekday) => ({ weekday, start_time: '16:00', end_time: '19:00' }));
const ANANYA = [...monWedFri, ...tueThu];

const gen = (over = {}) => generateDaySlots({ date: MON, durationMin: 15, schedules: ANANYA, leaves: [], booked: [], now: EARLIER, ...over });
const starts = (r) => r.slots.map((s) => s.start);

describe('time helpers', () => {
  test('weekday is computed from the date string, independent of timezone', () => {
    assert.equal(weekdayOf('2026-10-04'), 0); // Sunday
    assert.equal(weekdayOf(MON), 1);
    assert.equal(weekdayOf('2028-02-29'), 2); // leap day, Tuesday
  });

  test('invalid calendar dates are rejected, not rolled over', () => {
    assert.equal(isValidDate('2026-02-30'), false);
    assert.equal(isValidDate('2026-13-01'), false);
    assert.equal(isValidDate('2026-10-5'), false);
    assert.equal(isValidDate('2028-02-29'), true);
  });

  test('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('slot generation', () => {
  test('Mon 10:00–13:00 at 15 min gives 12 slots, last one 12:45–13:00', () => {
    const r = gen();
    assert.equal(r.slots.length, 12);
    assert.equal(r.slots[0].start, '10:00');
    assert.deepEqual(r.slots.at(-1), { start: '12:45', end: '13:00', status: 'available' });
    assert.ok(r.slots.every((s) => s.status === 'available'));
  });

  test('uses the right schedule for each weekday', () => {
    assert.equal(gen({ date: TUE }).slots[0].start, '16:00');
    assert.equal(gen({ date: TUE }).slots.at(-1).start, '18:45');
  });

  test('a day with no schedule has no slots and working=false', () => {
    const r = gen({ date: '2026-10-10' }); // Saturday
    assert.equal(r.working, false);
    assert.deepEqual(r.slots, []);
  });

  test('a trailing partial slot is dropped (10:00–10:50 at 15 min -> 3 slots)', () => {
    const r = gen({ schedules: [{ weekday: 1, start_time: '10:00', end_time: '10:50' }] });
    assert.deepEqual(starts(r), ['10:00', '10:15', '10:30']);
  });

  test('block shorter than one consultation gives no slots', () => {
    const r = gen({ durationMin: 30, schedules: [{ weekday: 1, start_time: '10:00', end_time: '10:20' }] });
    assert.deepEqual(r.slots, []);
  });

  test('split shift: two blocks on the same day', () => {
    const r = gen({
      durationMin: 30,
      schedules: [
        { weekday: 1, start_time: '17:00', end_time: '18:00' },
        { weekday: 1, start_time: '09:00', end_time: '10:00' }, // out of order on purpose
      ],
    });
    assert.deepEqual(starts(r), ['09:00', '09:30', '17:00', '17:30']);
  });

  test('overlapping blocks are merged — no duplicate or overlapping slots', () => {
    const r = gen({
      durationMin: 30,
      schedules: [
        { weekday: 1, start_time: '10:00', end_time: '11:30' },
        { weekday: 1, start_time: '11:10', end_time: '12:00' },
      ],
    });
    assert.deepEqual(starts(r), ['10:00', '10:30', '11:00', '11:30']);
  });

  test('touching blocks form one continuous grid', () => {
    const r = gen({
      durationMin: 20,
      schedules: [
        { weekday: 1, start_time: '10:00', end_time: '10:30' },
        { weekday: 1, start_time: '10:30', end_time: '11:00' },
      ],
    });
    // Separately these would give 10:00, 10:30. Merged, 10:20 and 10:40 fit too.
    assert.deepEqual(starts(r), ['10:00', '10:20', '10:40']);
  });

  test('mergeIntervals ignores empty/reversed intervals', () => {
    assert.deepEqual(mergeIntervals([[5, 5], [10, 2], [1, 3], [2, 4]]), [[1, 4]]);
  });
});

describe('booked slots', () => {
  test('a booked slot is marked booked and not available', () => {
    const r = gen({ booked: ['10:15'] });
    assert.equal(r.slots.find((s) => s.start === '10:15').status, 'booked');
    assert.ok(!availableSlots({ date: MON, durationMin: 15, schedules: ANANYA, booked: ['10:15'], now: EARLIER }).includes('10:15'));
  });

  test('bookings not on the current grid still block every overlapping slot', () => {
    // Doctor used to be 15 min; there is a 10:15 booking. Now duration is 20 min:
    // new grid 10:00, 10:20, 10:40 ... 10:15–10:35 overlaps both 10:00–10:20 and 10:20–10:40.
    const r = gen({ durationMin: 20, booked: ['10:15'] });
    const status = Object.fromEntries(r.slots.map((s) => [s.start, s.status]));
    assert.equal(status['10:00'], 'booked');
    assert.equal(status['10:20'], 'booked');
    assert.equal(status['10:40'], 'available');
  });

  test('slots are back-to-back, not overlapping: 10:00 booked does not block 10:15', () => {
    const r = gen({ booked: ['10:00'] });
    assert.equal(r.slots[1].status, 'available');
  });
});

describe('leave days', () => {
  test('a leave day has no slots at all', () => {
    const r = gen({ leaves: [{ start_date: MON, end_date: MON }] });
    assert.equal(r.onLeave, true);
    assert.deepEqual(r.slots, []);
  });

  test('leave ranges are inclusive on both ends', () => {
    const leaves = [{ start_date: '2026-10-05', end_date: '2026-10-07' }];
    assert.equal(isOnLeave('2026-10-04', leaves), false);
    assert.equal(isOnLeave('2026-10-05', leaves), true);
    assert.equal(isOnLeave('2026-10-07', leaves), true);
    assert.equal(isOnLeave('2026-10-08', leaves), false);
    assert.equal(gen({ date: '2026-10-09', leaves }).slots.length, 12); // Friday after leave
  });

  test('single-day leave with no end_date', () => {
    assert.equal(isOnLeave(MON, [{ start_date: MON }]), true);
  });
});

describe('past slots', () => {
  test('every slot on a past date is past', () => {
    const r = gen({ now: new Date(2026, 9, 6, 8, 0) }); // Tue morning, looking at Monday
    assert.ok(r.slots.every((s) => s.status === 'past'));
  });

  test('today: slots that already started are past, later ones available', () => {
    const r = gen({ now: new Date(2026, 9, 5, 11, 7) });
    const status = Object.fromEntries(r.slots.map((s) => [s.start, s.status]));
    assert.equal(status['11:00'], 'past'); // already started 7 min ago
    assert.equal(status['11:15'], 'available');
  });

  test('a slot starting exactly now is past', () => {
    const r = gen({ now: new Date(2026, 9, 5, 11, 15, 0) });
    assert.equal(r.slots.find((s) => s.start === '11:15').status, 'past');
    assert.equal(r.slots.find((s) => s.start === '11:30').status, 'available');
  });

  test('after the last slot of today, nothing is available', () => {
    assert.deepEqual(availableSlots({ date: MON, durationMin: 15, schedules: ANANYA, now: new Date(2026, 9, 5, 12, 50) }), []);
  });

  test('booked takes precedence over past in the label', () => {
    const r = gen({ booked: ['10:00'], now: new Date(2026, 9, 5, 12, 0) });
    assert.equal(r.slots[0].status, 'booked');
  });
});

describe('input validation', () => {
  test('throws on invalid date or duration', () => {
    assert.throws(() => gen({ date: '2026-02-30' }), /Invalid date/);
    assert.throws(() => gen({ durationMin: 0 }), /Invalid duration/);
    assert.throws(() => gen({ durationMin: 7.5 }), /Invalid duration/);
  });
});
