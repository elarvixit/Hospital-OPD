'use strict';

const { createClient } = require('@supabase/supabase-js');
const { SlotTakenError, LeaveOverlapError, QueueConflictError } = require('../errors');

// Every table/view/function in supabase/schema.sql starts with this prefix.
const PREFIX = 'ganesh_hospitalopd_';
const T = {
  doctors: `${PREFIX}doctors`,
  schedules: `${PREFIX}schedules`,
  leaves: `${PREFIX}leaves`,
  patients: `${PREFIX}patients`,
  appointments: `${PREFIX}appointments`,
  queueDays: `${PREFIX}queue_days`,
  queueEntries: `${PREFIX}queue_entries`,
  notifications: `${PREFIX}notifications`,
  appointmentDetails: `${PREFIX}appointment_details`,
  queueDetails: `${PREFIX}queue_details`,
  saveDoctor: `${PREFIX}save_doctor`,
  applyQueue: `${PREFIX}apply_queue`,
};

const QUEUE_FIELDS = ['id', 'appointment_id', 'token', 'seq', 'state', 'skips', 'checked_in_at', 'called_at', 'served_at'];

function toRepoError(error) {
  const text = `${error.message} ${error.details || ''}`;
  if (error.code === '23505' && text.includes('appointments_slot_uniq')) return new SlotTakenError(error.message);
  if (error.code === '23505' && text.includes('queue_entries')) return new QueueConflictError(error.message);
  if (error.code === '23P01' && text.includes('leaves_no_overlap')) return new LeaveOverlapError(error.message);
  if (error.code === '40001') return new QueueConflictError(error.message);
  const err = new Error(`Database error: ${error.message}`);
  err.cause = error;
  return err;
}

function unwrap({ data, error }) {
  if (error) throw toRepoError(error);
  return data;
}

const sortDoctor = (d) => {
  d.schedules = (d.schedules || []).sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
  d.leaves = (d.leaves || []).sort((a, b) => a.start_date.localeCompare(b.start_date));
  return d;
};
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function createSupabaseRepo({ url, key }) {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const DOCTOR_SELECT = `*, schedules:${T.schedules}(id, weekday, start_time, end_time), leaves:${T.leaves}(id, start_date, end_date, reason)`;

  return {
    // ----- doctors -----
    async listDoctors() {
      return unwrap(await db.from(T.doctors).select(DOCTOR_SELECT).order('name')).map(sortDoctor);
    },

    async getDoctor(id) {
      const d = unwrap(await db.from(T.doctors).select(DOCTOR_SELECT).eq('id', id).maybeSingle());
      return d && sortDoctor(d);
    },

    /** Create (no id) or update a doctor; schedules === null keeps the existing schedule. */
    async saveDoctor({ id = null, name, department, duration_min, room, schedules }) {
      return unwrap(await db.rpc(T.saveDoctor, {
        p_id: id, p_name: name, p_department: department, p_duration_min: duration_min, p_room: room ?? null, p_schedules: schedules ?? null,
      }));
    },

    async insertLeave(row) {
      return unwrap(await db.from(T.leaves).insert(row).select().single());
    },

    async deleteLeave(id) {
      return unwrap(await db.from(T.leaves).delete().eq('id', id).select('id')).length > 0;
    },

    // ----- patients -----
    async findOrCreatePatient({ name, phone, age }) {
      const find = async () => unwrap(await db.from(T.patients).select('id, age').eq('phone', phone).ilike('name', escapeLike(name)).limit(1).maybeSingle());
      let p = await find();
      if (!p) {
        const { data, error } = await db.from(T.patients).insert({ name, phone, age }).select('id, age').single();
        if (error && error.code === '23505') p = await find(); // created by someone else a moment ago
        else p = unwrap({ data, error });
      }
      if (p.age !== age) unwrap(await db.from(T.patients).update({ age }).eq('id', p.id));
      return p.id;
    },

    async findPatientsByPhonePrefix(prefix) {
      return unwrap(await db.from(T.patients).select('*').like('phone', `${prefix}%`).order('name').limit(5));
    },

    // ----- appointments -----
    /** { 'YYYY-MM-DD': ['10:00', ...] } for live (non-cancelled) slot bookings in [from, to]. */
    async bookedStarts(doctorId, from, to, excludeAppointmentId = null) {
      let q = db.from(T.appointments).select('date, slot_start')
        .eq('doctor_id', doctorId).gte('date', from).lte('date', to)
        .neq('status', 'cancelled').not('slot_start', 'is', null);
      if (excludeAppointmentId) q = q.neq('id', excludeAppointmentId);
      const out = {};
      for (const r of unwrap(await q)) (out[r.date] ||= []).push(r.slot_start);
      return out;
    },

    async insertAppointment(row) {
      return unwrap(await db.from(T.appointments).insert(row).select('id').single()).id;
    },

    /** Update only if the current status is `whereStatus` (when given). Returns true if a row changed. */
    async updateAppointment(id, patch, { whereStatus } = {}) {
      let q = db.from(T.appointments).update(patch).eq('id', id);
      if (whereStatus) q = q.eq('status', whereStatus);
      return unwrap(await q.select('id')).length > 0;
    },

    async deleteAppointment(id) {
      unwrap(await db.from(T.appointments).delete().eq('id', id));
    },

    async getAppointment(id) {
      return unwrap(await db.from(T.appointmentDetails).select('*').eq('id', id).maybeSingle());
    },

    async listAppointments({ date, doctorId, from, to, status } = {}) {
      let q = db.from(T.appointmentDetails).select('*');
      if (date) q = q.eq('date', date);
      if (from) q = q.gte('date', from);
      if (to) q = q.lte('date', to);
      if (doctorId) q = q.eq('doctor_id', doctorId);
      if (status) q = q.eq('status', status);
      q = q.order('date').order('slot_start', { nullsFirst: false }).order('token', { nullsFirst: false });
      return unwrap(await q);
    },

    // ----- queue -----
    async loadQueue(doctorId, date) {
      const [day, entries] = await Promise.all([
        db.from(T.queueDays).select('version').eq('doctor_id', doctorId).eq('date', date).maybeSingle(),
        db.from(T.queueDetails).select('*').eq('doctor_id', doctorId).eq('date', date),
      ]);
      return { version: unwrap(day)?.version ?? 0, entries: unwrap(entries) };
    },

    async listQueueByDate(date) {
      return unwrap(await db.from(T.queueDetails).select('*').eq('date', date));
    },

    /** Atomically write changed/new entries + appointment statuses; throws QueueConflictError on a stale version. */
    async applyQueue(doctorId, date, version, entries, appointmentUpdates) {
      const pick = (e) => Object.fromEntries(QUEUE_FIELDS.map((f) => [f, e[f] ?? null]));
      return unwrap(await db.rpc(T.applyQueue, {
        p_doctor_id: doctorId, p_date: date, p_version: version, p_entries: entries.map(pick), p_appointment_updates: appointmentUpdates,
      }));
    },

    // ----- notifications -----
    async insertNotification(row) {
      unwrap(await db.from(T.notifications).insert(row));
    },

    async listNotifications(limit) {
      return unwrap(await db.from(T.notifications).select('*').order('id', { ascending: false }).limit(limit));
    },
  };
}

module.exports = { createSupabaseRepo, TABLES: T, PREFIX };
