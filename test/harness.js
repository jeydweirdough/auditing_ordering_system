// Starts everything a test needs on this machine: an empty Postgres (PGlite,
// in memory), getmeds-system's schema plus this app's migration, the dev seed,
// and the app itself on a free port with Zoho in mock mode and file uploads
// going to a temp folder. Nothing reaches the network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startDevDb } = require('../scripts/dev-db');

// TEST_DATABASE_URL: a local Postgres that is already running (e.g.
// `node scripts/dev-db.js --memory`), wiped at the start of each run. Saves
// loading PGlite in every test process, which needs ~1 GB free.
async function useRunningDb(url) {
  if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('TEST_DATABASE_URL must be a database on this machine: the tests wipe it.');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  return { url, stop: async () => {} };
}

async function startStack() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const devDb = process.env.TEST_DATABASE_URL
    ? await useRunningDb(process.env.TEST_DATABASE_URL)
    : await startDevDb({ memory: true, port, quiet: true });
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-test-'));
  Object.assign(process.env, {
    DATABASE_URL: devDb.url,
    PGPOOL_MAX: '4',
    ZOHO_MODE: 'mock',
    ZOHO_DRY_RUN: 'false',
    ZOHO_TEST_CUSTOMER_IDS: '',
    DEV_STORAGE_DIR: storage,
    SESSION_SECRET: 'test-session-secret',
    JWT_SECRET: 'test-jwt-secret',
    CRON_SECRET: 'test-cron-secret',
    DISCORD_AUDIT_ENABLED: 'false',
    NODE_ENV: 'test',
  });
  delete process.env.SUPABASE_URL;
  delete process.env.ORBIT_WEB_URL;
  const { migrate } = require('../src/db/migrate');
  await migrate({ url: devDb.url, quiet: true });
  const { seed } = require('../scripts/seed-dev');
  const seeded = await seed(devDb.url, { quiet: true });

  const app = require('../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = base;

  return {
    base,
    seeded,
    async stop() {
      await new Promise((r) => server.close(r));
      await require('../src/db').close();
      await devDb.stop();
      fs.rmSync(storage, { recursive: true, force: true });
    },
  };
}

// A signed-in person: remembers their cookie, and answers with { status, body }.
function client(base) {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    patch: (u, b = {}) => call('PATCH', u, b),
    del: (u) => call('DELETE', u),
    async login(email, password = 'orders-dev-1') {
      const r = await call('POST', '/api/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.user;
    },
    // The three-call upload: ask for a URL, PUT the bytes, confirm.
    async upload(orderId, { name, kind, bytes = Buffer.from('test file'), type = 'image/png' }) {
      const u = await call('POST', `/api/orders/${orderId}/files/upload-url`, { fileName: name, contentType: type, fileSize: bytes.length, kind });
      if (u.status !== 200) throw new Error(`upload-url: ${u.status} ${JSON.stringify(u.body)}`);
      const put = await fetch(u.body.signedUrl, { method: 'PUT', body: bytes, headers: { 'content-type': type } });
      if (!put.ok) throw new Error(`PUT: ${put.status}`);
      return call('POST', `/api/orders/${orderId}/files`, { storagePath: u.body.storagePath, fileName: name, contentType: type, fileSize: bytes.length, kind });
    },
  };
}

module.exports = { startStack, client };
