// `npm run dev` on a developer's machine with no DATABASE_URL: the app starts
// its own Postgres (PGlite, kept in data/pgdata), sets it up (getmeds-system's
// schema plus this app's migration) and fills it with test accounts the first
// time. It never touches the shared Supabase database; for that, set
// DATABASE_URL yourself.
//
// With a local database, Zoho is forced to mock mode: a .env copied from a
// real setup can say ZOHO_MODE=live, and approving a test order would then
// create a real Sales Order. Set ZOHO_ALLOW_LIVE_LOCALLY=true to override.
//
// Never active in production (NODE_ENV=production or on Vercel).
const path = require('path');

const LOCAL_PORT = Number(process.env.DEV_DB_PORT) || 5433;
const isProduction = () => process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

let local = false;

// Sync, before anything reads the environment.
function prepareEnv() {
  if (isProduction()) return;
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'local-dev-only-jwt-secret';
    console.log('[local] JWT_SECRET not set: using a development-only one.');
  }
  if (process.env.DATABASE_URL) return;
  local = true;
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${LOCAL_PORT}/postgres?sslmode=disable`;
  process.env.PGPOOL_MAX = process.env.PGPOOL_MAX || '4';
  if (!process.env.SUPABASE_URL) process.env.DEV_STORAGE_DIR = process.env.DEV_STORAGE_DIR || path.join(__dirname, '..', 'data', 'storage');
  if (process.env.ZOHO_ALLOW_LIVE_LOCALLY !== 'true' && (process.env.ZOHO_MODE || 'mock') !== 'mock') {
    console.log(`[local] ZOHO_MODE was "${process.env.ZOHO_MODE}": using mock, so nothing reaches the real Zoho from a local database.`);
    process.env.ZOHO_MODE = 'mock';
  }
  process.env.DISCORD_AUDIT_ENABLED = 'false';
  console.log(`[local] No DATABASE_URL: using a local database in data/pgdata (127.0.0.1:${LOCAL_PORT}).`);
}

// Starts the local database and makes sure it's set up. Once per process.
let starting = null;
function startLocalDb() {
  if (!local) return Promise.resolve();
  return (starting ??= (async () => {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const reachable = async () => {
      const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      } finally {
        await pool.end().catch(() => {});
      }
    };
    // One already running (another `npm run dev`, or `npm run dev-db`) is used as it is.
    if (!(await reachable())) {
      const { startDevDb } = require('../scripts/dev-db');
      try {
        await startDevDb({ port: LOCAL_PORT });
      } catch (err) {
        const memory = /memory|allocation|RangeError/i.test(`${err.name} ${err.message}`);
        throw new Error(`the local database could not start (${err.message}).`
          + (memory ? ' It needs about 1 GB of free memory: close some programs and try again, or set DATABASE_URL.' : ''));
      }
    }
    const pool = new Pool({ connectionString: url, max: 1 });
    let setUp;
    let hasUsers;
    try {
      setUp = (await pool.query("SELECT to_regclass('public.app_config') AS t")).rows[0].t != null;
      hasUsers = setUp && (await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n > 0;
    } finally {
      await pool.end();
    }
    if (!setUp) {
      console.log('[local] Setting up the database (first run)…');
      await require('./db/migrate').migrate({ url, quiet: true });
    }
    if (!hasUsers) {
      await require('../scripts/seed-dev').seed(url);
      console.log('[local] Sign in with any of the accounts above.');
    }
  })().catch((err) => {
    starting = null;
    throw err;
  }));
}

module.exports = { prepareEnv, startLocalDb, isLocal: () => local };
