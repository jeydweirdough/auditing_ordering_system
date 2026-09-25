require('dotenv').config();
// Before anything else reads the environment: a local database and mock Zoho
// when DATABASE_URL isn't set (development only, see src/localDev.js).
const localDev = require('./localDev');
localDev.prepareEnv();
const path = require('path');
const express = require('express');
const db = require('./db');
const accounts = require('./accounts');
const orders = require('./orders');
const configStore = require('./configStore');
const products = require('./products');
const search = require('./search');
const cron = require('./cron');
const { asCore, invoke, relay } = require('./coreBridge');

const app = express();
app.disable('x-powered-by');

// The database is connected, and the settings and price list read, before
// anything is answered. `npm start` waits for it before listening; Vercel
// imports this file instead of running it, so there the first request waits.
// After that, settings are re-read at most every 30 seconds and the price list
// every minute, so a change made through another server instance shows here.
let loading = null;
const ready = () => (loading ??= localDev.startLocalDb()
  .then(() => db.ready())
  .then(() => Promise.all([configStore.load(), products.load()]))
  .catch((err) => {
    loading = null;
    throw err;
  }));
const PRICE_LIST_TTL_MS = 60_000;
app.use((_req, _res, next) => {
  ready()
    .then(() => configStore.refresh())
    .then(() => (Date.now() - products.loadedAt() > PRICE_LIST_TTL_MS ? products.load() : null))
    .then(() => next(), next);
});

// Zoho's older Workflow Rule webhooks post form-encoded; everything else is JSON.
app.use(express.json({ limit: '1mb' }));
app.use('/api/webhooks', express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const servePage = (filename) => (_req, res) => {
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.sendFile(path.join(__dirname, '..', 'public', filename));
};

app.get('/login', servePage('login.html'));
app.get('/dashboard', servePage('dashboard.html'));
app.get('/orders', servePage('orders.html'));
app.get('/order', servePage('order.html'));
app.get('/new-order', servePage('new-order.html'));
app.get('/pharmacy', servePage('pharmacy.html'));
app.get('/stock', servePage('stock.html'));
app.get('/zoho-sync', servePage('zoho-sync.html'));

// Orbit's screens, once Orbit is set up (ORBIT_WEB_URL).
const ORBIT_WEB = (process.env.ORBIT_WEB_URL || '').replace(/\/$/, '');
const movedToOrbit = (where, what) => (_req, res) => {
  if (ORBIT_WEB) return res.redirect(`${ORBIT_WEB}${where}`);
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Not here</title>'
    + '<body style="font:16px/1.5 system-ui;margin:3rem;max-width:34rem">'
    + `<h1 style="font-size:1.3rem">${what} isn't managed in the Orders app</h1>`
    + "<p>Accounts and roles are set on getmeds-system's Users screen for now.</p>"
    + '<p><a href="/dashboard">Back to the dashboard</a></p>',
  );
};
app.get('/people', movedToOrbit('/settings/people', 'Who can sign in'));
app.get('/settings', movedToOrbit('/settings/orders', "The order form's lists, fields and rules"));
app.get('/promotions', movedToOrbit('/m/inventory/promos', 'Promos and bundles'));
app.get(['/', '/app'], (_req, res) => res.redirect('/dashboard'));

app.use('/api', accounts.router);
app.use('/api/orders', orders.router);
app.use('/api/search', search.router);

// getmeds-system's own routes, for the person signed in here (src/coreBridge.js).
const signedIn = [accounts.requireUser, accounts.jsonOnly, asCore()];
app.use('/api/notifications', ...signedIn, require('./core/routes/notifications.routes'));
app.use('/api/stock-announcements', ...signedIn, require('./core/routes/stockAnnouncements.routes'));
// Dispatch's queues, the pharmacist's prescription queue and its decisions.
app.use('/api/dispatch', ...signedIn, require('./core/routes/dispatch.routes'));

// Admin: the Sales Orders that didn't reach Zoho, and retrying them.
const coreAdmin = require('./core/controllers/admin.controller');
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only Admin can see this.' }));
app.get('/api/zoho-sync/queue', accounts.requireUser, adminOnly, async (req, res, next) => {
  try {
    relay(res, await invoke(coreAdmin.getZohoQueue, req, { query: req.query }));
  } catch (err) {
    next(err);
  }
});
app.post('/api/zoho-sync/retry', accounts.requireUser, accounts.jsonOnly, adminOnly, async (req, res, next) => {
  try {
    relay(res, await invoke(coreAdmin.retryZohoQueue, req, { body: req.body ?? {} }));
  } catch (err) {
    next(err);
  }
});

// No sign-in: Zoho's webhooks carry ZOHO_WEBHOOK_SECRET, an attachment link
// carries its own signed token, and the cron URLs need CRON_SECRET.
app.use('/api/webhooks', require('./core/routes/webhook.routes'));
app.use('/api/attachment-view', require('./core/routes/attachmentView.routes'));
app.use('/api/cron', cron.router);

// Local development only: file uploads to a folder instead of Supabase.
if (process.env.DEV_STORAGE_DIR && !process.env.SUPABASE_URL) {
  app.use('/dev-storage', require('./devStorage').router());
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "the request body isn't valid JSON" });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again, and tell IT if it keeps happening.' });
});

const port = process.env.PORT || 4000;
if (require.main === module) {
  ready().then(() => {
    app.listen(port, () => console.log(`orders app on http://localhost:${port}/dashboard`));
  }).catch((err) => {
    console.error('[server] could not start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
