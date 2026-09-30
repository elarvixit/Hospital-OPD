'use strict';

// Dates are plain 'YYYY-MM-DD' strings and times are 'HH:MM' strings in the
// hospital's local time. Keeping them as strings (not Date objects) avoids
// timezone/DST surprises: a Monday is always a Monday, 10:00 is always 10:00.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects things like 2026-02-30 which Date would silently roll over.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 0 = Sunday ... 6 = Saturday (same convention as Date#getDay). */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * Wall-clock parts of `now` in `timeZone` (e.g. 'Asia/Kolkata').
 * Without a timeZone, the machine's local time is used. Servers like Vercel run in UTC,
 * so production passes the hospital's timezone explicitly.
 */
function zonedParts(now, timeZone) {
  if (!timeZone) {
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), min: now.getMinutes(), s: now.getSeconds() };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
}

/** The calendar date of `now` in the hospital's timezone, as 'YYYY-MM-DD'. */
function localDate(now, timeZone) {
  const { y, m, d } = zonedParts(now, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Minutes since midnight in the hospital's timezone, including the fractional seconds part. */
function localMinutes(now, timeZone) {
  const { h, min, s } = zonedParts(now, timeZone);
  return h * 60 + min + s / 60;
}

/** The instant at which the wall clock in `timeZone` reads `dateStr hhmm`. */
function zonedTimeToDate(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  if (!timeZone) return new Date(y, m - 1, d, h, min);
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = zonedParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;
  return new Date(guess - offset);
}

function minutesBetween(fromIso, toIso) {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

module.exports = {
  isValidDate,
  isValidTime,
  toMinutes,
  fromMinutes,
  weekdayOf,
  addDays,
  localDate,
  localMinutes,
  zonedTimeToDate,
  minutesBetween,
  WEEKDAY_NAMES,
};
