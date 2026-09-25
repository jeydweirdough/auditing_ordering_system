// The orders app: a Salesperson raises an order, then their Team Leader,
// Management, Finance and Dispatch each take their step. Admin can also edit,
// delete and restore any order. Every step is recorded in the order's trail.
//
// Orders live in the shared Getmeds database (src/orderRepo.js), the same rows
// getmeds-system works on, and reach Zoho through getmeds-system's own code
// (src/workflow/zohoSteps.js): Approve creates the Sales Order, Verify payment
// confirms it. Until Sep 25, 2026 they lived in Discord threads.
//
// The steps are described once, in ACTIONS: the server checks who may take a
// step, and when, from it, and hands the same description to the page to draw
// each step's form.
const express = require('express');
const db = require('./db');
const { requireUser, requirePermission, jsonOnly, findUser, listUsers, toDbRole, ROLES, ROLE_LABELS } = require('./accounts');
const products = require('./products');
const customers = require('./customers');
const configStore = require('./configStore');
const recycleBin = require('./recycleBin');
const repo = require('./orderRepo');
const zohoSteps = require('./workflow/zohoSteps');
const { STATUS, LIVE, CLOSED, BEFORE_PAYMENT, WAITING_ON } = require('./workflow/statuses');
const { invoke, relay } = require('./coreBridge');
const { generateOrderId } = require('./core/services/orderIdService');
const { notify, getUserIdsByRole } = require('./core/services/notificationService');
const { rxSummaries } = require('./core/services/prescriptionService');
const { buildTimeline } = require('./core/services/orderTimelineService');
const { WAREHOUSES, UNASSIGNED } = require('./core/services/dispatchWarehouses');
const { isDryRunMode } = require('./core/services/zohoTestFlags');
const proofStorage = require('./core/services/paymentProofStorage');
const coreOrders = require('./core/controllers/orders.controller');
const coreProof = require('./core/controllers/paymentProof.controller');
const coreDispatch = require('./core/controllers/dispatch.controller');

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

  for (const cf of configStore.getOrderFields() || []) {
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
  get: (_t, prop) => getFreshFields()[prop],
  ownKeys: () => Object.keys(getFreshFields()),
  getOwnPropertyDescriptor: (_t, prop) => ({ enumerable: true, configurable: true, value: getFreshFields()[prop] }),
});

const BASE_ORDER_FIELDS = [
  'customerName', 'contactNumber', 'address', 'receiverName', 'receiverContact',
  'division', 'subDivision', 'headQuarter', 'invoicingFrom', 'source', 'paymentMethod', 'paymentTerms', 'deliveryMethod',
  'customerIsDoctor', 'doctorName', 'remarks', 'notes',
];
const customFieldIds = () => (configStore.getOrderFields() || []).filter((f) => f.active !== false).map((f) => f.id);
const orderFields = () => [...BASE_ORDER_FIELDS, ...customFieldIds()];

// Files an order can carry, by extension: photos, PDF, Word and Excel. They
// upload straight from the browser to storage (Supabase), a file at a time, so
// the only limit is per file (proofStorage.MAX_BYTES), not per order.
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
const FILES = { max: 20, maxBytes: proofStorage.MAX_BYTES };
const PAYMENT_FIELDS = ['method', 'reference', 'amount', 'paidOn'];

// Payment terms that mean the customer pays up front. Anything else is on
// terms (credit): getmeds-system, and the Zoho Sales Order, need to know which.
const DIRECT_TERMS = ['paid', 'cash', 'cod', 'due on receipt', 'advanced payment', 'advanced payment - partial', 'donation/charity', 'samples'];
const customerTypeFor = (terms) => (DIRECT_TERMS.includes(String(terms || '').trim().toLowerCase()) ? 'direct' : 'credit');

// Where a Salesperson's order goes when they submit it: their Team Leader, or
// any Team Leader when they have none. Straight to Management when nobody
// holds the role, so an order never waits on a person who doesn't exist.
async function reviewStatusFor(order) {
  if (order.owner?.role !== 'salesperson' && order.createdBy?.role !== 'salesperson') return 'pending_management_approval';
  if (order.owner?.teamLeaderId) {
    const tl = await findUser(order.owner.teamLeaderId);
    if (tl?.active && tl.role === 'team_leader') return 'pending_tl_approval';
  }
  const leaders = await listUsers({ roles: ['team_leader'] });
  return leaders.some((u) => u.active) ? 'pending_tl_approval' : 'pending_management_approval';
}

// label: the button. done: how the step reads in the trail. mine: only whoever
// raised the order or the salesperson it's for. owner: the same, for
// salespeople only. form: the step has its own form on the page. logged: an
// admin change. to: a status, a function of the order, or null (unchanged).
const ACTIONS = {
  submit: { label: 'Submit for approval', done: 'Submitted', roles: ['salesperson', 'team_leader', 'management', 'admin'], from: ['draft'], to: reviewStatusFor, mine: true },
  resubmit: { label: 'Edit for approval', done: 'Resubmitted', roles: ['salesperson', 'team_leader', 'management'], from: ['returned'], to: reviewStatusFor, mine: true, form: 'order' },
  tl_approve: { label: 'Endorse to Management', done: 'Endorsed by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'pending_management_approval', fields: ['note'] },
  tl_send_back: { label: 'Send back for changes', done: 'Sent back by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'returned', fields: ['reason'] },
  tl_reject: { label: 'Reject', done: 'Rejected by Team Leader', roles: ['team_leader'], from: ['pending_tl_approval'], to: 'rejected', fields: ['reason'], danger: true },
  approve: { label: 'Approve', done: 'Approved', roles: ['management'], from: ['pending_management_approval'], to: 'ready_for_finance_verified', fields: ['note'], zoho: 'Creates the Sales Order in Zoho.' },
  send_back: { label: 'Send back for changes', done: 'Sent back for changes', roles: ['management'], from: ['pending_management_approval', 'pending_tl_approval'], to: 'returned', fields: ['reason'] },
  reject: { label: 'Reject', done: 'Rejected', roles: ['management'], from: ['pending_management_approval', 'pending_tl_approval'], to: 'rejected', fields: ['reason'], danger: true },
  verify_payment: { label: 'Verify payment', done: 'Payment verified', roles: ['finance'], from: ['ready_for_finance_verified', 'on_hold'], to: 'ready_for_dispatch', fields: PAYMENT_FIELDS, zoho: 'Confirms the Sales Order in Zoho.' },
  hold: { label: 'Put on hold', done: 'Put on hold', roles: ['finance'], from: ['ready_for_finance_verified'], to: 'on_hold', fields: ['reason'], danger: true },
  start_picking: { label: 'Start picking', done: 'Picking started', roles: ['dispatch'], from: ['ready_for_dispatch', 'ready_for_draft_invoice', 'ready_for_invoice_sent'], to: 'picking_packing', rx: true },
  mark_packed: { label: 'Mark packed', done: 'Packed', roles: ['dispatch'], from: ['picking_packing'], to: 'packed', fields: ['packingNotes'], rx: true },
  dispatch: { label: 'Dispatch', done: 'Dispatched', roles: ['dispatch'], from: ['packed'], to: 'dispatched', fields: ['courier', 'trackingNumber'], rx: true },
  deliver: { label: 'Mark delivered', done: 'Delivered', roles: ['dispatch'], from: ['dispatched', 'tracking_shared'], to: 'completed', fields: ['receivedBy'] },
  cancel: { label: 'Cancel order', done: 'Cancelled', roles: ['salesperson', 'team_leader', 'management'], from: ['draft', 'pending_tl_approval', 'pending_management_approval', 'returned', 'ready_for_finance_verified', 'on_hold'], to: 'cancelled', owner: true, fields: ['reason'], danger: true },
  edit: { label: 'Edit order', done: 'Edited', roles: ['admin', 'management', 'finance', 'team_leader'], from: LIVE, to: null, form: 'edit', logged: 'Edited' },
  delete_order: { label: 'Delete order', done: 'Deleted by Admin', roles: ['admin'], from: LIVE, to: 'deleted', fields: ['reason'], danger: true, logged: 'Deleted' },
  restore: { label: 'Restore order', done: 'Restored by Admin', roles: ['admin'], from: ['deleted'], to: null, fields: ['reason'], logged: 'Restored' },
  purge_order: { label: 'Delete permanently', done: 'Permanently deleted by Admin', roles: ['admin'], from: ['deleted'], to: null, fields: ['reason'], danger: true, logged: 'Purged' },
};
for (const [name, spec] of Object.entries(ACTIONS)) spec.name = name;

const ACTION_PERMISSIONS = {
  submit: 'raise_orders',
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

const canRaiseOrders = (user) => user && configStore.hasPermission(user.role, 'raise_orders');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(n * 100) / 100;
const describeField = (name) => ({ name, ...FIELDS[name] });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const statusLabel = (s) => STATUS[s] || s;

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
    const priceRemark = item?.priceRemark ? String(item.priceRemark).trim().slice(0, 500) : undefined;
    if (!product || product.length > 120) throw bad(`Item ${i + 1}: give a product name of up to 120 characters.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) throw bad(`Item ${i + 1}: quantity must be a whole number from 1 to 100,000.`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10_000_000) throw bad(`Item ${i + 1}: unit price must be from 0 to 10,000,000.`);
    return {
      product,
      qty,
      unitPrice: round2(unitPrice),
      ...(priceType ? { priceType } : {}),
      ...(unitType ? { unitType } : {}),
      ...(priceRemark ? { priceRemark } : {}),
    };
  });
}

// Each line points at the Zoho item it is for (the products table): that is
// what becomes the line on the Sales Order.
async function linkItems(items) {
  for (const [i, it] of items.entries()) {
    const row = await products.resolveProductRow(it.product);
    if (!row) {
      throw bad(`Item ${i + 1}: "${it.product}" isn't a product in Zoho, so it can't go on the Sales Order. Pick it from the product list.`);
    }
    it.productId = row.id;
  }
  return items;
}

const totalOf = (items) => round2(items.reduce((sum, it) => sum + it.qty * it.unitPrice, 0));

// The order form, checked. `attachments` are [{ kind }]: the files the order
// has, or (before it has any) the ones the page is about to upload, so the
// Guarantee Letter and prescription rules can be checked up front.
async function readOrderForm(body, attachments = [], role = null) {
  const values = readFields(orderFields(), body);
  const items = readItems(body?.items);
  const customer = body?.customerId ? await customers.getCustomer(body.customerId) : await customers.findCustomerByName(values.customerName);
  const customerHasSpecialPrice = Boolean(customer?.hasSpecialPrice);
  const constraintErr = products.validateOrderConstraints({ ...values, items, customerHasSpecialPrice }, attachments);
  if (constraintErr) throw bad(constraintErr);

  // In the salesperson view, products must come from the price list, at its prices.
  if (role === 'salesperson' && values.division !== 'BID') {
    for (const [i, it] of items.entries()) {
      const p = products.findProduct(it.product);
      if (!p) throw bad(`Item ${i + 1}: Salespeople must select an official catalog product ("${it.product}" was not found).`);
      if (it.priceType === 'special') continue;   // a special price is the requested one
      if (it.priceType && p.prices?.[it.priceType]) {
        const expected = it.unitType === 'pack' ? p.prices[it.priceType].packPrice : p.prices[it.priceType].unitPrice;
        if (expected != null && Math.abs(Number(expected) - it.unitPrice) > 0.01) {
          throw bad(`Item ${i + 1}: Products and prices cannot be changed in the salesperson view (expected ₱${expected} for ${p.brandName || p.fullName}).`);
        }
      }
    }
  }
  await linkItems(items);
  return { values, items, total: totalOf(items), customer, customerHasSpecialPrice };
}

// An order belongs to an active salesperson, whom Admin can pick.
async function salespersonFor(id) {
  const user = await findUser(Number(id));
  if (!user || user.role !== 'salesperson' || !user.active) throw bad('Pick an active salesperson for this order.');
  return user;
}

// An order is someone's when it's for them or they raised it, e.g. for another salesperson.
const isMine = (user, order) => order.ownerId === user.id || order.createdBy?.id === user.id;
const canSee = (user, order) => {
  if (order.status === 'deleted' && !configStore.hasPermission(user.role, 'restore_orders')) return false;
  if (user.role === 'salesperson') return isMine(user, order);
  if (user.role === 'team_leader') {
    if (isMine(user, order)) return true;
    // their team's, and any salesperson's who has no Team Leader
    return order.owner?.teamLeaderId === user.id || (order.owner?.role === 'salesperson' && !order.owner?.teamLeaderId);
  }
  return true;
};

// Why this person may not take this step now, as [status, message], or null when they may.
function refuse(user, order, spec) {
  const perm = ACTION_PERMISSIONS[spec.name];
  const hasPerm = perm ? configStore.hasPermission(user.role, perm) : spec.roles.includes(user.role);
  if (!hasPerm) return [403, 'Your role does not have permission to do this step.'];
  if (order.imported && !['edit', 'delete_order', 'restore', 'purge_order'].includes(spec.name)) {
    return [409, 'This order was imported from Zoho and is kept for reference. Work on it in Zoho.'];
  }
  if (!spec.from.includes(order.status)) return [409, `This order is ${statusLabel(order.status).toLowerCase()}, so this step isn't open.`];
  if (spec.mine || (spec.owner && user.role === 'salesperson')) {
    if (!isMine(user, order)) return [403, "Only whoever raised this order, or the salesperson it's for, can do that."];
  }
  // A Team Leader endorses their own people's orders (and those of salespeople
  // with no Team Leader), not everyone's.
  if (user.role === 'team_leader' && spec.roles.includes('team_leader') && !isMine(user, order)) {
    if (order.owner?.teamLeaderId && order.owner.teamLeaderId !== user.id) {
      return [403, 'This order belongs to a salesperson not assigned to your team.'];
    }
  }
  return null;
}

// The steps this person may take on this order now, for the page.
async function actionsFor(user, order) {
  const open = Object.values(ACTIONS).filter((spec) => !refuse(user, order, spec));
  const list = [];
  for (const spec of open) {
    let to = null;
    if (spec.name === 'restore') to = statusLabel(order.statusBeforeDelete || 'pending_management_approval');
    else if (typeof spec.to === 'function') to = statusLabel(await spec.to(order, user));
    else if (spec.to) to = statusLabel(spec.to);
    const rxBlocked = spec.rx && ['pending', 'rejected'].includes(order.rx?.state);
    list.push({
      name: spec.name,
      label: spec.label,
      to,
      danger: Boolean(spec.danger),
      form: spec.form ?? null,
      fields: (spec.fields ?? []).map(describeField),
      zoho: spec.zoho ?? null,
      blocked: rxBlocked ? (order.rx.state === 'pending'
        ? 'The prescription has not been verified by the pharmacist yet.'
        : 'The prescription was rejected and has not been replaced yet.') : null,
    });
  }
  return list;
}

async function fullOrder(order, user) {
  return {
    ...order,
    statusLabel: statusLabel(order.status),
    waitingOn: WAITING_ON[order.status] ? ROLE_LABELS[WAITING_ON[order.status]] : null,
    actions: await actionsFor(user, order),
  };
}

async function visibleOrder(req) {
  const order = await repo.getOrder(req.params.id);
  if (!order || !canSee(req.user, order)) throw bad('No such order.', 404);
  return order;
}

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// Who to tell, by this app's role names.
async function idsOf(...roles) {
  return getUserIdsByRole(...roles.map(toDbRole));
}

async function tell(order, recipientIds, message, eventType) {
  const ids = [...new Set(recipientIds.filter(Boolean))];
  if (!ids.length) return;
  await notify({
    orderId: order.dbId,
    recipientIds: ids,
    message,
    eventType,
    orderData: { getmeds_order_id: order.id, customer_name: order.customerName, status: order.status, total_amount: order.total },
  });
}

// ---------- editing (Admin, Management, Finance, Team Leader) ----------

// Which fields changed, what they were, and the writes that apply them. Nothing
// is written until the whole edit has been checked.
async function planEdit(order, body, user) {
  const { reason } = readFields(['reason'], body);
  const changed = [];
  const before = {};
  const shown = (v) => (v == null || v === '' ? '(empty)' : String(v));
  const note = (label, old) => {
    changed.push(label);
    before[label] = shown(old);
  };
  const writes = [];

  const present = orderFields().filter((k) => k in body);
  const values = readFields(present, body);
  const next = {};
  for (const k of present) {
    if ((values[k] ?? null) !== (order[k] ?? null)) {
      next[k] = values[k];
      note(FIELDS[k].label, order[k]);
    }
  }

  let items = null;
  if ('items' in body) {
    const incoming = readItems(body.items);
    const same = JSON.stringify(incoming.map(({ product, qty, unitPrice, priceType, unitType }) => ({ product, qty, unitPrice, priceType, unitType })))
      === JSON.stringify(order.items.map(({ product, qty, unitPrice, priceType, unitType }) => ({ product, qty, unitPrice, ...(priceType ? { priceType } : {}), ...(unitType ? { unitType } : {}) })));
    if (!same) {
      if (zohoSteps.hasRealSalesOrder({ zoho_so_id: order.zoho.soId })) {
        throw bad(`The items are on Sales Order ${order.zoho.soNumber || order.zoho.soId} in Zoho now. Change them there; they come back here on the next sync.`, 409);
      }
      items = await linkItems(incoming);
      note('Items', plural(order.items.length, 'item'));
      if (totalOf(items) !== order.total) note('Total', order.total.toFixed(2));
    }
  }

  if (items || present.some((k) => ['division', 'paymentTerms', 'source', 'notes', 'remarks'].includes(k))) {
    const merged = { ...order, ...next, items: items || order.items };
    const err = products.validateOrderConstraints(merged, order.attachments ?? []);
    if (err) throw bad(err);
  }

  if ('customerName' in next) {
    const customer = await customers.customerForOrder({ name: next.customerName, contactNumber: next.contactNumber ?? order.contactNumber, address: next.address ?? order.address, type: customerTypeFor(next.paymentTerms ?? order.paymentTerms) });
    writes.push(() => db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(customer.id, order.dbId));
  }

  let owner = null;
  if (body.ownerId != null && body.ownerId !== '' && Number(body.ownerId) !== order.ownerId) {
    owner = await salespersonFor(body.ownerId);
    note('Salesperson', order.owner?.name);
    writes.push(() => db.prepare('UPDATE orders SET medrep_id = ? WHERE id = ?').run(owner.id, order.dbId));
  }

  let to = order.status;
  if (body.status != null && body.status !== '' && body.status !== order.status) {
    if (!LIVE.includes(body.status)) throw bad(`Status must be one of: ${LIVE.join(', ')}.`);
    if (user.role !== 'admin') throw bad('Only Admin can set an order\'s status by hand.', 403);
    to = body.status;
    changed.push('Status');
  }

  if (order.payment && body.payment && typeof body.payment === 'object') {
    const v = readFields(PAYMENT_FIELDS, { ...order.payment, ...body.payment });
    const diff = PAYMENT_FIELDS.filter((k) => v[k] !== order.payment[k]);
    for (const k of diff) note(FIELDS[k].label, order.payment[k]);
    if (diff.length) writes.push(() => repo.recordPayment(order.dbId, v, user.id));
  }
  if (order.shipment && body.shipment && typeof body.shipment === 'object') {
    const keys = ['courier', 'trackingNumber', 'receivedBy', 'packingNotes'].filter((k) => order.shipment[k] != null && k in body.shipment);
    const v = readFields(keys, { ...order.shipment, ...body.shipment });
    const diff = keys.filter((k) => v[k] !== order.shipment[k]);
    for (const k of diff) note(FIELDS[k].label, order.shipment[k]);
    if (diff.includes('courier') || diff.includes('trackingNumber')) {
      writes.push(() => repo.recordDispatch(order.dbId, { courier: v.courier ?? order.shipment.courier, tracking_number: v.trackingNumber ?? order.shipment.trackingNumber }));
    }
    const extra = diff.filter((k) => ['receivedBy', 'packingNotes'].includes(k));
    if (extra.length) {
      writes.push(() => repo.mergeAppData(order.dbId, { shipment: { ...(order.shipment || {}), ...Object.fromEntries(extra.map((k) => [k, v[k]])) } }));
    }
  }

  if (!changed.length) throw bad('Nothing changed.');
  if (Object.keys(next).length) writes.push(() => repo.updateFields(order.dbId, next, customFieldIds()));
  if (items) writes.push(() => repo.replaceItems(order.dbId, items));
  return { to, note: reason, details: { changed, before }, writes };
}

// ---------- the steps ----------

// Everything a step writes besides the status and its trail entry, and whom it tells.
async function planStep(spec, order, body, user) {
  const plan = { to: spec.to, note: null, details: null, writes: [], tellAfter: null };
  const at = new Date().toISOString();

  if (typeof spec.to === 'function') plan.to = await spec.to(order, user);

  if (spec.name === 'submit') {
    const err = products.validateOrderConstraints(order, order.attachments);
    if (err) throw bad(err);
    plan.details = { items: order.items.length, total: order.total, ...(order.attachments.length ? { files: order.attachments.length } : {}) };
    plan.writes.push(() => db.prepare('UPDATE orders SET submitted_at = ? WHERE id = ?').run(at, order.dbId));
  } else if (spec.form === 'order') {
    // A salesperson can't move their order to another division when fixing it.
    if (user.role === 'salesperson') Object.assign(body, { division: order.division, subDivision: order.subDivision, headQuarter: order.headQuarter });
    const form = await readOrderForm(body, order.attachments, user.role);
    const customer = await customers.customerForOrder({
      customerId: body.customerId, name: form.values.customerName, contactNumber: form.values.contactNumber,
      address: form.values.address, receiverName: form.values.receiverName, receiverContact: form.values.receiverContact,
      type: customerTypeFor(form.values.paymentTerms),
    });
    plan.details = { items: form.items.length, total: form.total };
    plan.writes.push(
      () => repo.updateFields(order.dbId, form.values, customFieldIds()),
      () => repo.replaceItems(order.dbId, form.items),
      () => db.prepare('UPDATE orders SET customer_id = ?, customer_type = ?, submitted_at = ? WHERE id = ?')
        .run(customer.id, customerTypeFor(form.values.paymentTerms), at, order.dbId),
    );
  } else if (spec.form === 'edit') {
    const edit = await planEdit(order, body, user);
    Object.assign(plan, { to: edit.to, note: edit.note, details: edit.details, writes: edit.writes });
  } else if (spec.fields) {
    const values = readFields(spec.fields, body);
    plan.note = values.reason ?? values.note ?? null;
    const facts = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== 'reason' && k !== 'note' && v != null));
    plan.details = Object.keys(facts).length ? facts : null;
    const shipment = (extra) => repo.mergeAppData(order.dbId, { shipment: { ...(order.shipment || {}), ...extra } });

    if (spec.name === 'verify_payment') {
      plan.writes.push(() => repo.recordPayment(order.dbId, facts, user.id));
      if (order.status === 'on_hold') plan.writes.push(() => db.prepare('UPDATE orders SET exception_reason = NULL WHERE id = ?').run(order.dbId));
    }
    if (spec.name === 'hold') plan.writes.push(() => db.prepare('UPDATE orders SET exception_reason = ? WHERE id = ?').run(plan.note, order.dbId));
    if (spec.name === 'mark_packed') {
      plan.writes.push(
        () => repo.recordDispatch(order.dbId, { status: 'packing', dispatch_notes: facts.packingNotes ?? null }),
        () => shipment({ packingNotes: facts.packingNotes ?? null, packedAt: at, packedBy: user.name }),
      );
    }
    if (spec.name === 'dispatch') {
      plan.writes.push(() => repo.recordDispatch(order.dbId, {
        status: 'dispatched', courier: facts.courier, tracking_number: facts.trackingNumber, dispatched_by: user.id, dispatched_at: at,
      }));
    }
    if (spec.name === 'deliver') {
      plan.writes.push(
        () => repo.recordDispatch(order.dbId, { delivered_at: at, delivered_by: user.id }),
        () => shipment({ receivedBy: facts.receivedBy }),
      );
    }
    if (spec.name === 'cancel' && zohoSteps.hasRealSalesOrder({ zoho_so_id: order.zoho.soId })) {
      plan.note = `${plan.note} — Sales Order ${order.zoho.soNumber || order.zoho.soId} is still open in Zoho: void it there.`;
      plan.tellAfter = async () => tell(order, await idsOf('management', 'finance'),
        `Order ${order.id} was cancelled. Void Sales Order ${order.zoho.soNumber || order.zoho.soId} in Zoho.`, 'ORDER_CANCELLED');
    }
    if (spec.name === 'delete_order') {
      plan.writes.push(() => repo.mergeAppData(order.dbId, {
        deletedAt: at,
        purgeAt: new Date(Date.now() + recycleBin.RETENTION_MS).toISOString(),
        deletedBy: { id: user.id, name: user.name, role: user.role },
        statusBeforeDelete: order.status,
      }));
    }
    if (spec.name === 'restore') {
      plan.to = order.statusBeforeDelete || 'pending_management_approval';
      plan.writes.push(() => repo.removeAppData(order.dbId, ['deletedAt', 'purgeAt', 'deletedBy', 'statusBeforeDelete']));
    }
  }
  if (spec.name === 'start_picking') plan.writes.push(() => repo.recordDispatch(order.dbId, { status: 'picking' }));

  if (plan.to == null) plan.to = order.status;
  return plan;
}

// Who hears about a step, and what they're told.
async function announceStep(spec, order, to, note) {
  const owner = [order.ownerId, order.createdBy?.id];
  const reason = note ? `: ${note}` : '.';
  switch (spec.name) {
    case 'submit':
    case 'resubmit': {
      if (to === 'pending_tl_approval') {
        const leaders = order.owner?.teamLeaderId ? [order.owner.teamLeaderId] : await idsOf('team_leader');
        return tell(order, leaders, `Order ${order.id} from ${order.owner?.name} needs your endorsement.`, 'MANAGEMENT_APPROVAL_REQUIRED');
      }
      return tell(order, await idsOf('management'), `Order ${order.id} from ${order.owner?.name} needs your approval.`, spec.name === 'resubmit' ? 'ORDER_RESUBMITTED' : 'MANAGEMENT_APPROVAL_REQUIRED');
    }
    case 'tl_approve':
      return tell(order, await idsOf('management'), `Order ${order.id} was endorsed by the Team Leader and needs your approval.`, 'MANAGEMENT_APPROVAL_REQUIRED');
    case 'tl_send_back':
    case 'send_back':
      return tell(order, owner, `Order ${order.id} was sent back for changes${reason}`, 'MANAGEMENT_SENT_BACK');
    case 'tl_reject':
    case 'reject':
      return tell(order, owner, `Order ${order.id} was rejected${reason}`, 'MANAGEMENT_REJECTED');
    case 'verify_payment':
      return tell(order, [...owner, ...(await idsOf('dispatch'))], `Order ${order.id}: payment verified — ready for dispatch.`, 'FINANCE_VERIFIED');
    case 'hold':
      return tell(order, [...owner, ...(await idsOf('management'))], `Order ${order.id} was put on hold by Finance${reason}`, 'FINANCE_REJECTED');
    case 'dispatch':
      return tell(order, owner, `Order ${order.id} is on its way.`, 'ORDER_DISPATCHED');
    case 'deliver':
      return tell(order, owner, `Order ${order.id} was delivered.`, 'DELIVERY_CONFIRMED');
    case 'cancel':
      return tell(order, [...owner, ...(await idsOf('management'))], `Order ${order.id} was cancelled${reason}`, 'ORDER_CANCELLED');
    default:
      return null;
  }
}

async function takeStep(req, res, next, name) {
  try {
    const spec = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!spec) throw bad('No such step.', 404);
    const order = await visibleOrder(req);
    const refusal = refuse(req.user, order, spec);
    if (refusal) throw bad(refusal[1], refusal[0]);
    if (spec.rx && ['pending', 'rejected'].includes(order.rx?.state)) {
      throw bad(order.rx.state === 'pending'
        ? 'This order has a prescription the pharmacist has not verified yet. It cannot go out until they do.'
        : 'The prescription on this order was rejected and has not been replaced yet. It cannot go out until a new one is verified.', 409);
    }
    const body = { ...(req.body ?? {}) };
    const from = order.status;
    const doneLabel = spec.name === 'edit' ? `Edited by ${ROLE_LABELS[req.user.role] || req.user.role}` : spec.done;
    let zoho = null;

    if (spec.name === 'approve') {
      // Creates the Sales Order: getmeds-system's pipeline moves the order and
      // writes its own trail entries and notifications.
      const { note } = readFields(['note'], body);
      const row = await repo.rowByRef(order.id);
      const result = await zohoSteps.approveInZoho(row, req.user, note);
      zoho = { syncStatus: result.zohoSyncStatus, soNumber: result.zohoResult?.salesorder?.salesorder_number || null };
    } else if (spec.name === 'purge_order') {
      const { reason } = readFields(['reason'], body);
      if (zohoSteps.hasRealSalesOrder({ zoho_so_id: order.zoho.soId })) {
        throw bad(`Sales Order ${order.zoho.soNumber || order.zoho.soId} is in Zoho, so this order stays on record. It is kept at Deleted.`, 409);
      }
      await db.prepare("DELETE FROM orders WHERE id = ? AND status = 'deleted'").run(order.dbId);
      console.log(`[orders] ${order.id} permanently deleted by ${req.user.name}: ${reason}`);
      return res.json({ ok: true, purged: true, message: `Order ${order.id} permanently deleted.` });
    } else {
      const plan = await planStep(spec, order, body, req.user);
      await db.transaction(async () => {
        // The move is conditional on the order still being where this person
        // saw it: of two people pressing buttons at once, the first wins.
        const moved = plan.to !== from
          ? await repo.moveIf(order.dbId, from, plan.to)
          : (await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ? AND status = ?').run(new Date().toISOString(), order.dbId, from)).changes === 1;
        if (!moved) throw bad('Someone has just moved this order on. Reload it to see where it is now.', 409);
        for (const write of plan.writes) await write();
        await repo.logStep(order.dbId, { step: spec.name, from, to: plan.to, actor: req.user, label: doneLabel, note: plan.note, details: plan.details });
        await announceStep(spec, { ...order, status: plan.to }, plan.to, plan.note);
      })();
      if (plan.tellAfter) await plan.tellAfter().catch((err) => console.warn('[orders] notify failed:', err.message));
      if (spec.name === 'verify_payment') {
        zoho = await zohoSteps.confirmInZoho(await repo.rowByRef(order.id), req.user, plan.to);
      }
    }
    if (spec.logged) console.log(`[admin] ${spec.logged} ${order.id} by ${req.user.name}`);
    const fresh = await repo.getOrder(order.id);
    res.json({ order: await fullOrder(fresh, req.user), zoho });
  } catch (err) {
    fail(err, res, next);
  }
}

// ---------- the recycle bin's 30 days ----------

// Deleted orders past their 30 days are removed for good, except one with a
// real Sales Order in Zoho, which stays on record at Deleted. Run daily by the
// cron route (src/cron.js); the Discord version ran on a timer that serverless
// hosting doesn't keep alive.
async function purgeExpired() {
  const rows = await db.prepare(
    `SELECT id, getmeds_order_id, zoho_so_id, app_data->>'purgeAt' AS purge_at FROM orders
      WHERE status = 'deleted' AND app_data->>'purgeAt' IS NOT NULL`,   // not jsonb's ? operator: every ? here becomes a parameter
  ).all();
  let purged = 0;
  for (const r of rows) {
    if (!r.purge_at || Date.parse(r.purge_at) > Date.now()) continue;
    if (zohoSteps.hasRealSalesOrder(r)) continue;
    await db.prepare("DELETE FROM orders WHERE id = ? AND status = 'deleted'").run(r.id);
    purged += 1;
  }
  const others = await recycleBin.purgeExpiredRecycledItems().catch(() => []);
  return { purgedOrders: purged, purgedOthers: others.length };
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
const LARGE_ORDER = Number(process.env.FINANCE_LARGE_ORDER_PHP) || 100_000;
const AGING = [
  { label: 'On track', days: '0–3 days', from: 0, to: 3 },
  { label: 'Follow up', days: '4–7 days', from: 4, to: 7 },
  { label: 'Late', days: '8–14 days', from: 8, to: 14 },
  { label: 'Overdue', days: '15+ days', from: 15, to: Infinity },
];
const DECISIONS = ['approve', 'send_back', 'reject', 'tl_approve', 'tl_send_back', 'tl_reject'];
const AWAITING_PAYMENT = 'ready_for_finance_verified';

const dayName = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
const monthName = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', year: 'numeric' });
const monthStart = (t, add = 0) => {
  const d = new Date(t + MANILA);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) - MANILA;
};
const within = (iso, r) => {
  const t = Date.parse(iso ?? '');
  return t >= r.from && t < r.to;
};
const sumOf = (orders) => round2(orders.reduce((s, o) => s + (o.total ?? 0), 0));
const isSale = (o) => !['cancelled', 'rejected', 'deleted', 'draft'].includes(o.status);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const reachedAt = (o, i, status) => Date.parse(o.events.slice(0, i).findLast((e) => e.to === status)?.at ?? o.createdAt);
const ownerName = (o) => o.owner?.name ?? o.createdBy?.name;

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

function decisionsBy(userId, orders, r) {
  const found = [];
  for (const o of orders) {
    o.events.forEach((e, i) => {
      if (DECISIONS.includes(e.type) && e.actor?.id === userId && within(e.at, r)) {
        const waitingFor = e.type.startsWith('tl_') ? 'pending_tl_approval' : 'pending_management_approval';
        found.push({ o, e, hours: (Date.parse(e.at) - reachedAt(o, i, waitingFor)) / HOUR });
      }
    });
  }
  return found;
}

function decisionFigures(found) {
  const n = (type) => found.filter((d) => d.e.type === type || d.e.type === `tl_${type}`).length;
  return {
    decisions: found.length,
    approved: n('approve'),
    sentBack: n('send_back'),
    rejected: n('reject'),
    approvalRate: found.length ? n('approve') / found.length : null,
    approvedValue: sumOf([...new Set(found.filter((d) => d.e.type === 'approve' || d.e.type === 'tl_approve').map((d) => d.o))]),
    decideHours: median(found.map((d) => d.hours).filter((h) => Number.isFinite(h) && h >= 0)),
  };
}

function salespersonDashboard(user, all, r) {
  const mine = all.filter((o) => o.ownerId === user.id);
  return {
    now: salesFigures(mine, r),
    prev: r.prev && salesFigures(mine, r.prev),
    trend: trendOf(mine, r),
    sentBack: mine.filter((o) => o.status === 'returned' || o.status === 'draft').length,
  };
}

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
  const waiting = all.filter((o) => o.status === 'pending_management_approval');
  const waitedDays = waiting.map((o) => (now - reachedAt(o, o.events.length, 'pending_management_approval')) / DAY);
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
  const awaiting = all.filter((o) => o.status === AWAITING_PAYMENT).map((o) => ({ o, days: daysIn(o, AWAITING_PAYMENT) }));
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

async function adminDashboard(_user, all, r) {
  const users = await listUsers();
  const zoho = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE zoho_sync_status = 'failed' AND getmeds_order_id NOT LIKE 'ZOHO-%') AS failed,
       (SELECT COUNT(*) FROM zoho_sync_queue WHERE status = 'pending') AS queued,
       (SELECT COUNT(*) FROM zoho_sync_queue WHERE status = 'failed_permanent') AS gave_up`,
  ).get();
  return {
    now: salesFigures(all, r),
    prev: r.prev && salesFigures(all, r.prev),
    trend: trendOf(all, r),
    roles: Array.from(ROLES).filter(Boolean).map((role) => ({
      role,
      label: ROLE_LABELS[role] || role,
      active: users.filter((u) => u.role === role && u.active).length,
      inactive: users.filter((u) => u.role === role && !u.active).length,
    })),
    salespeople: users.filter((u) => u.role === 'salesperson').map((u) => {
      const f = salesFigures(all.filter((o) => o.ownerId === u.id), r);
      return { name: u.name, active: u.active, raised: f.raised, sales: f.sales, deliveredValue: f.deliveredValue, approvalRate: f.approvalRate };
    }).filter((s) => s.raised || s.active).sort((a, b) => b.sales - a.sales || b.raised - a.raised),
    managers: users.filter((u) => u.role === 'management').map((u) => {
      const f = decisionFigures(decisionsBy(u.id, all, r));
      return { name: u.name, active: u.active, decisions: f.decisions, approved: f.approved, sentBack: f.sentBack, rejected: f.rejected, decideHours: f.decideHours };
    }).sort((a, b) => b.decisions - a.decisions),
    zoho: { mode: (process.env.ZOHO_MODE || 'mock').toLowerCase(), dryRun: isDryRunMode(), failed: zoho?.failed ?? 0, queued: zoho?.queued ?? 0, gaveUp: zoho?.gave_up ?? 0 },
  };
}

function dispatchDashboard(_user, all, r) {
  const brief = (o, extra = {}) => ({
    id: o.id,
    customer: o.customerName ?? null,
    owner: ownerName(o),
    total: o.total,
    deliveryMethod: o.deliveryMethod || 'Standard',
    courier: o.shipment?.courier || null,
    trackingNumber: o.shipment?.trackingNumber || null,
    warehouse: o.warehouse?.label || null,
    status: o.status,
    ...extra,
  });
  const ready = all.filter((o) => ['ready_for_dispatch', 'ready_for_draft_invoice', 'ready_for_invoice_sent'].includes(o.status));
  const picking = all.filter((o) => o.status === 'picking_packing');
  const packed = all.filter((o) => o.status === 'packed');
  const dispatched = all.filter((o) => o.status === 'dispatched' || o.status === 'tracking_shared');
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
    const c = o.shipment?.courier || o.deliveryMethod || 'Standard';
    courierCounts[c] = (courierCounts[c] || 0) + 1;
  }
  return {
    pipeline: {
      ready: { count: ready.length, value: sumOf(ready), items: ready.slice(0, 5).map((o) => brief(o)) },
      picking: { count: picking.length, value: sumOf(picking), items: picking.slice(0, 5).map((o) => brief(o)) },
      packed: { count: packed.length, value: sumOf(packed), items: packed.slice(0, 5).map((o) => brief(o)) },
      dispatched: { count: dispatched.length, value: sumOf(dispatched), items: dispatched.slice(0, 5).map((o) => brief(o)) },
    },
    fulfillment: {
      deliveredCount: delivered.length,
      deliveredValue: sumOf(delivered),
      prevDeliveredCount: prevDelivered ? prevDelivered.length : null,
      prevDeliveredValue: prevDelivered ? sumOf(prevDelivered) : null,
      turnaroundHours: turnarounds.length ? median(turnarounds) : null,
    },
    couriers: Object.entries(courierCounts).map(([courier, count]) => ({ courier, count })).sort((a, b) => b.count - a.count),
    urgent: [...ready, ...picking].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 8).map((o) => brief(o)),
  };
}

async function teamLeaderDashboard(user, all, r) {
  const brief = (o, extra = {}) => ({ id: o.id, customer: o.customerName ?? null, owner: ownerName(o), total: o.total, status: o.status, ...extra });
  const salespeople = (await listUsers({ roles: ['salesperson'] })).filter((u) => u.teamLeaderId === user.id || !u.teamLeaderId);
  const teamUserIds = new Set(salespeople.map((u) => u.id));
  const teamOrders = all.filter((o) => teamUserIds.has(o.ownerId) || o.ownerId === user.id);
  const pendingReview = teamOrders.filter((o) => o.status === 'pending_tl_approval');
  const inProgress = teamOrders.filter((o) => !CLOSED.includes(o.status) && o.status !== 'pending_tl_approval');
  return {
    now: salesFigures(teamOrders, r),
    prev: r.prev ? salesFigures(teamOrders, r.prev) : null,
    trend: trendOf(teamOrders, r),
    pendingReview: { count: pendingReview.length, value: sumOf(pendingReview), items: pendingReview.slice(0, 6).map((o) => brief(o)) },
    inProgress: { count: inProgress.length, value: sumOf(inProgress) },
    team: salespeople.map((u) => {
      const orders = teamOrders.filter((o) => o.ownerId === u.id);
      const f = salesFigures(orders, r);
      return { id: u.id, name: u.name, active: u.active, raised: f.raised, sales: f.sales, deliveredValue: f.deliveredValue, pending: orders.filter((o) => o.status === 'pending_tl_approval').length };
    }).filter((t) => t.raised || t.pending || t.active).sort((a, b) => b.sales - a.sales || b.raised - a.raised),
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

// ---------- CSV ----------

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // A cell starting with = + - @ is a formula to a spreadsheet: quote it inert.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// ---------- routes ----------

const router = express.Router();
router.use(requireUser, jsonOnly);

router.get('/meta', (req, res) => res.json({
  statuses: STATUS,
  roles: ROLE_LABELS,
  orderFields: orderFields().map(describeField),
  fields: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, describeField(k)])),
  fieldLabels: { ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])), items: 'Items', total: 'Total', files: 'Files' },
  files: { ...FILES, kinds: FILE_KINDS, accept: Object.keys(FILE_TYPES).map((ext) => `.${ext}`).join(','), types: FILE_TYPES },
  storage: { kind: 'database' },
  zoho: { mode: (process.env.ZOHO_MODE || 'mock').toLowerCase(), dryRun: isDryRunMode() },
  warehouses: [...WAREHOUSES.map(({ key, label }) => ({ key, label })), UNASSIGNED],
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

router.get('/customers', async (req, res, next) => {
  try {
    res.json({ customers: await customers.searchCustomers(String(req.query.q ?? '')) });
  } catch (err) {
    fail(err, res, next);
  }
});

// Customers already in Zoho that look like the one about to be added.
router.post('/customers/check-duplicates', async (req, res, next) => {
  try {
    res.json({ matches: await customers.checkDuplicates(req.body ?? {}) });
  } catch (err) {
    fail(err, res, next);
  }
});

// Adds a customer, or fills in the details of the one with that name.
async function addCustomer(req, res, next) {
  try {
    const name = String(req.body?.name || req.body?.customerName || '').trim();
    if (!name) throw bad('Customer name is required.');
    const customer = await customers.customerForOrder({
      name,
      contactNumber: req.body?.contactNumber,
      address: req.body?.address,
      receiverName: req.body?.receiverName,
      receiverContact: req.body?.receiverContact,
      type: req.body?.type,
    });
    res.status(201).json({ customer });
  } catch (err) {
    fail(err, res, next);
  }
}
router.post('/customers', addCustomer);
router.post('/customers/quick', addCustomer);

// Management's say on whether a customer may be sold at Special Price.
router.patch('/customers/:id/special-price', async (req, res, next) => {
  try {
    if (!['management', 'admin'].includes(req.user.role)) throw bad('Only Management can clear a customer for Special Price.', 403);
    res.json({ customer: await customers.setSpecialPrice(req.params.id, Boolean(req.body?.hasSpecialPrice)) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get('/custom-fields', (_req, res) => res.json({ fields: configStore.getOrderFields() }));
router.get('/configs', (_req, res) => res.json({ configs: configStore.getAllConfigs() }));
router.get('/promotions', (_req, res) => res.json({ ok: true, promotions: configStore.getPromotions() }));

// The order form's lists, extra fields, roles and promos: read here, edited in Orbit when it is set up.
const inOrbitNow = (what) => (_req, res) => res.status(410).json({ error: `${what} can't be changed from this app.` });
for (const path of ['/custom-fields', '/custom-fields/:id', '/configs/:type', '/configs/:type/:id', '/rbac/roles', '/rbac/roles/:roleId',
  '/promotions/bundle', '/promotions/bundle/:bundleId', '/promotions/promo', '/promotions/promo/:promoId', '/promotions/discount', '/promotions/discount/:discountId']) {
  router.post(path, inOrbitNow('That setting'));
  router.put(path, inOrbitNow('That setting'));
  router.delete(path, inOrbitNow('That setting'));
}

// The signed-in person's dashboard, for ?period=month (the default), last_month, 90d or all.
router.get('/dashboard', async (req, res, next) => {
  try {
    const build = DASHBOARDS[req.user.role];
    if (!build) throw bad('There is no dashboard for this role.', 404);
    const key = Object.hasOwn(PERIODS, req.query.period) ? req.query.period : 'month';
    const now = Date.now();
    // The period and the one before it, for the comparison.
    const since = key === 'all' ? '0' : new Date(monthStart(now, key === '90d' ? -7 : -3)).toISOString();
    const all = await repo.ordersForDashboards(since);
    const r = periodRange(key, all, now);
    res.json({
      role: req.user.role,
      period: { key, label: PERIODS[key], compare: r.prev ? COMPARED_WITH[key] : null },
      periods: PERIODS,
      at: new Date(now).toISOString(),
      ...(await build(req.user, all, r, now)),
    });
  } catch (err) {
    fail(err, res, next);
  }
});

// Who a new order can be for, besides yourself: every other active salesperson.
router.get('/owners', async (req, res, next) => {
  try {
    if (!canRaiseOrders(req.user)) throw bad('Only Salesperson, Team Leader, Management or Admin can raise orders.', 403);
    const salespeople = (await listUsers({ roles: ['salesperson'] }))
      .filter((u) => u.active && u.id !== req.user.id)
      .map(({ id, name }) => ({ id, name }));
    res.json({ salespeople });
  } catch (err) {
    fail(err, res, next);
  }
});

// The orders this person may see. ?origin=zoho lists the history imported
// from Zoho instead; ?origin=all both.
router.get('/', async (req, res, next) => {
  try {
    const origin = ['zoho', 'all'].includes(req.query.origin) ? req.query.origin : 'getmeds';
    res.json({ orders: await repo.listOrders(req.user, { origin }) });
  } catch (err) {
    fail(err, res, next);
  }
});

// The same list as a spreadsheet.
router.get('/export.csv', async (req, res, next) => {
  try {
    const origin = ['zoho', 'all'].includes(req.query.origin) ? req.query.origin : 'getmeds';
    let list = await repo.listOrders(req.user, { origin, limit: 5000 });
    if (req.query.status) list = list.filter((o) => String(req.query.status).split(',').includes(o.status));
    const head = ['Order', 'Status', 'Customer', 'Division', 'Warehouse', 'Salesperson', 'Items', 'Total (PHP)', 'Zoho SO', 'Created', 'Updated'];
    const lines = [head, ...list.map((o) => [o.id, o.statusLabel, o.customerName, o.division, o.warehouse?.label, o.owner, o.items, o.total.toFixed(2), o.zohoSo, o.createdAt, o.updatedAt])];
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="getmeds-orders-${stamp}.csv"`, 'Cache-Control': 'no-store' });
    res.send(`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`);
  } catch (err) {
    fail(err, res, next);
  }
});

// A new order, saved as a Draft. The page then uploads its files
// (POST /:id/files/upload-url, the PUT, POST /:id/files) and submits it
// (POST /:id/actions/submit), which checks the Guarantee Letter and
// prescription rules against the files it really has. `submitNow: true`
// submits at once, for an order with no files.
router.post('/', async (req, res, next) => {
  try {
    if (!canRaiseOrders(req.user)) throw bad('Only Salesperson, Team Leader, Management or Admin can raise orders.', 403);
    const declared = Array.isArray(req.body?.fileKinds) ? req.body.fileKinds.filter((k) => Object.hasOwn(FILE_KINDS, k)).map((kind) => ({ kind })) : [];
    const form = await readOrderForm(req.body, declared, req.user.role);
    const pick = req.body?.ownerId;
    const forOther = pick != null && pick !== '' && Number(pick) !== req.user.id;
    const owner = forOther ? await salespersonFor(pick) : req.user;
    const customer = await customers.customerForOrder({
      customerId: req.body?.customerId, name: form.values.customerName, contactNumber: form.values.contactNumber,
      address: form.values.address, receiverName: form.values.receiverName, receiverContact: form.values.receiverContact,
      type: customerTypeFor(form.values.paymentTerms),
    });
    const ref = await generateOrderId();
    const creator = { id: req.user.id, name: req.user.name, role: req.user.role };
    await db.transaction(async () => {
      const { dbId, total } = await repo.insertOrder({
        ref,
        status: 'draft',
        customerId: customer.id,
        customerType: customerTypeFor(form.values.paymentTerms),
        ownerId: owner.id,
        raisedById: forOther ? req.user.id : null,
        creator,
        values: form.values,
        items: form.items,
        customFieldIds: customFieldIds(),
        customerHasSpecialPrice: form.customerHasSpecialPrice,
        gmLeadId: ['management', 'admin'].includes(req.user.role) ? req.user.name : null,
      });
      await repo.logStep(dbId, {
        step: 'created', from: null, to: 'draft', actor: req.user, label: 'Order created',
        details: { items: form.items.length, total, ...(forOther ? { for: owner.name } : {}) },
      });
    })();
    if (req.body?.submitNow && !declared.length) {
      req.params.id = ref;
      req.body = {};
      return takeStep(req, res, next, 'submit');
    }
    const order = await repo.getOrder(ref);
    res.status(201).json({ order: await fullOrder(order, req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get('/recycle-bin', requirePermission('restore_orders'), async (req, res, next) => {
  try {
    const orders = (await repo.listOrders(req.user, { deletedOnly: true, origin: 'all' })).map((o) => ({
      ...o,
      daysLeft: recycleBin.calculateDaysLeft(o.purgeAt),
      type: 'order',
    }));
    const others = recycleBin.getRecycleBinSettings().map((it) => ({ ...it, daysLeft: recycleBin.calculateDaysLeft(it.purgeAt) }));
    res.json({ orders, others, total: orders.length + others.length });
  } catch (err) {
    fail(err, res, next);
  }
});

async function purgeOne(req, res, next) {
  const item = recycleBin.findRecycledItem(req.params.id);
  if (item) {
    await recycleBin.permanentlyPurgeRecycledItem(item);
    return res.json({ ok: true, message: `${item.name} permanently deleted.` });
  }
  req.body = { reason: req.body?.reason || 'Emptied from the Recycle Bin' };
  return takeStep(req, res, next, 'purge_order');
}
router.delete('/recycle-bin/:id', requirePermission('delete_orders'), purgeOne);
router.delete('/:id/permanent', requirePermission('delete_orders'), purgeOne);

router.post('/recycle-bin/empty', requirePermission('delete_orders'), async (req, res, next) => {
  try {
    const deleted = await repo.listOrders(req.user, { deletedOnly: true, origin: 'all' });
    let purged = 0;
    let kept = 0;
    for (const o of deleted) {
      const row = await repo.rowByRef(o.id);
      if (zohoSteps.hasRealSalesOrder(row)) {
        kept += 1;
        continue;
      }
      await db.prepare("DELETE FROM orders WHERE id = ? AND status = 'deleted'").run(row.id);
      purged += 1;
    }
    const others = [...recycleBin.getRecycleBinSettings()];
    for (const item of others) await recycleBin.permanentlyPurgeRecycledItem(item);
    res.json({
      ok: true,
      purgedOrders: purged,
      keptOrders: kept,
      purgedOthers: others.length,
      message: `Recycle Bin emptied: ${purged + others.length} item(s) removed.${kept ? ` ${kept} order(s) with a Sales Order in Zoho stay on record.` : ''}`,
    });
  } catch (err) {
    fail(err, res, next);
  }
});

router.post('/recycle-bin/:id/restore', requirePermission('restore_orders'), (req, res, next) => {
  req.body = { reason: req.body?.reason || req.body?.note || 'Restored from Recycle Bin' };
  return takeStep(req, res, next, 'restore');
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ order: await fullOrder(await visibleOrder(req), req.user) });
  } catch (err) {
    fail(err, res, next);
  }
});

// The order's ten-stage pipeline (Created → … → Completed), from its trail
// and Zoho's four status axes: getmeds-system's own timeline.
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const order = await visibleOrder(req);
    const row = await repo.rowByRef(order.id);
    const events = await db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id').all(row.id);
    const splits = await db.prepare('SELECT * FROM order_split_sales_orders WHERE order_id = ?').all(row.id);
    res.json(buildTimeline(row, events, splits));
  } catch (err) {
    fail(err, res, next);
  }
});

router.post('/:id/actions/:action', (req, res, next) => takeStep(req, res, next, req.params.action));
router.patch('/:id', (req, res, next) => takeStep(req, res, next, 'edit'));
router.delete('/:id', (req, res, next) => takeStep(req, res, next, 'delete_order'));

// ---------- files ----------
//
// Two calls around a direct upload, so a file never passes through this server
// (Vercel caps a request at 4.5 MB; a phone photo is often bigger):
//   1. POST /:id/files/upload-url { fileName, contentType, fileSize, kind } -> { signedUrl, storagePath }
//   2. the page PUTs the file to signedUrl
//   3. POST /:id/files { storagePath, fileName, contentType, fileSize, kind }
// getmeds-system's own attachment handlers do the work, including pushing the
// file onto the Zoho Sales Order once there is one.

async function forFiles(req) {
  const order = await visibleOrder(req);
  const kind = String(req.body?.kind || 'other');
  if (!Object.hasOwn(FILE_KINDS, kind)) throw bad(`Tag the file as one of: ${Object.values(FILE_KINDS).join(', ')}.`);
  const ext = String(req.body?.fileName || '').split('.').pop().toLowerCase();
  if (!Object.hasOwn(FILE_TYPES, ext)) throw bad('Attach a photo, PDF, Word or Excel file.');
  if (order.attachments.length >= FILES.max) throw bad(`An order can have at most ${FILES.max} files.`);
  return { order, body: { ...req.body, contentType: FILE_TYPES[ext], file_type: repo.fileTypeOf(kind) } };
}

router.post('/:id/files/upload-url', async (req, res, next) => {
  try {
    const { order, body } = await forFiles(req);
    relay(res, await invoke(coreProof.getUploadUrl, req, { params: { id: order.dbId }, body }));
  } catch (err) {
    fail(err, res, next);
  }
});

router.post('/:id/files', async (req, res, next) => {
  try {
    const { order, body } = await forFiles(req);
    const result = await invoke(coreProof.attach, req, { params: { id: order.dbId }, body });
    if (result.body?.success === false) return relay(res, result);
    const fresh = await repo.getOrder(order.id);
    res.status(201).json({ order: await fullOrder(fresh, req.user), zohoPushed: Boolean(result.body?.data?.zoho_pushed) });
  } catch (err) {
    fail(err, res, next);
  }
});

// Each file with a link to open it (a signed link getmeds-system's
// /api/attachment-view answers).
router.get('/:id/files', async (req, res, next) => {
  try {
    const order = await visibleOrder(req);
    const result = await invoke(coreProof.list, req, { params: { id: order.dbId } });
    if (result.body?.success === false) return relay(res, result);
    const rows = result.body?.data?.attachments || [];
    res.json({
      files: rows.map((f) => ({
        id: f.id,
        name: f.file_name,
        kind: repo.kindOf(f.file_type),
        type: f.content_type,
        size: f.file_size,
        status: f.status,
        uploadedAt: f.uploaded_at,
        uploadedBy: f.uploaded_by_name || null,
        inZoho: Boolean(f.zoho_pushed),
        viewUrl: f.viewUrl,
        downloadUrl: f.downloadUrl,
      })),
    });
  } catch (err) {
    fail(err, res, next);
  }
});

// ---------- Zoho, holds, Rx ----------

// Pulls the order's latest from Zoho now (Sales Order, invoice, package,
// shipment), rather than waiting for the next sync.
router.post('/:id/zoho/sync', async (req, res, next) => {
  try {
    const order = await visibleOrder(req);
    if (!order.zoho.soId) throw bad('This order has no Sales Order in Zoho yet.', 409);
    const result = await invoke(coreOrders.syncFromZoho, req, { params: { id: order.dbId } });
    if (result.body?.success === false) return relay(res, result);
    res.json({ order: await fullOrder(await repo.getOrder(order.id), req.user), result: result.body?.data ?? null });
  } catch (err) {
    fail(err, res, next);
  }
});

// Tries the Sales Order again for an order whose first try failed.
router.post('/:id/zoho/retry', async (req, res, next) => {
  try {
    const order = await visibleOrder(req);
    if (!['management', 'admin'].includes(req.user.role) && !isMine(req.user, order)) throw bad('Only Management, Admin or the order\'s owner can retry it.', 403);
    const result = await invoke(coreOrders.retryZohoSync, req, { params: { id: order.dbId } });
    if (result.body?.success === false) return relay(res, result);
    res.json({ order: await fullOrder(await repo.getOrder(order.id), req.user), result: result.body?.data ?? null });
  } catch (err) {
    fail(err, res, next);
  }
});

// Dispatch's flags. A hold doesn't change the order's status: it keeps its
// place in Dispatch, shows "On hold by Dispatch — <reason>", and the
// salesperson and Management are told. getmeds-system's own handlers.
const DISPATCH_FLAGS = {
  'dispatch-hold': coreDispatch.holdOrder,
  'dispatch-hold/lift': coreDispatch.liftHold,
  'tracking-hold': coreDispatch.holdTracking,
  'tracking-hold/release': coreDispatch.releaseTrackingHold,
};
for (const [path, handler] of Object.entries(DISPATCH_FLAGS)) {
  router.post(`/:id/${path}`, async (req, res, next) => {
    try {
      if (!['dispatch', 'management', 'admin'].includes(req.user.role)) throw bad('Only Dispatch can do that.', 403);
      const order = await visibleOrder(req);
      const result = await invoke(handler, req, { params: { id: order.dbId }, body: req.body ?? {} });
      if (result.body?.success === false) return relay(res, result);
      res.json({ order: await fullOrder(await repo.getOrder(order.id), req.user), message: result.body?.data?.message ?? null });
    } catch (err) {
      fail(err, res, next);
    }
  });
}

module.exports = { router, ACTIONS, STATUS, purgeExpired, canSee, readOrderForm };
