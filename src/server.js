const path = require('path');
const express = require('express');
const accounts = require('./accounts');
const orders = require('./orders');
const configStore = require('./configStore');
const products = require('./products');

const app = express();

// All records (orders, config/settings, products) are read back from Discord before anything is answered.
// `npm start` waits for it before listening; Vercel imports this file instead of running it, so there
// the first request waits for it.
let loading = null;
const ready = () => (loading ??= Promise.all([
  orders.load(),
  configStore.loadFromDiscord(),
  products.loadFromDiscord(),
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
app.get('/people', servePage('people.html'));
app.get('/settings', servePage('settings.html'));
app.get('/promotions', servePage('promotions.html'));
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
