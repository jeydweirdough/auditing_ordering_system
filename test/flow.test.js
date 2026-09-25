// One order, raised by a Salesperson, taken through every step by every role,
// against a real (local) Postgres and Zoho in mock mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startStack, client } = require('./harness');

let stack;
const as = {};
let product;

const B2C_FORM = (overrides = {}) => ({
  customerName: 'Juan Dela Cruz',
  contactNumber: '0917 555 0101',
  address: '12 Mabini St, Quezon City',
  receiverName: 'Juan Dela Cruz',
  receiverContact: '0917 555 0101',
  division: 'B2C',
  subDivision: 'MD Telesales',
  invoicingFrom: 'Getmeds Philippines Inc.',
  source: 'Doctor order',
  paymentMethod: 'GCash',
  paymentTerms: 'Paid',
  deliveryMethod: 'Lalamove',
  remarks: 'Deliver before noon',
  items: [{ product: product.fullName, qty: 2, unitPrice: product.prices.patient.unitPrice, priceType: 'patient', unitType: 'unit' }],
  ...overrides,
});

test.before(async () => {
  stack = await startStack();
  product = stack.seeded.catalog[0];
  for (const [who, email] of Object.entries({
    admin: 'admin@dev.local', manager: 'manager@dev.local', leader: 'leader@dev.local', sales: 'sales@dev.local',
    sales2: 'sales2@dev.local', finance: 'finance@dev.local', dispatch: 'dispatch@dev.local',
  })) {
    as[who] = client(stack.base);
    await as[who].login(email);
  }
});

test.after(async () => {
  await stack?.stop();
});

test('accounts come from the shared users table, with this app\'s role names', async () => {
  const me = await as.sales.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'salesperson');
  assert.equal((await as.leader.get('/api/auth/me')).body.user.role, 'team_leader');
  const wrong = await client(stack.base).post('/api/auth/login', { email: 'sales@dev.local', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
});

let orderId;

test('a salesperson raises an order: a draft first, then submitted to their Team Leader', async () => {
  const created = await as.sales.post('/api/orders', B2C_FORM());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const order = created.body.order;
  assert.match(order.id, /^GM-\d{8}-\d{4}$/);
  assert.equal(order.status, 'draft');
  assert.equal(order.total, product.prices.patient.unitPrice * 2);
  assert.equal(order.items[0].priceType, 'patient');
  assert.ok(order.items[0].productId, 'the line points at a Zoho item');
  assert.ok(order.actions.some((a) => a.name === 'submit'));
  orderId = order.id;

  const up = await as.sales.upload(orderId, { name: 'po.png', kind: 'purchase_order' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.order.attachments.length, 1);

  const submitted = await as.sales.post(`/api/orders/${orderId}/actions/submit`);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.order.status, 'pending_tl_approval');
});

test('the Team Leader endorses it; Management approves it and the Sales Order is made in Zoho', async () => {
  const other = await as.sales2.get(`/api/orders/${orderId}`);
  assert.equal(other.status, 404, 'another salesperson cannot see it');

  const endorsed = await as.leader.post(`/api/orders/${orderId}/actions/tl_approve`, { note: 'ok' });
  assert.equal(endorsed.status, 200, JSON.stringify(endorsed.body));
  assert.equal(endorsed.body.order.status, 'pending_management_approval');

  const approved = await as.manager.post(`/api/orders/${orderId}/actions/approve`, { note: 'go' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const order = approved.body.order;
  assert.equal(order.status, 'ready_for_finance_verified');
  assert.ok(order.zoho.soId, 'has a Sales Order id');
  assert.equal(order.zoho.syncStatus, 'synced');
  assert.ok(order.events.some((e) => e.type === 'approve'), 'the approval is on the trail');
});

test('Finance verifies the payment, which confirms the Sales Order', async () => {
  const verified = await as.finance.post(`/api/orders/${orderId}/actions/verify_payment`, {
    method: 'GCash', reference: 'GC-123', amount: product.prices.patient.unitPrice * 2, paidOn: '2026-09-25',
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.order.status, 'ready_for_dispatch');
  assert.equal(verified.body.order.payment.reference, 'GC-123');
  assert.equal(verified.body.zoho.ok, true, JSON.stringify(verified.body.zoho));
  assert.equal(verified.body.order.zoho.soStatus, 'confirmed');
});

test('Dispatch picks, packs, dispatches and delivers it', async () => {
  let r = await as.dispatch.post(`/api/orders/${orderId}/actions/start_picking`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'picking_packing');
  r = await as.dispatch.post(`/api/orders/${orderId}/actions/mark_packed`, { packingNotes: '1 box' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'packed');
  r = await as.dispatch.post(`/api/orders/${orderId}/actions/dispatch`, { courier: 'Lalamove', trackingNumber: 'LM-9' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.shipment.trackingNumber, 'LM-9');
  r = await as.dispatch.post(`/api/orders/${orderId}/actions/deliver`, { receivedBy: 'Juan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'completed');
  assert.equal(r.body.order.shipment.receivedBy, 'Juan');
  assert.equal(r.body.order.shipment.packingNotes, '1 box');
});

test('the trail, the timeline and the notifications show what happened', async () => {
  const tl = await as.sales.get(`/api/orders/${orderId}/timeline`);
  assert.equal(tl.status, 200, JSON.stringify(tl.body));
  const stage = (k) => tl.body.stages.find((s) => s.key === k);
  assert.equal(stage('approved').state, 'done');
  assert.equal(stage('verified').state, 'done');
  assert.equal(stage('packed').state, 'done');
  assert.equal(stage('delivered').state, 'done');

  const bell = await as.sales.get('/api/notifications/unread-count');
  assert.equal(bell.status, 200, JSON.stringify(bell.body));
  assert.ok(bell.body.data.count > 0, 'the salesperson was told');
});
