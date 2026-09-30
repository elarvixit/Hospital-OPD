'use strict';

// Local development server. On Vercel, api/index.js is used instead.
const { createApp } = require('./app');
const { createServices } = require('./services');
const { createRepo } = require('./repo');
const { seedDemo } = require('./seed');

async function main() {
  const { repo, kind } = createRepo();
  const timeZone = process.env.APP_TIMEZONE || undefined;
  if (kind === 'memory') {
    console.log('No Supabase credentials found — using an in-memory database with demo data (lost on restart).');
    await seedDemo(repo, { timeZone });
  } else {
    console.log('Using Supabase.');
  }
  const port = Number(process.env.PORT) || 3000;
  createApp(createServices(repo, { timeZone })).listen(port, () => {
    console.log(`OPD running at http://localhost:${port}`);
    console.log(`Waiting-room display: http://localhost:${port}/display.html`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
