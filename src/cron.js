// Scheduled jobs, as URLs a scheduler calls (Vercel Cron, GitHub Actions),
// because serverless hosting keeps no timer running between requests. Every
// one needs `Authorization: Bearer $CRON_SECRET` (or ?key=) and refuses to run
// when CRON_SECRET isn't set.
//
//   /api/cron/auto-sync        getmeds-system's: re-checks a batch of open orders
//                              against Zoho, refreshes the Salesperson list, and
//                              clears old notifications
//   /api/cron/zoho-retry       getmeds-system's: retries failed Sales Orders
//                              (only with ZOHO_AUTO_RETRY_ENABLED=true)
//   /api/cron/purge-deleted    this app's: removes orders 30 days in the Recycle Bin
//   /api/cron/health           when each job last ran
//
// Each job holds a lease in the database while it runs (cronLock), so two
// schedulers, or this app and getmeds-system on the same database, never run
// the same job at once.
const express = require('express');
const coreCron = require('./core/routes/cron.routes');
const { withLock } = require('./core/services/cronLock');

function authorized(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'CRON_SECRET is not set. Refusing to run an unauthenticated scheduled job.' });
    return false;
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.query.key;
  if (provided !== secret) {
    res.status(401).json({ error: 'Bad cron secret' });
    return false;
  }
  return true;
}

const router = express.Router();

router.all('/purge-deleted', async (req, res, next) => {
  if (!authorized(req, res)) return;
  try {
    const { purgeExpired } = require('./orders');
    const outcome = await withLock('purge_deleted', 4 * 60 * 1000, purgeExpired);
    res.json(outcome.ran ? { ran: true, ...outcome.result } : { ran: false, reason: 'another run holds the lock' });
  } catch (err) {
    next(err);
  }
});

router.use(coreCron);

module.exports = { router };
