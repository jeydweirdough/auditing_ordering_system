// Integration test: verifying that when an order is sent back (by Team Leader or Management),
// salesperson can edit items/quantities and resubmit with the updated content.
const http = require('http');
const assert = require('assert');

const app = require('../src/server');

async function run() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log('--- Running Send Back & Salesperson Resubmit Test ---');

  try {
    // 1. Log in as Salesperson, Team Leader, Management
    const login = async (email, password = 'passwordpass') => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.strictEqual(res.status, 200, `Login failed for ${email}`);
      const rawCookie = res.headers.get('set-cookie');
      return rawCookie ? rawCookie.split(';')[0] : '';
    };

    const salesCookie = await login('salesperson.test@getmeds.ph');
    const tlCookie = await login('teamleader.test@getmeds.ph');
    const mgmtCookie = await login('management.test@getmeds.ph');

    // 2. Salesperson creates an order with 1 item
    console.log('[STEP 1] Salesperson creates an order...');
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
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
        remarks: 'Initial order submission',
        items: [
          { product: 'AtraGet 10mg', qty: 10, unitPrice: 250, priceType: 'hospital' },
        ],
        notes: 'Initial submission',
      }),
    });
    const createData = await createRes.json();
    assert([200, 201, 202].includes(createRes.status), `Create order failed: ${JSON.stringify(createData)}`);
    const orderId = createData.order.id;
    console.log(`✓ Order created: ${orderId}, status: ${createData.order.status}, items: ${createData.order.items.length}, total: ${createData.order.total}`);
    assert.strictEqual(createData.order.items.length, 1);
    assert.strictEqual(createData.order.items[0].qty, 10);
    assert.strictEqual(createData.order.total, 2500);
    assert.strictEqual(createData.order.status, 'pending_tl_approval');

    // 3. Team Leader sends it back with tl_send_back
    console.log('[STEP 2] Team Leader sends back order with changes requested...');
    const tlSendBackRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/tl_send_back`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: tlCookie,
      },
      body: JSON.stringify({
        reason: 'Quantity too low, please change to 25 boxes.',
      }),
    });
    const tlSendBackData = await tlSendBackRes.json();
    assert([200, 202].includes(tlSendBackRes.status));
    assert.strictEqual(tlSendBackData.order.status, 'returned');
    console.log(`✓ Order returned by TL with note: "${tlSendBackData.order.events.slice(-1)[0].note}"`);

    // 4. Salesperson resubmits with updated items (updated qty from 10 to 25)
    console.log('[STEP 3] Salesperson modifies items and resubmits...');
    const resubmitPayload = {
      customerName: tlSendBackData.order.customerName,
      contactNumber: tlSendBackData.order.contactNumber,
      address: tlSendBackData.order.address,
      deliveryAddress: tlSendBackData.order.deliveryAddress || tlSendBackData.order.address,
      division: tlSendBackData.order.division,
      subDivision: tlSendBackData.order.subDivision,
      headQuarter: tlSendBackData.order.headQuarter,
      invoicingFrom: tlSendBackData.order.invoicingFrom,
      paymentMethod: tlSendBackData.order.paymentMethod,
      source: tlSendBackData.order.source,
      paymentTerms: tlSendBackData.order.paymentTerms,
      deliveryMethod: tlSendBackData.order.deliveryMethod,
      remarks: 'Updated quantities as requested by Team Leader',
      notes: 'Updated quantities to 25 boxes',
      items: [
        { product: 'AtraGet 10mg', qty: 25, unitPrice: 250, priceType: 'hospital' },
      ],
    };

    const resubmitRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/resubmit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(resubmitPayload),
    });
    const resubmitData = await resubmitRes.json();
    assert([200, 202].includes(resubmitRes.status), `Resubmit failed: ${JSON.stringify(resubmitData)}`);
    console.log(`✓ Order resubmitted. Status: ${resubmitData.order.status}`);
    assert.strictEqual(resubmitData.order.status, 'pending_tl_approval');

    // VERIFY ITEMS WERE ACTUALLY UPDATED!
    console.log('[STEP 4] Verifying updated items on order...');
    assert.strictEqual(resubmitData.order.items.length, 1);
    assert.strictEqual(resubmitData.order.items[0].qty, 25, 'Item qty must be updated to 25');
    const expectedTotal = 25 * 250; // 6250
    assert.strictEqual(resubmitData.order.total, expectedTotal, `Total should be ${expectedTotal}, got ${resubmitData.order.total}`);
    console.log(`✓ Verified: item qty = 25, total = ₱${resubmitData.order.total} (was ₱2,500)`);

    // 5. Team Leader endorses to Management
    console.log('[STEP 5] Team Leader endorses to Management...');
    const tlApproveRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/tl_approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: tlCookie,
      },
      body: JSON.stringify({ note: 'Looks good now with 25 boxes, endorsing to Management.' }),
    });
    const tlApproveData = await tlApproveRes.json();
    assert([200, 202].includes(tlApproveRes.status));
    assert.strictEqual(tlApproveData.order.status, 'pending_approval');
    console.log(`✓ Endorsed to Management. Status: ${tlApproveData.order.status}`);

    // 6. Management sends it back
    console.log('[STEP 6] Management sends back order...');
    const mgmtSendBackRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/send_back`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: mgmtCookie,
      },
      body: JSON.stringify({ reason: 'Adjust AtraGet 10mg to 30 boxes.' }),
    });
    const mgmtSendBackData = await mgmtSendBackRes.json();
    assert([200, 202].includes(mgmtSendBackRes.status));
    assert.strictEqual(mgmtSendBackData.order.status, 'returned');
    console.log(`✓ Order returned by Management. Status: ${mgmtSendBackData.order.status}`);

    // 7. Salesperson updates to 30 boxes and resubmits
    console.log('[STEP 7] Salesperson updates AtraGet 10mg to 30 boxes and resubmits...');
    const resubmit2Payload = {
      ...resubmitPayload,
      items: [
        { product: 'AtraGet 10mg', qty: 30, unitPrice: 250, priceType: 'hospital' },
      ],
      notes: 'Adjusted to 30 boxes as requested by Management',
    };
    const resubmit2Res = await fetch(`${baseUrl}/api/orders/${orderId}/actions/resubmit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(resubmit2Payload),
    });
    const resubmit2Data = await resubmit2Res.json();
    assert([200, 202].includes(resubmit2Res.status));
    assert.strictEqual(resubmit2Data.order.items[0].qty, 30);
    const newExpectedTotal = 30 * 250; // 7500
    assert.strictEqual(resubmit2Data.order.total, newExpectedTotal);
    console.log(`✓ Resubmitted with 30 boxes! Total: ₱${resubmit2Data.order.total}`);

    console.log('\n--- ALL SEND BACK & RESUBMIT TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});