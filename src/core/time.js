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

/** The local calendar date of a JS Date, as 'YYYY-MM-DD'. */
function localDate(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Minutes since local midnight, including the fractional seconds part. */
function localMinutes(now) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
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
  minutesBetween,
  WEEKDAY_NAMES,
};
