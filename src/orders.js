// The orders app: Salesperson raises an order, then Management, Finance and Dispatch each take
// their step. Admin can also create, edit, delete and restore any order. Every step and every
// Admin change is recorded in the order's audit trail.
//
// Orders are kept in Discord, not on disk: every step is posted to the order's thread in
// #order-audit with a reply holding the order's data, and the server rebuilds every order from
// those replies when it starts (src/orderAudit.js). Admin changes also get a line in the Admin
// log thread. Accounts stay in data/users.json.
//
// The steps are described once, in ACTIONS: the server checks who may take a step, and when,
// from it, and hands the same description to the page to draw each step's form.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireUser, jsonOnly, findUser, onAccountChange, ROLE_LABELS } = require('./accounts');
const { buildTransport, createOrderAudit, storageKind, snapshotOf } = require('./orderAudit');
const { createOrderCodec } = require('./orderCodec');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ORDER_ID = /^ORD-(\d{8})-(\d{4})$/;
const state = { counters: {}, orders: {} };

const STATUS = {
  pending_approval: 'Waiting for approval',
  returned: 'Sent back',
  rejected: 'Rejected',
  awaiting_payment: 'Awaiting payment',
  on_hold: 'On hold',
  ready_for_dispatch: 'Ready for dispatch',
  picking: 'Picking',
  packed: 'Packed',
  dispatched: 'Dispatched',
  completed: 'Delivered',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
};
const LIVE = Object.keys(STATUS).filter((s) => s !== 'deleted');   // every status but deleted

// Whose move it is, for "Next: Finance" on the page. Finished orders have none.
const WAITING_ON = {
  pending_approval: 'management',
  returned: 'salesperson',
  awaiting_payment: 'finance',
  on_hold: 'finance',
  ready_for_dispatch: 'dispatch',
  picking: 'dispatch',
  packed: 'dispatch',
  dispatched: 'dispatch',
};

const DIVISIONS = ['HOS | MARIKINA', 'HOS | PASIG', 'HOS | QUEZON CITY', 'HOS | MAKATI', 'HOS | TAGUIG', 'B2B', 'B2C'];
const PAYMENT_METHODS = ['Cash on delivery', 'Bank transfer', 'GCash', 'Credit terms'];

const FIELDS = {
  customerName: { label: 'Customer name', type: 'text', max: 120, required: true },
  contactNumber: { label: 'Contact number', type: 'text', max: 30 },
  address: { label: 'Delivery address', type: 'textarea', max: 300, required: true },
  division: { label: 'Division', type: 'select', options: DIVISIONS, required: true },
  paymentMethod: { label: 'Payment method', type: 'select', options: PAYMENT_METHODS, required: true },
  notes: { label: 'Notes', type: 'textarea', max: 1000 },
  note: { label: 'Note', type: 'textarea', max: 500 },
  reason: { label: 'Reason', type: 'textarea', max: 500, required: true },
  method: { label: 'Paid by', type: 'select', options: PAYMENT_METHODS, required: true },
  reference: { label: 'Reference number', type: 'text', max: 60, required: true },
  amount: { label: 'Amount received (PHP)', type: 'number', min: 0.01, max: 100_000_000, required: true },
  paidOn: { label: 'Paid on', type: 'date', required: true },
  courier: { label: 'Courier', type: 'text', max: 60, required: true },
  trackingNumber: { label: 'Tracking number', type: 'text', max: 60, required: true },
  receivedBy: { label: 'Received by', type: 'text', max: 120, required: true },
};
const ORDER_FIELDS = ['customerName', 'contactNumber', 'address', 'division', 'paymentMethod', 'notes'];
const PAYMENT_FIELDS = ['method', 'reference', 'amount', 'paidOn'];
const SHIPMENT_FIELDS = ['courier', 'trackingNumber', 'receivedBy'];

// label: the button. done: how the step reads in the audit trail. owner: a salesperson may only
// do it on their own orders. form: the step has its own form on the page. logged: Admin's steps
// also get a line in the Admin log. Admin may take any step.
const ACTIONS = {
  resubmit: { label: 'Resubmit for approval', done: 'Resubmitted', roles: ['salesperson'], from: ['returned'], to: 'pending_approval', owner: true, form: 'order' },
  approve: { label: 'Approve', done: 'Approved', roles: ['management'], from: ['pending_approval'], to: 'awaiting_payment', fields: ['note'] },
  send_back: { label: 'Send back for changes', done: 'Sent back for changes', roles: ['management'], from: ['pending_approval'], to: 'returned', fields: ['reason'] },
  reject: { label: 'Reject', done: 'Rejected', roles: ['management'], from: ['pending_approval'], to: 'rejected', fields: ['reason'], danger: true },
  verify_payment: { label: 'Verify payment', done: 'Payment verified', roles: ['finance'], from: ['awaiting_payment', 'on_hold'], to: 'ready_for_dispatch', fields: ['method', 'reference', 'amount', 'paidOn'] },
  hold: { label: 'Put on hold', done: 'Put on hold', roles: ['finance'], from: ['awaiting_payment'], to: 'on_hold', fields: ['reason'], danger: true },
  start_picking: { label: 'Start picking', done: 'Picking started', roles: ['dispatch'], from: ['ready_for_dispatch'], to: 'picking' },
  mark_packed: { label: 'Mark packed', done: 'Packed', roles: ['dispatch'], from: ['picking'], to: 'packed' },
  dispatch: { label: 'Dispatch', done: 'Dispatched', roles: ['dispatch'], from: ['packed'], to: 'dispatched', fields: ['courier', 'trackingNumber'] },
  deliver: { label: 'Mark delivered', done: 'Delivered', roles: ['dispatch'], from: ['dispatched'], to: 'completed', fields: ['receivedBy'] },
  cancel: { label: 'Cancel order', done: 'Cancelled', roles: ['salesperson', 'management'], from: ['pending_approval', 'returned', 'awaiting_payment', 'on_hold'], to: 'cancelled', owner: true, fields: ['reason'], danger: true },
  edit: { label: 'Edit order', done: 'Edited by Admin', roles: ['admin'], from: LIVE, to: null, form: 'edit', logged: 'Edited' },
  delete_order: { label: 'Delete order', done: 'Deleted by Admin', roles: ['admin'], from: LIVE, to: 'deleted', fields: ['reason'], danger: true, logged: 'Deleted' },
  restore: { label: 'Restore order', done: 'Restored by Admin', roles: ['admin'], from: ['deleted'], to: null, fields: ['reason'], logged: 'Restored' },
};
for (const [name, spec] of Object.entries(ACTIONS)) spec.name = name;

const transport = buildTransport();
const codec = createOrderCodec(process.env.RECORD_SECRET);
const audit = createOrderAudit({
  transport,
  codec,
  getOrder: (id) => state.orders[id],
  statusLabel: (s) => STATUS[s] ?? s,
  roleLabel: (r) => ROLE_LABELS[r] ?? r,
});
onAccountChange((entry) => audit.logAdmin(entry));

// Where orders live, and what happened when they were read back on startup. The page shows it.
const storage = { kind: storageKind(transport), encrypts: codec.encrypts, loaded: 0, scanned: 0, locked: 0, unreadable: 0, error: null };
const storesInDiscord = storage.kind === 'discord';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(n * 100) / 100;
const describeField = (name) => ({ name, ...FIELDS[name] });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ORD-YYYYMMDD-NNNN, dated in the Philippines rather than UTC.
function nextOrderId() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '');
  const n = (state.counters[day] ?? 0) + 1;
  state.counters[day] = n;
  return `ORD-${day}-${String(n).padStart(4, '0')}`;
}

// New ids carry on after every id already used, whether or not its order could be read.
function countIds(ids) {
  for (const id of ids) {
    const match = ORDER_ID.exec(id);
    if (match) state.counters[match[1]] = Math.max(state.counters[match[1]] ?? 0, Number(match[2]));
  }
}

function readFields(names, body) {
  const values = {};
  for (const name of names) {
    const f = FIELDS[name];
    let v = body?.[name];
    if (v == null || String(v).trim() === '') {
      if (f.required) throw bad(`${f.label} is required.`);
      values[name] = null;
      continue;
    }
    if (f.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < f.min || v > f.max) throw bad(`${f.label} must be a number from ${f.min} to ${f.max.toLocaleString('en-PH')}.`);
      v = round2(v);
    } else if (f.type === 'date') {
      v = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${f.label} must be a date.`);
    } else {
      v = String(v).trim();
      if (f.max && v.length > f.max) throw bad(`${f.label} can be at most ${f.max} characters.`);
      if (f.options && !f.options.includes(v)) throw bad(`${f.label} must be one of: ${f.options.join(', ')}.`);
    }
    values[name] = v;
  }
  return values;
}

function readItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('Add at least one item.');
  if (raw.length > 20) throw bad('An order can have at most 20 items.');
  return raw.map((item, i) => {
    const product = String(item?.product ?? '').trim();
    const number = (v) => (v == null || v === '' ? NaN : Number(v));   // a blank price is not a free item
    const qty = number(item?.qty);
    const unitPrice = number(item?.unitPrice);
    if (!product || product.length > 120) throw bad(`Item ${i + 1}: give a product name of up to 120 characters.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) throw bad(`Item ${i + 1}: quantity must be a whole number from 1 to 100,000.`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10_000_000) throw bad(`Item ${i + 1}: unit price must be from 0 to 10,000,000.`);
    return { product, qty, unitPrice: round2(unitPrice) };
  });
}

const totalOf = (items) => round2(items.reduce((sum, it) => sum + it.qty * it.unitPrice, 0));

function readOrderForm(body) {
  const values = readFields(ORDER_FIELDS, body);
  const items = readItems(body?.items);
  return { ...values, items, total: totalOf(items) };
}

// An order belongs to an active salesperson, whom Admin can pick.
function salespersonFor(id) {
  const user = findUser(Number(id));
  if (!user || user.role !== 'salesperson' || !user.active) throw bad('Pick an active salesperson for this order.');
  return user;
}

const ownerName = (order) => order.owner?.name ?? order.createdBy.name;
const canSee = (user, order) => (order.status !== 'deleted' || user.role === 'admin')
  && (user.role !== 'salesperson' || order.ownerId === user.id);

// A restored order goes back to the status it had when it was deleted.
const statusBeforeDelete = (order) => order.events.findLast((e) => e.to === 'deleted')?.from ?? 'pending_approval';

// Why this person may not take this step now, as [status, message], or null when they may.
function refuse(user, order, spec) {
  if (user.role !== 'admin' && !spec.roles.includes(user.role)) {
    return [403, `Only ${spec.roles.map((r) => ROLE_LABELS[r]).join(' or ')} can do this step.`];
  }
  if (!spec.from.includes(order.status)) return [409, `This order is ${STATUS[order.status].toLowerCase()}, so this step isn't open.`];
  if (spec.owner && user.role === 'salesperson' && order.ownerId !== user.id) {
    return [403, 'Only the salesperson who raised this order can do that.'];
  }
  return null;
}

const actionsFor = (user, order) => Object.values(ACTIONS)
  .filter((spec) => !refuse(user, order, spec))
  .map((spec) => ({
    name: spec.name,
    label: spec.label,
    to: spec.name === 'restore' ? STATUS[statusBeforeDelete(order)] : spec.to ? STATUS[spec.to] : null,
    danger: Boolean(spec.danger),
    form: spec.form ?? null,
    fields: (spec.fields ?? []).map(describeField),
  }));

// Admin's edit: any order field, the items, the salesperson, the status, and the payment and
// shipment details once they exist. Everything is checked before anything changes. Returns the
// step's new status, its details (which fields changed, and what they were before) and its note.
function applyEdit(order, body) {
  const { reason } = readFields(['reason'], body);
  const changed = [];
  const before = {};
  const shown = (v) => (v == null || v === '' ? '(empty)' : String(v));
  const note = (label, old) => {
    changed.push(label);
    before[label] = shown(old);
  };

  const present = ORDER_FIELDS.filter((k) => k in body);
  const values = readFields(present, body);
  const next = {};
  for (const k of present) {
    if ((values[k] ?? null) !== (order[k] ?? null)) {
      next[k] = values[k];
      note(FIELDS[k].label, order[k]);
    }
  }

  if ('items' in body) {
    const items = readItems(body.items);
    if (JSON.stringify(items) !== JSON.stringify(order.items)) {
      next.items = items;
      next.total = totalOf(items);
      note('Items', plural(order.items.length, 'item'));
      if (next.total !== order.total) note('Total', order.total.toFixed(2));
    }
  }

  let owner = null;
  if (body.ownerId != null && body.ownerId !== '' && Number(body.ownerId) !== order.ownerId) {
    owner = salespersonFor(body.ownerId);
    note('Salesperson', ownerName(order));
  }

  let to = order.status;
  if (body.status != null && body.status !== '' && body.status !== order.status) {
    if (!LIVE.includes(body.status)) throw bad(`Status must be one of: ${LIVE.join(', ')}.`);
    to = body.status;
    changed.push('Status');   // the step's own from → to says what it was
  }

  const editPart = (current, keys, incoming) => {
    if (!current || !incoming || typeof incoming !== 'object') return null;
    const own = keys.filter((k) => current[k] != null);
    const v = readFields(own, { ...current, ...incoming });
    let copy = null;
    for (const k of own) {
      if (v[k] !== current[k]) {
        copy ??= { ...current };
        copy[k] = v[k];
        note(FIELDS[k].label, current[k]);
      }
    }
    return copy;
  };
  const payment = editPart(order.payment, PAYMENT_FIELDS, body.payment);
  const shipment = editPart(order.shipment, SHIPMENT_FIELDS, body.shipment);

  if (!changed.length) throw bad('Nothing changed.');

  Object.assign(order, next);
  if (owner) {
    order.ownerId = owner.id;
    order.owner = { id: owner.id, name: owner.name };
  }
  if (payment) order.payment = payment;
  if (shipment) order.shipment = shipment;
  return { to, note: reason, details: { changed, before } };
}

// Each step keeps a copy of the order as it stood after it, for its data reply. The copy isn't
// enumerable, so it never appears in answers to the page, and it's dropped once Discord has it.
function keepSnapshot(step, order) {
  Object.defineProperty(step, 'snapshot', { value: snapshotOf(order), writable: true, configurable: true });
}

function record(order, user, type, label, from, to, { details = null, note = null } = {}) {
  const at = new Date().toISOString();
  const step = {
    seq: order.events.length + 1,
    type,
    label,
    from,
    to,
    at,
    actor: { id: user.id, name: user.name, role: user.role },
    note,
    details,
    discord: { state: audit.initialState() },
  };
  order.status = to;
  order.updatedAt = at;
  keepSnapshot(step, order);
  order.events.push(step);
  return step;
}

// A line in the Admin log: what changed, never the values or the reason.
function logAdmin(user, title, step) {
  const parts = [];
  if (step?.from && step.to && step.from !== step.to) parts.push(`${STATUS[step.from]} → ${STATUS[step.to]}`);
  const changed = (step?.details?.changed ?? []).filter((c) => c !== 'Status');
  if (changed.length) parts.push(`Changed: ${changed.join(', ')}`);
  audit.logAdmin({ title, description: parts.join('\n'), actor: { id: user.id, name: user.name, role: user.role }, at: new Date().toISOString() });
}

const summary = (o) => ({
  id: o.id,
  status: o.status,
  statusLabel: STATUS[o.status],
  customerName: o.customerName,
  division: o.division,
  total: o.total,
  items: o.items.length,
  owner: ownerName(o),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
  discordProblem: o.events.some((s) => s.discord?.state === 'failed'),
});

const fullOrder = (order, user) => ({
  ...order,
  statusLabel: STATUS[order.status],
  waitingOn: WAITING_ON[order.status] ? ROLE_LABELS[WAITING_ON[order.status]] : null,
  actions: actionsFor(user, order),
});

function visibleOrder(req) {
  const order = state.orders[req.params.id];
  if (!order || !canSee(req.user, order)) throw bad('No such order.', 404);
  return order;
}

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// ---------- loading ----------

// Reads every order back from #order-audit, before the server takes requests. Never throws: if
// Discord can't be read, the reason is kept and new orders are refused until a restart.
async function load() {
  const oldFile = path.join(DATA_DIR, 'orders.json');
  if (!storesInDiscord) {
    if (transport.mode === 'live') console.warn("[orders] DISCORD_BOT_TOKEN isn't set: orders are posted to #order-audit but can't be read back, so they're lost when the server stops.");
    if (fs.existsSync(oldFile)) console.warn('[orders] data/orders.json is only copied into Discord in live mode with the bot, so it was left alone.');
    return;
  }
  if (!codec.encrypts) console.warn("[orders] RECORD_SECRET isn't set: customer details in #order-audit are readable by everyone in the channel.");
  try {
    const found = await audit.load();
    state.orders = found.orders;
    countIds(found.ids);
    Object.assign(storage, { loaded: Object.keys(found.orders).length, scanned: found.scanned, locked: found.locked, unreadable: found.unreadable });
    console.log(`[orders] loaded ${storage.loaded} order(s) from #order-audit, ${found.scanned} channel message(s) scanned`);
    if (found.unreadable) console.warn(`[orders] ${found.unreadable} data repl${found.unreadable === 1 ? 'y' : 'ies'} didn't decrypt. Is RECORD_SECRET the one they were written with?`);
  } catch (err) {
    storage.error = err.message;
    console.error('[orders] could not read orders from #order-audit:', err.message);
    return;
  }
  importOldFile(oldFile);
}

// Orders saved before Discord became their storage are in data/orders.json. Every step Discord
// doesn't have yet gets its data reply now, and its post if that never went out. The replies
// carry the order as it stands in the file, since the file didn't keep each step's copy. Once
// all of them are in, the file is renamed orders.imported.json, so it's never copied twice.
function importOldFile(file) {
  if (!fs.existsSync(file)) return;
  let old;
  try {
    old = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[orders] data/orders.json couldn't be read, so it wasn't copied into Discord: ${err.message}`);
    return;
  }
  const done = () => {
    try {
      fs.renameSync(file, path.join(DATA_DIR, 'orders.imported.json'));
      console.log('[orders] every order from data/orders.json is in #order-audit; the file is now orders.imported.json');
    } catch (err) {
      console.warn(`[orders] couldn't rename data/orders.json: ${err.message}`);
    }
  };

  const copying = [];
  for (const o of Object.values(old.orders ?? {})) {
    if (!ORDER_ID.test(o?.id ?? '') || !Array.isArray(o.events)) continue;
    const have = state.orders[o.id];
    const stored = new Map((have?.events ?? []).map((e) => [e.seq, e]));
    if (o.events.every((e) => stored.has(e.seq))) continue;

    const known = Object.fromEntries(Object.entries(have?.discord ?? {}).filter(([, v]) => v != null));
    const order = { ...o, discord: { starterMessageId: o.discord?.starterMessageId ?? null, threadId: o.discord?.threadId ?? null, ...known } };
    order.events = o.events.map((e) => {
      if (stored.has(e.seq)) return stored.get(e.seq);
      const posted = e.discord?.state === 'sent' && e.discord.messageId;
      const step = { ...e, discord: { state: 'queued', messageId: posted ? e.discord.messageId : null, inThread: posted ? Boolean(e.discord.inThread) : false } };
      keepSnapshot(step, order);
      return step;
    });
    state.orders[o.id] = order;
    copying.push(o.id);
  }
  countIds(Object.keys(old.orders ?? {}));
  if (!copying.length) return done();

  console.log(`[orders] copying ${copying.length} order(s) from data/orders.json into #order-audit`);
  Promise.all(copying.map((id) => audit.sync(id))).then(() => {
    if (copying.every((id) => state.orders[id].events.every((e) => e.discord.state === 'sent'))) done();
    else console.warn("[orders] some steps from data/orders.json aren't in Discord yet; they're tried again on the next start.");
  });
}

// ---------- routes ----------

const router = express.Router();
router.use(requireUser, jsonOnly);

router.get('/meta', (_req, res) => res.json({
  statuses: STATUS,
  roles: ROLE_LABELS,
  orderFields: ORDER_FIELDS.map(describeField),
  fields: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, describeField(k)])),
  fieldLabels: { ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])), items: 'Items', total: 'Total' },
  discord: audit.describe(),
  storage,
}));

router.get('/', (req, res) => {
  const orders = Object.values(state.orders)
    .filter((o) => canSee(req.user, o))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(summary);
  res.json({ orders });
});

// 202 when Discord is the storage: accepted now, stored once its posts are in Discord.
const accepted = (fallback) => (storesInDiscord ? 202 : fallback);

router.post('/', (req, res, next) => {
  try {
    if (!['salesperson', 'admin'].includes(req.user.role)) throw bad('Only Salesperson can raise orders.', 403);
    if (storage.error) throw bad(`Orders couldn't be read from #order-audit, so a new order could reuse an existing id. ${storage.error}`, 503);
    const form = readOrderForm(req.body);
    const pick = req.body?.ownerId;
    const owner = req.user.role === 'admin' && pick != null && pick !== '' ? salespersonFor(pick) : req.user;
    const now = new Date().toISOString();
    const order = {
      id: nextOrderId(),
      status: 'pending_approval',
      ownerId: owner.id,
      owner: { id: owner.id, name: owner.name },
      createdBy: { id: req.user.id, name: req.user.name, role: req.user.role },
      createdAt: now,
      updatedAt: now,
      ...form,
      payment: null,
      shipment: null,
      events: [],
      discord: {},
    };
    record(order, req.user, 'created', 'Order created', null, 'pending_approval', { details: { items: form.items.length, total: form.total } });
    state.orders[order.id] = order;
    audit.sync(order.id);
    if (req.user.role === 'admin') {
      audit.logAdmin({ title: `Created ${order.id}`, description: `For ${owner.name}`, actor: order.createdBy, at: now });
    }
    res.status(accepted(201)).json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json({ order: fullOrder(visibleOrder(req), req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

function takeStep(req, res, next, name) {
  try {
    const order = visibleOrder(req);
    const spec = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!spec) throw bad('No such step.', 404);
    const refusal = refuse(req.user, order, spec);
    if (refusal) throw bad(refusal[1], refusal[0]);

    const body = req.body ?? {};
    const from = order.status;
    const at = new Date().toISOString();
    let to = spec.to;
    let details = null;
    let note = null;
    if (spec.form === 'order') {
      const form = readOrderForm(body);
      Object.assign(order, form);
      details = { items: form.items.length, total: form.total };
    } else if (spec.form === 'edit') {
      ({ to, details, note } = applyEdit(order, body));
    } else if (spec.fields) {
      const values = readFields(spec.fields, body);
      note = values.reason ?? values.note ?? null;
      const facts = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== 'reason' && k !== 'note' && v != null));
      details = Object.keys(facts).length ? facts : null;
      if (spec.name === 'verify_payment') order.payment = { ...facts, verifiedBy: req.user.name, verifiedAt: at };
      if (spec.name === 'dispatch') order.shipment = { ...facts, dispatchedAt: at };
      if (spec.name === 'deliver') order.shipment = { ...order.shipment, ...facts, deliveredAt: at };
    }
    if (spec.name === 'restore') to = statusBeforeDelete(order);

    const step = record(order, req.user, spec.name, spec.done, from, to, { details, note });
    audit.sync(order.id);
    if (spec.logged) logAdmin(req.user, `${spec.logged} ${order.id}`, step);
    res.status(accepted(200)).json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
}

router.post('/:id/actions/:action', (req, res, next) => takeStep(req, res, next, req.params.action));
router.patch('/:id', (req, res, next) => takeStep(req, res, next, 'edit'));             // Admin: update
router.delete('/:id', (req, res, next) => takeStep(req, res, next, 'delete_order'));   // Admin: delete, kept for restoring

// Sends again whatever isn't stored in #order-audit yet, in order.
router.post('/:id/audit/retry', (req, res, next) => {
  try {
    if (!['management', 'admin'].includes(req.user.role)) throw bad('Only Management or Admin can send the audit again.', 403);
    const order = visibleOrder(req);
    audit.retry(order.id);
    res.json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

module.exports = { router, load, STATUS, ACTIONS };
