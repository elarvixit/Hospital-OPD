'use strict';

const { transaction } = require('./db');
const { isValidDate, isValidTime, toMinutes, addDays, localDate, minutesBetween, WEEKDAY_NAMES } = require('./core/time');
const { generateDaySlots, isOnLeave, mergeIntervals } = require('./core/slots');
const Queue = require('./core/queue');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new AppError(400, msg);
const notFound = (msg) => new AppError(404, msg);
const conflict = (msg) => new AppError(409, msg);

/** '9876543210' -> '98xxxxxx10' */
function maskPhone(phone) {
  const p = String(phone);
  if (p.length <= 4) return p;
  return p.slice(0, 2) + 'x'.repeat(p.length - 4) + p.slice(-2);
}

function validatePatient(p) {
  if (!p || typeof p !== 'object') throw bad('Patient details are required');
  const name = String(p.name || '').trim();
  const phone = String(p.phone || '').replace(/\s|-/g, '');
  const age = Number(p.age);
  if (name.length < 2 || name.length > 80) throw bad('Patient name must be 2–80 characters');
  if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Phone must be a valid 10-digit mobile number');
  if (!Number.isInteger(age) || age < 0 || age > 120) throw bad('Age must be a whole number between 0 and 120');
  return { name, phone, age };
}

function validateDoctorInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = String(input.name || '').trim();
    if (out.name.length < 2) throw bad('Doctor name is required');
  }
  if (!partial || input.department !== undefined) {
    out.department = String(input.department || '').trim();
    if (!out.department) throw bad('Department is required');
  }
  if (!partial || input.duration_min !== undefined) {
    out.duration_min = Number(input.duration_min);
    if (!Number.isInteger(out.duration_min) || out.duration_min < 5 || out.duration_min > 120) {
      throw bad('Consultation duration must be 5–120 minutes');
    }
  }
  if (input.room !== undefined) out.room = input.room ? String(input.room).trim() : null;
  return out;
}

function validateSchedules(schedules, durationMin) {
  if (!Array.isArray(schedules)) throw bad('Schedule must be a list of time blocks');
  const cleaned = schedules.map((s) => {
    const weekday = Number(s.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw bad('Weekday must be 0 (Sun) to 6 (Sat)');
    if (!isValidTime(s.start_time) || !isValidTime(s.end_time)) throw bad('Times must be HH:MM (24-hour)');
    const start = toMinutes(s.start_time);
    const end = toMinutes(s.end_time);
    if (end <= start) throw bad(`${WEEKDAY_NAMES[weekday]} ${s.start_time}–${s.end_time}: end must be after start (overnight shifts are not supported)`);
    if (end - start < durationMin) throw bad(`${WEEKDAY_NAMES[weekday]} ${s.start_time}–${s.end_time} is shorter than one ${durationMin}-min consultation`);
    return { weekday, start_time: s.start_time, end_time: s.end_time };
  });
  for (let wd = 0; wd <= 6; wd++) {
    const blocks = cleaned.filter((s) => s.weekday === wd).map((s) => [toMinutes(s.start_time), toMinutes(s.end_time)]);
    // Touching blocks (10–12 and 12–13) are fine; overlapping ones are a data-entry mistake.
    const merged = mergeIntervals(blocks.map(([s, e]) => [s, e - 0.5]));
    if (merged.length < blocks.length) throw bad(`${WEEKDAY_NAMES[wd]} has overlapping schedule blocks`);
  }
  return cleaned;
}

/**
 * @param {DatabaseSync} db
 * @param {{ now?: () => Date }} opts  inject a clock so tests can time-travel
 */
function createServices(db, { now = () => new Date() } = {}) {
  const today = () => localDate(now());

  // ---------- helpers ----------
  const q = (sql) => db.prepare(sql);

  function notify(phone, message) {
    q('INSERT INTO notifications (phone, message, created_at) VALUES (?, ?, ?)').run(
      phone,
      `SMS sent to ${maskPhone(phone)}: ${message}`,
      now().toISOString()
    );
  }

  function getDoctorRow(id) {
    const d = q('SELECT * FROM doctors WHERE id = ?').get(Number(id));
    if (!d) throw notFound('Doctor not found');
    return d;
  }

  function getDoctor(id) {
    const d = getDoctorRow(id);
    d.schedules = q('SELECT id, weekday, start_time, end_time FROM schedules WHERE doctor_id = ? ORDER BY weekday, start_time').all(d.id);
    d.leaves = q('SELECT id, start_date, end_date, reason FROM leaves WHERE doctor_id = ? ORDER BY start_date').all(d.id);
    return d;
  }

  function bookedStarts(doctorId, date, excludeAppointmentId = null) {
    return q(
      `SELECT slot_start FROM appointments
       WHERE doctor_id = ? AND date = ? AND status <> 'cancelled' AND slot_start IS NOT NULL AND id IS NOT ?`
    )
      .all(doctorId, date, excludeAppointmentId)
      .map((r) => r.slot_start);
  }

  function daySlots(doctor, date, excludeAppointmentId = null) {
    return generateDaySlots({
      date,
      durationMin: doctor.duration_min,
      schedules: doctor.schedules,
      leaves: doctor.leaves,
      booked: bookedStarts(doctor.id, date, excludeAppointmentId),
      now: now(),
    });
  }

  /** Throw a helpful error if `slot` can't be booked for doctor on date. */
  function assertBookable(doctor, date, slot, excludeAppointmentId = null) {
    if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
    if (!isValidTime(slot)) throw bad('Slot must be HH:MM');
    if (date < today()) throw bad('Cannot book a date in the past');
    const day = daySlots(doctor, date, excludeAppointmentId);
    if (day.onLeave) throw bad(`${doctor.name} is on leave on ${date}`);
    const match = day.slots.find((s) => s.start === slot);
    if (!match) throw bad(`${slot} is not a valid slot for ${doctor.name} on ${date}`);
    if (match.status === 'booked') throw conflict(`${slot} on ${date} is already booked`);
    if (match.status === 'past') throw bad(`${slot} on ${date} is in the past`);
  }

  function findOrCreatePatient(p) {
    const existing = q('SELECT * FROM patients WHERE phone = ? AND name = ? COLLATE NOCASE').get(p.phone, p.name);
    if (existing) {
      if (existing.age !== p.age) q('UPDATE patients SET age = ? WHERE id = ?').run(p.age, existing.id);
      return existing.id;
    }
    return Number(q('INSERT INTO patients (name, phone, age) VALUES (?, ?, ?)').run(p.name, p.phone, p.age).lastInsertRowid);
  }

  function getAppointmentRow(id) {
    const a = q('SELECT * FROM appointments WHERE id = ?').get(Number(id));
    if (!a) throw notFound('Appointment not found');
    return a;
  }

  const APPT_SELECT = `
    SELECT a.*, p.name AS patient_name, p.phone AS patient_phone, p.age AS patient_age,
           d.name AS doctor_name, d.department, d.duration_min,
           qe.token, qe.state AS queue_state, qe.skips
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d  ON d.id = a.doctor_id
    LEFT JOIN queue_entries qe ON qe.appointment_id = a.id`;

  function getAppointment(id) {
    const a = q(`${APPT_SELECT} WHERE a.id = ?`).get(Number(id));
    if (!a) throw notFound('Appointment not found');
    return a;
  }

  // ---------- queue persistence ----------
  const QUEUE_FIELDS = ['token', 'seq', 'state', 'skips', 'checked_in_at', 'called_at', 'served_at'];

  function loadEntries(doctorId, date) {
    return q('SELECT * FROM queue_entries WHERE doctor_id = ? AND date = ?').all(doctorId, date);
  }

  /** Write back whatever the pure queue functions changed, and keep appointment.status in sync. */
  function saveEntries(doctorId, date, before, after) {
    const old = new Map(before.map((e) => [e.id, e]));
    for (const e of after) {
      if (e.id === undefined) {
        q(
          `INSERT INTO queue_entries (appointment_id, doctor_id, date, token, seq, state, skips, checked_in_at, called_at, served_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(e.appointment_id, doctorId, date, e.token, e.seq, e.state, e.skips, e.checked_in_at, e.called_at, e.served_at);
        continue;
      }
      const prev = old.get(e.id);
      if (QUEUE_FIELDS.every((f) => prev[f] === e[f])) continue;
      q(`UPDATE queue_entries SET ${QUEUE_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(
        ...QUEUE_FIELDS.map((f) => e[f]),
        e.id
      );
      if (e.state !== prev.state && (e.state === 'done' || e.state === 'no_show')) {
        q('UPDATE appointments SET status = ? WHERE id = ?').run(e.state, e.appointment_id);
      }
    }
  }

  function queueAction(doctorId, fn) {
    const doctor = getDoctorRow(doctorId);
    const date = today();
    return transaction(db, () => {
      const before = loadEntries(doctor.id, date);
      let result;
      try {
        result = fn(before);
      } catch (err) {
        if (err instanceof Queue.QueueError) throw conflict(err.message);
        throw err;
      }
      saveEntries(doctor.id, date, before, result.entries);
      if (result.called) {
        const a = getAppointment(result.called.appointment_id);
        notify(a.patient_phone, `Token ${result.called.token}, please proceed to ${doctor.name}${doctor.room ? ` (Room ${doctor.room})` : ''}.`);
      }
      return getQueue(doctor.id, date);
    });
  }

  // ---------- public API ----------
  const api = {
    today,

    // Doctors
    listDoctors() {
      return q('SELECT id FROM doctors ORDER BY name').all().map((d) => getDoctor(d.id));
    },

    getDoctor,

    createDoctor(input) {
      const d = validateDoctorInput(input);
      const schedules = validateSchedules(input.schedules || [], d.duration_min);
      return transaction(db, () => {
        const id = Number(
          q('INSERT INTO doctors (name, department, duration_min, room) VALUES (?, ?, ?, ?)').run(d.name, d.department, d.duration_min, d.room ?? null)
            .lastInsertRowid
        );
        for (const s of schedules) q('INSERT INTO schedules (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)').run(id, s.weekday, s.start_time, s.end_time);
        return getDoctor(id);
      });
    },

    updateDoctor(id, input) {
      const current = getDoctorRow(id);
      const d = { ...current, ...validateDoctorInput(input, { partial: true }) };
      const schedules = input.schedules !== undefined ? validateSchedules(input.schedules, d.duration_min) : null;
      return transaction(db, () => {
        q('UPDATE doctors SET name = ?, department = ?, duration_min = ?, room = ? WHERE id = ?').run(d.name, d.department, d.duration_min, d.room ?? null, current.id);
        if (schedules) {
          q('DELETE FROM schedules WHERE doctor_id = ?').run(current.id);
          for (const s of schedules) q('INSERT INTO schedules (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)').run(current.id, s.weekday, s.start_time, s.end_time);
        }
        return getDoctor(current.id);
      });
    },

    /** Adds a leave range. Returns the live appointments that now need rescheduling. */
    addLeave(doctorId, { start_date, end_date, reason }) {
      const doctor = getDoctorRow(doctorId);
      end_date = end_date || start_date;
      if (!isValidDate(start_date) || !isValidDate(end_date)) throw bad('Leave dates must be YYYY-MM-DD');
      if (end_date < start_date) throw bad('Leave end date is before start date');
      const overlap = q('SELECT 1 FROM leaves WHERE doctor_id = ? AND start_date <= ? AND end_date >= ?').get(doctor.id, end_date, start_date);
      if (overlap) throw conflict('This leave overlaps an existing leave');
      const id = Number(q('INSERT INTO leaves (doctor_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)').run(doctor.id, start_date, end_date, reason || null).lastInsertRowid);
      const affected = q(`${APPT_SELECT} WHERE a.doctor_id = ? AND a.date BETWEEN ? AND ? AND a.status = 'booked' ORDER BY a.date, a.slot_start`).all(doctor.id, start_date, end_date);
      return { id, doctor_id: doctor.id, start_date, end_date, reason: reason || null, affected };
    },

    removeLeave(leaveId) {
      const r = q('DELETE FROM leaves WHERE id = ?').run(Number(leaveId));
      if (!r.changes) throw notFound('Leave not found');
      return { ok: true };
    },

    // Slots
    getSlots(doctorId, date) {
      if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
      return { doctor_id: Number(doctorId), ...daySlots(getDoctor(doctorId), date) };
    },

    /** The next `count` free slots from now, scanning forward up to `horizonDays`. */
    nextFreeSlots(doctorId, { count = 3, fromDate = today(), horizonDays = 60 } = {}) {
      const doctor = getDoctor(doctorId);
      const start = !isValidDate(fromDate) || fromDate < today() ? today() : fromDate;
      const found = [];
      for (let i = 0; i < horizonDays && found.length < count; i++) {
        const date = addDays(start, i);
        const day = daySlots(doctor, date);
        for (const s of day.slots) {
          if (s.status === 'available') found.push({ date, start: s.start, end: s.end });
          if (found.length === count) break;
        }
      }
      return found;
    },

    // Patients
    findPatients(phone) {
      const digits = String(phone || '').replace(/\D/g, '');
      if (digits.length < 3) return [];
      return q('SELECT * FROM patients WHERE phone LIKE ? ORDER BY name LIMIT 5').all(`${digits}%`);
    },

    // Appointments
    listAppointments({ date, doctorId } = {}) {
      const where = [];
      const params = [];
      if (date) {
        where.push('a.date = ?');
        params.push(date);
      }
      if (doctorId) {
        where.push('a.doctor_id = ?');
        params.push(Number(doctorId));
      }
      return q(`${APPT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY a.date, a.slot_start IS NULL, a.slot_start, qe.token`).all(...params);
    },

    getAppointment,

    bookAppointment({ doctorId, date, slot, patient }) {
      const doctor = getDoctor(doctorId);
      const p = validatePatient(patient);
      return transaction(db, () => {
        assertBookable(doctor, date, slot);
        const patientId = findOrCreatePatient(p);
        let id;
        try {
          id = Number(
            q(`INSERT INTO appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at)
               VALUES (?, ?, ?, ?, 'scheduled', 'booked', ?)`).run(doctor.id, patientId, date, slot, now().toISOString()).lastInsertRowid
          );
        } catch (err) {
          // The partial unique index catches any race the check above could miss.
          if (/UNIQUE/i.test(err.message)) throw conflict(`${slot} on ${date} is already booked`);
          throw err;
        }
        notify(p.phone, `Appointment confirmed with ${doctor.name} on ${date} at ${slot}.`);
        return getAppointment(id);
      });
    },

    /** Walk-ins skip the slot and go straight into today's queue. */
    addWalkIn({ doctorId, patient }) {
      const doctor = getDoctor(doctorId);
      const p = validatePatient(patient);
      const date = today();
      if (isOnLeave(date, doctor.leaves)) throw bad(`${doctor.name} is on leave today`);
      return transaction(db, () => {
        const patientId = findOrCreatePatient(p);
        const id = Number(
          q(`INSERT INTO appointments (doctor_id, patient_id, date, slot_start, kind, status, created_at)
             VALUES (?, ?, ?, NULL, 'walkin', 'checked_in', ?)`).run(doctor.id, patientId, date, now().toISOString()).lastInsertRowid
        );
        const before = loadEntries(doctor.id, date);
        const { entries, entry } = Queue.checkIn(before, { appointmentId: id, now: now() });
        saveEntries(doctor.id, date, before, entries);
        notify(p.phone, `Walk-in registered for ${doctor.name}. Your token is ${entry.token}.`);
        return getAppointment(id);
      });
    },

    cancelAppointment(id) {
      const a = getAppointmentRow(id);
      if (a.status !== 'booked') throw conflict(`Only booked appointments can be cancelled (this one is ${a.status.replace('_', ' ')})`);
      if (a.date < today()) throw bad('Cannot cancel a past appointment');
      q("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now().toISOString(), a.id);
      const full = getAppointment(a.id);
      notify(full.patient_phone, `Your appointment with ${full.doctor_name} on ${a.date} at ${a.slot_start} is cancelled.`);
      return full;
    },

    reschedule(id, { date, slot }) {
      const a = getAppointmentRow(id);
      if (a.status !== 'booked' || a.kind !== 'scheduled') throw conflict('Only booked (not yet checked-in) appointments can be rescheduled');
      if (a.date === date && a.slot_start === slot) throw bad('That is the current slot');
      const doctor = getDoctor(a.doctor_id);
      return transaction(db, () => {
        assertBookable(doctor, date, slot, a.id);
        q('UPDATE appointments SET date = ?, slot_start = ? WHERE id = ?').run(date, slot, a.id);
        const full = getAppointment(a.id);
        notify(full.patient_phone, `Your appointment with ${doctor.name} is moved to ${date} at ${slot}.`);
        return full;
      });
    },

    // Queue
    checkIn(appointmentId) {
      const a = getAppointmentRow(appointmentId);
      if (a.status !== 'booked') throw conflict(`Cannot check in: appointment is ${a.status.replace('_', ' ')}`);
      if (a.date !== today()) throw bad(`Check-in is only allowed on the appointment day (${a.date})`);
      const doctor = getDoctor(a.doctor_id);
      if (isOnLeave(a.date, doctor.leaves)) throw bad(`${doctor.name} is on leave today — please reschedule`);
      return transaction(db, () => {
        const before = loadEntries(doctor.id, a.date);
        const { entries, entry } = Queue.checkIn(before, { appointmentId: a.id, now: now() });
        saveEntries(doctor.id, a.date, before, entries);
        q("UPDATE appointments SET status = 'checked_in' WHERE id = ?").run(a.id);
        const full = getAppointment(a.id);
        notify(full.patient_phone, `You are checked in for ${doctor.name}. Your token is ${entry.token}.`);
        return full;
      });
    },

    getQueue,
    callNext: (doctorId) => queueAction(doctorId, (entries) => Queue.callNext(entries, { now: now() })),
    markDone: (doctorId) => queueAction(doctorId, (entries) => Queue.markDone(entries, { now: now() })),
    skip: (doctorId) => queueAction(doctorId, (entries) => Queue.skip(entries, { now: now() })),

    // Reports
    getReport(date = today()) {
      if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
      return q('SELECT * FROM doctors ORDER BY name').all().map((d) => {
        const appts = q('SELECT * FROM appointments WHERE doctor_id = ? AND date = ?').all(d.id, date);
        const entries = loadEntries(d.id, date);
        const live = appts.filter((a) => a.status !== 'cancelled');
        const waits = entries.filter((e) => e.state === 'done' && e.called_at).map((e) => minutesBetween(e.checked_in_at, e.called_at));
        const consults = entries.filter((e) => e.state === 'done' && e.called_at && e.served_at).map((e) => minutesBetween(e.called_at, e.served_at));
        const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
        return {
          doctor_id: d.id,
          doctor_name: d.name,
          department: d.department,
          booked: live.filter((a) => a.kind === 'scheduled').length,
          walk_ins: live.filter((a) => a.kind === 'walkin').length,
          cancelled: appts.length - live.length,
          checked_in: entries.length,
          seen: entries.filter((e) => e.state === 'done').length,
          no_shows: entries.filter((e) => e.state === 'no_show').length,
          not_arrived: live.filter((a) => a.status === 'booked').length,
          still_in_queue: entries.filter((e) => e.state === 'waiting' || e.state === 'serving').length,
          avg_wait_min: avg(waits),
          avg_consult_min: avg(consults),
        };
      });
    },

    listNotifications(limit = 100) {
      return q('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(Number(limit));
    },
  };

  function getQueue(doctorId, date = today()) {
    const doctor = getDoctorRow(doctorId);
    const rows = q(
      `SELECT qe.*, p.name AS patient_name, p.age AS patient_age, a.kind, a.slot_start
       FROM queue_entries qe
       JOIN appointments a ON a.id = qe.appointment_id
       JOIN patients p ON p.id = a.patient_id
       WHERE qe.doctor_id = ? AND qe.date = ?`
    ).all(doctor.id, date);
    return { doctor, date, ...Queue.viewQueue(rows) };
  }

  return api;
}

module.exports = { createServices, AppError, maskPhone, validatePatient, validateSchedules };
