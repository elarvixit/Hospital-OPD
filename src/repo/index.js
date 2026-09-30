'use strict';

const { createSupabaseRepo } = require('./supabase');
const { createMemoryRepo } = require('./memory');

/** Supabase if configured; otherwise in-memory (local demo only — refused on Vercel). */
function createRepo(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { repo: createSupabaseRepo({ url, key }), kind: 'supabase' };
  if (env.VERCEL) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the Vercel project environment variables');
  }
  return { repo: createMemoryRepo(), kind: 'memory' };
}

module.exports = { createRepo };
