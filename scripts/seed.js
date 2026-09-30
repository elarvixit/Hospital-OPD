'use strict';

// Load demo data into Supabase:  npm run seed   (reads SUPABASE_* and APP_TIMEZONE from .env)
const { createRepo } = require('../src/repo');
const { seedDemo } = require('../src/seed');

(async () => {
  const { repo, kind } = createRepo();
  if (kind !== 'supabase') {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first (see .env.example).');
    process.exit(1);
  }
  const seeded = await seedDemo(repo, { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' });
  console.log(seeded ? 'Demo data loaded into Supabase.' : 'Doctors already exist — nothing seeded.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
