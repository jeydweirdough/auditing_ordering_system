const path = require('path');
const express = require('express');
const accounts = require('./accounts');
const orders = require('./orders');
const configStore = require('./configStore');
const products = require('./products');

const app = express();

// All records (orders, config/settings, products, accounts) are read back from Discord before anything is answered.
// `npm start` waits for it before listening; Vercel imports this file instead of running it, so there
// the first request waits for it.
let loading = null;
const ready = () => (loading ??= Promise.all([
  orders.load(),
  configStore.loadFromDiscord(),
  products.loadFromDiscord(),
  accounts.loadFromDiscord(),
]));
app.use((_req, _res, next) => { ready().then(() => next(), next); });

app.use(express.json({ limit: '5mb' }));   // a new order's files come base64-encoded in the JSON
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multi-page routing
const servePage = (filename) => (_req, res) => {
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.sendFile(path.join(__dirname, '..', 'public', filename));
};

app.get('/login', servePage('login.html'));
app.get('/dashboard', servePage('dashboard.html'));
app.get('/orders', servePage('orders.html'));
app.get('/order', servePage('order.html'));
app.get('/new-order', servePage('new-order.html'));
// Administration is Orbit's. Accounts, roles, the order form's lists and
// fields, and promos were all kept here too once — the same things in two
// places, each able to disagree with the other. They are Orbit's alone now, and
// anyone reaching for them here is sent to the screen that holds them.
//
// The pages themselves are gone, not hidden: public/people.html and the rest
// were deleted, so there is no address left that serves them.
const ORBIT_WEB = (process.env.ORBIT_WEB_URL || '').replace(/\/$/, '');
const movedToOrbit = (where, what) => (_req, res) => {
  if (ORBIT_WEB) return res.redirect(`${ORBIT_WEB}${where}`);
  res.status(503).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Moved to Orbit</title>` +
    `<body style="font:16px/1.5 system-ui;margin:3rem;max-width:34rem">` +
    `<h1 style="font-size:1.3rem">${what} is managed in Orbit</h1>` +
    `<p>It isn't kept in the Orders app any more. Set <code>ORBIT_WEB_URL</code> ` +
    `in this app's <code>.env</code> and this page will take you straight there.</p>` +
    `<p><a href="/dashboard">Back to the dashboard</a></p>`
  );
};

app.get('/people', movedToOrbit('/settings/people', 'Who can sign in'));
app.get('/settings', movedToOrbit('/settings/orders', "The order form's lists, fields and rules"));
app.get('/promotions', movedToOrbit('/m/inventory/promos', 'Promos and bundles'));
app.get(['/', '/app'], (_req, res) => res.redirect('/dashboard'));
app.use('/api', accounts.router);
app.use('/api/orders', orders.router);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "the request body isn't valid JSON" });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The files are too large to send. Keep them under 3 MB in all.' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 4000;
if (require.main === module) {
  ready().then(() => {
    app.listen(port, () => console.log(`orders app on http://localhost:${port}/app`));
  });
}

module.exports = app;
