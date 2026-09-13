const path = require('path');
const express = require('express');
const accounts = require('./accounts');
const orders = require('./orders');

const app = express();

// Orders are read back from #order-audit before anything is answered, so new order ids continue
// after the stored ones. `npm start` waits for it before listening; Vercel imports this file
// instead of running it, so there the first request waits for it.
let loading = null;
const ready = () => (loading ??= orders.load());
app.use((_req, _res, next) => { ready().then(() => next(), next); });

app.use(express.json());

// The orders app: sign-in, a dashboard per role, and each order's audit trail, mirrored to its
// thread in #order-audit (src/orders.js).
app.get('/app', (_req, res) => {
  res.set('Content-Security-Policy', "frame-ancestors 'none'");   // no other site can frame the sign-in
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});
app.get('/', (_req, res) => res.redirect('/app'));
app.use('/api', accounts.router);
app.use('/api/orders', orders.router);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "the request body isn't valid JSON" });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'the request is too large' });
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
