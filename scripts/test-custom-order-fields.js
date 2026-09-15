#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const app = require('../src/server');

async function run() {
  console.log('===============================================================');
  console.log('🚀 Testing Configurable Custom Order Fields Architecture');
  console.log('===============================================================\nValues');

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
    const finCookie = await login('finance.test@getmeds.ph');
    const spCookie = await login('salesperson.test@getmeds.ph');

    // 1. Test RBAC: Non-admin cannot create custom fields
    console.log('[TEST 1] Verifying RBAC restriction on Custom Field Management...');
    const spCreateFieldRes = await fetch(baseUrl + '/api/orders/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: spCookie },
      body: JSON.stringify({ label: 'Unauthorized Field', type: 'text' }),
    });
    assert.strictEqual(spCreateFieldRes.status, 403, 'Salesperson MUST NOT be able to create custom fields (403)');
    console.log('✓ Test 1 Passed: Unauthorized field creation rejected with 403 Forbidden\nValues');

    // 2. Admin creates custom fields across various sections and types\n    console.log('[TEST 2] Creating custom fields as Admin across various types and sections...');
    
    // Field 2A: Hospital PO (text, details section)
    const f1Res = await fetch(baseUrl + '/api/orders/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        id: 'test_hospital_po',
        label: 'Hospital PO Number',
        type: 'text',
        section: 'details',
        required: true,
        helpText: 'The official purchase order number from the hospital.',
      }),
    });
    assert.strictEqual(f1Res.status, 201, 'Failed creating f1');
    const f1 = (await f1Res.json()).field;
    assert.strictEqual(f1.id, 'test_hospital_po');

    // Field 2B: Cost Center Code (select dropdown, billing section)
    const f2Res = await fetch(baseUrl + '/api/orders/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        id: 'test_cost_center',
        label: 'Cost Center Code',
        type: 'select',
        section: 'billing',
        options: ['CC-101 (Oncology)', 'CC-202 (ICU)', 'CC-303 (General)'],
        required: false,
      }),
    });
    assert.strictEqual(f2Res.status, 201);

    // Field 2C: Special Handling Required (choice Yes/No, additional section)
    const f3Res = await fetch(baseUrl + '/api/orders/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        id: 'test_cold_chain_pack',
        label: 'Cold Chain Ice Packs Required',
        type: 'choice',
        section: 'additional',
        required: false,
      }),
    });
    assert.strictEqual(f3Res.status, 201);
    console.log('✓ Test 2 Passed: Created text, select, and choice custom fields successfully.\nValues');

    // 3. Verify GET /api/orders/custom-fields and GET /api/orders/meta\n    console.log('[TEST 3] Verifying custom fields inclusion in API and Meta...');
    const listRes = await fetch(baseUrl + '/api/orders/custom-fields', {
      headers: { Cookie: adminCookie },
    });
    assert.strictEqual(listRes.status, 200);
    const { fields: allFields } = await listRes.json();
    assert(allFields.some((f) => f.id === 'test_hospital_po'), 'Hospital PO must exist in custom-fields');
    assert(allFields.some((f) => f.id === 'test_cost_center'), 'Cost Center must exist in custom-fields');

    const metaRes = await fetch(baseUrl + '/api/orders/meta', {
      headers: { Cookie: spCookie },
    });
    assert.strictEqual(metaRes.status, 200);
    const meta = await metaRes.json();
    assert(meta.orderFields.some((f) => f.name === 'test_hospital_po'), 'Meta orderFields must contain custom field');
    assert.strictEqual(meta.fields.test_hospital_po?.label, 'Hospital PO Number');
    console.log('✓ Test 3 Passed: Custom fields dynamically exposed in /api/orders/meta and /custom-fields\n');

    // 4. Raise an order with custom fields & verify validations
    console.log('[TEST 4] Raising order with custom field validation...');

    // 4A: Missing required custom field
    const failCreateRes = await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        customerName: 'Custom Field Hospital',
        contactNumber: '0917-555-6666',
        address: 'Quezon City Hospital',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Testing custom fields validation',
        items: [{ product: 'AtraGet 10mg', qty: 2, unitPrice: 250, priceType: 'hospital' }],
      }),
    });
    assert.strictEqual(failCreateRes.status, 400);
    const failJson = await failCreateRes.json();
    assert(failJson.error.includes('Hospital PO Number is required'), 'Expected required error, got: ' + failJson.error);
    console.log('✓ Test 4A Passed: Missing required custom field properly rejected with 400');

    // 4B: Successful order creation with valid custom field values
    const okCreateRes = await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        customerName: 'Custom Field Hospital',
        contactNumber: '0917-555-6666',
        address: 'Quezon City Hospital',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Testing custom fields validation',
        items: [{ product: 'AtraGet 10mg', qty: 2, unitPrice: 250, priceType: 'hospital' }],
        test_hospital_po: 'PO-2026-998877',
        test_cost_center: 'CC-101 (Oncology)',
        test_cold_chain_pack: 'Yes',
      }),
    });
    assert([200, 201, 202].includes(okCreateRes.status));
    const created = await okCreateRes.json();
    const orderId = created.order.id;
    assert.strictEqual(created.order.test_hospital_po, 'PO-2026-998877');
    assert.strictEqual(created.order.test_cost_center, 'CC-101 (Oncology)');
    assert.strictEqual(created.order.test_cold_chain_pack, 'Yes');
    console.log('✓ Test 4B Passed: Order ' + orderId + ' raised with custom fields persisted correctly\n');

    // 5. Test Management and Finance editing custom fields & audit logging
    console.log('[TEST 5] Testing Management and Finance editing custom fields...');
    
    // Management edits Hospital PO and Cold Chain
    const mgmtEditRes = await fetch(baseUrl + '/api/orders/' + orderId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: mgmtCookie },
      body: JSON.stringify({
        reason: 'Management corrected PO number after verification with procurement',
        test_hospital_po: 'PO-2026-998877-REVISED',
      }),
    });
    assert([200, 202].includes(mgmtEditRes.status));
    const mgmtEdited = await mgmtEditRes.json();
    assert.strictEqual(mgmtEdited.order.test_hospital_po, 'PO-2026-998877-REVISED');
    const lastMgmtEvent = mgmtEdited.order.events[mgmtEdited.order.events.length - 1];
    assert.strictEqual(lastMgmtEvent.label, 'Edited by Management');
    assert(lastMgmtEvent.details?.changed?.includes('Hospital PO Number'), 'Audit trail must record Hospital PO Number changed');
    console.log('✓ Test 5A Passed: Management successfully updated custom field with audit trail recording');

    // Finance edits Cost Center
    const finEditRes = await fetch(baseUrl + '/api/orders/' + orderId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: finCookie },
      body: JSON.stringify({
        reason: 'Finance reallocated department charge code to ICU',
        test_cost_center: 'CC-202 (ICU)',
      }),
    });
    assert([200, 202].includes(finEditRes.status));
    const finEdited = await finEditRes.json();
    assert.strictEqual(finEdited.order.test_cost_center, 'CC-202 (ICU)');
    const lastFinEvent = finEdited.order.events[finEdited.order.events.length - 1];
    assert.strictEqual(lastFinEvent.label, 'Edited by Finance');
    assert(lastFinEvent.details?.changed?.includes('Cost Center Code'), 'Audit trail must record Cost Center Code changed');
    console.log('✓ Test 5B Passed: Finance successfully updated custom field with audit trail recording\n');

    // 6. Test Field Updates & Active Toggle
    console.log('[TEST 6] Testing Field Updates and Active/Inactive toggle...');
    const updateRes = await fetch(baseUrl + '/api/orders/custom-fields/test_hospital_po', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        label: 'Hospital Procurement Reference',
        active: false,
      }),
    });
    assert.strictEqual(updateRes.status, 200);
    const updated = (await updateRes.json()).field;
    assert.strictEqual(updated.label, 'Hospital Procurement Reference');
    assert.strictEqual(updated.active, false);

    // Verify it is excluded from active fields on /meta
    const metaAfterDeactivate = await (await fetch(baseUrl + '/api/orders/meta', { headers: { Cookie: adminCookie } })).json();
    assert(!metaAfterDeactivate.orderFields.some((f) => f.name === 'test_hospital_po'), 'Deactivated field must not appear in active orderFields');
    console.log('✓ Test 6 Passed: Field successfully updated and deactivated from new forms\n');

    // 7. Test Field Deletion
    console.log('[TEST 7] Testing Custom Field Deletion...');
    for (const fid of ['test_hospital_po', 'test_cost_center', 'test_cold_chain_pack']) {
      const delRes = await fetch(baseUrl + '/api/orders/custom-fields/' + fid, {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      });
      assert.strictEqual(delRes.status, 200);
    }
    const listAfterDelete = await (await fetch(baseUrl + '/api/orders/custom-fields', { headers: { Cookie: adminCookie } })).json();
    assert(!listAfterDelete.fields.some((f) => f.id && f.id.startsWith('test_')), 'Test fields should be deleted');
    console.log('✓ Test 7 Passed: Custom fields cleanly removed from configuration\n');

    console.log('==============================================================');
    console.log('🌉 ALL CONFIGURABLE CUSTOM ORDER FIELDS TESTS PASSED 100%!');
    console.log('==============================================================');
    process.exit(0);
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
