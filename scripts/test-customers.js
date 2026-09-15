const assert = require('assert');
const http = require('http');
const app = require('../src/server');
const customers = require('../src/customers');

async function run() {
  console.log('--- Running Customer Search, Add & Admin Edit Tests ---\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  // Helper for logging in and getting session cookie
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
    const salesCookie = await login('salesperson.test@getmeds.ph');

    console.log('[TEST 1] Testing Customer Search API...');
    const searchRes = await fetch(`${baseUrl}/api/orders/customers?q=`, {
      headers: { Cookie: salesCookie },
    });
    assert.strictEqual(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert(Array.isArray(searchData.customers), 'customers should be an array');
    console.log(`✓ Test 1 Passed: Retrieved ${searchData.customers.length} customer(s).\n`);

    console.log('[TEST 2] Testing Customer Creation API (POST /api/orders/customers)...');
    const newCustPayload = {
      name: 'Special Pharmacy Clinic',
      contactNumber: '0917-888-9999',
      address: 'Suite 405, Medical Arts Bldg, Manila',
      receiverName: 'Nurse Elena',
      receiverContact: '0918-777-6666',
      hasSpecialPrice: true,
      division: 'HOS', // should be ignored
      subDivision: 'Hospital', // should be ignored
      headQuarter: 'PGH Manila HQ', // should be ignored
    };
    const createRes = await fetch(`${baseUrl}/api/orders/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(newCustPayload),
    });
    assert.strictEqual(createRes.status, 201);
    const createData = await createRes.json();
    assert(createData.customer, 'Expected created customer');
    assert.strictEqual(createData.customer.name, newCustPayload.name);
    assert.strictEqual(createData.customer.hasSpecialPrice, true, 'hasSpecialPrice should be true');
    assert.strictEqual(createData.customer.division, undefined, 'Customer should not have division');
    assert.strictEqual(createData.customer.subDivision, undefined, 'Customer should not have subDivision');
    assert.strictEqual(createData.customer.headQuarter, undefined, 'Customer should not have headQuarter');
    console.log(`✓ Test 2 Passed: Customer created with ID ${createData.customer.id} and hasSpecialPrice=true without division fields.\n`);

    console.log('[TEST 3] Testing Searching for the newly created customer...');
    const searchNewRes = await fetch(`${baseUrl}/api/orders/customers?q=Special`, {
      headers: { Cookie: salesCookie },
    });
    assert.strictEqual(searchNewRes.status, 200);
    const searchNewData = await searchNewRes.json();
    assert(searchNewData.customers.length >= 1, 'Should find at least 1 match');
    const found = searchNewData.customers.find((c) => c.name.includes('Special'));
    assert(found, 'Should find Special Pharmacy Clinic');
    assert.strictEqual(found.contactNumber, '0917-888-9999');
    assert.strictEqual(found.hasSpecialPrice, true);
    console.log(`✓ Test 3 Passed: Found customer by name query "Special" with hasSpecialPrice=true.\n`);

    console.log('[TEST 4] Creating an order to test Admin Edit vs Salesperson Lock...');
    const orderPayload = {
      customerName: 'Test Hospital Order',
      contactNumber: '0917-123-4567',
      address: '123 Health Ave, QC',
      receiverName: 'Pharmacy Dept',
      receiverContact: '0917-123-4567',
      division: 'HOS',
      subDivision: 'Hospital',
      headQuarter: 'QC Central HQ',
      invoicingFrom: 'Getmeds Philippines Inc.',
      source: 'Hospital PO',
      paymentMethod: 'Bank transfer',
      paymentTerms: '30 days',
      deliveryMethod: 'Grab Express',
      customerIsDoctor: 'No',
      doctorName: '',
      remarks: 'Testing admin editability',
      notes: 'Initial notes',
      items: [
        { product: 'DoseGet-80', qty: 2, unitPrice: 1820, priceType: 'hospital' },
      ],
    };

    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(orderPayload),
    });
    const orderText = await orderRes.text();
    if (![200, 201, 202].includes(orderRes.status)) {
      throw new Error(`Order creation failed with status ${orderRes.status}: ${orderText}`);
    }
    const orderData = JSON.parse(orderText);
    const orderId = orderData.order.id;
    console.log(`Created order ${orderId} with division=${orderData.order.division}, subDivision=${orderData.order.subDivision}, headQuarter=${orderData.order.headQuarter}`);

    console.log('[TEST 5] Testing Admin editing division, subDivision, and headQuarter...');
    const adminEditPayload = {
      division: 'B2B',
      subDivision: 'NBD',
      headQuarter: 'Updated Makati HQ',
      invoicingFrom: 'Getmeds Philippines Inc.',
      source: 'Distributor order',
      paymentMethod: 'Credit terms',
      paymentTerms: '60 Day',
      deliveryMethod: 'Distributor Delivery',
      customerName: 'Test Hospital Order - Edited',
      contactNumber: '0917-123-4567',
      address: '123 Health Ave, QC',
      receiverName: 'Pharmacy Dept',
      receiverContact: '0917-123-4567',
      customerIsDoctor: 'No',
      doctorName: '',
      remarks: 'Admin updated the division and headquarter',
      reason: 'Changing division and headquarters to B2B per management request',
      notes: 'Admin change notes',
      items: [
        { product: 'DoseGet-80', qty: 2, unitPrice: 10800, priceType: 'srp' },
      ],
    };

    const adminEditRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify(adminEditPayload),
    });
    const adminEditText = await adminEditRes.text();
    if (![200, 202].includes(adminEditRes.status)) {
      throw new Error(`Admin edit failed with status ${adminEditRes.status}: ${adminEditText}`);
    }
    const adminEditData = JSON.parse(adminEditText);
    assert.strictEqual(adminEditData.order.division, 'B2B', 'Admin should be able to update division');
    assert.strictEqual(adminEditData.order.subDivision, 'NBD', 'Admin should be able to update subDivision');
    assert.strictEqual(adminEditData.order.headQuarter, 'Updated Makati HQ', 'Admin should be able to update headQuarter');
    console.log('✓ Test 5 Passed: Admin successfully changed division, sub-division, and headquarters.\n');

    console.log('[TEST 6] Testing that order audit trail recorded Admin division changes...');
    const getOrderRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      headers: { Cookie: adminCookie },
    });
    const orderDetails = await getOrderRes.json();
    const lastEvent = orderDetails.order.events[orderDetails.order.events.length - 1];
    assert(['Edited by Admin', 'Edited by Administrator'].includes(lastEvent.label), `Expected edit label, got: ${lastEvent.label}`);
    assert(lastEvent.details && Array.isArray(lastEvent.details.changed), 'Details should contain changed labels');
    assert(lastEvent.details.changed.includes('Division'), 'Should record Division change');
    assert(lastEvent.details.changed.includes('Sub-division'), 'Should record Sub-division change');
    assert(lastEvent.details.changed.includes('Head quarter'), 'Should record Head quarter change');
    assert.strictEqual(lastEvent.details.before['Division'], 'HOS');
    assert.strictEqual(lastEvent.details.before['Sub-division'], 'Hospital');
    console.log('✓ Test 6 Passed: Audit trail recorded all Admin division and headquarter changes.\n');

    console.log('[TEST 7] Testing Salesperson cannot change division on resubmit...');
    // Send order back first so salesperson can resubmit
    const sendBackRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/send_back`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        reason: 'Please check the quantities and resubmit',
      }),
    });
    assert([200, 202].includes(sendBackRes.status));

    // Salesperson attempts to resubmit with altered division
    const resubmitRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/resubmit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify({
        ...adminEditPayload,
        division: 'HOS', // salesperson tries to tamper with division
        subDivision: 'Hospital',
        headQuarter: 'Hacked HQ',
        items: [
          { product: 'DoseGet-80', qty: 2, unitPrice: 10800, priceType: 'srp' },
        ],
        remarks: 'Salesperson resubmitting',
      }),
    });
    const resubmitText = await resubmitRes.text();
    if (![200, 202].includes(resubmitRes.status)) {
      throw new Error(`Resubmit failed with status ${resubmitRes.status}: ${resubmitText}`);
    }
    const resubmitData = JSON.parse(resubmitText);
    // Verify division, subDivision, headQuarter remain unchanged (B2B, NBD, Updated Makati HQ)
    assert.strictEqual(resubmitData.order.division, 'B2B', 'Salesperson must NOT be able to change division');
    assert.strictEqual(resubmitData.order.subDivision, 'NBD', 'Salesperson must NOT be able to change subDivision');
    assert.strictEqual(resubmitData.order.headQuarter, 'Updated Makati HQ', 'Salesperson must NOT be able to change headQuarter');
    console.log('✓ Test 7 Passed: Salesperson resubmit strictly kept original division, sub-division, and headquarter.\n');

    console.log('[TEST 8] Testing Special Price Request on Order Submission...');
    // A) Salesperson submits order with special price for customer with hasSpecialPrice: true -> should SUCCEED
    const specialOrderPayload = {
      customerName: 'Special Pharmacy Clinic',
      contactNumber: '0917-888-9999',
      address: 'Suite 405, Medical Arts Bldg, Manila',
      customerHasSpecialPrice: true,
      division: 'HOS',
      subDivision: 'Hospital',
      headQuarter: 'QC Central HQ',
      invoicingFrom: 'Getmeds Philippines Inc.',
      source: 'Hospital PO',
      paymentMethod: 'Bank transfer',
      paymentTerms: '30 days',
      deliveryMethod: 'Grab Express',
      customerIsDoctor: 'No',
      remarks: 'Approved special price request',
      notes: 'Requested special price of ₱1,500 due to annual volume agreement',
      items: [
        { product: 'DoseGet-80', qty: 5, unitPrice: 1500, priceType: 'special' },
      ],
    };

    const specialOrderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(specialOrderPayload),
    });
    const specialOrderText = await specialOrderRes.text();
    assert([200, 201, 202].includes(specialOrderRes.status), `Special price order should succeed: ${specialOrderText}`);
    const specialOrderData = JSON.parse(specialOrderText);
    assert.strictEqual(specialOrderData.order.items[0].priceType, 'special');
    assert.strictEqual(specialOrderData.order.items[0].unitPrice, 1500);
    assert.strictEqual(specialOrderData.order.customerHasSpecialPrice, true);
    console.log(`✓ Test 8A Passed: Successfully raised order ${specialOrderData.order.id} with requested Special Price ₱1,500.\n`);

    // B) Salesperson submits order with special price for customer WITHOUT special price eligibility -> should FAIL
    const unauthSpecialPayload = {
      ...specialOrderPayload,
      customerName: 'Regular Customer',
      customerHasSpecialPrice: false,
    };
    const unauthSpecialRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: salesCookie,
      },
      body: JSON.stringify(unauthSpecialPayload),
    });
    assert.strictEqual(unauthSpecialRes.status, 400, 'Order without special price eligibility should fail');
    console.log('✓ Test 8B Passed: Special price rejected for customer without special price eligibility.\n');

    console.log('ALL CUSTOMER & ADMIN EDIT TESTS PASSED 100%!');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
