'use strict';

const { isValidDate, isValidTime, toMinutes, fromMinutes, weekdayOf, localDate, localMinutes } = require('./time');

/**
 * Sort and merge overlapping or touching intervals.
 * [[600,720],[700,780]] -> [[600,780]]
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

/** leaves: [{ start_date, end_date }] — inclusive ranges. A single day has start_date === end_date. */
function isOnLeave(date, leaves) {
  return leaves.some((l) => date >= l.start_date && date <= (l.end_date || l.start_date));
}

/**
 * Build every slot for one doctor on one date and label each one.
 *
 * @param {object} p
 * @param {string} p.date          'YYYY-MM-DD'
 * @param {number} p.durationMin   consultation length in minutes
 * @param {Array}  p.schedules     [{ weekday, start_time, end_time }]
 * @param {Array}  p.leaves        [{ start_date, end_date }]
 * @param {Array}  p.booked        slot_start strings of non-cancelled appointments, e.g. ['10:15']
 * @param {Date}   p.now           current time (injected so tests can control it)
 * @returns {{ date, onLeave, working, slots: Array<{start,end,status}> }}
 *          status is one of 'available' | 'booked' | 'past'
 */
function generateDaySlots({ date, durationMin, schedules, leaves = [], booked = [], now }) {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  if (!Number.isInteger(durationMin) || durationMin <= 0) throw new Error(`Invalid duration: ${durationMin}`);
  if (!(now instanceof Date)) throw new Error('now must be a Date');

  const weekday = weekdayOf(date);
  const blocks = mergeIntervals(
    schedules
      .filter((s) => Number(s.weekday) === weekday && isValidTime(s.start_time) && isValidTime(s.end_time))
      .map((s) => [toMinutes(s.start_time), toMinutes(s.end_time)])
  );

  const result = { date, onLeave: false, working: blocks.length > 0, slots: [] };

  // A leave day has no slots at all — not even "booked" ones to look at.
  if (isOnLeave(date, leaves)) {
    result.onLeave = true;
    return result;
  }

  // Booked intervals use the *current* duration. If a doctor's duration changes after
  // bookings were made, any new slot that overlaps an existing booking is still blocked.
  const bookedIntervals = booked.filter(isValidTime).map((b) => [toMinutes(b), toMinutes(b) + durationMin]);

  const today = localDate(now);
  const nowMin = localMinutes(now);

  for (const [blockStart, blockEnd] of blocks) {
    // Only whole slots: a 15-min doctor with a 10:00-10:50 block gets 10:00, 10:15, 10:30 (not 10:45).
    for (let start = blockStart; start + durationMin <= blockEnd; start += durationMin) {
      const end = start + durationMin;
      let status = 'available';
      if (bookedIntervals.some(([bs, be]) => start < be && bs < end)) status = 'booked';
      else if (date < today || (date === today && start <= nowMin)) status = 'past';
      result.slots.push({ start: fromMinutes(start), end: fromMinutes(end), status });
    }
  }
  return result;
}

/** Just the bookable slot start times. */
function availableSlots(params) {
  return generateDaySlots(params)
    .slots.filter((s) => s.status === 'available')
    .map((s) => s.start);
}

module.exports = { mergeIntervals, isOnLeave, generateDaySlots, availableSlots };
