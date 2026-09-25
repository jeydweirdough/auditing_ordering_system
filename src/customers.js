// Customers, from the shared `customers` table: the ~95,000 Zoho contacts
// getmeds-system keeps in sync, plus any added here.
//
// A customer added here has no Zoho contact yet. It is saved with
// zoho_sync_status 'pending', the same way getmeds-system saves one Zoho
// wouldn't take, so it shows in the Pending Customers list for someone to push
// to Zoho or link to the contact Zoho already has. An order for it can be
// raised, but not approved until it is linked: the Sales Order needs the Zoho
// contact (src/workflow/zohoSteps.js says so at Approve).
//
// Two things this app keeps per customer have no column there, and live in
// customers.app_data: the usual receiver (name and number, filled into the
// next order) and whether Management has cleared them for Special Price.
const db = require('./db');
const customerCreate = require('./core/services/customerCreateService');

const clean = (v) => (v == null ? '' : String(v).trim());
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const COLUMNS = `id, name, type, contact_number, contact_person, address, zoho_contact_id,
  zoho_sync_status, category, tin, is_active, app_data`;

// The shape the order form works with.
function view(row) {
  if (!row) return null;
  const extra = row.app_data || {};
  return {
    id: row.id,
    name: row.name,
    contactNumber: row.contact_number || '',
    address: row.address || '',
    receiverName: extra.receiverName || '',
    receiverContact: extra.receiverContact || '',
    hasSpecialPrice: Boolean(extra.hasSpecialPrice),
    type: row.type,
    category: row.category || null,
    tin: row.tin || null,
    inZoho: Boolean(row.zoho_contact_id),
    zohoStatus: row.zoho_sync_status || null,
  };
}

// Up to 15 active customers whose name, number or address contains q; the 15
// most recently added when q is empty. Customers already in Zoho first.
async function searchCustomers(query) {
  const q = clean(query);
  if (!q) {
    return (await db.prepare(`SELECT ${COLUMNS} FROM customers WHERE is_active = 1 ORDER BY id DESC LIMIT 15`).all()).map(view);
  }
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db.prepare(
    `SELECT ${COLUMNS} FROM customers
      WHERE is_active = 1 AND (name ILIKE ? OR contact_number ILIKE ? OR address ILIKE ?)
      ORDER BY (zoho_contact_id IS NULL), (LOWER(name) = LOWER(?)) DESC, LOWER(name)
      LIMIT 15`,
  ).all(like, like, like, q);
  return rows.map(view);
}

async function getCustomer(id) {
  if (!Number.isInteger(Number(id))) return null;
  return view(await db.prepare(`SELECT ${COLUMNS} FROM customers WHERE id = ?`).get(Number(id)));
}

// The customer with exactly this name (any case), preferring one that is in Zoho.
async function findCustomerByName(name) {
  const n = clean(name);
  if (!n) return null;
  return view(await db.prepare(
    `SELECT ${COLUMNS} FROM customers WHERE LOWER(TRIM(name)) = LOWER(?) AND is_active = 1
      ORDER BY (zoho_contact_id IS NULL), id LIMIT 1`,
  ).get(n));
}

// The customer an order is for, made or brought up to date from the order form:
// by id when the form picked one, else by exact name, else a new one.
// `type` matters only for a new customer (the table requires one): 'credit'
// when the order is on terms, 'direct' when paid up front.
async function customerForOrder({ customerId, name, contactNumber, address, receiverName, receiverContact, type }) {
  const found = customerId ? await getCustomer(customerId) : await findCustomerByName(name);
  const receiver = { receiverName: clean(receiverName), receiverContact: clean(receiverContact) };
  if (found) {
    await db.prepare(
      `UPDATE customers SET
          contact_number = COALESCE(NULLIF(contact_number, ''), NULLIF(?, '')),
          address = COALESCE(NULLIF(address, ''), NULLIF(?, '')),
          app_data = app_data || ?::jsonb
        WHERE id = ?`,
    ).run(clean(contactNumber), clean(address), JSON.stringify(receiver), found.id);
    return getCustomer(found.id);
  }
  const n = clean(name);
  if (!n) throw bad('Customer name is required.');
  const row = await db.prepare(
    `INSERT INTO customers (name, type, contact_number, address, source, zoho_sync_status, app_data, created_at)
     VALUES (?, ?, ?, ?, 'local', 'pending', ?::jsonb, ?) RETURNING id`,
  ).get(n, type === 'credit' ? 'credit' : 'direct', clean(contactNumber) || null, clean(address) || null,
    JSON.stringify(receiver), new Date().toISOString());
  return getCustomer(row.id);
}

// Management's say on whether a customer may be given Special Price.
async function setSpecialPrice(id, allowed) {
  const res = await db.prepare(`UPDATE customers SET app_data = app_data || ?::jsonb WHERE id = ?`)
    .run(JSON.stringify({ hasSpecialPrice: Boolean(allowed) }), Number(id));
  if (!res.changes) throw bad('No such customer.', 404);
  return getCustomer(id);
}

// Customers already in Zoho that look like this new one: the same name or a
// close spelling, the same phone number, TIN, LTO licence or email.
// getmeds-system's own matcher (customerCreateService.checkDuplicates), so the
// two apps warn about the same things.
async function checkDuplicates({ name, contactNumber, tin, email, ltoLicenseNumber } = {}) {
  const matches = await customerCreate.checkDuplicates({
    display_name: clean(name),
    contact_number: clean(contactNumber),
    tin: clean(tin),
    email: clean(email),
    lto_license_number: clean(ltoLicenseNumber),
  });
  return matches.map((m) => ({
    id: m.id,
    name: m.name,
    contactNumber: m.contact_number || '',
    address: m.address || '',
    tin: m.tin || null,
    orders: m.order_count,
    matched: m.matched,
    sameCustomer: !m.overridable,
  }));
}

module.exports = {
  searchCustomers,
  getCustomer,
  findCustomerByName,
  findCustomer: findCustomerByName,
  customerForOrder,
  setSpecialPrice,
  checkDuplicates,
  view,
};
