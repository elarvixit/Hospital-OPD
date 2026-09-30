'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS doctors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  department    TEXT    NOT NULL,
  duration_min  INTEGER NOT NULL CHECK (duration_min > 0),
  room          TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id   INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT    NOT NULL,
  end_time    TEXT    NOT NULL,
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS leaves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id   INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,
  reason      TEXT,
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS patients (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT    NOT NULL,
  phone  TEXT    NOT NULL,
  age    INTEGER NOT NULL,
  UNIQUE (phone, name)
);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id),
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  date          TEXT    NOT NULL,
  slot_start    TEXT,                 -- NULL for walk-ins
  kind          TEXT    NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'walkin')),
  status        TEXT    NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked', 'checked_in', 'done', 'no_show', 'cancelled')),
  created_at    TEXT    NOT NULL,
  cancelled_at  TEXT
);

-- Last line of defence against double-booking: only one live appointment per slot.
-- Cancelled rows are excluded, so cancelling frees the slot immediately.
CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_slot
  ON appointments (doctor_id, date, slot_start)
  WHERE status <> 'cancelled' AND slot_start IS NOT NULL;

CREATE TABLE IF NOT EXISTS queue_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id  INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
  doctor_id       INTEGER NOT NULL REFERENCES doctors(id),
  date            TEXT    NOT NULL,
  token           INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  state           TEXT    NOT NULL CHECK (state IN ('waiting', 'serving', 'done', 'no_show')),
  skips           INTEGER NOT NULL DEFAULT 0,
  checked_in_at   TEXT    NOT NULL,
  called_at       TEXT,
  served_at       TEXT,
  -- Tokens restart at 1 each day per doctor, so uniqueness is scoped to (doctor, date).
  UNIQUE (doctor_id, date, token)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

/** Open (or create) a database. Pass ':memory:' for tests. */
function openDb(file = path.join(__dirname, '..', 'data', 'opd.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back if it throws. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
