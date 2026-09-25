// Orders in the shared database, in the shape this app's pages use.
//
// An order here is a row in `orders` with its `order_items`, `payments`,
// `dispatch_records`, `payment_proofs` (every attachment) and `order_events`
// (the trail): getmeds-system's tables, so an order raised in either app is the
// same order in both. This file is the only place that knows how the two
// shapes line up; src/orders.js works with the page's shape.
//
// Where a form field lives:
//   customerName        customers.name (orders.customer_id)
//   address             orders.delivery_address
//   receiverName        orders.intake_receiver
//   receiverContact     orders.intake_contact_no
//   division / subDivision / headQuarter   division / sub_division / headquarter
//   invoicingFrom       orders.invoicing_from
//   source / paymentMethod / paymentTerms / deliveryMethod
//                       intake_source / intake_mop / intake_payment_terms / intake_delivery_method
//   customerIsDoctor    orders.intake_is_doctor (1 Yes, 0 No)
//   doctorName          orders.intake_doctor
//   remarks             orders.delivery_notes
//   contactNumber, notes, the admin's extra fields, the special-price flag,
//   Dispatch's packing and receiving details, the recycle-bin dates
//                       orders.app_data (migrations/002_discord_app.sql)
const db = require('./db');
const { logEvent } = require('./core/services/auditService');
const { rxSummaries } = require('./core/services/prescriptionService');
const { warehouseOf } = require('./core/services/dispatchWarehouses');
const { isImportedRef } = require('./core/services/orderOrigin');
const { STATUS, CLOSED, EVENT_TYPE_OF_STEP, STEP_OF_EVENT_TYPE, labelOfEvent } = require('./workflow/statuses');
const { fromDbRole } = require('./accounts');

// This app's file kinds <-> payment_proofs.file_type. Only the guarantee
// letter has a different name there.
const KIND_TO_TYPE = { guarantee_letter: 'gl' };
const TYPE_TO_KIND = { gl: 'guarantee_letter', id: 'other' };
const fileTypeOf = (kind) => KIND_TO_TYPE[kind] || kind;
const kindOf = (type) => TYPE_TO_KIND[type] || type;

const round2 = (n) => Math.round(n * 100) / 100;
const json = (v) => (v == null ? {} : typeof v === 'string' ? JSON.parse(v) : v);

const ORDER_SELECT = `
  SELECT o.*,
         c.name AS customer_name, c.contact_number AS customer_contact, c.type AS customer_master_type,
         c.zoho_contact_id AS customer_zoho_contact_id, c.app_data AS customer_app_data,
         u.name AS medrep_name, u.email AS medrep_email, u.role AS medrep_role, u.team_lead_id AS medrep_team_lead_id,
         u.salesperson AS medrep_salesperson, u.division AS medrep_division, u.sub_division AS medrep_sub_division,
         rb.name AS raised_by_name, rb.role AS raised_by_role
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.medrep_id
    LEFT JOIN users rb ON rb.id = o.raised_by_id`;

// ---------- reading ----------

function eventView(row, i) {
  const meta = json(row.metadata);
  const step = meta.step || STEP_OF_EVENT_TYPE[row.event_type] || null;
  return {
    seq: i + 1,
    id: row.id,
    type: step || row.event_type,
    eventType: row.event_type,
    label: meta.label || labelOfEvent(row.event_type, row),
    from: row.old_status || null,
    to: row.new_status || null,
    at: row.created_at,
    exact: row.occurred_at_exact !== false,
    actor: { id: row.actor_id, name: row.actor_name || 'System', role: row.actor_role ? fromDbRole(row.actor_role) : null },
    note: row.notes || null,
    details: meta.details || null,
  };
}

// The latest of a pair of trail entries decides a flag: on hold / lifted.
function latestFlag(events, onType, offTypes) {
  const last = [...events].reverse().find((e) => e.eventType === onType || offTypes.includes(e.eventType));
  if (!last || last.eventType !== onType) return null;
  return { by: last.actor.name, at: last.at, reason: (last.note || '').replace(/^On hold by Dispatch: /, '') || null };
}

function attachmentView(row, n) {
  return {
    n,
    id: row.id,
    name: row.file_name || `file-${row.id}`,
    type: row.content_type || 'application/octet-stream',
    size: row.file_size ?? null,
    kind: kindOf(row.file_type),
    status: row.status,
    rejectionReason: row.rejection_reason || null,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by_name || null,
    deletion: row.deletion_status && row.deletion_status !== 'none' ? row.deletion_status : null,
  };
}

// The page's order, from its row and the rows around it.
function toOrder(row, { items = [], payment = null, dispatch = null, files = [], events = [], rx = null } = {}) {
  const app = json(row.app_data);
  const cust = json(row.customer_app_data);
  const evs = events.map(eventView);
  const created = evs.find((e) => e.eventType === 'ORDER_CREATED');
  const createdBy = app.createdBy
    || (row.raised_by_id ? { id: row.raised_by_id, name: row.raised_by_name, role: fromDbRole(row.raised_by_role) } : null)
    || (created ? { id: created.actor.id, name: created.actor.name, role: created.actor.role } : null)
    || { id: row.medrep_id, name: row.medrep_name, role: fromDbRole(row.medrep_role) };
  const shipmentExtra = app.shipment || {};
  const shipment = dispatch || Object.keys(shipmentExtra).length ? {
    courier: dispatch?.courier ?? null,
    trackingNumber: dispatch?.tracking_number ?? null,
    dispatchedAt: dispatch?.dispatched_at ?? null,
    dispatchedBy: dispatch?.dispatched_by_name ?? null,
    deliveredAt: dispatch?.delivered_at ?? null,
    deliveredBy: dispatch?.delivered_by_name ?? null,
    zohoPackage: dispatch?.zoho_package_number ?? null,
    zohoShipment: dispatch?.zoho_shipment_number ?? null,
    ...shipmentExtra,
  } : null;
  return {
    id: row.getmeds_order_id,
    dbId: row.id,
    imported: isImportedRef(row.getmeds_order_id),
    status: row.status,
    ownerId: row.medrep_id,
    owner: { id: row.medrep_id, name: row.medrep_name, teamLeaderId: row.medrep_team_lead_id ?? null, role: fromDbRole(row.medrep_role) },
    createdBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    customerId: row.customer_id,
    customerName: row.customer_name,
    contactNumber: app.contactNumber ?? row.customer_contact ?? null,
    address: row.delivery_address,
    receiverName: row.intake_receiver,
    receiverContact: row.intake_contact_no,
    division: row.division,
    subDivision: row.sub_division,
    headQuarter: row.headquarter,
    invoicingFrom: row.invoicing_from,
    source: row.intake_source,
    paymentMethod: row.intake_mop,
    paymentTerms: row.intake_payment_terms,
    deliveryMethod: row.intake_delivery_method,
    customerIsDoctor: row.intake_is_doctor == null ? null : Number(row.intake_is_doctor) === 1 ? 'Yes' : 'No',
    doctorName: row.intake_doctor,
    remarks: row.delivery_notes,
    notes: app.notes ?? null,
    ...(app.custom || {}),
    customerHasSpecialPrice: Boolean(app.customerHasSpecialPrice ?? cust.hasSpecialPrice),
    items: items.map((it) => ({
      id: it.id,
      product: it.product_label || it.product_name,
      productId: it.product_id,
      sku: it.sku || null,
      qty: it.quantity,
      unitPrice: it.unit_price,
      lineTotal: it.line_total,
      ...(it.price_type ? { priceType: it.price_type } : {}),
      ...(it.unit_type ? { unitType: it.unit_type } : {}),
      ...(it.price_remark ? { priceRemark: it.price_remark } : {}),
    })),
    total: round2(Number(row.total_amount) || 0),
    payment: payment && (payment.status === 'verified' || payment.amount != null) ? {
      method: payment.payment_method,
      reference: payment.payment_reference,
      amount: payment.amount,
      paidOn: payment.payment_date,
      verifiedBy: payment.verified_by_name || null,
      verifiedAt: payment.verified_at,
      status: payment.status,
    } : null,
    shipment,
    attachments: files.map(attachmentView),
    events: evs,
    deletedAt: app.deletedAt || null,
    purgeAt: app.purgeAt || null,
    deletedBy: app.deletedBy || null,
    statusBeforeDelete: app.statusBeforeDelete || null,
    zoho: {
      soId: row.zoho_so_id,
      soNumber: row.zoho_so_number,
      soStatus: row.zoho_so_status,
      syncStatus: row.zoho_sync_status,
      invoiceNumber: row.zoho_invoice_number,
      orderStatus: row.zoho_order_status,
      invoicedStatus: row.zoho_invoiced_status,
      paidStatus: row.zoho_paid_status,
      shippedStatus: row.zoho_shipped_status,
      lastReconciledAt: row.last_reconciled_at,
      customerInZoho: Boolean(row.customer_zoho_contact_id),
    },
    exceptionReason: row.exception_reason || null,
    warehouse: warehouseOf(row.division, row.intake_source),
    rx: rx ? { state: rx.state, prescriptions: rx.prescriptions } : { state: 'none', prescriptions: [] },
    holds: {
      dispatch: latestFlag(evs, 'DISPATCH_HOLD', ['DISPATCH_HOLD_LIFTED']),
      tracking: shipment?.trackingNumber ? null : latestFlag(evs, 'TRACKING_ON_HOLD', ['TRACKING_HOLD_RELEASED', 'DISPATCH_TRACKING_ADDED']),
    },
    claim: row.action_claim ? { by: String(row.action_claim).split('|')[0], at: row.action_claim_at } : null,
  };
}

// The raw row with the joins the core's Zoho pipeline expects (customer_name,
// customer_zoho_contact_id, medrep_* …), or null.
async function rowByRef(ref, { forUpdate = false } = {}) {
  return (await db.prepare(`${ORDER_SELECT} WHERE o.getmeds_order_id = ?${forUpdate ? ' FOR UPDATE OF o' : ''}`).get(String(ref))) || null;
}

async function loadRow(row) {
  const [items, payment, dispatch, files, events, rx] = await Promise.all([
    db.prepare(`SELECT oi.*, p.name AS product_name, p.sku, p.zoho_item_id, p.unit
                  FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                 WHERE oi.order_id = ? ORDER BY oi.id`).all(row.id),
    db.prepare(`SELECT pa.*, vu.name AS verified_by_name FROM payments pa
                  LEFT JOIN users vu ON vu.id = pa.verified_by WHERE pa.order_id = ?`).get(row.id),
    db.prepare(`SELECT dr.*, du.name AS dispatched_by_name, dl.name AS delivered_by_name FROM dispatch_records dr
                  LEFT JOIN users du ON du.id = dr.dispatched_by LEFT JOIN users dl ON dl.id = dr.delivered_by
                 WHERE dr.order_id = ?`).get(row.id),
    db.prepare(`SELECT pp.*, uu.name AS uploaded_by_name FROM payment_proofs pp
                  LEFT JOIN users uu ON uu.id = pp.uploaded_by
                 WHERE pp.order_id = ? AND pp.deleted_at IS NULL ORDER BY pp.id`).all(row.id),
    db.prepare(`SELECT id, event_type, old_status, new_status, actor_id, actor_name, actor_role, notes, metadata,
                       created_at, occurred_at_exact
                  FROM order_events WHERE order_id = ? ORDER BY created_at, id`).all(row.id),
    rxSummaries([row.id]).then((m) => m.get(row.id)),
  ]);
  return toOrder(row, { items, payment, dispatch, files, events, rx });
}

async function getOrder(ref) {
  const row = await rowByRef(ref);
  return row ? loadRow(row) : null;
}

// Who may see an order, as SQL over `o` (orders) and `u` (its owner in users).
// Mirrors src/orders.js's canSee.
function visibilitySql(user, { includeDeleted = false } = {}) {
  const parts = [];
  const params = [];
  if (!includeDeleted) parts.push("o.status <> 'deleted'");
  if (user.role === 'salesperson') {
    parts.push('(o.medrep_id = ? OR o.raised_by_id = ?)');
    params.push(user.id, user.id);
  } else if (user.role === 'team_leader') {
    // Their own; their team's; and any salesperson's who has no Team Leader,
    // since any Team Leader may endorse those.
    parts.push(`(o.medrep_id = ? OR o.raised_by_id = ? OR u.team_lead_id = ? OR (u.role = 'medrep' AND u.team_lead_id IS NULL))`);
    params.push(user.id, user.id, user.id);
  }
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

// One line per order for the list pages, newest first.
//   origin: 'getmeds' (raised in an app; the default), 'zoho' (imported history) or 'all'
async function listOrders(user, { origin = 'getmeds', statuses = null, deletedOnly = false, limit = 2000 } = {}) {
  const vis = visibilitySql(user, { includeDeleted: deletedOnly });
  const where = [vis.sql];
  const params = [...vis.params];
  if (deletedOnly) where.push("o.status = 'deleted'");
  if (origin === 'getmeds') where.push("o.getmeds_order_id NOT LIKE 'ZOHO-%'");
  else if (origin === 'zoho') where.push("o.getmeds_order_id LIKE 'ZOHO-%'");
  if (statuses?.length) {
    where.push('o.status = ANY(?)');
    params.push(statuses);
  }
  const rows = await db.prepare(
    `SELECT o.id, o.getmeds_order_id, o.status, o.division, o.sub_division, o.intake_source, o.total_amount,
            o.medrep_id, o.created_at, o.updated_at, o.app_data, o.zoho_so_number, o.zoho_sync_status,
            c.name AS customer_name, u.name AS medrep_name,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = o.medrep_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 2000, 1), 5000)}`,
  ).all(...params);
  return rows.map((r) => {
    const app = json(r.app_data);
    return {
      id: r.getmeds_order_id,
      status: r.status,
      statusLabel: STATUS[r.status] || r.status,
      customerName: r.customer_name,
      division: [r.division, r.sub_division].filter(Boolean).join(' | '),
      total: round2(Number(r.total_amount) || 0),
      items: Number(r.item_count) || 0,
      owner: r.medrep_name,
      ownerId: r.medrep_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: app.deletedAt || null,
      purgeAt: app.purgeAt || null,
      deletedBy: app.deletedBy || null,
      warehouse: warehouseOf(r.division, r.intake_source),
      zohoSo: r.zoho_so_number || null,
      zohoProblem: r.zoho_sync_status === 'failed',
    };
  });
}

// Orders with just enough of their trail for the dashboards: every order
// raised in an app since `sinceIso`, and every one still open whenever raised.
async function ordersForDashboards(sinceIso) {
  const rows = await db.prepare(
    `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id, o.total_amount, o.created_at, o.intake_delivery_method,
            o.division, o.intake_source, c.name AS customer_name, u.name AS medrep_name,
            pa.amount AS paid_amount, pa.verified_at, dr.courier, dr.tracking_number
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = o.medrep_id
       LEFT JOIN payments pa ON pa.order_id = o.id AND pa.status = 'verified'
       LEFT JOIN dispatch_records dr ON dr.order_id = o.id
      WHERE o.status <> 'deleted' AND o.getmeds_order_id NOT LIKE 'ZOHO-%'
        AND (o.created_at >= ? OR NOT (o.status = ANY(?)))`,
  ).all(sinceIso, CLOSED);
  if (!rows.length) return [];
  const events = await db.prepare(
    `SELECT order_id, id, event_type, old_status, new_status, actor_id, actor_name, actor_role, notes, metadata, created_at
       FROM order_events WHERE order_id = ANY(?) ORDER BY created_at, id`,
  ).all(rows.map((r) => r.id));
  const byOrder = new Map();
  for (const e of events) {
    if (!byOrder.has(e.order_id)) byOrder.set(e.order_id, []);
    byOrder.get(e.order_id).push(e);
  }
  return rows.map((r) => ({
    id: r.getmeds_order_id,
    dbId: r.id,
    status: r.status,
    ownerId: r.medrep_id,
    owner: { id: r.medrep_id, name: r.medrep_name },
    createdBy: { name: r.medrep_name },
    customerName: r.customer_name,
    total: round2(Number(r.total_amount) || 0),
    createdAt: r.created_at,
    deliveryMethod: r.intake_delivery_method,
    warehouse: warehouseOf(r.division, r.intake_source),
    payment: r.verified_at ? { amount: r.paid_amount, verifiedAt: r.verified_at } : null,
    shipment: r.courier || r.tracking_number ? { courier: r.courier, trackingNumber: r.tracking_number } : null,
    events: (byOrder.get(r.id) || []).map(eventView),
  }));
}

// ---------- writing ----------

// Form fields -> orders columns. Anything not here goes to app_data.
const COLUMN_OF = {
  address: 'delivery_address',
  receiverName: 'intake_receiver',
  receiverContact: 'intake_contact_no',
  division: 'division',
  subDivision: 'sub_division',
  headQuarter: 'headquarter',
  invoicingFrom: 'invoicing_from',
  source: 'intake_source',
  paymentMethod: 'intake_mop',
  paymentTerms: 'intake_payment_terms',
  deliveryMethod: 'intake_delivery_method',
  doctorName: 'intake_doctor',
  remarks: 'delivery_notes',
};
const APP_DATA_FIELDS = ['contactNumber', 'notes'];

// Splits form values into orders columns and app_data.
function toColumns(values, customFieldIds = []) {
  const cols = {};
  const app = {};
  for (const [k, v] of Object.entries(values)) {
    if (COLUMN_OF[k]) cols[COLUMN_OF[k]] = v ?? null;
    else if (k === 'customerIsDoctor') cols.intake_is_doctor = v == null ? null : v === 'Yes' ? 1 : 0;
    else if (APP_DATA_FIELDS.includes(k)) app[k] = v ?? null;
    else if (customFieldIds.includes(k)) (app.custom ??= {})[k] = v ?? null;
  }
  return { cols, app };
}

// Lines for order_items: the product each is for, and what it costs. Prices
// here include VAT (the price list's are), so each line's total is qty × price
// and the VAT inside it is worked out from the product's own tax rate, the
// way getmeds-system does for a tax-inclusive order (services/lineAmounts.js).
async function insertItems(orderId, items) {
  const { computeLine } = require('./core/services/lineAmounts');
  let total = 0;
  for (const it of items) {
    const product = await db.prepare('SELECT id, tax_percentage, tax_name FROM products WHERE id = ?').get(it.productId);
    const subtotal = round2(it.qty * it.unitPrice);
    const line = computeLine({ subtotal, discount: 0, taxPercent: product?.tax_percentage, inclusive: true });
    total += line.lineTotal;
    await db.prepare(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, discount_amount, tax_percent,
                                tax_label, line_total, price_type, unit_type, product_label, price_remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(orderId, it.productId, it.qty, it.unitPrice, subtotal, line.discountAmount, line.taxPercent,
      product?.tax_name || null, round2(line.lineTotal), it.priceType || null, it.unitType || null, it.product, it.priceRemark || null);
  }
  return round2(total);
}

async function insertOrder({ ref, status, customerId, customerType, ownerId, raisedById, creator, values, items, customFieldIds, customerHasSpecialPrice, gmLeadId }) {
  const { cols, app } = toColumns(values, customFieldIds);
  const now = new Date().toISOString();
  const appData = { ...app, customerHasSpecialPrice: Boolean(customerHasSpecialPrice), createdBy: creator };
  const names = ['getmeds_order_id', 'customer_id', 'medrep_id', 'raised_by_id', 'status', 'customer_type', 'total_amount',
    'is_inclusive_tax', 'gm_lead_id', 'app_data', 'created_at', 'updated_at', ...Object.keys(cols)];
  const vals = [ref, customerId, ownerId, raisedById, status, customerType, 0, 1, gmLeadId || null,
    JSON.stringify(appData), now, now, ...Object.values(cols)];
  const row = await db.prepare(
    `INSERT INTO orders (${names.join(', ')}) VALUES (${names.map((n) => (n === 'app_data' ? '?::jsonb' : '?')).join(', ')}) RETURNING id`,
  ).get(...vals);
  const total = await insertItems(row.id, items);
  await db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(total, row.id);
  return { dbId: row.id, total };
}

// Changes form fields on an order. `values` holds only the fields to change.
async function updateFields(dbId, values, customFieldIds = []) {
  const { cols, app } = toColumns(values, customFieldIds);
  const sets = Object.keys(cols).map((c) => `${c} = ?`);
  const params = Object.values(cols);
  if (Object.keys(app).length) {
    // custom fields merge into app_data.custom, the rest into app_data itself
    const { custom, ...rest } = app;
    sets.push('app_data = app_data || ?::jsonb');
    params.push(JSON.stringify(rest));
    if (custom) {
      sets.push(`app_data = jsonb_set(app_data, '{custom}', COALESCE(app_data->'custom', '{}'::jsonb) || ?::jsonb)`);
      params.push(JSON.stringify(custom));
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), dbId);
  await db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

async function replaceItems(dbId, items) {
  await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(dbId);
  const total = await insertItems(dbId, items);
  await db.prepare('UPDATE orders SET total_amount = ?, updated_at = ? WHERE id = ?').run(total, new Date().toISOString(), dbId);
  return total;
}

async function mergeAppData(dbId, patch) {
  await db.prepare('UPDATE orders SET app_data = app_data || ?::jsonb WHERE id = ?').run(JSON.stringify(patch), dbId);
}

async function removeAppData(dbId, keys) {
  await db.prepare(`UPDATE orders SET app_data = app_data - ?::text[] WHERE id = ?`).run(keys, dbId);
}

// Moves the order only if it is still where the caller last saw it. Two people
// pressing different buttons at once: the first wins, the second is told.
async function moveIf(dbId, from, to) {
  const res = await db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(to, new Date().toISOString(), dbId, from);
  return res.changes === 1;
}

async function recordPayment(dbId, { method, reference, amount, paidOn }, verifierId) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO payments (order_id, status, payment_method, payment_reference, amount, payment_date, verified_by, verified_at, created_at)
     VALUES (?, 'verified', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (order_id) DO UPDATE SET status = 'verified', payment_method = EXCLUDED.payment_method,
       payment_reference = EXCLUDED.payment_reference, amount = EXCLUDED.amount, payment_date = EXCLUDED.payment_date,
       verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at`,
  ).run(dbId, method ?? null, reference ?? null, amount ?? null, paidOn ?? null, verifierId, now, now);
}

// dispatch_records for the order, made if it has none. Only the given columns change.
async function recordDispatch(dbId, fields) {
  await db.prepare(`INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'queued', ?)
                    ON CONFLICT (order_id) DO NOTHING`).run(dbId, new Date().toISOString());
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.prepare(`UPDATE dispatch_records SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE order_id = ?`)
    .run(...Object.values(fields), dbId);
}

// A trail entry for one of this app's steps.
async function logStep(dbId, { step, from, to, actor, label, note = null, details = null }) {
  await logEvent({
    orderId: dbId,
    eventType: EVENT_TYPE_OF_STEP[step] || step.toUpperCase(),
    oldStatus: from,
    newStatus: to,
    actorId: actor.id,
    actorName: actor.name,
    notes: note,
    metadata: { step, label, ...(details ? { details } : {}) },
  });
}

module.exports = {
  ORDER_SELECT,
  rowByRef,
  loadRow,
  getOrder,
  listOrders,
  ordersForDashboards,
  visibilitySql,
  insertOrder,
  updateFields,
  replaceItems,
  mergeAppData,
  removeAppData,
  moveIf,
  recordPayment,
  recordDispatch,
  logStep,
  fileTypeOf,
  kindOf,
  toOrder,
};
