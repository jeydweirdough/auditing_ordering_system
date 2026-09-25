// A real Postgres on this machine for development and tests, with no install:
// PGlite (Postgres compiled to WebAssembly) behind a socket that speaks the
// Postgres wire protocol, so the app connects to it with the same `pg` driver
// and the same DATABASE_URL shape it uses against Supabase.
//
//   node scripts/dev-db.js            keeps its data in data/pgdata
//   node scripts/dev-db.js --memory   starts empty every time (tests)
//
// Then: DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres?sslmode=disable
//
// It is never used in production. Production is Supabase.
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

async function startDevDb({ memory = false, port = Number(process.env.DEV_DB_PORT) || 5433, quiet = false } = {}) {
  const dataDir = memory ? undefined : path.join(__dirname, '..', 'data', 'pgdata');
  if (dataDir) require('fs').mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create({ dataDir, extensions: { pg_trgm } });
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();
  if (!quiet) console.log(`[dev-db] Postgres (PGlite${memory ? ', in memory' : `, ${dataDir}`}) on 127.0.0.1:${port}`);
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

module.exports = { startDevDb };

if (require.main === module) {
  const memory = process.argv.includes('--memory');
  startDevDb({ memory }).then((h) => {
    const stop = () => h.stop().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    console.error('[dev-db] could not start:', err.message);
    process.exit(1);
  });
}
