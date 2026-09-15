'use strict';

const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/server');

async function run() {
  console.log('===============================================================');
  console.log('🚀 Testing Dispatch Dashboard Backend & Data Figures');
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
    const dispatchCookie = await login('dispatch.test@getmeds.ph');

    // 1. Request Dispatch Dashboard
    console.log('[TEST 1] Fetching Dispatch dashboard via GET /api/orders/dashboard...');
    const dashRes = await fetch(baseUrl + '/api/orders/dashboard?period=month', {
      headers: { Cookie: dispatchCookie },
    });
    assert.strictEqual(dashRes.status, 200, 'Expected 200 OK for dispatch dashboard, got: ' + dashRes.status);
    const dash = await dashRes.json();

    assert.strictEqual(dash.role, 'dispatch', 'Dashboard role should be dispatch');
    assert(dash.pipeline, 'Dashboard must contain pipeline');
    assert('ready' in dash.pipeline, 'Pipeline must have ready count');
    assert('picking' in dash.pipeline, 'Pipeline must have picking count');
    assert('packed' in dash.pipeline, 'Pipeline must have packed count');
    assert('dispatched' in dash.pipeline, 'Pipeline must have dispatched count');
    assert(dash.fulfillment, 'Dashboard must contain fulfillment stats');
    assert(Array.isArray(dash.couriers), 'Dashboard must contain couriers breakdown');
    assert(Array.isArray(dash.urgent), 'Dashboard must contain urgent dispatch orders');

    console.log('✓ Test 1 Passed: Dispatch dashboard successfully returned full pipeline and fulfillment stats.\n');

    // 2. Test different period scopes
    console.log('[TEST 2] Testing period filters (all, 90d, last_month)...');
    for (const p of ['all', '90d', 'last_month']) {
      const pRes = await fetch(baseUrl + `/api/orders/dashboard?period=${p}`, {
        headers: { Cookie: dispatchCookie },
      });
      assert.strictEqual(pRes.status, 200);
      const pData = await pRes.json();
      assert.strictEqual(pData.period.key, p);
    }
    console.log('✓ Test 2 Passed: All period scopes for Dispatch dashboard operate correctly.\n');

    console.log('===============================================================');
    console.log('🎉 DISPATCH DASHBOARD TESTS PASSED 100%!');
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
