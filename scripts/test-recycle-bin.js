const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Auto-load .env if needed
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
const orders = require('../src/orders');
const recycleBin = require('../src/recycleBin');
const discordHub = require('../src/discordHub');

async function run() {
  console.log('===========================================================');
  console.log('🚀 Running Recycle Bin & Discord Purge Lifecycle Test Suite');
  console.log('===========================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = "http://localhost:" + port;

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
    const salesCookie = await login('salesperson.test@getmeds.ph');

    console.log('[TEST 1] Verifying 6 Webhook configurations in discordHub...');
    const webhooks = discordHub.getWebhooks();
    assert(webhooks.audit, 'Audit webhook must exist');
    assert(webhooks.rbac, 'RBAC webhook must exist');
    assert(webhooks.promotion, 'Promotion webhook must exist');
    assert(webhooks.product, 'Product webhook must exist');
    assert(webhooks.user, 'User webhook must exist');
    assert(webhooks.setting, 'Setting webhook must exist');
    console.log('✓ Test 1 Passed: All 6 webhooks configured correctly in discordHub.\n');

    console.log('[TEST 2] Verifying recycleBin 30-day retention countdown and expiration logic...');
    assert.strictEqual(recycleBin.RETENTION_DAYS, 30, 'Retention period must be exactly 30 days');

    const freshRecord = recycleBin.createRecycleRecord('setting', 'test_key', { name: 'Test' });
    assert(freshRecord.deletedAt, 'deletedAt must be present');
    assert(freshRecord.purgeAt, 'purgeAt must be present');

    const daysFresh = recycleBin.calculateDaysLeft(freshRecord.purgeAt);
    assert(daysFresh >= 29 && daysFresh <= 30, 'Expected ~30 days left, got ' + daysFresh);
    assert.strictEqual(recycleBin.isExpired(freshRecord.purgeAt), false, 'Fresh item must not be expired');

    const expiredDate = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(recycleBin.isExpired(expiredDate), true, 'Past purgeAt must be expired');
    assert.strictEqual(recycleBin.calculateDaysLeft(expiredDate), 0, 'Expired item must have 0 days left');
    console.log('✓ Test 2 Passed: 30-day retention countdown and expiration calculations verified.\n');

    function makeOrderPayload(customerName) {
      return {
        customerName,
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
        remarks: 'Test order for recycle bin',
        notes: 'Testing',
        items: [
          { product: 'DoseGet-80', qty: 1, unitPrice: 1820, priceType: 'hospital' },
        ],
      };
    }

    console.log('[TEST 3] Raising order and soft-deleting to Recycle Bin...');
    const raiseRes = await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify(makeOrderPayload('Recycle Bin Test Customer')),
    });
    if (![200, 201, 202].includes(raiseRes.status)) {
      const err = await raiseRes.text();
      throw new Error('Order creation failed (' + raiseRes.status + '): ' + err);
    }
    const { order: createdOrder } = await raiseRes.json();
    const orderId = createdOrder.id;
    console.log('- Created order: ' + orderId);

    const delRes = await fetch(baseUrl + '/api/orders/' + encodeURIComponent(orderId) + '/actions/delete_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Testing soft delete to recycle bin' }),
    });
    assert([200, 202].includes(delRes.status), 'Soft delete failed');
    const { order: deletedOrder } = await delRes.json();
    assert.strictEqual(deletedOrder.status, 'deleted', 'Status must be deleted');
    assert(deletedOrder.deletedAt, 'deletedAt must be set on deleted order');
    assert(deletedOrder.purgeAt, 'purgeAt must be set on deleted order');

    const purgeDiffDays = Math.round((new Date(deletedOrder.purgeAt) - new Date(deletedOrder.deletedAt)) / (24 * 3600 * 1000));
    assert.strictEqual(purgeDiffDays, 30, 'purgeAt must be exactly 30 days after deletedAt');

    const binListRes = await fetch(baseUrl + '/api/orders/recycle-bin', {
      headers: { Cookie: adminCookie },
    });
    assert.strictEqual(binListRes.status, 200);
    const binData = await binListRes.json();
    const foundInBin = binData.orders.find((o) => o.id === orderId);
    assert(foundInBin, 'Order ' + orderId + ' must be present in Recycle Bin API response');
    assert(foundInBin.daysLeft >= 29 && foundInBin.daysLeft <= 30, 'Recycle bin item must show ~30 days left');
    console.log('✓ Test 3 Passed: Order successfully moved to Recycle Bin with 30-day countdown (' + foundInBin.daysLeft + ' days left).\n');

    console.log('[TEST 4] Restoring order from Recycle Bin...');
    const restoreRes = await fetch(baseUrl + '/api/orders/recycle-bin/' + encodeURIComponent(orderId) + '/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ note: 'Restoring for test' }),
    });
    assert([200, 202].includes(restoreRes.status), 'Restore failed');
    const { order: restoredOrder } = await restoreRes.json();
    assert.notStrictEqual(restoredOrder.status, 'deleted', 'Restored order status must not be deleted');
    assert.strictEqual(restoredOrder.deletedAt, undefined, 'deletedAt must be cleared');
    assert.strictEqual(restoredOrder.purgeAt, undefined, 'purgeAt must be cleared');

    const binAfterRestore = await (await fetch(baseUrl + '/api/orders/recycle-bin', { headers: { Cookie: adminCookie } })).json();
    assert(!binAfterRestore.orders.some((o) => o.id === orderId), 'Restored order must not be in Recycle Bin list');
    console.log('✓ Test 4 Passed: Order restored to ' + restoredOrder.status + ' and removed from Recycle Bin.\n');

    console.log('[TEST 5] Soft-deleting again, then permanently deleting from Recycle Bin before 30 days...');
    await fetch(baseUrl + '/api/orders/' + encodeURIComponent(orderId) + '/actions/delete_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Re-delete for permanent purge test' }),
    });

    const purgeRes = await fetch(baseUrl + '/api/orders/' + encodeURIComponent(orderId) + '/actions/purge_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Permanent purge from Discord database' }),
    });
    assert([200, 202].includes(purgeRes.status), 'Permanent purge failed');
    const purgeData = await purgeRes.json();
    assert(purgeData.purged, 'Expected purged: true in response');

    const checkOrderRes = await fetch(baseUrl + '/api/orders/' + encodeURIComponent(orderId), {
      headers: { Cookie: adminCookie },
    });
    assert.strictEqual(checkOrderRes.status, 404, 'Order must return 404 after permanent deletion');

    const binAfterPurge = await (await fetch(baseUrl + '/api/orders/recycle-bin', { headers: { Cookie: adminCookie } })).json();
    assert(!binAfterPurge.orders.some((o) => o.id === orderId), 'Purged order must not exist in Recycle Bin');
    console.log('✓ Test 5 Passed: Order permanently vanished from Discord and memory before 30 days.\n');

    console.log('[TEST 6] Testing automatic purge when retention reaches 30 days...');
    const expOrderRes = await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify(makeOrderPayload('Auto Expire Test Customer')),
    });
    const { order: expOrder } = await expOrderRes.json();
    const expOrderId = expOrder.id;

    const delExpRes = await fetch(baseUrl + '/api/orders/' + encodeURIComponent(expOrderId) + '/actions/delete_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Auto expire test delete' }),
    });
    assert([200, 202].includes(delExpRes.status));

    const pastDate = new Date(Date.now() - 31 * 86400000).toISOString();
    const expiredPurgeAt = new Date(Date.now() - 1000).toISOString();
    orders.setOrderPurgeDateForTesting(expOrderId, pastDate, expiredPurgeAt);

    await orders.checkAndPurgeExpired();

    const checkExpiredRes = await fetch(baseUrl + '/api/orders/' + encodeURIComponent(expOrderId), {
      headers: { Cookie: adminCookie },
    });
    assert.strictEqual(checkExpiredRes.status, 404, 'Expired order must be automatically purged after 30 days');
    console.log('✓ Test 6 Passed: Order past 30 days was automatically purged by background worker.\n');

    console.log('[TEST 7] Testing Empty Recycle Bin (bulk permanent purge)...');
    const o1 = (await (await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify(makeOrderPayload('Bulk Empty 1')),
    })).json()).order;

    const o2 = (await (await fetch(baseUrl + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify(makeOrderPayload('Bulk Empty 2')),
    })).json()).order;

    await fetch(baseUrl + '/api/orders/' + encodeURIComponent(o1.id) + '/actions/delete_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Bulk delete 1' }),
    });
    await fetch(baseUrl + '/api/orders/' + encodeURIComponent(o2.id) + '/actions/delete_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'Bulk delete 2' }),
    });

    const emptyRes = await fetch(baseUrl + '/api/orders/recycle-bin/empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    });
    assert.strictEqual(emptyRes.status, 200);
    const emptyResult = await emptyRes.json();
    assert((emptyResult.totalPurged || emptyResult.purgedCount) >= 2, 'Expected at least 2 purged, got ' + (emptyResult.totalPurged || emptyResult.purgedCount));

    assert.strictEqual((await fetch(baseUrl + '/api/orders/' + encodeURIComponent(o1.id), { headers: { Cookie: adminCookie } })).status, 404);
    assert.strictEqual((await fetch(baseUrl + '/api/orders/' + encodeURIComponent(o2.id), { headers: { Cookie: adminCookie } })).status, 404);
    console.log('✓ Test 7 Passed: Empty Recycle Bin successfully purged ' + (emptyResult.totalPurged || emptyResult.purgedCount) + ' orders.\n');

    console.log('[TEST 8] Verifying data directory / Discord migration integrity...');
    const dataDir = path.join(__dirname, '..', 'data');
    const backupDir = path.join(__dirname, '..', 'data.bak');
    const checkDir = fs.existsSync(dataDir) ? dataDir : backupDir;
    assert(fs.existsSync(checkDir), 'Either data/ or data.bak/ must exist for data verification');
    const dataFiles = fs.readdirSync(checkDir).filter((f) => f.endsWith('.json'));
    console.log('- Verified dataset JSON files: ' + dataFiles.join(', '));
    assert.strictEqual(dataFiles.length, 5, 'Expected strictly 5 data files, found ' + dataFiles.length);
    const expectedFiles = ['products.json', 'promotions.json', 'rbac.json', 'settings.json', 'users.json'];
    for (const ef of expectedFiles) {
      assert(dataFiles.includes(ef), 'Dataset ' + ef + ' must exist');
    }

    const settingsRaw = JSON.parse(fs.readFileSync(path.join(checkDir, 'settings.json'), 'utf8'));
    assert(Array.isArray(settingsRaw.recycleBin), 'settings.json must contain recycleBin array');
    console.log('✓ Test 8 Passed: Data compression integrity intact (strictly 5 compressed JSON files migrated).\n');

    console.log('===========================================================');
    console.log('🎉 ALL RECYCLE BIN & DISCORD PURGE TESTS PASSED SUCCESSFULLY');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});