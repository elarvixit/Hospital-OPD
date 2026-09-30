'use strict';

const { SlotTakenError, LeaveOverlapError, QueueConflictError } = require('../errors');

/*
 * In-memory repository with the same interface and the same constraints as the Supabase one
 * (unique live slot, no overlapping leave, unique token per doctor/day, queue version check).
 * Used by the tests and for running locally without a Supabase project. Data is lost on restart.
 */
function createMemoryRepo() {
  const t = { doctors: [], schedules: [], leaves: [], patients: [], appointments: [], queueEntries: [], notifications: [] };
  const queueVersions = new Map();
  const seq = {};
  const nextId = (table) => (seq[table] = (seq[table] || 0) + 1);
  const copy = (x) => structuredClone(x);
  // Yield like a real network call would, so concurrent requests interleave in tests.
  const tick = () => new Promise((r) => setImmediate(r));
  const dayKey = (doctorId, date) => `${doctorId}|${date}`;

  const fullDoctor = (d) => ({
    ...copy(d),
    schedules: t.schedules.filter((s) => s.doctor_id === d.id)
      .sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time))
      .map(({ id, weekday, start_time, end_time }) => ({ id, weekday, start_time, end_time })),
    leaves: t.leaves.filter((l) => l.doctor_id === d.id)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .map(({ id, start_date, end_date, reason }) => ({ id, start_date, end_date, reason })),
  });

  const assertSlotFree = (row, ignoreId = null) => {
    if (row.slot_start === null || row.status === 'cancelled') return;
    const clash = t.appointments.some((a) => a.id !== ignoreId && a.doctor_id === row.doctor_id && a.date === row.date
      && a.slot_start === row.slot_start && a.status !== 'cancelled');
    if (clash) throw new SlotTakenError('duplicate key value violates unique constraint "appointments_slot_uniq"');
  };

  const appointmentDetails = (a) => {
    const p = t.patients.find((x) => x.id === a.patient_id);
    const d = t.doctors.find((x) => x.id === a.doctor_id);
    const q = t.queueEntries.find((x) => x.appointment_id === a.id);
    return {
      ...copy(a),
      patient_name: p.name, patient_phone: p.phone, patient_age: p.age,
      doctor_name: d.name, department: d.department, duration_min: d.duration_min,
      token: q?.token ?? null, queue_state: q?.state ?? null, skips: q?.skips ?? null,
    };
  };

  const queueDetails = (e) => {
    const a = t.appointments.find((x) => x.id === e.appointment_id);
    const p = t.patients.find((x) => x.id === a.patient_id);
    return { ...copy(e), patient_name: p.name, patient_age: p.age, patient_phone: p.phone, kind: a.kind, slot_start: a.slot_start };
  };

  return {
    // ----- doctors -----
    async listDoctors() {
      await tick();
      return t.doctors.slice().sort((a, b) => a.name.localeCompare(b.name)).map(fullDoctor);
    },

    async getDoctor(id) {
      await tick();
      const d = t.doctors.find((x) => x.id === id);
      return d ? fullDoctor(d) : null;
    },

    async saveDoctor({ id = null, name, department, duration_min, room, schedules }) {
      await tick();
      let d;
      if (id === null) {
        d = { id: nextId('doctors'), name, department, duration_min, room: room ?? null };
        t.doctors.push(d);
      } else {
        d = t.doctors.find((x) => x.id === id);
        if (!d) throw new Error('DOCTOR_NOT_FOUND');
        Object.assign(d, { name, department, duration_min, room: room ?? null });
      }
      if (schedules) {
        t.schedules = t.schedules.filter((s) => s.doctor_id !== d.id);
        for (const s of schedules) t.schedules.push({ id: nextId('schedules'), doctor_id: d.id, ...s });
      }
      return d.id;
    },

    async insertLeave(row) {
      await tick();
      const overlap = t.leaves.some((l) => l.doctor_id === row.doctor_id && l.start_date <= row.end_date && l.end_date >= row.start_date);
      if (overlap) throw new LeaveOverlapError('conflicting key value violates exclusion constraint "leaves_no_overlap"');
      const leave = { id: nextId('leaves'), ...row };
      t.leaves.push(leave);
      return copy(leave);
    },

    async deleteLeave(id) {
      await tick();
      const before = t.leaves.length;
      t.leaves = t.leaves.filter((l) => l.id !== id);
      return t.leaves.length < before;
    },

    // ----- patients -----
    async findOrCreatePatient({ name, phone, age }) {
      await tick();
      let p = t.patients.find((x) => x.phone === phone && x.name.toLowerCase() === name.toLowerCase());
      if (!p) {
        p = { id: nextId('patients'), name, phone, age };
        t.patients.push(p);
      }
      p.age = age;
      return p.id;
    },

    async findPatientsByPhonePrefix(prefix) {
      await tick();
      return copy(t.patients.filter((p) => p.phone.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5));
    },

    // ----- appointments -----
    async bookedStarts(doctorId, from, to, excludeAppointmentId = null) {
      await tick();
      const out = {};
      for (const a of t.appointments) {
        if (a.doctor_id !== doctorId || a.date < from || a.date > to || a.status === 'cancelled' || a.slot_start === null) continue;
        if (a.id === excludeAppointmentId) continue;
        (out[a.date] ||= []).push(a.slot_start);
      }
      return out;
    },

    async insertAppointment(row) {
      await tick();
      const a = { id: nextId('appointments'), cancelled_at: null, ...row };
      assertSlotFree(a);
      t.appointments.push(a);
      return a.id;
    },

    async updateAppointment(id, patch, { whereStatus } = {}) {
      await tick();
      const a = t.appointments.find((x) => x.id === id);
      if (!a || (whereStatus && a.status !== whereStatus)) return false;
      const next = { ...a, ...patch };
      assertSlotFree(next, a.id);
      Object.assign(a, patch);
      return true;
    },

    async deleteAppointment(id) {
      await tick();
      t.appointments = t.appointments.filter((a) => a.id !== id);
    },

    async getAppointment(id) {
      await tick();
      const a = t.appointments.find((x) => x.id === id);
      return a ? appointmentDetails(a) : null;
    },

    async listAppointments({ date, doctorId, from, to, status } = {}) {
      await tick();
      return t.appointments
        .filter((a) => (!date || a.date === date) && (!from || a.date >= from) && (!to || a.date <= to)
          && (!doctorId || a.doctor_id === doctorId) && (!status || a.status === status))
        .map(appointmentDetails)
        .sort((a, b) => a.date.localeCompare(b.date)
          || (a.slot_start === null) - (b.slot_start === null)
          || (a.slot_start || '').localeCompare(b.slot_start || '')
          || (a.token ?? Infinity) - (b.token ?? Infinity));
    },

    // ----- queue -----
    async loadQueue(doctorId, date) {
      await tick();
      return {
        version: queueVersions.get(dayKey(doctorId, date)) || 0,
        entries: t.queueEntries.filter((e) => e.doctor_id === doctorId && e.date === date).map(queueDetails),
      };
    },

    async listQueueByDate(date) {
      await tick();
      return t.queueEntries.filter((e) => e.date === date).map(queueDetails);
    },

    async applyQueue(doctorId, date, version, entries, appointmentUpdates) {
      await tick();
      const key = dayKey(doctorId, date);
      const current = queueVersions.get(key) || 0;
      if (current !== version) throw new QueueConflictError('QUEUE_CONFLICT');
      const FIELDS = ['token', 'seq', 'state', 'skips', 'checked_in_at', 'called_at', 'served_at'];
      for (const e of entries) {
        if (e.id == null) {
          if (t.queueEntries.some((x) => x.doctor_id === doctorId && x.date === date && x.token === e.token)) {
            throw new QueueConflictError('duplicate token');
          }
          const row = { id: nextId('queueEntries'), appointment_id: e.appointment_id, doctor_id: doctorId, date };
          for (const f of FIELDS) row[f] = e[f] ?? null;
          t.queueEntries.push(row);
        } else {
          const row = t.queueEntries.find((x) => x.id === e.id && x.doctor_id === doctorId && x.date === date);
          if (row) for (const f of FIELDS) row[f] = e[f] ?? null;
        }
      }
      for (const u of appointmentUpdates) {
        const a = t.appointments.find((x) => x.id === u.id);
        if (a) a.status = u.status;
      }
      queueVersions.set(key, current + 1);
      return current + 1;
    },

    // ----- notifications -----
    async insertNotification(row) {
      await tick();
      t.notifications.push({ id: nextId('notifications'), ...row });
    },

    async listNotifications(limit) {
      await tick();
      return copy(t.notifications.slice().reverse().slice(0, limit));
    },
  };
}

module.exports = { createMemoryRepo };
