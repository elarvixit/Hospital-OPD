'use strict';

const path = require('node:path');
const express = require('express');
const { AppError } = require('./errors');

function createApp(services) {
  const app = express();
  app.use(express.json());
  // Locally Express serves the frontend; on Vercel the CDN serves public/ directly.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Wrap an async handler so thrown errors reach the error middleware.
  const h = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      next(err);
    }
  };
  const id = (req) => Number(req.params.id);

  app.get('/api/meta', h(() => ({ today: services.today(), serverTime: new Date().toISOString() })));

  // Doctors, schedules, leaves
  app.get('/api/doctors', h(() => services.listDoctors()));
  app.get('/api/doctors/:id', h((req) => services.getDoctor(id(req))));
  app.post('/api/doctors', h((req) => services.createDoctor(req.body)));
  app.put('/api/doctors/:id', h((req) => services.updateDoctor(id(req), req.body)));
  app.post('/api/doctors/:id/leaves', h((req) => services.addLeave(id(req), req.body)));
  app.delete('/api/leaves/:id', h((req) => services.removeLeave(id(req))));

  // Slots
  app.get('/api/doctors/:id/slots', h((req) => services.getSlots(id(req), req.query.date)));
  app.get('/api/doctors/:id/next-free', h((req) => services.nextFreeSlots(id(req), { fromDate: req.query.from, count: Number(req.query.count) || 3 })));

  // Patients
  app.get('/api/patients', h((req) => services.findPatients(req.query.phone)));

  // Appointments
  app.get('/api/appointments', h((req) => services.listAppointments({ date: req.query.date, doctorId: req.query.doctorId })));
  app.post('/api/appointments', h((req) => services.bookAppointment(req.body)));
  app.post('/api/walkins', h((req) => services.addWalkIn(req.body)));
  app.post('/api/appointments/:id/cancel', h((req) => services.cancelAppointment(id(req))));
  app.post('/api/appointments/:id/reschedule', h((req) => services.reschedule(id(req), req.body)));
  app.post('/api/appointments/:id/checkin', h((req) => services.checkIn(id(req))));

  // Queue
  app.get('/api/queue', h(() => services.getAllQueues()));
  app.get('/api/doctors/:id/queue', h((req) => services.getQueue(id(req), req.query.date || undefined)));
  app.post('/api/doctors/:id/queue/next', h((req) => services.callNext(id(req))));
  app.post('/api/doctors/:id/queue/done', h((req) => services.markDone(id(req))));
  app.post('/api/doctors/:id/queue/skip', h((req) => services.skip(id(req))));

  // Reports & notifications
  app.get('/api/reports/daily', h((req) => services.getReport(req.query.date || undefined)));
  app.get('/api/notifications', h(() => services.listNotifications()));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
