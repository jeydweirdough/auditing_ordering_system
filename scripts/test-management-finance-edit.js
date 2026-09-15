#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const app = require('../src/server');

async function run() {
  console.log('===============================================================');
  console.log('🚀 Testing Management and Finance Order Editing Permissions');
  console.log('===============================================================\n');

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  async function login(email, password = 'passwordpass') {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.strictEqual(res.status, 200, `Login failed for ${email}`);
    const cookie = res.headers.get('set-cookie');
    assert(cookie, 'Expected set-cookie header on login');
    return cookie.split(';')[0];
  }

  try {
    const adminCookie = await login('admin.test@getmeds.ph');
    const mgmtCookie = await login('management.test@getmeds.ph');
    const finCookie = await login('finance.test@getmeds.ph');
    const spCookie = await login('salesperson.test@getmeds.ph');

    // 1. Create a test order
    console.log('[TEST 1] Raising an order to test role-based edits...');
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        customerName: 'Edit Perm Hospital',
        contactNumber: '0917-111-2222',
        address: 'Manila General Hospital',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Test order for role-based edits',
        items: [{ product: 'AtraGet 10mg', qty: 5, unitPrice: 250, priceType: 'hospital' }],
      }),
    });
    assert([200, 201, 202].includes(createRes.status));
    const created = await createRes.json();
    const orderId = created.order.id;
    console.log(`✓ Test 1 Passed: Created test order ${orderId}\n`);

    // 2. Test Management Edit
    console.log('[TEST 2] Testing Management Order Edit Capabilities...');
    const mgmtViewRes = await fetch(`${baseUrl}/api/orders/${orderId}`, { headers: { Cookie: mgmtCookie } });
    assert.strictEqual(mgmtViewRes.status, 200);
    const mgmtView = await mgmtViewRes.json();
    const mgmtCanEdit = mgmtView.order.actions.some((a) => a.name === 'edit');
    assert.strictEqual(mgmtCanEdit, true, 'Management MUST have edit action available');

    const mgmtEditRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: mgmtCookie },
      body: JSON.stringify({
        remarks: 'Management verified allocation: approved 10 units',
        reason: 'Adjusting quantities for ward stock',
        items: [{ product: 'AtraGet 10mg', qty: 10, unitPrice: 250, priceType: 'hospital' }],
      }),
    });
    assert([200, 202].includes(mgmtEditRes.status), `Management edit returned status ${mgmtEditRes.status}`);
    const mgmtEdited = await mgmtEditRes.json();
    assert.strictEqual(mgmtEdited.order.items[0].qty, 10);
    const lastEventMgmt = mgmtEdited.order.events[mgmtEdited.order.events.length - 1];
    assert.strictEqual(lastEventMgmt.label, 'Edited by Management');
    console.log(`✓ Test 2 Passed: Management successfully edited order items and status recorded "Edited by Management"\n`);

    // 3. Test Finance Edit
    console.log('[TEST 3] Testing Finance Order Edit Capabilities...');
    const finViewRes = await fetch(`${baseUrl}/api/orders/${orderId}`, { headers: { Cookie: finCookie } });
    assert.strictEqual(finViewRes.status, 200);
    const finView = await finViewRes.json();
    const finCanEdit = finView.order.actions.some((a) => a.name === 'edit');
    assert.strictEqual(finCanEdit, true, 'Finance MUST have edit action available');

    const finEditRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: finCookie },
      body: JSON.stringify({
        paymentTerms: 'COD',
        reason: 'Finance changed credit term to Cash on Delivery based on credit limit review',
      }),
    });
    assert([200, 202].includes(finEditRes.status), `Finance edit returned status ${finEditRes.status}`);
    const finEdited = await finEditRes.json();
    assert.strictEqual(finEdited.order.paymentTerms, 'COD');
    const lastEventFin = finEdited.order.events[finEdited.order.events.length - 1];
    assert.strictEqual(lastEventFin.label, 'Edited by Finance');
    console.log(`✓ Test 3 Passed: Finance successfully edited payment terms and status recorded "Edited by Finance"\n`);

    // 4. Test Salesperson is Restricted
    console.log('[TEST 4] Testing Salesperson is Strictly Forbidden from Order Editing...');
    const spOtherEditRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: spCookie },
      body: JSON.stringify({ remarks: 'Salesperson unauthorized change' }),
    });
    assert([403, 404].includes(spOtherEditRes.status), 'Salesperson edit on other order must be rejected (403 or 404)');

    const spCreateRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: spCookie },
      body: JSON.stringify({
        customerName: 'Salesperson Hospital',
        contactNumber: '0917-333-4444',
        address: 'Quezon City Hospital',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Salesperson order to verify edit restriction',
        items: [{ product: 'DoseGet-80', qty: 1, unitPrice: 1820, priceType: 'hospital' }],
      }),
    });
    assert([200, 201, 202].includes(spCreateRes.status), `Salesperson order create failed: ${spCreateRes.status}`);
    const spCreated = await spCreateRes.json();
    const spOrderId = spCreated.order.id;

    const spViewRes = await fetch(`${baseUrl}/api/orders/${spOrderId}`, { headers: { Cookie: spCookie } });
    assert.strictEqual(spViewRes.status, 200);
    const spView = await spViewRes.json();
    const spCanEdit = spView.order.actions.some((a) => a.name === 'edit');
    assert.strictEqual(spCanEdit, false, 'Salesperson MUST NOT have edit action');

    const spEditRes = await fetch(`${baseUrl}/api/orders/${spOrderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: spCookie },
      body: JSON.stringify({ remarks: 'Salesperson unauthorized change on own order' }),
    });
    assert.strictEqual(spEditRes.status, 403, 'Salesperson edit on own order MUST be rejected with 403');
    console.log(`✓ Test 4 Passed: Salesperson edit strictly forbidden (403 Forbidden)\n`);

    console.log('===============================================================');
    console.log('🎉 ALL MANAGEMENT & FINANCE EDIT PERMISSION TESTS PASSED 100%!');
    console.log('===============================================================');
    process.exit(0);
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
