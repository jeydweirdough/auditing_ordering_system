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
const { requireUser, requireRole, requirePermission, jsonOnly, findUser, listUsers, onAccountChange, ROLES, ROLE_LABELS } = require('./accounts');
const { buildTransport, createOrderAudit, storageKind, snapshotOf } = require('./orderAudit');
const { createOrderCodec } = require('./orderCodec');
const products = require('./products');
const customers = require('./customers');
const configStore = require('./configStore');
const recycleBin = require('./recycleBin');
const discordHub = require('./discordHub');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// GM-YYYYMMDD-NNNN, the Getmeds order id (getmeds-backend's orderIdService.js). Orders raised before
// this app used it are ORD-YYYYMMDD-NNNN, and keep their ids.
const ORDER_ID = /^(GM|ORD)-(\d{8})-(\d{4})$/;
const state = { counters: {}, orders: {} };

const STATUS = {
  pending_tl_approval: 'Waiting for Team Leader',
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
  pending_tl_approval: 'team_leader',
  pending_approval: 'management',
  returned: 'salesperson',
  awaiting_payment: 'finance',
  on_hold: 'finance',
  ready_for_dispatch: 'dispatch',
  picking: 'dispatch',
  packed: 'dispatch',
  dispatched: 'dispatch',
};

// Getmeds' divisions and their official sub-divisions from configStore:
const DIVISIONS = new Proxy([], {
  get(target, prop) {
    const list = configStore.getDivisions().map((d) => d.name);
    if (prop === 'includes') return (val) => list.includes(val);
    if (prop === 'length') return list.length;
    if (prop === Symbol.iterator) return list[Symbol.iterator].bind(list);
    return list[prop];
  },
});

const SUB_DIVISIONS = new Proxy({}, {
  get(target, prop) {
    return configStore.getAllConfigs().subDivisionMap[prop] || [];
  },
  has(target, prop) {
    return prop in configStore.getAllConfigs().subDivisionMap;
  },
});

function getFreshFields() {
  const configs = configStore.getAllConfigs();
  const base = {
    customerName: { label: 'Customer name', type: 'text', max: 120, required: true },
    contactNumber: { label: 'Contact number', type: 'text', max: 30 },
    address: { label: 'Delivery address', type: 'textarea', max: 300, required: true },
    receiverName: { label: 'Receiver name', type: 'text', max: 120 },
    receiverContact: { label: 'Receiver contact no.', type: 'tel', max: 30 },
    division: { label: 'Division', type: 'select', options: configs.divisionList, required: true },
    subDivision: { label: 'Sub-division', type: 'select', options: ['MD Telesales', 'NBD', 'CRR', 'Hospital', 'Telesales', 'Bidding'], optionsBy: { field: 'division', lists: configs.subDivisionMap }, required: true, help: 'Follows the selected Division.' },
    headQuarter: { label: 'Head quarter', type: 'text', max: 120, suggestions: configs.headquarters },
    invoicingFrom: { label: 'Invoicing from', type: 'select', options: configs.invoicingFrom, required: true, help: 'Which entity this order is invoiced under.' },
    source: { label: 'Source', type: 'select', options: configs.sources, required: true },
    paymentMethod: { label: 'Payment method', type: 'select', options: configs.paymentMethods, required: true },
    paymentTerms: { label: 'Payment terms', type: 'select', options: configs.paymentTerms, required: true },
    deliveryMethod: { label: 'Delivery method', type: 'text', max: 60, suggestions: configs.deliveryMethods, help: 'Type to see suggestions, or enter your own.' },
    customerIsDoctor: { label: 'Is the customer the doctor?', type: 'choice', options: ['Yes', 'No'] },
    doctorName: { label: 'Doctor name', type: 'text', max: 120, help: 'The referring or prescribing doctor.' },
    remarks: { label: 'Customer remarks', type: 'textarea', max: 1000, required: true },
    notes: { label: 'Notes', type: 'textarea', max: 1000 },
    note: { label: 'Note', type: 'textarea', max: 500 },
    reason: { label: 'Reason', type: 'textarea', max: 500, required: true },
    method: { label: 'Paid by', type: 'select', options: configs.paymentMethods, required: true },
    reference: { label: 'Reference number', type: 'text', max: 60, required: true },
    amount: { label: 'Amount received (PHP)', type: 'number', min: 0.01, max: 100_000_000, required: true },
    paidOn: { label: 'Paid on', type: 'date', required: true },
    courier: { label: 'Courier', type: 'text', max: 60, required: true },
    trackingNumber: { label: 'Tracking number / Reference ID / URL', type: 'text', max: 255, required: true, help: 'Carrier tracking number, reference ID, or tracking link' },
    receivedBy: { label: 'Received by', type: 'text', max: 120, required: true, help: 'Person who received the order' },
    packingNotes: { label: 'Packing notes', type: 'textarea', max: 500, help: 'Optional notes on parcel condition, box count, etc.' },
  };

  const customFields = configStore.getOrderFields() || [];
  for (const cf of customFields) {
    if (!cf || !cf.id) continue;
    base[cf.id] = {
      label: cf.label || cf.id,
      type: cf.type || 'text',
      max: cf.type === 'textarea' ? 1000 : 255,
      required: Boolean(cf.required),
      options: cf.options || (cf.type === 'choice' ? ['Yes', 'No'] : undefined),
      help: cf.helpText || cf.help,
      section: cf.section || 'additional',
      isCustom: true,
      active: cf.active !== false,
    };
  }

  return base;
}

const FIELDS = new Proxy({}, {
  get(target, prop) {
    const fields = getFreshFields();
    return fields[prop];
  },
  ownKeys() {
    return Object.keys(getFreshFields());
  },
  getOwnPropertyDescriptor(target, prop) {
    return {
      enumerable: true,
      configurable: true,
      value: getFreshFields()[prop],
    };
  },
});

const BASE_ORDER_FIELDS = [
  'customerName', 'contactNumber', 'address', 'receiverName', 'receiverContact',
  'division', 'subDivision', 'headQuarter', 'invoicingFrom', 'source', 'paymentMethod', 'paymentTerms', 'deliveryMethod',
  'customerIsDoctor', 'doctorName', 'remarks', 'notes',
];

const ORDER_FIELDS = new Proxy(BASE_ORDER_FIELDS, {
  get(target, prop) {
    const custom = (configStore.getOrderFields() || []).filter((f) => f.active !== false).map((f) => f.id);
    const all = [...BASE_ORDER_FIELDS, ...custom];
    if (prop === 'filter') return (fn) => all.filter(fn);
    if (prop === 'map') return (fn) => all.map(fn);
    if (prop === 'includes') return (val) => all.includes(val);
    if (prop === 'length') return all.length;
    if (prop === Symbol.iterator) return all[Symbol.iterator].bind(all);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return all[Number(prop)];
    return all[prop];
  },
});

// Files a new order can carry, by extension: photos, PDF, Word and Excel, as the Getmeds order form
// takes. The type a file is served back with comes from here, never from the browser.
const FILE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const FILE_KINDS = {
  payment_proof: 'Proof of payment',
  purchase_order: 'Purchase order',
  guarantee_letter: 'Guarantee letter (DSWD/PCSO)',
  prescription: 'Prescription / Rx',
  packing_proof: 'Proof of packing',
  dispatch_proof: 'Proof of dispatch / waybill',
  delivery_proof: 'Proof of delivery (POD)',
  other: 'Other',
};
// Vercel takes at most 4.5 MB per request, and files arrive base64-encoded in the JSON, a third
// bigger than they are. 3 MB of files leaves room for the rest of the order. 10 is Discord's
// limit of files per message.
const FILES = { max: 20, maxBytes: 8_000_000 };
const PAYMENT_FIELDS = ['method', 'reference', 'amount', 'paidOn'];
const SHIPMENT_FIELDS = ['courier', 'trackingNumber', 'receivedBy', 'packedBy', 'packedAt', 'dispatchedAt', 'deliveredAt', 'packingNotes'];

// label: the button. done: how the step reads in the audit trail. owner: a salesperson may only
// do it on their own orders. form: the step has its own form on the page. logged: Admin's steps
// also get a line in the Admin log. Admin may take any step.
const ACTIONS = {
  resubmit: { label: 'Edit for approval', done: 'Resubmitted', roles: ['salesperson', 'team_leader', 'management'], from: ['returned'], to: (order, user) => (user?.role === 'salesperson' || order?.createdBy?.role === 'salesperson' ? 'pending_tl_approval' : 'pending_approval'), mine: true, form: 'order' },
  tl_approve: { label: 'Endorse to Management', done: 'Endorsed by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'pending_approval', fields: ['note'] },
  tl_send_back: { label: 'Send back for changes', done: 'Sent back by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'returned', fields: ['reason'] },
  tl_reject: { label: 'Reject', done: 'Rejected by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'rejected', fields: ['reason'], danger: true },
  approve: { label: 'Approve', done: 'Approved', roles: ['management'], from: ['pending_approval'], to: 'awaiting_payment', fields: ['note'] },
  send_back: { label: 'Send back for changes', done: 'Sent back for changes', roles: ['management'], from: ['pending_approval', 'pending_tl_approval'], to: 'returned', fields: ['reason'] },
  reject: { label: 'Reject', done: 'Rejected', roles: ['management'], from: ['pending_approval', 'pending_tl_approval'], to: 'rejected', fields: ['reason'], danger: true },
  verify_payment: { label: 'Verify payment', done: 'Payment verified', roles: ['finance'], from: ['awaiting_payment', 'on_hold'], to: 'ready_for_dispatch', fields: ['method', 'reference', 'amount', 'paidOn'] },
  hold: { label: 'Put on hold', done: 'Put on hold', roles: ['finance'], from: ['awaiting_payment'], to: 'on_hold', fields: ['reason'], danger: true },
  start_picking: { label: 'Start picking', done: 'Picking started', roles: ['dispatch'], from: ['ready_for_dispatch'], to: 'picking' },
  mark_packed: { label: 'Mark packed', done: 'Packed', roles: ['dispatch'], from: ['picking'], to: 'packed', fields: ['packingNotes'] },
    dispatch: { label: 'Dispatch', done: 'Dispatched', roles: ['dispatch'], from: ['packed'], to: 'dispatched', fields: ['courier', 'trackingNumber'] },
  deliver: { label: 'Mark delivered', done: 'Delivered', roles: ['dispatch'], from: ['dispatched'], to: 'completed', fields: ['receivedBy'] },
  cancel: { label: 'Cancel order', done: 'Cancelled', roles: ['salesperson', 'team_leader', 'management'], from: ['pending_tl_approval', 'pending_approval', 'returned', 'awaiting_payment', 'on_hold'], to: 'cancelled', owner: true, fields: ['reason'], danger: true },
  edit: { label: 'Edit order', done: 'Edited by Admin', roles: ['admin', 'management', 'finance', 'team_leader'], from: LIVE, to: null, form: 'edit', logged: 'Edited' },
  delete_order: { label: 'Delete order', done: 'Deleted by Admin', roles: ['admin'], from: LIVE, to: 'deleted', fields: ['reason'], danger: true, logged: 'Deleted' },
  restore: { label: 'Restore order', done: 'Restored by Admin', roles: ['admin'], from: ['deleted'], to: null, fields: ['reason'], logged: 'Restored' },
  purge_order: { label: 'Delete permanently', done: 'Permanently deleted by Admin', roles: ['admin'], from: ['deleted'], to: null, fields: ['reason'], danger: true, logged: 'Purged' },
};
for (const [name, spec] of Object.entries(ACTIONS)) spec.name = name;

// Who may raise an order: for themselves, or for an active salesperson.
const canRaiseOrders = (user) => user && configStore.hasPermission(user.role, 'raise_orders');
const CREATORS = new Proxy(['salesperson', 'team_leader', 'management', 'admin'], {
  get(target, prop) {
    const list = configStore.getRbac().filter((r) => r.permissions?.raise_orders).map((r) => r.id);
    if (prop === 'includes') return (val) => list.includes(val);
    if (prop === 'length') return list.length;
    if (prop === Symbol.iterator) return list[Symbol.iterator].bind(list);
    return list[prop];
  },
});

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

// GM-YYYYMMDD-NNNN, numbered from 0001 each day like getmeds-backend's, but dated in the
// Philippines rather than UTC.
function nextOrderId() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '');
  const key = `GM-${day}`;
  const n = (state.counters[key] ?? 0) + 1;
  state.counters[key] = n;
  return `${key}-${String(n).padStart(4, '0')}`;
}

// New ids carry on after every id already used, whether or not its order could be read. Old ORD-
// ids are counted apart, since they can't clash with GM- ones.
function countIds(ids) {
  for (const id of ids) {
    const match = ORDER_ID.exec(id);
    if (!match) continue;
    const key = `${match[1]}-${match[2]}`;
    state.counters[key] = Math.max(state.counters[key] ?? 0, Number(match[3]));
  }
}

function readFields(names, body) {
  const values = {};
  for (const name of names) {
    const f = FIELDS[name];
    if (!f) continue;
    let v = body?.[name];
    if (v == null || String(v).trim() === '') {
      if (f.required) throw bad(`${f.label} is required.`);
      values[name] = null;
      continue;
    }
    if (f.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) {
        const rangeText = f.min != null && f.max != null ? ` from ${f.min} to ${f.max.toLocaleString('en-PH')}` : '';
        throw bad(`${f.label} must be a valid number${rangeText}.`);
      }
      v = round2(v);
    } else if (f.type === 'date') {
      v = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${f.label} must be a date.`);
    } else {
      v = String(v).trim();
      if (f.max && v.length > f.max) throw bad(`${f.label} can be at most ${f.max} characters.`);
      const allowed = f.optionsBy ? (f.optionsBy.lists[values[f.optionsBy.field] ?? body?.[f.optionsBy.field]] ?? f.options) : f.options;
      if (allowed && allowed.length > 0) {
        const match = allowed.find((opt) => opt.toLowerCase() === v.toLowerCase());
        if (!match) throw bad(`${f.label} must be one of: ${allowed.join(', ')}.`);
        v = match;
      }
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
    const priceType = item?.priceType ? String(item.priceType).trim() : undefined;
    const unitType = item?.unitType ? String(item.unitType).trim() : undefined;
    if (!product || product.length > 120) throw bad(`Item ${i + 1}: give a product name of up to 120 characters.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) throw bad(`Item ${i + 1}: quantity must be a whole number from 1 to 100,000.`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10_000_000) throw bad(`Item ${i + 1}: unit price must be from 0 to 10,000,000.`);
    return {
      product,
      qty,
      unitPrice: round2(unitPrice),
      ...(priceType ? { priceType } : {}),
      ...(unitType ? { unitType } : {}),
    };
  });
}

const totalOf = (items) => round2(items.reduce((sum, it) => sum + it.qty * it.unitPrice, 0));

function readOrderForm(body, attachments = [], role = null) {
  const values = readFields(ORDER_FIELDS, body);
  const items = readItems(body?.items);
  const customerRecord = customers.findCustomer(values.customerName);
  const customerHasSpecialPrice = Boolean(
    body?.customerHasSpecialPrice || body?.hasSpecialPrice || customerRecord?.hasSpecialPrice
  );
  const orderData = {
    ...values,
    items,
    customerHasSpecialPrice,
  };
  const constraintErr = products.validateOrderConstraints(orderData, attachments);
  if (constraintErr) throw bad(constraintErr);

  // In salesperson view, products cannot be arbitrary custom products or price-tampered
  if (role === 'salesperson' && values.division !== 'BID') {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const p = products.findProduct(it.product);
      if (!p) throw bad(`Item ${i + 1}: Salespeople must select an official catalog product ("${it.product}" was not found).`);
      // Special price requests allow entering the requested custom price
      if (it.priceType === 'special') continue;
      if (it.priceType && p.prices?.[it.priceType]) {
        const expectedPrice = it.unitType === 'pack' ? p.prices[it.priceType].packPrice : p.prices[it.priceType].unitPrice;
        if (expectedPrice != null && Math.abs(Number(expectedPrice) - it.unitPrice) > 0.01) {
          throw bad(`Item ${i + 1}: Products and prices cannot be changed in the salesperson view (expected ₱${expectedPrice} for ${p.brandName || p.fullName}).`);
        }
      }
    }
  }

  return { ...values, items, total: totalOf(items), customerHasSpecialPrice };
}

// [{ name, type, size, kind, data }] from the page's [{ name, kind, data (base64) }]. Names are
// kept to plain characters and made unique, so they're safe in a header and in Discord.
function readAttachments(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw bad('Attachments must be a list of files.');
  if (raw.length > FILES.max) throw bad(`An order can have at most ${FILES.max} files.`);
  let total = 0;
  const taken = new Set();
  return raw.map((f, i) => {
    const original = String(f?.name ?? '').trim();
    const dot = original.lastIndexOf('.');
    const ext = dot > 0 ? original.slice(dot + 1).toLowerCase() : '';
    if (!Object.hasOwn(FILE_TYPES, ext)) throw bad(`File ${i + 1}: attach a photo, PDF, Word or Excel file.`);
    if (!Object.hasOwn(FILE_KINDS, f?.kind)) throw bad(`File ${i + 1}: tag it as ${Object.values(FILE_KINDS).join(', ')}.`);
    const b64 = String(f?.data ?? '');
    if (b64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad(`File ${i + 1} didn't arrive whole. Attach it again.`);
    const data = Buffer.from(b64, 'base64');
    if (!data.length) throw bad(`File ${i + 1} is empty.`);
    total += data.length;
    if (total > FILES.maxBytes) throw bad(`Files can add up to ${FILES.maxBytes / 1e6} MB per order.`);
    const base = original.slice(0, dot).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'file';
    let name = `${base}.${ext}`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}-${k}.${ext}`;
    taken.add(name.toLowerCase());
    return { name, type: FILE_TYPES[ext], size: data.length, kind: f.kind, data };
  });
}

// A file's name in Discord. Encrypted files get a neutral one, since a name can say who the
// customer is.
const discordFile = (orderId, n, name) => (codec.encrypts
  ? { file: `${orderId}-file-${n + 1}.bin`, sealed: true }
  : { file: `${orderId}-file-${n + 1}-${name}`, sealed: false });

// The files' bytes ride on their step until Discord has them, like its snapshot: not enumerable,
// so they never reach the page or the data reply.
function keepFiles(step, order, files) {
  if (!files.length) return;
  const currentAtts = order.attachments || [];
  const value = files.map((f, idx) => {
    const att = currentAtts.find((a) => a.name === f.name) || currentAtts[currentAtts.length - files.length + idx];
    return { n: att?.n ?? idx, file: att?.file, sealed: att?.sealed, type: f.type, data: f.data };
  });
  Object.defineProperty(step, 'files', { value, writable: true, configurable: true });
}

// An order belongs to an active salesperson, whom Admin can pick.
function salespersonFor(id) {
  const user = findUser(Number(id));
  if (!user || user.role !== 'salesperson' || !user.active) throw bad('Pick an active salesperson for this order.');
  return user;
}

const ownerName = (order) => order.owner?.name ?? order.createdBy.name;
// An order is someone's when it's for them or they raised it, e.g. for another salesperson.
const isMine = (user, order) => order.ownerId === user.id || order.createdBy?.id === user.id;
const canSee = (user, order) => {
  // The recycle bin is for whoever may restore from it.
  if (order.status === 'deleted' && !configStore.hasPermission(user.role, 'restore_orders')) return false;
  if (user.role === 'salesperson') return isMine(user, order);
  if (user.role === 'team_leader') {
    if (isMine(user, order)) return true;
    const ownerUser = findUser(order.ownerId);
    if (ownerUser?.teamLeaderId && ownerUser.teamLeaderId !== user.id) return false;
    return true;
  }
  return true;
};

// A restored order goes back to the status it had when it was deleted.
const statusBeforeDelete = (order) => order.events.findLast((e) => e.to === 'deleted')?.from ?? 'pending_approval';

const ACTION_PERMISSIONS = {
  resubmit: 'raise_orders',
  tl_approve: 'approve_orders',
  tl_send_back: 'send_back_orders',
  tl_reject: 'reject_orders',
  approve: 'approve_orders',
  send_back: 'send_back_orders',
  reject: 'reject_orders',
  verify_payment: 'verify_payment',
  hold: 'hold_payment',
  start_picking: 'pick_pack_dispatch',
  mark_packed: 'pick_pack_dispatch',
  dispatch: 'pick_pack_dispatch',
  deliver: 'deliver_orders',
  cancel: 'raise_orders',
  edit: 'edit_orders',
  delete_order: 'delete_orders',
  restore: 'restore_orders',
  purge_order: 'delete_orders',
};

// Why this person may not take this step now, as [status, message], or null when they may.
function refuse(user, order, spec) {
  const perm = ACTION_PERMISSIONS[spec.name];
  const hasPerm = perm ? configStore.hasPermission(user.role, perm) : spec.roles.includes(user.role);

  // Everyone answers to the permission table, admin included. There used to be
  // two ways past this line for 'admin' — one here and one in hasPermission —
  // so an Administrator could take all eighteen steps of anybody's order and
  // nothing on the RBAC screen said so.
  if (!hasPerm) {
    return [403, `Your role does not have permission to do this step.`];
  }
  if (!spec.from.includes(order.status)) return [409, `This order is ${STATUS[order.status].toLowerCase()}, so this step isn't open.`];
  // mine: only whoever raised the order or whom it's for. owner: the same, for
  // salespeople only, so Management can still cancel anyone's order.
  if (spec.mine || (spec.owner && user.role === 'salesperson')) {
    if (!isMine(user, order)) return [403, "Only whoever raised this order, or the salesperson it's for, can do that."];
  }
  // Team leader supervision: a team leader endorses their own people's orders,
  // not everyone's. (Orbit does this per team for every role, not just this one.)
  if (user.role === 'team_leader' && spec.roles.includes('team_leader')) {
    const ownerUser = findUser(order.ownerId);
    if (ownerUser?.teamLeaderId && ownerUser.teamLeaderId !== user.id) {
      return [403, "This order belongs to a salesperson not assigned to your team."];
    }
  }
  return null;
}

const actionsFor = (user, order) => Object.values(ACTIONS)
  .filter((spec) => !refuse(user, order, spec))
  .map((spec) => ({
    name: spec.name,
    label: spec.label,
    to: spec.name === 'restore'
      ? STATUS[statusBeforeDelete(order)]
      : typeof spec.to === 'function'
      ? STATUS[spec.to(order, user)]
      : spec.to
      ? STATUS[spec.to]
      : null,
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

  if ('items' in body || present.some((k) => ['division', 'paymentTerms', 'source', 'notes', 'remarks'].includes(k))) {
    const merged = { ...order, ...next };
    const err = products.validateOrderConstraints(merged, order.attachments ?? []);
    if (err) throw bad(err);
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
  let newFiles = [];
  if (Array.isArray(body.attachments)) {
    let currentAttachments = order.attachments ?? [];
    if (Array.isArray(body.keepExistingAttachmentIndices)) {
      currentAttachments = currentAttachments.filter((f) => body.keepExistingAttachmentIndices.includes(f.n));
    }
    newFiles = readAttachments(body.attachments);
    if (newFiles.length > 0 || currentAttachments.length !== (order.attachments?.length ?? 0)) {
      const startN = currentAttachments.length;
      const appended = newFiles.map(({ data, ...file }, idx) => ({
        n: startN + idx,
        ...file,
        seq: order.events.length + 1,
        ...discordFile(order.id, startN + idx, file.name),
      }));
      order.attachments = [...currentAttachments, ...appended];
      note('Attachments', `${order.attachments.length} file(s)`);
    }
  }

  if (!changed.length) throw bad('Nothing changed.');

  Object.assign(order, next);
  if (owner) {
    order.ownerId = owner.id;
    order.owner = { id: owner.id, name: owner.name };
  }
  if (payment) order.payment = payment;
  if (shipment) order.shipment = shipment;
  return { to, note: reason, details: { changed, before }, newFiles };
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
  division: [o.division, o.subDivision].filter(Boolean).join(' | '),   // "HOS | MARIKINA" on the list
  total: o.total,
  items: o.items.length,
  owner: ownerName(o),
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
  deletedAt: o.deletedAt || null,
  purgeAt: o.purgeAt || null,
  deletedBy: o.deletedBy || null,
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

// Orders from before Sub-division had its own field kept both in Division, as "HOS | MARIKINA".
// They're read as Division HOS and Sub-division MARIKINA, so they show and edit like new ones.
function splitDivision(order) {
  const [division, sub] = String(order.division ?? '').split(' | ');
  if (sub && DIVISIONS.includes(division) && !order.subDivision) Object.assign(order, { division, subDivision: sub });
}

async function checkAndPurgeExpired() {
  const now = Date.now();
  const deleted = Object.values(state.orders).filter((o) => o.status === 'deleted');
  for (const order of deleted) {
    const purgeTime = order.purgeAt
      ? new Date(order.purgeAt).getTime()
      : (order.deletedAt ? new Date(order.deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000 : null);
    if (purgeTime && now >= purgeTime) {
      console.log(`[retention] Order ${order.id} reached 30-day retention limit; vanishing from Discord database.`);
      await audit.purgeOrder(order, { name: 'Retention Worker', role: 'system' });
      delete state.orders[order.id];
      recycleBin.removeRecycledItem(order.id, 'order');
    }
  }
  await recycleBin.purgeExpiredRecycledItems().catch((err) => {
    console.warn('[retention] Failed to purge expired recycled items:', err.message);
  });
}

setInterval(checkAndPurgeExpired, 60 * 60 * 1000).unref();

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
    for (const order of Object.values(state.orders)) splitDivision(order);
    customers.seedFromOrders(Object.values(state.orders));
    await checkAndPurgeExpired();
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

// ---------- dashboards ----------

// Each role's dashboard, worked out here so a salesperson's only ever counts their own orders. The
// period scopes the figures, and each is compared with the same stretch of the period before.
// Figures the page tags "Now" (a queue, what's waiting for payment) are as things stand.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MANILA = 8 * HOUR;   // the Philippines is UTC+8 all year
const PERIODS = { month: 'This month', last_month: 'Last month', '90d': 'Last 90 days', all: 'All time' };
const COMPARED_WITH = { month: 'the same days last month', last_month: 'the month before', '90d': 'the 90 days before' };
// Finance's thresholds: open orders from this amount up get a second look before payment is
// verified, and payment waits are banded by days since approval.
const LARGE_ORDER = Number(process.env.FINANCE_LARGE_ORDER_PHP) || 100_000;
const AGING = [
  { label: 'On track', days: '0–3 days', from: 0, to: 3 },
  { label: 'Follow up', days: '4–7 days', from: 4, to: 7 },
  { label: 'Late', days: '8–14 days', from: 8, to: 14 },
  { label: 'Overdue', days: '15+ days', from: 15, to: Infinity },
];
const DECISIONS = ['approve', 'send_back', 'reject', 'tl_approve', 'tl_send_back', 'tl_reject'];
const BEFORE_PAYMENT = ['pending_tl_approval', 'pending_approval', 'returned', 'awaiting_payment', 'on_hold'];

const dayName = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
const monthName = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', year: 'numeric' });
// The start of t's month in Manila, add months on.
const monthStart = (t, add = 0) => {
  const d = new Date(t + MANILA);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) - MANILA;
};
const within = (iso, r) => {
  const t = Date.parse(iso ?? '');
  return t >= r.from && t < r.to;
};
const sumOf = (orders) => round2(orders.reduce((s, o) => s + (o.total ?? 0), 0));
const isSale = (o) => !['cancelled', 'rejected', 'deleted'].includes(o.status);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// When, before its event i, the order last reached this status: where a wait began.
const reachedAt = (o, i, status) => Date.parse(o.events.slice(0, i).findLast((e) => e.to === status)?.at ?? o.createdAt);

// { from, to, prev, buckets }. prev is the same stretch just before (none for all time). buckets
// split the period for its trend: days in a month, weeks in 90 days, months in all time.
function periodRange(key, orders, now) {
  const to = key === 'last_month' ? monthStart(now) : now + 1;
  let from;
  let prev = null;
  if (key === 'last_month') {
    from = monthStart(now, -1);
    prev = { from: monthStart(now, -2), to: from };
  } else if (key === '90d') {
    from = now - 90 * DAY;
    prev = { from: from - 90 * DAY, to: from };
  } else if (key === 'all') {
    from = 0;
  } else {
    from = monthStart(now);
    const before = monthStart(now, -1);
    prev = { from: before, to: Math.min(from, before + (to - from)) };
  }
  const buckets = [];
  if (key === '90d') {
    for (let i = 13; i > 0; i--) {
      const start = Math.max(from, to - i * 7 * DAY);
      buckets.push({ from: start, to: to - (i - 1) * 7 * DAY, label: dayName.format(start) });
    }
  } else if (key === 'all') {
    const first = Math.min(now, ...orders.map((o) => Date.parse(o.createdAt)).filter(Number.isFinite));
    for (let t = Math.max(monthStart(first), monthStart(now, -23)); t < to; t = monthStart(t, 1)) {
      buckets.push({ from: t, to: monthStart(t, 1), label: monthName.format(t) });
    }
  } else {
    for (let t = from; t < to; t += DAY) buckets.push({ from: t, to: Math.min(t + DAY, to), label: dayName.format(t) });
  }
  return { from, to, prev, buckets };
}

// A set of orders' sales in a period: what was raised, what Management decided, what was delivered.
function salesFigures(orders, r) {
  const raised = orders.filter((o) => within(o.createdAt, r));
  const decided = orders.flatMap((o) => o.events).filter((e) => DECISIONS.includes(e.type) && within(e.at, r));
  const approved = decided.filter((e) => e.type === 'approve').length;
  const delivered = orders.filter((o) => o.events.some((e) => e.type === 'deliver' && within(e.at, r)));
  return {
    raised: raised.length,
    sales: sumOf(raised.filter(isSale)),
    approved,
    decisions: decided.length,
    approvalRate: decided.length ? approved / decided.length : null,
    delivered: delivered.length,
    deliveredValue: sumOf(delivered),
  };
}

const trendOf = (orders, r) => r.buckets.map((b) => {
  const sold = orders.filter((o) => isSale(o) && within(o.createdAt, b));
  return { label: b.label, value: sumOf(sold), count: sold.length };
});

// Someone's approve, send back and reject steps in a period, with how long each order waited.
function decisionsBy(userId, orders, r) {
  const found = [];
  for (const o of orders) {
    o.events.forEach((e, i) => {
      if (DECISIONS.includes(e.type) && e.actor?.id === userId && within(e.at, r)) {
        found.push({ o, e, hours: (Date.parse(e.at) - reachedAt(o, i, 'pending_approval')) / HOUR });
      }
    });
  }
  return found;
}

function decisionFigures(found) {
  const n = (type) => found.filter((d) => d.e.type === type).length;
  return {
    decisions: found.length,
    approved: n('approve'),
    sentBack: n('send_back'),
    rejected: n('reject'),
    approvalRate: found.length ? n('approve') / found.length : null,
    approvedValue: sumOf([...new Set(found.filter((d) => d.e.type === 'approve').map((d) => d.o))]),
    decideHours: median(found.map((d) => d.hours).filter((h) => Number.isFinite(h) && h >= 0)),
  };
}

function salespersonDashboard(user, all, r) {
  const mine = all.filter((o) => o.ownerId === user.id);
  return {
    now: salesFigures(mine, r),
    prev: r.prev && salesFigures(mine, r.prev),
    trend: trendOf(mine, r),
    sentBack: mine.filter((o) => o.status === 'returned').length,
  };
}

// A manager's team is the salespeople whose orders they decided on in the period.
function managementDashboard(user, all, r, now) {
  const found = decisionsBy(user.id, all, r);
  const approvedByMe = (o) => o.events.some((e) => e.type === 'approve' && e.actor?.id === user.id);
  const deliveredIn = (range) => sumOf(all.filter((o) => approvedByMe(o) && o.events.some((e) => e.type === 'deliver' && within(e.at, range))));
  const team = new Map();
  for (const { o, e } of found) {
    const row = team.get(o.ownerId) ?? { name: ownerName(o), approved: 0, sentBack: 0, rejected: 0, orders: new Set() };
    if (e.type === 'approve') {
      row.approved += 1;
      row.orders.add(o);
    }
    if (e.type === 'send_back') row.sentBack += 1;
    if (e.type === 'reject') row.rejected += 1;
    team.set(o.ownerId, row);
  }
  const waiting = all.filter((o) => o.status === 'pending_approval');
  const waitedDays = waiting.map((o) => (now - reachedAt(o, o.events.length, 'pending_approval')) / DAY);
  return {
    now: { ...decisionFigures(found), delivered: deliveredIn(r) },
    prev: r.prev && { ...decisionFigures(decisionsBy(user.id, all, r.prev)), delivered: deliveredIn(r.prev) },
    team: [...team.values()]
      .map(({ orders, ...row }) => ({ ...row, value: sumOf([...orders]), delivered: sumOf([...orders].filter((o) => o.status === 'completed')) }))
      .sort((a, b) => b.value - a.value || b.approved - a.approved),
    waiting: { count: waiting.length, value: sumOf(waiting), oldestDays: waitedDays.length ? Math.floor(Math.max(...waitedDays)) : null },
  };
}

function financeDashboard(_user, all, r, now) {
  const daysIn = (o, status) => Math.floor((now - reachedAt(o, o.events.length, status)) / DAY);
  const brief = (o, extra = {}) => ({ id: o.id, customer: o.customerName ?? null, owner: ownerName(o), total: o.total, ...extra });
  const awaiting = all.filter((o) => o.status === 'awaiting_payment').map((o) => ({ o, days: daysIn(o, 'awaiting_payment') }));
  const held = all.filter((o) => o.status === 'on_hold').map((o) => ({ o, days: daysIn(o, 'on_hold') }));
  const large = all.filter((o) => BEFORE_PAYMENT.includes(o.status) && o.total >= LARGE_ORDER).sort((a, b) => b.total - a.total);
  const verified = (range) => all.filter((o) => o.payment && within(o.payment.verifiedAt, range));
  const mismatched = (range) => verified(range).filter((o) => Math.abs((o.payment.amount ?? 0) - o.total) >= 0.01);
  const received = (list) => round2(list.reduce((s, o) => s + (o.payment.amount ?? 0), 0));
  const off = mismatched(r).sort((a, b) => Math.abs(b.payment.amount - b.total) - Math.abs(a.payment.amount - a.total));
  return {
    awaiting: {
      count: awaiting.length,
      value: sumOf(awaiting.map((a) => a.o)),
      aging: AGING.map((band) => {
        const inBand = awaiting.filter((a) => a.days >= band.from && a.days <= band.to).map((a) => a.o);
        return { label: band.label, days: band.days, count: inBand.length, value: sumOf(inBand) };
      }),
      oldest: [...awaiting].sort((a, b) => b.days - a.days).slice(0, 5).map((a) => brief(a.o, { days: a.days })),
    },
    large: { threshold: LARGE_ORDER, count: large.length, value: sumOf(large), top: large.slice(0, 3).map((o) => brief(o)) },
    mismatches: {
      count: off.length,
      prevCount: r.prev ? mismatched(r.prev).length : null,
      net: round2(off.reduce((s, o) => s + (o.payment.amount - o.total), 0)),
      top: off.slice(0, 3).map((o) => brief(o, { received: o.payment.amount })),
    },
    onHold: { count: held.length, value: sumOf(held.map((h) => h.o)), longestDays: held.length ? Math.max(...held.map((h) => h.days)) : null },
    verified: {
      count: verified(r).length,
      received: received(verified(r)),
      prevReceived: r.prev ? received(verified(r.prev)) : null,
    },
  };
}

function adminDashboard(_user, all, r) {
  const users = listUsers();
  const steps = all.flatMap((o) => o.events);
  return {
    now: salesFigures(all, r),
    prev: r.prev && salesFigures(all, r.prev),
    trend: trendOf(all, r),
    roles: Array.from(ROLES).filter(Boolean).map((role) => ({
      role,
      label: ROLE_LABELS[role] || (role ? role.charAt(0).toUpperCase() + role.slice(1) : ''),
      active: users.filter((u) => u.role === role && u.active).length,
      inactive: users.filter((u) => u.role === role && !u.active).length,
    })).filter((r) => r && r.role),
    salespeople: users.filter((u) => u.role === 'salesperson').map((u) => {
      const f = salesFigures(all.filter((o) => o.ownerId === u.id), r);
      return { name: u.name, active: u.active, raised: f.raised, sales: f.sales, deliveredValue: f.deliveredValue, approvalRate: f.approvalRate };
    }).sort((a, b) => b.sales - a.sales || b.raised - a.raised),
    managers: users.filter((u) => u.role === 'management').map((u) => {
      const f = decisionFigures(decisionsBy(u.id, all, r));
      return { name: u.name, active: u.active, decisions: f.decisions, approved: f.approved, sentBack: f.sentBack, rejected: f.rejected, decideHours: f.decideHours };
    }).sort((a, b) => b.decisions - a.decisions),
    discord: {
      kind: storage.kind,
      waiting: steps.filter((e) => ['queued', 'sending'].includes(e.discord?.state)).length,
      failed: steps.filter((e) => e.discord?.state === 'failed').length,
    },
  };
}

function dispatchDashboard(_user, all, r, now) {
  const brief = (o, extra = {}) => ({
    id: o.id,
    customer: o.customerName ?? null,
    owner: ownerName(o),
    total: o.total,
    deliveryMethod: o.deliveryMethod || 'Standard',
    courier: o.dispatch?.courier || null,
    trackingNumber: o.dispatch?.trackingNumber || null,
    status: o.status,
    ...extra,
  });

  const ready = all.filter((o) => o.status === 'ready_for_dispatch');
  const picking = all.filter((o) => o.status === 'picking');
  const packed = all.filter((o) => o.status === 'packed');
  const dispatched = all.filter((o) => o.status === 'dispatched');

  const delivered = all.filter((o) => o.events.some((e) => e.type === 'deliver' && within(e.at, r)));
  const prevDelivered = r.prev ? all.filter((o) => o.events.some((e) => e.type === 'deliver' && within(e.at, r.prev))) : null;

  const turnarounds = delivered.map((o) => {
    const readyEvent = o.events.find((e) => e.type === 'verify_payment' || e.to === 'ready_for_dispatch');
    const deliverEvent = o.events.find((e) => e.type === 'deliver');
    if (!readyEvent || !deliverEvent) return null;
    const diff = (Date.parse(deliverEvent.at) - Date.parse(readyEvent.at)) / HOUR;
    return Number.isFinite(diff) && diff >= 0 ? diff : null;
  }).filter((h) => h !== null);

  const courierCounts = {};
  for (const o of [...dispatched, ...delivered]) {
    const c = o.dispatch?.courier || o.deliveryMethod || 'Standard';
    courierCounts[c] = (courierCounts[c] || 0) + 1;
  }
  const couriers = Object.entries(courierCounts)
    .map(([courier, count]) => ({ courier, count }))
    .sort((a, b) => b.count - a.count);

  return {
    pipeline: {
      ready: { count: ready.length, value: sumOf(ready), items: ready.slice(0, 5).map(brief) },
      picking: { count: picking.length, value: sumOf(picking), items: picking.slice(0, 5).map(brief) },
      packed: { count: packed.length, value: sumOf(packed), items: packed.slice(0, 5).map(brief) },
      dispatched: { count: dispatched.length, value: sumOf(dispatched), items: dispatched.slice(0, 5).map(brief) },
    },
    fulfillment: {
      deliveredCount: delivered.length,
      deliveredValue: sumOf(delivered),
      prevDeliveredCount: prevDelivered ? prevDelivered.length : null,
      prevDeliveredValue: prevDelivered ? sumOf(prevDelivered) : null,
      turnaroundHours: turnarounds.length ? median(turnarounds) : null,
    },
    couriers,
    urgent: [...ready, ...picking].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 8).map(brief),
  };
}

function teamLeaderDashboard(user, all, r, now) {
  const brief = (o, extra = {}) => ({ id: o.id, customer: o.customerName ?? null, owner: ownerName(o), total: o.total, status: o.status, ...extra });
  const users = listUsers();
  // Supervised salespeople (direct teamLeaderId match, or unassigned salespeople)
  const mySalespeople = users.filter((u) => u.role === 'salesperson' && (u.teamLeaderId === user.id || !u.teamLeaderId));
  const teamUserIds = new Set(mySalespeople.map((u) => u.id));

  const teamOrders = all.filter((o) => teamUserIds.has(o.ownerId) || o.ownerId === user.id);
  const pendingReview = teamOrders.filter((o) => o.status === 'pending_tl_approval');
  const inProgress = teamOrders.filter((o) => !['completed', 'cancelled', 'rejected', 'deleted'].includes(o.status) && o.status !== 'pending_tl_approval');

  const nowSales = salesFigures(teamOrders, r);
  const prevSales = r.prev ? salesFigures(teamOrders, r.prev) : null;

  const team = mySalespeople.map((u) => {
    const orders = teamOrders.filter((o) => o.ownerId === u.id);
    const f = salesFigures(orders, r);
    return {
      id: u.id,
      name: u.name,
      active: u.active,
      raised: f.raised,
      sales: f.sales,
      deliveredValue: f.deliveredValue,
      pending: orders.filter((o) => o.status === 'pending_tl_approval').length,
    };
  }).sort((a, b) => b.sales - a.sales || b.raised - a.raised);

  return {
    now: nowSales,
    prev: prevSales,
    trend: trendOf(teamOrders, r),
    pendingReview: {
      count: pendingReview.length,
      value: sumOf(pendingReview),
      items: pendingReview.slice(0, 6).map(brief),
    },
    inProgress: {
      count: inProgress.length,
      value: sumOf(inProgress),
    },
    team,
  };
}

const DASHBOARDS = {
  salesperson: salespersonDashboard,
  team_leader: teamLeaderDashboard,
  management: managementDashboard,
  finance: financeDashboard,
  dispatch: dispatchDashboard,
  admin: adminDashboard,
};

// ---------- routes ----------

const router = express.Router();
router.use(requireUser, jsonOnly);

router.get('/meta', (req, res) => res.json({
  statuses: STATUS,
  roles: ROLE_LABELS,
  orderFields: ORDER_FIELDS.map(describeField),
  fields: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, describeField(k)])),
  fieldLabels: { ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])), items: 'Items', total: 'Total', files: 'Files' },
  files: { ...FILES, kinds: FILE_KINDS, accept: Object.keys(FILE_TYPES).map((ext) => `.${ext}`).join(',') },
  discord: audit.describe(),
  storage,
  products: products.getProducts(),
  divisionRules: products.DIVISION_PRICE_RULES,
  priceTiers: products.PRICE_TIERS,
  configs: configStore.getAllConfigs(),
  canRaiseOrders: canRaiseOrders(req.user),
  canManageSettings: configStore.hasPermission(req.user.role, 'manage_settings'),
  canManageUsers: configStore.hasPermission(req.user.role, 'manage_users'),
  canDeleteOrders: configStore.hasPermission(req.user.role, 'delete_orders'),
  canRestoreOrders: configStore.hasPermission(req.user.role, 'restore_orders'),
}));

router.get('/products', (_req, res) => res.json({
  products: products.getProducts(),
  divisionRules: products.DIVISION_PRICE_RULES,
  priceTiers: products.PRICE_TIERS,
}));

router.get('/customers', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  res.json({ customers: customers.searchCustomers(q) });
});

router.post('/customers', (req, res, next) => {
  try {
    const customer = customers.addCustomer(req.body ?? {});
    res.status(201).json({ customer });
  } catch (err) {
    fail(err, res, next);
  }
});

router.post('/customers/quick', (req, res, next) => {
  try {
    const name = String(req.body?.name || req.body?.customerName || '').trim();
    if (!name) throw bad('Customer name is required.');
    const customer = customers.addCustomer({
      name,
      contactNumber: req.body?.contactNumber || '',
      address: req.body?.address || '',
      receiverName: req.body?.receiverName || '',
      receiverContact: req.body?.receiverContact || '',
      hasSpecialPrice: Boolean(req.body?.hasSpecialPrice),
    });
    res.status(201).json({ customer });
  } catch (err) {
    fail(err, res, next);
  }
});

// Custom Order Fields routes

// --- what moved to Orbit -----------------------------------------------------
// Roles, the order form's lists and extra fields, and promos are Orbit's. The
// writes are gone from here; the reads stay for now, because the order form
// still fills its dropdowns from them and will be re-pointed at Orbit's
// /orders-api/v1/config in the same step that deletes configStore.js.
const inOrbitNow = (what, where) => (_req, res) =>
  res.status(410).json({
    error: `${what} is managed in Orbit now, not here.`,
    orbit: `${(process.env.ORBIT_WEB_URL || '').replace(/\/$/, '')}${where}`,
  });

router.get('/custom-fields', requireUser, (_req, res) => {
  res.json({ fields: configStore.getOrderFields() });
});

router.post('/custom-fields', inOrbitNow('Extra order fields', '/settings/orders'));

router.put('/custom-fields/:id', inOrbitNow('Extra order fields', '/settings/orders'));

router.delete('/custom-fields/:id', inOrbitNow('Extra order fields', '/settings/orders'));

// Master Reference Data & RBAC routes
router.get('/configs', (_req, res) => {
  res.json({ configs: configStore.getAllConfigs() });
});

router.post('/configs/:type', inOrbitNow("The order form's lists", '/settings/orders'));

router.put('/configs/:type', inOrbitNow("The order form's lists", '/settings/orders'));

router.delete('/configs/:type/:id', inOrbitNow("The order form's lists", '/settings/orders'));

router.post('/rbac/roles', inOrbitNow('Roles and permissions', '/settings/roles'));

router.put('/rbac/roles/:roleId', inOrbitNow('Roles and permissions', '/settings/roles'));

router.delete('/rbac/roles/:roleId', inOrbitNow('Roles and permissions', '/settings/roles'));

// Promotions, Bundles & Discounts API
router.get('/promotions', (req, res, next) => {
  try {
    const promotions = configStore.getPromotions();
    res.json({ ok: true, promotions });
  } catch (err) {
    fail(err, res, next);
  }
});

// Bundles CRUD
router.post('/promotions/bundle', inOrbitNow('Bundles', '/m/inventory/bundles'));

router.delete('/promotions/bundle/:bundleId', inOrbitNow('Bundles', '/m/inventory/bundles'));

// Promos / Campaigns CRUD
router.post('/promotions/promo', inOrbitNow('Promos', '/m/inventory/promos'));

router.delete('/promotions/promo/:promoId', inOrbitNow('Promos', '/m/inventory/promos'));

// Discounts CRUD
router.post('/promotions/discount', inOrbitNow('Discounts', '/m/inventory/promos'));

router.delete('/promotions/discount/:discountId', inOrbitNow('Discounts', '/m/inventory/promos'));

// The signed-in person's dashboard, for ?period=month (the default), last_month, 90d or all.
router.get('/dashboard', (req, res, next) => {
  try {
    const build = DASHBOARDS[req.user.role];
    if (!build) throw bad('There is no dashboard for this role.', 404);
    const key = Object.hasOwn(PERIODS, req.query.period) ? req.query.period : 'month';
    const now = Date.now();
    const all = Object.values(state.orders).filter((o) => o.status !== 'deleted');
    const r = periodRange(key, all, now);
    res.json({
      role: req.user.role,
      period: { key, label: PERIODS[key], compare: r.prev ? COMPARED_WITH[key] : null },
      periods: PERIODS,
      at: new Date(now).toISOString(),
      ...build(req.user, all, r, now),
    });
  } catch (err) {
    fail(err, res, next);
  }
});

// Who a new order can be for, besides yourself: every other active salesperson.
router.get('/owners', (req, res, next) => {
  try {
    if (!CREATORS.includes(req.user.role)) throw bad('Only Salesperson, Management or Admin can raise orders.', 403);
    const salespeople = listUsers()
      .filter((u) => u.role === 'salesperson' && u.active && u.id !== req.user.id)
      .map(({ id, name }) => ({ id, name }));
    res.json({ salespeople });
  } catch (err) {
    fail(err, res, next);
  }
});

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
    if (!CREATORS.includes(req.user.role)) throw bad('Only Salesperson, Team Leader, Management or Admin can raise orders.', 403);
    const files = readAttachments(req.body?.attachments);
    const form = readOrderForm(req.body, files, req.user.role);
    const pick = req.body?.ownerId;
    const forOther = pick != null && pick !== '' && Number(pick) !== req.user.id;
    const owner = forOther ? salespersonFor(pick) : req.user;   // for me, or for an active salesperson
    const now = new Date().toISOString();
    const id = nextOrderId();
    const initialStatus = (req.user.role === 'salesperson') ? 'pending_tl_approval' : 'pending_approval';
    const order = {
      id,
      status: initialStatus,
      ownerId: owner.id,
      owner: { id: owner.id, name: owner.name },
      createdBy: { id: req.user.id, name: req.user.name, role: req.user.role },
      createdAt: now,
      updatedAt: now,
      ...form,
      payment: null,
      shipment: null,
      // They go out with this first step's data, so seq says which message holds them.
      attachments: files.map(({ data, ...file }, n) => ({ n, ...file, seq: 1, ...discordFile(id, n, file.name) })),
      events: [],
      discord: {},
    };
    const details = { items: form.items.length, total: form.total, ...(files.length ? { files: files.length } : {}) };
    const step = record(order, req.user, 'created', 'Order created', null, initialStatus, { details });
    keepFiles(step, order, files);
    state.orders[order.id] = order;
    if (order.customerName) {
      customers.addCustomer({
        name: order.customerName,
        contactNumber: order.contactNumber,
        address: order.address,
        receiverName: order.receiverName,
        receiverContact: order.receiverContact,
        division: order.division,
        subDivision: order.subDivision,
        headQuarter: order.headQuarter,
      });
    }
    audit.sync(order.id);
    if (req.user.role === 'admin') {
      audit.logAdmin({ title: `Created ${order.id}`, description: `For ${owner.name}`, actor: order.createdBy, at: now });
    }
    res.status(accepted(201)).json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get('/recycle-bin', requirePermission('manage_settings'), (req, res) => {
  const recycledOrders = Object.values(state.orders)
    .filter((o) => o.status === 'deleted')
    .map((o) => ({
      ...summary(o),
      daysLeft: recycleBin.calculateDaysLeft(o.purgeAt || (o.deletedAt ? new Date(new Date(o.deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() : null)),
      type: 'order',
    }));
  const recycledOthers = recycleBin.getRecycleBinSettings().map((it) => ({
    ...it,
    daysLeft: recycleBin.calculateDaysLeft(it.purgeAt),
  }));
  res.json({
    orders: recycledOrders,
    others: recycledOthers,
    total: recycledOrders.length + recycledOthers.length,
  });
});

async function purgeSingleRecycledItem(req, res, next) {
  try {
    const id = req.params.id;
    const order = state.orders[id];
    if (order) {
      if (order.status !== 'deleted') {
        throw bad('Order must be in the Recycle Bin before it can be permanently deleted.', 400);
      }
      await audit.purgeOrder(order, req.user);
      delete state.orders[id];
      recycleBin.removeRecycledItem(id, 'order');
      return res.json({ ok: true, message: `Order ${id} permanently deleted and vanished from Discord database.` });
    }

    const item = recycleBin.findRecycledItem(id);
    if (item) {
      await recycleBin.permanentlyPurgeRecycledItem(item);
      return res.json({ ok: true, message: `${item.name} permanently deleted and vanished from Discord database.` });
    }

    throw bad('Item not found in Recycle Bin.', 404);
  } catch (err) {
    fail(err, res, next);
  }
}

router.delete('/recycle-bin/:id', requirePermission('delete_orders'), purgeSingleRecycledItem);
router.delete('/:id/permanent', requirePermission('delete_orders'), purgeSingleRecycledItem);

router.post('/recycle-bin/empty', requirePermission('delete_orders'), async (req, res, next) => {
  try {
    const deletedOrders = Object.values(state.orders).filter((o) => o.status === 'deleted');
    for (const order of deletedOrders) {
      await audit.purgeOrder(order, req.user);
      delete state.orders[order.id];
      recycleBin.removeRecycledItem(order.id, 'order');
    }
    const otherItems = [...recycleBin.getRecycleBinSettings()];
    for (const item of otherItems) {
      await recycleBin.permanentlyPurgeRecycledItem(item);
    }
    res.json({
      ok: true,
      purgedOrders: deletedOrders.length,
      purgedOthers: otherItems.length,
      totalPurged: deletedOrders.length + otherItems.length,
      message: `Recycle Bin emptied: ${deletedOrders.length + otherItems.length} item(s) permanently vanished from Discord database.`,
    });
  } catch (err) {
    fail(err, res, next);
  }
});

router.post('/recycle-bin/:id/restore', requirePermission('delete_orders'), async (req, res, next) => {
  const id = req.params.id;
  const order = state.orders[id];
  if (order) {
    req.body = req.body || {};
    req.body.reason = req.body.reason || req.body.note || 'Restored from Recycle Bin';
    return takeStep(req, res, next, 'restore');
  }
  const item = recycleBin.findRecycledItem(id);
  if (item) {
    if (item.type === 'customer' && item.data) {
      customers.addCustomer(item.data);
    } else if (item.type === 'bundle' && item.data) {
      const bundles = configStore.getPromotionsBundles();
      bundles.push(item.data);
      configStore.setPromotionsBundles(bundles);
    } else if (item.type === 'promo' && item.data) {
      const promos = configStore.getPromotionsPromos();
      promos.push(item.data);
      configStore.setPromotionsPromos(promos);
    } else if (item.type === 'discount' && item.data) {
      const discounts = configStore.getPromotionsDiscounts();
      discounts.push(item.data);
      configStore.setPromotionsDiscounts(discounts);
    } else if (item.type === 'role' && item.data) {
      const roles = configStore.getRoles();
      roles.push(item.data);
      configStore.setRoles(roles);
    }
    recycleBin.removeRecycledItem(id);
    const category = item.discord?.category || 'setting';
    await discordHub.notifyCategory(category, {
      title: `♻️ Restored: ${item.name}`,
      description: `${item.name} (${item.type}) was restored from the Recycle Bin by ${req.user.name}.`,
      actor: req.user,
    }).catch(() => {});
    return res.json({ ok: true, message: `${item.name} restored successfully.` });
  }
  return res.status(404).json({ error: 'Item not found in Recycle Bin.' });
});

router.get('/:id', (req, res, next) => {
  try {
    res.json({ order: fullOrder(visibleOrder(req), req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

async function takeStep(req, res, next, name) {
  try {
    const order = visibleOrder(req);
    const spec = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!spec) throw bad('No such step.', 404);
    const refusal = refuse(req.user, order, spec);
    if (refusal) throw bad(refusal[1], refusal[0]);

    const body = req.body ?? {};
    const from = order.status;
    const at = new Date().toISOString();
    let to = typeof spec.to === 'function' ? spec.to(order, req.user) : spec.to;
    let details = null;
    let note = null;
    let newFiles = [];
    if (spec.form === 'order') {
      // Division, sub-division, and headquarters cannot be changed in salesperson view (products and items can be edited upon resubmission)
      if (req.user.role === 'salesperson') {
        body.division = order.division;
        body.subDivision = order.subDivision;
        body.headQuarter = order.headQuarter;
      }
      let currentAttachments = order.attachments ?? [];
      if (Array.isArray(body.keepExistingAttachmentIndices)) {
        currentAttachments = currentAttachments.filter((f) => body.keepExistingAttachmentIndices.includes(f.n));
      }
      if (Array.isArray(body.attachments) && body.attachments.length > 0) {
        newFiles = readAttachments(body.attachments);
        const startN = currentAttachments.length;
        const appended = newFiles.map(({ data, ...file }, idx) => ({
          n: startN + idx,
          ...file,
          seq: order.events.length + 1,
          ...discordFile(order.id, startN + idx, file.name),
        }));
        order.attachments = [...currentAttachments, ...appended];
      } else {
        order.attachments = currentAttachments;
      }

      const form = readOrderForm(body, order.attachments ?? [], req.user.role);
      if (req.user.role === 'salesperson') {
        form.division = order.division;
        form.subDivision = order.subDivision;
        form.headQuarter = order.headQuarter;
      }
      Object.assign(order, form);
      details = { items: form.items.length, total: form.total, ...(newFiles.length ? { files: newFiles.length } : {}) };
    } else if (spec.form === 'edit') {
      ({ to, details, note, newFiles } = applyEdit(order, body));
    } else if (spec.fields) {
      const values = readFields(spec.fields, body);
      note = values.reason ?? values.note ?? null;
      const facts = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== 'reason' && k !== 'note' && v != null));
      details = Object.keys(facts).length ? facts : null;
      if (spec.name === 'verify_payment') order.payment = { ...facts, verifiedBy: req.user.name, verifiedAt: at };
      if (spec.name === 'mark_packed') order.shipment = { ...(order.shipment || {}), ...facts, packedAt: at, packedBy: req.user.name };
      if (spec.name === 'dispatch') order.shipment = { ...(order.shipment || {}), ...facts, dispatchedAt: at, dispatchedBy: req.user.name };
      if (spec.name === 'deliver') order.shipment = { ...(order.shipment || {}), ...facts, deliveredAt: at, deliveredBy: req.user.name };
    }
    if (Array.isArray(body.attachments) && body.attachments.length > 0 && spec.form !== 'order' && spec.form !== 'edit') {
      const addedFiles = readAttachments(body.attachments);
      let currentAttachments = order.attachments ?? [];
      const startN = currentAttachments.length;
      const appended = addedFiles.map(({ data, ...file }, idx) => ({
        n: startN + idx,
        ...file,
        seq: order.events.length + 1,
        ...discordFile(order.id, startN + idx, file.name),
      }));
      order.attachments = [...currentAttachments, ...appended];
      newFiles = [...newFiles, ...addedFiles];
      details = { ...(details || {}), files: addedFiles.length };
    }
    if (spec.name === 'purge_order') {
      await audit.purgeOrder(order, req.user);
      delete state.orders[order.id];
      recycleBin.removeRecycledItem(order.id, 'order');
      return res.json({ ok: true, purged: true, message: `Order ${order.id} permanently deleted and vanished from Discord database.` });
    }
    if (spec.name === 'delete_order') {
      order.deletedAt = at;
      order.purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      order.deletedBy = { id: req.user.id, name: req.user.name, role: req.user.role };
    } else if (spec.name === 'restore') {
      to = statusBeforeDelete(order);
      delete order.deletedAt;
      delete order.purgeAt;
      delete order.deletedBy;
    }

    const roleLabel = ROLE_LABELS[req.user.role] ?? (req.user.role ? (req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1)) : 'Admin');
    const doneLabel = spec.name === 'edit' ? `Edited by ${roleLabel}` : spec.done;
    const step = record(order, req.user, spec.name, doneLabel, from, to, { details, note });
    if (newFiles && newFiles.length > 0) {
      keepFiles(step, order, newFiles);
    }
    audit.sync(order.id);
    if (spec.logged) logAdmin(req.user, `${spec.logged} ${order.id}`, step);
    res.status(accepted(200)).json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
}



router.post('/:id/actions/:action', (req, res, next) => takeStep(req, res, next, req.params.action));
router.patch('/:id', (req, res, next) => takeStep(req, res, next, 'edit'));             // Admin: update
router.delete('/:id', (req, res, next) => takeStep(req, res, next, 'delete_order'));   // Admin: delete, moved to Recycle Bin

// Opens file n of an order, for anyone who may see the order. Until Discord has it, it comes from
// memory; after that from its message in #order-audit, decrypted here.
router.get('/:id/files/:n', async (req, res, next) => {
  try {
    const order = visibleOrder(req);
    const meta = order.attachments?.[Number(req.params.n)];
    if (!meta) throw bad('No such file.', 404);
    const step = order.events.find((e) => e.seq === meta.seq);
    const data = step?.files?.find((f) => f.n === meta.n)?.data ?? await audit.fetchFile(order, step, meta);
    res.set({
      'Content-Type': meta.type,
      'Content-Disposition': `inline; filename="${meta.name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(data);
  } catch (err) {
    fail(err, res, next);
  }
});

// Sends again whatever isn't stored in #order-audit yet, in order.
router.post('/:id/audit/retry', (req, res, next) => {
  try {
    if (!configStore.hasPermission(req.user.role, 'manage_settings')) throw bad('You do not have permission to send the audit again.', 403);
    const order = visibleOrder(req);
    audit.retry(order.id);
    res.json({ order: fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

function setOrderPurgeDateForTesting(orderId, deletedAt, purgeAt) {
  if (state.orders[orderId]) {
    state.orders[orderId].deletedAt = deletedAt;
    state.orders[orderId].purgeAt = purgeAt;
  }
}

module.exports = { router, load, STATUS, ACTIONS, checkAndPurgeExpired, setOrderPurgeDateForTesting };
