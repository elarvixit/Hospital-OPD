'use strict';

const { AppError, SlotTakenError, LeaveOverlapError, QueueConflictError } = require('./errors');
const { isValidDate, isValidTime, toMinutes, addDays, localDate, minutesBetween, WEEKDAY_NAMES } = require('./core/time');
const { generateDaySlots, isOnLeave, mergeIntervals } = require('./core/slots');
const Queue = require('./core/queue');

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

const QUEUE_FIELDS = ['token', 'seq', 'state', 'skips', 'checked_in_at', 'called_at', 'served_at'];

/** Which entries the pure queue functions added/changed, and which appointments finished. */
function diffQueue(before, after) {
  const old = new Map(before.map((e) => [e.id, e]));
  const changed = [];
  const statusUpdates = [];
  for (const e of after) {
    const prev = e.id === undefined ? null : old.get(e.id);
    if (prev && QUEUE_FIELDS.every((f) => prev[f] === e[f])) continue;
    changed.push(e);
    if (prev && e.state !== prev.state && (e.state === 'done' || e.state === 'no_show')) {
      statusUpdates.push({ id: e.appointment_id, status: e.state });
    }
  }
  return { changed, statusUpdates };
}

/**
 * @param repo  a repository (src/repo/supabase.js or src/repo/memory.js)
 * @param opts.now       clock, injectable so tests can time-travel
 * @param opts.timeZone  hospital timezone, e.g. 'Asia/Kolkata' (defaults to APP_TIMEZONE, else machine local)
 */
function createServices(repo, { now = () => new Date(), timeZone = process.env.APP_TIMEZONE || undefined } = {}) {
  const today = () => localDate(now(), timeZone);

  // ---------- helpers ----------
  async function notify(phone, message) {
    await repo.insertNotification({ phone, message: `SMS sent to ${maskPhone(phone)}: ${message}`, created_at: now().toISOString() });
  }

  async function getDoctor(id) {
    const d = await repo.getDoctor(Number(id));
    if (!d) throw notFound('Doctor not found');
    return d;
  }

  async function getAppointment(id) {
    const a = await repo.getAppointment(Number(id));
    if (!a) throw notFound('Appointment not found');
    return a;
  }

  const slotsFor = (doctor, date, booked) => generateDaySlots({
    date, durationMin: doctor.duration_min, schedules: doctor.schedules, leaves: doctor.leaves, booked, now: now(), timeZone,
  });

  async function daySlots(doctor, date, excludeAppointmentId = null) {
    const booked = await repo.bookedStarts(doctor.id, date, date, excludeAppointmentId);
    return slotsFor(doctor, date, booked[date] || []);
  }

  /** Throw a helpful error if `slot` can't be booked for doctor on date. */
  async function assertBookable(doctor, date, slot, excludeAppointmentId = null) {
    if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
    if (!isValidTime(slot)) throw bad('Slot must be HH:MM');
    if (date < today()) throw bad('Cannot book a date in the past');
    const day = await daySlots(doctor, date, excludeAppointmentId);
    if (day.onLeave) throw bad(`${doctor.name} is on leave on ${date}`);
    const match = day.slots.find((s) => s.start === slot);
    if (!match) throw bad(`${slot} is not a valid slot for ${doctor.name} on ${date}`);
    if (match.status === 'booked') throw conflict(`${slot} on ${date} is already booked`);
    if (match.status === 'past') throw bad(`${slot} on ${date} is in the past`);
  }

  const runQueue = (fn) => {
    try { return fn(); } catch (err) {
      if (err instanceof Queue.QueueError) throw conflict(err.message);
      throw err;
    }
  };

  async function saveQueue(doctorId, date, version, before, after, extraStatusUpdates = []) {
    const { changed, statusUpdates } = diffQueue(before, after);
    await repo.applyQueue(doctorId, date, version, changed, [...statusUpdates, ...extraStatusUpdates]);
  }

  /**
   * Put an appointment in today's line. Two desks checking people in at the same moment
   * both read the same queue version; the loser simply re-reads and takes the next token.
   */
  async function enqueue(doctorId, date, appointmentId, extraStatusUpdates) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { version, entries } = await repo.loadQueue(doctorId, date);
      const { entries: after, entry } = runQueue(() => Queue.checkIn(entries, { appointmentId, now: now() }));
      try {
        await saveQueue(doctorId, date, version, entries, after, extraStatusUpdates);
        return entry;
      } catch (err) {
        if (!(err instanceof QueueConflictError)) throw err;
      }
    }
    throw conflict('The queue is busy — please try again');
  }

  /**
   * Done / Skip / Call next. Unlike check-in these are NOT retried on a conflict: if two
   * screens press Done at the same time, only the first should advance the queue.
   */
  async function queueAction(doctorId, fn) {
    const doctor = await getDoctor(doctorId);
    const date = today();
    const { version, entries } = await repo.loadQueue(doctor.id, date);
    const result = runQueue(() => fn(entries));
    try {
      await saveQueue(doctor.id, date, version, entries, result.entries);
    } catch (err) {
      if (err instanceof QueueConflictError) throw conflict('The queue was just updated from another screen — refreshed, please try again');
      throw err;
    }
    if (result.called) {
      const e = result.called;
      const phone = e.patient_phone || (await getAppointment(e.appointment_id)).patient_phone;
      await notify(phone, `Token ${e.token}, please proceed to ${doctor.name}${doctor.room ? ` (Room ${doctor.room})` : ''}.`);
    }
    return getQueue(doctor.id, date);
  }

  async function getQueue(doctorId, date = today()) {
    const doctor = await getDoctor(doctorId);
    const { entries } = await repo.loadQueue(doctor.id, date);
    return { doctor, date, ...Queue.viewQueue(entries) };
  }

  // ---------- public API ----------
  return {
    today,

    // Doctors
    listDoctors: () => repo.listDoctors(),
    getDoctor,

    async createDoctor(input) {
      const d = validateDoctorInput(input);
      const schedules = validateSchedules(input.schedules || [], d.duration_min);
      const id = await repo.saveDoctor({ ...d, room: d.room ?? null, schedules });
      return getDoctor(id);
    },

    async updateDoctor(id, input) {
      const current = await getDoctor(id);
      const d = { ...current, ...validateDoctorInput(input, { partial: true }) };
      const schedules = input.schedules !== undefined ? validateSchedules(input.schedules, d.duration_min) : null;
      await repo.saveDoctor({ id: current.id, name: d.name, department: d.department, duration_min: d.duration_min, room: d.room ?? null, schedules });
      return getDoctor(current.id);
    },

    /** Adds a leave range. Returns the live appointments that now need rescheduling. */
    async addLeave(doctorId, { start_date, end_date, reason } = {}) {
      const doctor = await getDoctor(doctorId);
      end_date = end_date || start_date;
      if (!isValidDate(start_date) || !isValidDate(end_date)) throw bad('Leave dates must be YYYY-MM-DD');
      if (end_date < start_date) throw bad('Leave end date is before start date');
      let leave;
      try {
        leave = await repo.insertLeave({ doctor_id: doctor.id, start_date, end_date, reason: reason || null });
      } catch (err) {
        if (err instanceof LeaveOverlapError) throw conflict('This leave overlaps an existing leave');
        throw err;
      }
      const affected = await repo.listAppointments({ doctorId: doctor.id, from: start_date, to: end_date, status: 'booked' });
      return { ...leave, affected };
    },

    async removeLeave(leaveId) {
      if (!(await repo.deleteLeave(Number(leaveId)))) throw notFound('Leave not found');
      return { ok: true };
    },

    // Slots
    async getSlots(doctorId, date) {
      if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
      const doctor = await getDoctor(doctorId);
      return { doctor_id: doctor.id, ...(await daySlots(doctor, date)) };
    },

    /** The next `count` free slots from now, scanning forward up to `horizonDays`. One DB read. */
    async nextFreeSlots(doctorId, { count = 3, fromDate = today(), horizonDays = 60 } = {}) {
      const doctor = await getDoctor(doctorId);
      const start = !isValidDate(fromDate) || fromDate < today() ? today() : fromDate;
      const booked = await repo.bookedStarts(doctor.id, start, addDays(start, horizonDays - 1));
      const found = [];
      for (let i = 0; i < horizonDays && found.length < count; i++) {
        const date = addDays(start, i);
        for (const s of slotsFor(doctor, date, booked[date] || []).slots) {
          if (s.status === 'available') found.push({ date, start: s.start, end: s.end });
          if (found.length === count) break;
        }
      }
      return found;
    },

    // Patients
    async findPatients(phone) {
      const digits = String(phone || '').replace(/\D/g, '');
      if (digits.length < 3) return [];
      return repo.findPatientsByPhonePrefix(digits);
    },

    // Appointments
    listAppointments: ({ date, doctorId } = {}) => repo.listAppointments({ date, doctorId: doctorId ? Number(doctorId) : undefined }),
    getAppointment,

    async bookAppointment({ doctorId, date, slot, patient } = {}) {
      const doctor = await getDoctor(doctorId);
      const p = validatePatient(patient);
      await assertBookable(doctor, date, slot);
      const patientId = await repo.findOrCreatePatient(p);
      let id;
      try {
        id = await repo.insertAppointment({
          doctor_id: doctor.id, patient_id: patientId, date, slot_start: slot, kind: 'scheduled', status: 'booked', created_at: now().toISOString(),
        });
      } catch (err) {
        // The unique index catches the race where two desks book the same slot at once.
        if (err instanceof SlotTakenError) throw conflict(`${slot} on ${date} is already booked`);
        throw err;
      }
      await notify(p.phone, `Appointment confirmed with ${doctor.name} on ${date} at ${slot}.`);
      return getAppointment(id);
    },

    /** Walk-ins skip the slot and go straight into today's queue. */
    async addWalkIn({ doctorId, patient } = {}) {
      const doctor = await getDoctor(doctorId);
      const p = validatePatient(patient);
      const date = today();
      if (isOnLeave(date, doctor.leaves)) throw bad(`${doctor.name} is on leave today`);
      const patientId = await repo.findOrCreatePatient(p);
      const id = await repo.insertAppointment({
        doctor_id: doctor.id, patient_id: patientId, date, slot_start: null, kind: 'walkin', status: 'checked_in', created_at: now().toISOString(),
      });
      let entry;
      try {
        entry = await enqueue(doctor.id, date, id, []);
      } catch (err) {
        await repo.deleteAppointment(id); // don't leave a walk-in that isn't in the queue
        throw err;
      }
      await notify(p.phone, `Walk-in registered for ${doctor.name}. Your token is ${entry.token}.`);
      return getAppointment(id);
    },

    async cancelAppointment(id) {
      const a = await getAppointment(id);
      if (a.status !== 'booked') throw conflict(`Only booked appointments can be cancelled (this one is ${a.status.replace('_', ' ')})`);
      if (a.date < today()) throw bad('Cannot cancel a past appointment');
      // Conditional update: if they were checked in a moment ago, this changes nothing.
      const ok = await repo.updateAppointment(a.id, { status: 'cancelled', cancelled_at: now().toISOString() }, { whereStatus: 'booked' });
      if (!ok) throw conflict('This appointment was just updated — please refresh');
      await notify(a.patient_phone, `Your appointment with ${a.doctor_name} on ${a.date} at ${a.slot_start} is cancelled.`);
      return getAppointment(a.id);
    },

    async reschedule(id, { date, slot } = {}) {
      const a = await getAppointment(id);
      if (a.status !== 'booked' || a.kind !== 'scheduled') throw conflict('Only booked (not yet checked-in) appointments can be rescheduled');
      if (a.date === date && a.slot_start === slot) throw bad('That is the current slot');
      const doctor = await getDoctor(a.doctor_id);
      await assertBookable(doctor, date, slot, a.id);
      let ok;
      try {
        ok = await repo.updateAppointment(a.id, { date, slot_start: slot }, { whereStatus: 'booked' });
      } catch (err) {
        if (err instanceof SlotTakenError) throw conflict(`${slot} on ${date} is already booked`);
        throw err;
      }
      if (!ok) throw conflict('This appointment was just updated — please refresh');
      await notify(a.patient_phone, `Your appointment with ${doctor.name} is moved to ${date} at ${slot}.`);
      return getAppointment(a.id);
    },

    // Queue
    async checkIn(appointmentId) {
      const a = await getAppointment(appointmentId);
      if (a.status !== 'booked') throw conflict(`Cannot check in: appointment is ${a.status.replace('_', ' ')}`);
      if (a.date !== today()) throw bad(`Check-in is only allowed on the appointment day (${a.date})`);
      const doctor = await getDoctor(a.doctor_id);
      if (isOnLeave(a.date, doctor.leaves)) throw bad(`${doctor.name} is on leave today — please reschedule`);
      const entry = await enqueue(doctor.id, a.date, a.id, [{ id: a.id, status: 'checked_in' }]);
      await notify(a.patient_phone, `You are checked in for ${doctor.name}. Your token is ${entry.token}.`);
      return getAppointment(a.id);
    },

    getQueue,

    /** Every doctor's queue for today, in one read (used by the live queue + waiting screen). */
    async getAllQueues() {
      const date = today();
      const [doctors, entries] = await Promise.all([repo.listDoctors(), repo.listQueueByDate(date)]);
      return doctors.map((doctor) => ({ doctor, date, ...Queue.viewQueue(entries.filter((e) => e.doctor_id === doctor.id)) }));
    },

    callNext: (doctorId) => queueAction(doctorId, (entries) => Queue.callNext(entries, { now: now() })),
    markDone: (doctorId) => queueAction(doctorId, (entries) => Queue.markDone(entries, { now: now() })),
    skip: (doctorId) => queueAction(doctorId, (entries) => Queue.skip(entries, { now: now() })),

    // Reports
    async getReport(date = today()) {
      if (!isValidDate(date)) throw bad('Date must be YYYY-MM-DD');
      const [doctors, appointments, queue] = await Promise.all([repo.listDoctors(), repo.listAppointments({ date }), repo.listQueueByDate(date)]);
      const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
      return doctors.map((d) => {
        const appts = appointments.filter((a) => a.doctor_id === d.id);
        const entries = queue.filter((e) => e.doctor_id === d.id);
        const live = appts.filter((a) => a.status !== 'cancelled');
        const seen = entries.filter((e) => e.state === 'done');
        return {
          doctor_id: d.id,
          doctor_name: d.name,
          department: d.department,
          booked: live.filter((a) => a.kind === 'scheduled').length,
          walk_ins: live.filter((a) => a.kind === 'walkin').length,
          cancelled: appts.length - live.length,
          checked_in: entries.length,
          seen: seen.length,
          no_shows: entries.filter((e) => e.state === 'no_show').length,
          not_arrived: live.filter((a) => a.status === 'booked').length,
          still_in_queue: entries.filter((e) => e.state === 'waiting' || e.state === 'serving').length,
          avg_wait_min: avg(seen.filter((e) => e.called_at).map((e) => minutesBetween(e.checked_in_at, e.called_at))),
          avg_consult_min: avg(seen.filter((e) => e.called_at && e.served_at).map((e) => minutesBetween(e.called_at, e.served_at))),
        };
      });
    },

    listNotifications: (limit = 100) => repo.listNotifications(Number(limit)),
  };
}

module.exports = { createServices, AppError, maskPhone, validatePatient, validateSchedules };
