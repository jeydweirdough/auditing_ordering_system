// Brings a database up to what this app needs:
//
//   1. getmeds-system's own schema and migration (src/core/db/migrate.pg.js),
//      unchanged. On the shared Supabase database this is a no-op, since
//      getmeds-system has already applied it; on a fresh database (the local
//      one, a test run) it builds every table.
//   2. The values this app writes that getmeds-system never did: four order
//      statuses and two attachment kinds.
//   3. migrations/002_discord_app.sql: this app's own columns and table.
//
// Run with DATABASE_URL set to the DIRECT connection (port 5432), not the
// pooler: the pooler refuses some DDL.
//
//   npm run migrate
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

// Not execFileSync: in tests the database runs in this same process, and a
// blocking call would stop it answering the child.
const run = promisify(execFile);
const { Pool } = require('pg');

// Statuses only this app writes. Team Leader's step; an order sent back to its
// salesperson; a rejection (terminal here, where getmeds-system parks a rejected
// order on hold); and Packed, which this app keeps as its own step after
// picking (getmeds-system has one picking_packing stop).
const APP_STATUSES = ['pending_tl_approval', 'returned', 'rejected', 'packed'];
// Dispatch's photo of the packed parcel, and the proof of delivery.
const APP_FILE_TYPES = ['packing_proof', 'delivery_proof'];

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

// The CHECK constraint on exactly this column, found by the column it covers
// (the same way getmeds-system's migrate.pg.js finds it, and for its reason: a
// text match on "status" also matches zoho_sync_status's constraint).
async function checkOn(client, table, column) {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = $1 AND n.nspname = current_schema() AND c.contype = 'c'
        AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = t.oid AND a.attname = $2 AND NOT a.attisdropped)]::smallint[]`,
    [table, column],
  );
  if (rows.length !== 1) throw new Error(`expected one CHECK constraint on ${table}.${column}, found ${rows.length}`);
  const values = new Set([...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));
  return { name: rows[0].conname, def: rows[0].def, values };
}

// Adds values to a CHECK (col IN (...)) constraint, keeping every value it
// already allows.
async function widen(client, table, column, add) {
  const current = await checkOn(client, table, column);
  const missing = add.filter((v) => !current.values.has(v));
  if (!missing.length) {
    console.log(`  ✔ ${table}.${column} already allows ${add.join(', ')}`);
    return;
  }
  const list = [...current.values, ...missing].map((v) => `'${v}'`).join(', ');
  const clause = current.def.includes('IS NULL OR') ? `${column} IS NULL OR ${column} IN (${list})` : `${column} IN (${list})`;
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(current.name)}`);
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(current.name)} CHECK (${clause})`);
    await client.query('COMMIT');
    console.log(`  ↻ ${table}.${column} now also allows ${missing.join(', ')}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function migrate({ url = process.env.DATABASE_URL, core = true, quiet = false } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const log = quiet ? () => {} : console.log;
  if (core) {
    log('— getmeds-system schema (src/core/db/migrate.pg.js)');
    const { stdout: out } = await run(process.execPath, [path.join(__dirname, '..', 'core', 'db', 'migrate.pg.js')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!quiet) process.stdout.write(out.split('\n').slice(-3).join('\n'));
  }
  const ssl = /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, max: 1 });
  const client = await pool.connect();
  const origLog = console.log;
  if (quiet) console.log = () => {};
  try {
    log('— this app\'s additions');
    await widen(client, 'orders', 'status', APP_STATUSES);
    await widen(client, 'payment_proofs', 'file_type', APP_FILE_TYPES);
    await client.query(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '002_discord_app.sql'), 'utf8'));
    log('  ✔ applied migrations/002_discord_app.sql');
  } finally {
    console.log = origLog;
    client.release();
    await pool.end();
  }
}

module.exports = { migrate, APP_STATUSES, APP_FILE_TYPES };

if (require.main === module) {
  require('dotenv').config();
  migrate({ core: !process.argv.includes('--app-only') }).then(() => {
    console.log('\n✅ Database is ready for the orders app.');
  }).catch((err) => {
    console.error('\n❌', err.message);
    process.exit(1);
  });
}
