const assert = require('assert');
const http = require('http');
const app = require('../src/server');
const configStore = require('../src/configStore');
const accounts = require('../src/accounts');

async function run() {
  console.log('--- Testing Promotions & Pricing Architecture ---');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Test 1: Promotions HTML Page and JS Script Delivery
    console.log('\n--- Test 1: Page & Asset Delivery ---');
    const pageRes = await fetch(`${baseUrl}/promotions`);
    assert.strictEqual(pageRes.status, 200, 'Page /promotions should return 200');
    const pageHtml = await pageRes.text();
    assert(pageHtml.includes('Promotions & Pricing'), 'Page must contain title');
    assert(pageHtml.includes('data-promo-tab="bundles"'), 'Page must contain bundles tab');
    assert(pageHtml.includes('data-promo-tab="promos"'), 'Page must contain promos tab');
    assert(pageHtml.includes('data-promo-tab="discounts"'), 'Page must contain discounts tab');
    assert(pageHtml.includes('id="bundle-dialog"'), 'Page must include bundle dialog');
    assert(pageHtml.includes('id="promo-dialog"'), 'Page must include promo dialog');
    assert(pageHtml.includes('id="discount-dialog"'), 'Page must include discount dialog');

    const jsRes = await fetch(`${baseUrl}/js/promotions.js`);
    assert.strictEqual(jsRes.status, 200, 'JS /js/promotions.js should return 200');
    const jsContent = await jsRes.text();
    assert(jsContent.includes('loadPromotionsData'), 'promotions.js must define loadPromotionsData');
    assert(jsContent.includes('renderBundlesTab'), 'promotions.js must define renderBundlesTab');
    assert(jsContent.includes('renderPromosTab'), 'promotions.js must define renderPromosTab');
    assert(jsContent.includes('renderDiscountsTab'), 'promotions.js must define renderDiscountsTab');
    console.log('✔ Test 1 Passed: Promotions HTML & JS properly delivered.');

    // Test 2: Auth Protection on Read Endpoint
    console.log('\n--- Test 2: Read Endpoint Authentication ---');
    const unauthGetRes = await fetch(`${baseUrl}/api/orders/promotions`);
    assert.strictEqual(unauthGetRes.status, 401, 'Unauthenticated GET /api/orders/promotions must return 401');

    // Create or use salesperson account
    let salesCookie;
    if (process.env.ACCOUNTS) {
      const salesLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'salesperson.test@getmeds.ph', password: 'passwordpass' }),
      });
      salesCookie = salesLogin.headers.get('set-cookie');
    } else {
      const salesEmail = `sales_${Date.now()}@getmeds.ph`;
      await accounts.createAccount({
        name: 'Sales Rep',
        email: salesEmail,
        role: 'salesperson',
        password: 'Password123!',
      });
      const salesLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: salesEmail, password: 'Password123!' }),
      });
      salesCookie = salesLogin.headers.get('set-cookie');
    }

    const authGetRes = await fetch(`${baseUrl}/api/orders/promotions`, {
      headers: { Cookie: salesCookie },
    });
    assert.strictEqual(authGetRes.status, 200);
    const getData = await authGetRes.json();
    assert.strictEqual(getData.ok, true);
    assert(Array.isArray(getData.promotions.bundles), 'bundles must be an array');
    assert(Array.isArray(getData.promotions.promos), 'promos must be an array');
    assert(Array.isArray(getData.promotions.discounts), 'discounts must be an array');
    console.log(`✔ Test 2 Passed: Authenticated read endpoint returned ${getData.promotions.bundles.length} bundles, ${getData.promotions.promos.length} promos, ${getData.promotions.discounts.length} discounts.`);

    // Test 3: Unauthenticated & Non-Admin Mutation Attempt
    console.log('\n--- Test 3: RBAC Protection (Unauthenticated & Non-Admin) ---');
    const unauthRes = await fetch(`${baseUrl}/api/orders/promotions/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacker Bundle', bundlePrice: 500 }),
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must be 401');

    // Non-admin salesperson tries to mutate
    const forbiddenRes = await fetch(`${baseUrl}/api/orders/promotions/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify({ name: 'Hacker Bundle', bundlePrice: 500 }),
    });
    assert.strictEqual(forbiddenRes.status, 403, 'Salesperson must receive 403 Forbidden for manage_settings');
    console.log('✔ Test 3 Passed: RBAC properly rejects unauthenticated and non-admin mutations.');

    // Test 4: Admin Mutations (Bundles, Promos, Discounts)
    console.log('\n--- Test 4: Admin CRUD Operations ---');
    // Create or use admin account
    let adminCookie;
    if (process.env.ACCOUNTS) {
      const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin.test@getmeds.ph', password: 'passwordpass' }),
      });
      adminCookie = adminLogin.headers.get('set-cookie');
    } else {
      const adminEmail = `admin_${Date.now()}@getmeds.ph`;
      await accounts.createAccount({
        name: 'Admin Boss',
        email: adminEmail,
        role: 'admin',
        password: 'AdminPassword123!',
      });
      const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail, password: 'AdminPassword123!' }),
      });
      adminCookie = adminLogin.headers.get('set-cookie');
    }

    // 4A: Bundle CRUD
    const newBundle = {
      name: 'Emergency Pack Test',
      code: 'BND-EMERG-TEST',
      description: 'First aid emergency package',
      bundlePrice: 850,
      items: [
        { name: 'Betadine 10%', qty: 2 },
        { name: 'Gauze Bandage 4x4', qty: 10 },
      ],
      active: true,
    };
    const createBndRes = await fetch(`${baseUrl}/api/orders/promotions/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(newBundle),
    });
    assert.strictEqual(createBndRes.status, 201);
    const bndData = await createBndRes.json();
    assert.strictEqual(bndData.ok, true);
    assert.strictEqual(bndData.bundle.name, 'Emergency Pack Test');
    const createdBndId = bndData.bundle.id;

    // Update Bundle
    const updateBndRes = await fetch(`${baseUrl}/api/orders/promotions/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ ...bndData.bundle, bundlePrice: 900 }),
    });
    assert.strictEqual(updateBndRes.status, 200);
    const updatedBnd = await updateBndRes.json();
    assert.strictEqual(updatedBnd.bundle.bundlePrice, 900);

    // Delete Bundle
    const delBndRes = await fetch(`${baseUrl}/api/orders/promotions/bundle/${createdBndId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    });
    assert.strictEqual(delBndRes.status, 200);
    const afterDelBnd = await delBndRes.json();
    assert(!afterDelBnd.promotions.bundles.some((b) => b.id === createdBndId), 'Bundle should be deleted');
    console.log('✔ Test 4A Passed: Admin Bundle CRUD verified.');

    // 4B: Promo CRUD
    const newPromo = {
      name: 'Christmas Special Test',
      code: 'XMAS2026',
      description: 'Holiday medicine discount drive',
      startDate: '2026-12-01',
      endDate: '2026-12-31',
      tag: 'Holiday Special',
      active: true,
    };
    const createPrmRes = await fetch(`${baseUrl}/api/orders/promotions/promo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(newPromo),
    });
    assert.strictEqual(createPrmRes.status, 201);
    const prmData = await createPrmRes.json();
    const createdPrmId = prmData.promo.id;

    // Delete Promo
    const delPrmRes = await fetch(`${baseUrl}/api/orders/promotions/promo/${createdPrmId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    });
    assert.strictEqual(delPrmRes.status, 200);
    const afterDelPrm = await delPrmRes.json();
    assert(!afterDelPrm.promotions.promos.some((p) => p.id === createdPrmId), 'Promo should be deleted');
    console.log('✔ Test 4B Passed: Admin Promo Campaign CRUD verified.');

    // 4C: Discount CRUD
    const newDiscount = {
      name: 'Clinic Partnership 8%',
      code: 'CLINIC8',
      type: 'percentage',
      value: 8,
      minSpend: 5000,
      description: 'Accredited clinic orders',
      active: true,
    };
    const createDscRes = await fetch(`${baseUrl}/api/orders/promotions/discount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(newDiscount),
    });
    assert.strictEqual(createDscRes.status, 201);
    const dscData = await createDscRes.json();
    const createdDscId = dscData.discount.id;

    // Delete Discount
    const delDscRes = await fetch(`${baseUrl}/api/orders/promotions/discount/${createdDscId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    });
    assert.strictEqual(delDscRes.status, 200);
    const afterDelDsc = await delDscRes.json();
    assert(!afterDelDsc.promotions.discounts.some((d) => d.id === createdDscId), 'Discount should be deleted');
    console.log('✔ Test 4C Passed: Admin Discount Rules CRUD verified.');

    console.log('\n=============================================');
    console.log('ALL PROMOTIONS & PRICING TESTS PASSED 100%!');
    console.log('=============================================');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
