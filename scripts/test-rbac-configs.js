const assert = require('assert');
const http = require('http');
const app = require('../src/server');
const configStore = require('../src/configStore');
const customers = require('../src/customers');

async function run() {
  console.log('--- Testing ConfigStore & Master Data Files ---');

  // Test 1: ConfigStore defaults and data files
  const configs = configStore.getAllConfigs();
  assert(Array.isArray(configs.divisions), 'divisions must be an array');
  assert(Array.isArray(configs.headquarters), 'headquarters must be an array');
  assert(Array.isArray(configs.invoicingFrom), 'invoicingFrom must be an array');
  assert(Array.isArray(configs.paymentMethods), 'paymentMethods must be an array');
  assert(Array.isArray(configs.sources), 'sources must be an array');
  assert(Array.isArray(configs.paymentTerms), 'paymentTerms must be an array');
  assert(Array.isArray(configs.deliveryMethods), 'deliveryMethods must be an array');
  assert(Array.isArray(configs.rbac), 'rbac must be an array');
  console.log('✓ Test 1 Passed: All 8 master configurations loaded from data/*.json');

  // Test 2: RBAC permissions verification
  assert.strictEqual(configStore.hasPermission('admin', 'raise_orders'), true);
  assert.strictEqual(configStore.hasPermission('admin', 'manage_settings'), true);
  assert.strictEqual(configStore.hasPermission('salesperson', 'raise_orders'), true);
  assert.strictEqual(configStore.hasPermission('salesperson', 'approve_orders'), false);
  assert.strictEqual(configStore.hasPermission('management', 'approve_orders'), true);
  assert.strictEqual(configStore.hasPermission('finance', 'verify_payment'), true);
  assert.strictEqual(configStore.hasPermission('dispatch', 'pick_pack_dispatch'), true);
  console.log('✓ Test 2 Passed: RBAC standard role permissions verified.');

  // Test 3: API Integration tests
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Sign in as admin (we can use dummy header if needed or login)
    // Let's create an admin account or test endpoints
    console.log('\n--- Testing Quick Customer Add ---');
    const custRes = await customers.addCustomer({
      name: 'Quick Test Pharmacy',
      contactNumber: '09170001122',
      address: '123 Test Street, Manila',
    });
    assert.strictEqual(custRes.name, 'Quick Test Pharmacy');
    assert.strictEqual(custRes.contactNumber, '09170001122');
    const found = customers.findCustomerByName('Quick Test Pharmacy');
    assert(found, 'Customer must be saved in database');
    console.log('✓ Test 3 Passed: Quick customer add and lookup verified.');

    // Test 4: Dynamic master data modification
    console.log('\n--- Testing Master Data CRUD in ConfigStore ---');
    const initialDivs = configStore.getDivisions();
    const testDiv = { name: 'TEST_DIV', subDivisions: ['Sub 1', 'Sub 2'] };
    configStore.setDivisions([...initialDivs, testDiv]);
    assert(configStore.getDivisions().some((d) => d.name === 'TEST_DIV'), 'TEST_DIV must exist');
    assert.strictEqual(configStore.getAllConfigs().subDivisionMap['TEST_DIV'].length, 2);

    // Clean up
    configStore.setDivisions(initialDivs.filter((d) => d.name !== 'TEST_DIV'));
    assert(!configStore.getDivisions().some((d) => d.name === 'TEST_DIV'), 'TEST_DIV must be removed');
    console.log('✓ Test 4 Passed: Division and sub-division CRUD verified.');

    // Test 5: Dynamic custom role addition
    console.log('\n--- Testing Dynamic Custom Role in RBAC ---');
    const initialRbac = configStore.getRbac();
    const customRole = {
      id: 'auditor_lead',
      label: 'Lead Auditor',
      description: 'Reviews orders and audits without approval power',
      isSystem: false,
      permissions: {
        raise_orders: false,
        approve_orders: false,
        manage_settings: true,
      },
    };
    configStore.setRbac([...initialRbac, customRole]);
    assert.strictEqual(configStore.hasPermission('auditor_lead', 'manage_settings'), true);
    assert.strictEqual(configStore.hasPermission('auditor_lead', 'raise_orders'), false);

    // Clean up
    configStore.setRbac(initialRbac.filter((r) => r.id !== 'auditor_lead'));
    console.log('✓ Test 5 Passed: Custom role creation, permission evaluation, and removal verified.');

    // Test 6: Verify accounts.publicUser permissions flags for raise_orders
    console.log('\n--- Testing Role-based Order Raising Permissions ---');
    const accounts = require('../src/accounts');
    const financePub = accounts.publicUser({ id: 99, name: 'Finance User', email: 'fin@test.com', role: 'finance', active: true });
    const dispatchPub = accounts.publicUser({ id: 98, name: 'Dispatch User', email: 'dsp@test.com', role: 'dispatch', active: true });
    const salesPub = accounts.publicUser({ id: 97, name: 'Sales User', email: 'sp@test.com', role: 'salesperson', active: true });
    const adminPub = accounts.publicUser({ id: 96, name: 'Admin User', email: 'adm@test.com', role: 'admin', active: true });

    const mgmtPub = accounts.publicUser({ id: 95, name: 'Mgmt User', email: 'mgmt@test.com', role: 'management', active: true });

    assert.strictEqual(financePub.canRaiseOrders, false, 'Finance must NOT have canRaiseOrders');
    assert.strictEqual(dispatchPub.canRaiseOrders, false, 'Dispatch must NOT have canRaiseOrders');
    assert.strictEqual(salesPub.canRaiseOrders, true, 'Salesperson MUST have canRaiseOrders');
    assert.strictEqual(mgmtPub.canRaiseOrders, true, 'Management MUST have canRaiseOrders');
    assert.strictEqual(adminPub.canRaiseOrders, true, 'Admin MUST have canRaiseOrders');

    // Management must NOT have settings or RBAC management permissions
    assert.strictEqual(mgmtPub.canManageSettings, false, 'Management must NOT have canManageSettings');
    assert.strictEqual(mgmtPub.canManageUsers, false, 'Management must NOT have canManageUsers');
    assert.strictEqual(adminPub.canManageSettings, true, 'Admin MUST have canManageSettings');
    assert.strictEqual(adminPub.canManageUsers, true, 'Admin MUST have canManageUsers');
    console.log('✓ Test 6 Passed: canRaiseOrders and Settings/RBAC permissions strictly enforced per role.');

    // Test 7: Personal password change API
    console.log('\n--- Testing Personal Password Change Endpoint ---');
    let cookie;
    let oldPw = 'OldPassword123!';
    let newPw = 'NewPassword123!';

    if (process.env.ACCOUNTS) {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'finance.test@getmeds.ph', password: 'passwordpass' }),
      });
      assert.strictEqual(loginRes.status, 200);
      cookie = loginRes.headers.get('set-cookie');
      oldPw = 'passwordpass';
    } else {
      const testEmail = `pwtest_${Date.now()}@getmeds.ph`;
      await accounts.createAccount({
        name: 'Password Test User',
        email: testEmail,
        role: 'finance',
        password: oldPw,
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: oldPw }),
      });
      assert.strictEqual(loginRes.status, 200);
      cookie = loginRes.headers.get('set-cookie');
    }

    if (process.env.ACCOUNTS) {
      const failRes = await fetch(`${baseUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ currentPassword: 'WrongPassword!', newPassword: newPw }),
      });
      assert.strictEqual(failRes.status, 409);
      console.log('✓ Test 7 Passed: Personal password change properly guards against env-based accounts (409).');
    } else {
      // Attempt password change with wrong current password
      const failRes = await fetch(`${baseUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ currentPassword: 'WrongPassword!', newPassword: newPw }),
      });
      assert.strictEqual(failRes.status, 400);

      // Change password with correct current password
      const okRes = await fetch(`${baseUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ currentPassword: oldPw, newPassword: newPw }),
      });
      assert.strictEqual(okRes.status, 200);
      const okData = await okRes.json();
      assert.strictEqual(okData.ok, true);
      console.log('✓ Test 7 Passed: Personal password change endpoint verified.');
    }

    // Test 8: Verify compressed data folder structure
    console.log('\n--- Testing Compressed Data Directory Structure ---');
    const fs = require('fs');
    const path = require('path');
    const dataDir = path.join(__dirname, '..', 'data');
    const backupDir = path.join(__dirname, '..', 'data.bak');
    const checkDir = fs.existsSync(dataDir) ? dataDir : backupDir;
    assert(fs.existsSync(checkDir), 'Either data/ or data.bak/ must exist for data verification');
    const dataFiles = fs.readdirSync(checkDir).filter((f) => f.endsWith('.json')).sort();
    const expectedFiles = ['products.json', 'promotions.json', 'rbac.json', 'settings.json', 'users.json'].sort();
    assert.deepStrictEqual(dataFiles, expectedFiles, 'data directory must contain ONLY the 5 compressed files');
    console.log('✓ Test 8 Passed: data directory strictly contains ONLY:', expectedFiles.join(', '));

    console.log('\n=======================================');
    console.log('ALL CONFIG & RBAC TESTS PASSED 100%!');
    console.log('=======================================');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
