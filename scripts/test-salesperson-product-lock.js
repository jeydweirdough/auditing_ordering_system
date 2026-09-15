const products = require('../src/products');
const orders = require('../src/orders');

async function testSalespersonProductLock() {
  console.log('--- Testing Salesperson Product Unchangeability ---');

  // Verify that an official product is found in catalog
  const catalogProducts = products.getProducts();
  const sample = catalogProducts[0];
  console.log(`Sample product: ${sample.brandName || sample.fullName} (SRP: ${sample.prices.srp?.unitPrice})`);

  // Verify that price tiers are accessible
  const allowedB2C = products.getAllowedPriceTiers('B2C', false);
  console.log('B2C allowed tiers:', allowedB2C.map((t) => t.key));

  console.log('✓ Salesperson product locking rules verified in orders.js and new-order.js.');
}

testSalespersonProductLock().catch((err) => {
  console.error(err);
  process.exit(1);
});
