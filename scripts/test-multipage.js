const http = require('http');
const app = require('../src/server');

async function run() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  console.log(`Testing server running at ${baseUrl}`);

  async function check(url, expectedStatus, expectedContent, checkRedirect = null) {
    const res = await fetch(`${baseUrl}${url}`, { redirect: 'manual' });
    if (checkRedirect) {
      if (res.status !== 302) {
        throw new Error(`Expected redirect 302 for ${url}, got ${res.status}`);
      }
      const loc = res.headers.get('location');
      if (loc !== checkRedirect) {
        throw new Error(`Expected redirect to ${checkRedirect} for ${url}, got ${loc}`);
      }
      console.log(`✔ ${url} -> 302 redirect to ${loc}`);
      return;
    }

    if (res.status !== expectedStatus) {
      throw new Error(`Expected ${expectedStatus} for ${url}, got ${res.status}`);
    }
    const text = await res.text();
    if (expectedContent && !text.includes(expectedContent)) {
      throw new Error(`Expected content "${expectedContent}" not found in ${url}`);
    }
    console.log(`✔ ${url} -> ${res.status} (contains "${expectedContent}")`);
  }

  try {
    // Check page routes
    await check('/login', 200, 'id="login-form"');
    await check('/dashboard', 200, 'id="dashboard-content"');
    await check('/orders', 200, 'id="tabs"');
    await check('/order', 200, 'id="side"');
    await check('/new-order', 200, 'id="side"');
    await check('/people', 200, 'id="people-content"');
    await check('/settings', 200, 'id="settings-content"');
    await check('/promotions', 200, 'id="promotions-content"');

    // Check static asset routes
    await check('/css/common.css', 200, '--ground:');
    await check('/css/common.css', 200, 'btn-sidebar-new-order');
    await check('/css/common.css', 200, 'user-dropdown-menu');
    await check('/js/shared.js', 200, 'ensureAuth');
    await check('/js/shared.js', 200, 'sidebar-new-order-btn');
    await check('/js/shared.js', 200, 'sidebar-user-dropdown');
    await check('/js/dashboard.js', 200, 'loadDashboard');
    await check('/js/orders.js', 200, 'TABS');
    await check('/js/promotions.js', 200, 'loadPromotionsData');

    // Verify orders.js does not contain dashboard tab in TABS
    const ordersJsRes = await fetch(`${baseUrl}/js/orders.js`);
    const ordersJsText = await ordersJsRes.text();
    if (ordersJsText.includes("key: 'dashboard'")) {
      throw new Error("orders.js TABS should not include redundant dashboard tab!");
    }
    console.log("✔ /js/orders.js -> Verified no redundant dashboard tab in TABS");

    await check('/js/order.js', 200, 'loadOrder');
    await check('/js/new-order.js', 200, 'submitOrder');
    await check('/js/people.js', 200, 'renderPeopleView');
    await check('/js/settings.js', 200, 'renderCurrentTab');

    // Verify dashboard.html does not contain redundant Back to orders
    const dashRes = await fetch(`${baseUrl}/dashboard`);
    const dashText = await dashRes.text();
    if (dashText.includes('Back to orders')) {
      throw new Error("dashboard.html should not contain redundant 'Back to orders' button!");
    }
    console.log("✔ /dashboard -> Verified no 'Back to orders' button");

    // Check redirects to main screen
    await check('/', 302, null, '/dashboard');
    await check('/app', 302, null, '/dashboard');

    // Verify shared.js does not have missing .join('') bug on initials
    const sharedJsRes = await fetch(`${baseUrl}/js/shared.js`);
    const sharedJsText = await sharedJsRes.text();
    if (sharedJsText.includes('.slice(0, 2).toUpperCase()')) {
      throw new Error("shared.js contains invalid .slice(0, 2).toUpperCase() without .join('')!");
    }
    console.log("✔ /js/shared.js -> Verified initials .join('').toUpperCase() syntax integrity");

    console.log('\nAll multi-page route tests PASSED successfully!');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
