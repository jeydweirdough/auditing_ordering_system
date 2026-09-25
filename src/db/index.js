// The database handle for this app: getmeds-system's own data layer
// (src/core/db/pg.js), so this app's queries and the core services it calls run
// on the same pool and inside the same transactions.
//
// It keeps better-sqlite3's call shape, which the core's 180-odd query sites
// were written against:
//
//   await db.prepare('SELECT … WHERE id = ?').get(id)
//   await db.prepare('…').all(a, b)
//   await db.prepare('INSERT …').run(a, b)      -> { changes, lastInsertRowid }
//   await db.transaction(async () => { … })()
//
// `?` placeholders are translated to $1, $2… by the core.
const db = require('../core/db/database');

let initing = null;
// Connects once per process (per serverless instance). Safe to call on every
// request; only the first call does anything.
db.ready = () => (initing ??= db.init().catch((err) => {
  initing = null;   // let the next request try again rather than failing forever
  throw err;
}));

module.exports = db;
