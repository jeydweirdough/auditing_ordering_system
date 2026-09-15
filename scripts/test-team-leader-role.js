'use strict';

const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/server');

async function run() {
  console.log('===============================================================');
  console.log('🚀 Testing Team Leader Role & Supervised Order Workflow');
  console.log('===============================================================\n');

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = 'http://localhost:' + port;

  async function login(email, password = 'passwordpass') {
    const res = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.strictEqual(res.status, 200, 'Login failed for ' + email);
    const cookie = res.headers.get('set-cookie');
    assert(cookie, 'Expected set-cookie header on login');
    return cookie.split(';')[0];
  }

  try {
    const adminCookie = await login('admin.test@getmeds.ph');
    const mgmtCookie = await login('management.test@getmeds.ph');
    const tl1Cookie = await login('teamleader.test@getmeds.ph');
    const tl2Cookie = await login('teamleader2.test@getmeds.ph');
    const spCookie = await login('salesperson.test@getmeds.ph');

    // 1. Verify team_leader in RBAC roles
    console.log('[TEST 1] Verifying team_leader in RBAC table...');
    const usersRes = await fetch(baseUrl + '/api/users', { headers: { Cookie: adminCookie } });
    assert.strictEqual(usersRes.status, 200);
    const { roles, users } = await usersRes.json();
    assert(roles.some((r) => r.value === 'team_leader'), 'team_leader role must exist in RBAC roles');
    
    // Check salesperson is assigned to Team Leader 8
    const spUser = users.find((u) => u.email === 'salesperson.test@getmeds.ph');
    assert.strictEqual(spUser.teamLeaderId, 8, 'Salesperson must be assigned to Team Leader 8');
    console.log('✓ Test 1 Passed: team_leader present in RBAC and Salesperson assigned to TL1 (id: 8).\n');

    // 2. Salesperson raises an order -> check status is pending_tl_approval
    console.log('[TEST 2] Salesperson raises order -> checking initial status pending_tl_approval...');
    const createRes = await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: spCookie },
      body: JSON.stringify({
        customerName: 'Saint Jude Hospital',
        contactNumber: '0917-222-3333',
        address: 'Manila Hospital Road',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Test supervised order submission',
        items: [{ product: 'AtraGet 10mg', qty: 10, unitPrice: 250, priceType: 'hospital' }],
      }),
    });
    assert([200, 201, 202].includes(createRes.status));
    const created = await createRes.json();
    const orderId = created.order.id;
    assert.strictEqual(created.order.status, 'pending_tl_approval', 'Supervised salesperson order must enter pending_tl_approval');
    console.log(`✓ Test 2 Passed: Order ${orderId} created in pending_tl_approval status.\n`);

    // 3. Unauthorized Team Leader (TL 9) tries to approve order from TL 8's salesperson -> 403 Forbidden
    console.log('[TEST 3] Unauthorized Team Leader (TL2) tries to approve order...');
    const unauthApproveRes = await fetch(baseUrl + `/api/orders/${orderId}/actions/tl_approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tl2Cookie },
      body: JSON.stringify({ note: 'Unauthorized endorsement' }),
    });
    assert([403, 404].includes(unauthApproveRes.status), 'TL2 must be rejected with 403 or 404 when trying to access TL1 supervised order, got: ' + unauthApproveRes.status);
    console.log('✓ Test 3 Passed: Cross-team access prevented with ' + unauthApproveRes.status + ' Forbidden/NotFound.\n');

    // 4. Assigned Team Leader (TL 8) views Dashboard and Endorses Order
    console.log('[TEST 4] Assigned Team Leader (TL1) verifies dashboard and endorses order...');
    
    // Check TL Dashboard
    const tlDashRes = await fetch(baseUrl + '/api/orders/dashboard?period=month', {
      headers: { Cookie: tl1Cookie },
    });
    assert.strictEqual(tlDashRes.status, 200);
    const tlDash = await tlDashRes.json();
    assert.strictEqual(tlDash.role, 'team_leader');
    assert(tlDash.pendingReview.count >= 1, 'Team Leader dashboard must report pending review order');
    assert(tlDash.pendingReview.items.some((item) => item.id === orderId), 'Order must be in pending review list');

    // TL1 edits order
    const tlEditRes = await fetch(baseUrl + `/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: tl1Cookie },
      body: JSON.stringify({
        remarks: 'Supervised notes reviewed by TL',
        reason: 'Team Leader adjusted order remarks after customer coordination',
      }),
    });
    assert([200, 202].includes(tlEditRes.status));
    const tlEdited = await tlEditRes.json();
    const editEvent = tlEdited.order.events[tlEdited.order.events.length - 1];
    assert.strictEqual(editEvent.label, 'Edited by Team Leader', 'Audit trail must record Edited by Team Leader');

    // TL1 endorses order to Management
    const tlApproveRes = await fetch(baseUrl + `/api/orders/${orderId}/actions/tl_approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tl1Cookie },
      body: JSON.stringify({ note: 'Verified with procurement, endorsing to Management' }),
    });
    assert([200, 202].includes(tlApproveRes.status));
    const endorsed = await tlApproveRes.json();
    assert.strictEqual(endorsed.order.status, 'pending_approval', 'Order must transition to pending_approval for Management');
    const lastEvent = endorsed.order.events[endorsed.order.events.length - 1];
    assert.strictEqual(lastEvent.label, 'Endorsed by Team Leader');
    console.log(`✓ Test 4 Passed: TL1 successfully edited (logged as Edited by Team Leader) and endorsed order to Management.\n`);

    // 5. Management reviews and approves order as legitimate
    console.log('[TEST 5] Management confirms order as legitimate...');
    const mgmtApproveRes = await fetch(baseUrl + `/api/orders/${orderId}/actions/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: mgmtCookie },
      body: JSON.stringify({ note: 'Confirmed valid order, ready for finance' }),
    });
    assert([200, 202].includes(mgmtApproveRes.status));
    const approved = await mgmtApproveRes.json();
    assert.strictEqual(approved.order.status, 'awaiting_payment', 'Order must move to awaiting_payment after Management approval');
    console.log(`✓ Test 5 Passed: Management confirmed order as legitimate; status moved to awaiting_payment.\n`);

    console.log('===============================================================');
    console.log('🎉 ALL TEAM LEADER & SUPERVISION TESTS PASSED 100%!');
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
