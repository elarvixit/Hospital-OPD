'use strict';

// Vercel serverless entry point: every /api/* request is rewritten here (see vercel.json).
const { createApp } = require('../src/app');
const { createServices } = require('../src/services');
const { createRepo } = require('../src/repo');

let handler;
try {
  const { repo } = createRepo();
  handler = createApp(createServices(repo, { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }));
} catch (err) {
  // Missing env vars: answer every request with a clear message instead of crashing.
  console.error(err.message);
  handler = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  };
}

module.exports = handler;
