const assert = require('assert');
const products = require('../src/products');

console.log('--- Running Constraint & Database Tests ---\n');

// 1. Verify Products Database
const list = products.getProducts();
console.log(`[TEST 1] Products count: ${list.length}`);
assert.strictEqual(list.length, 99, 'Should have 99 products');

const doseget = list.find((p) => p.brandName === 'DoseGet-80');
assert(doseget, 'DoseGet-80 should exist');
assert.strictEqual(doseget.classification, 'ONCOLOGY');
assert.strictEqual(doseget.prices.doctor.unitPrice, 4500);
assert.strictEqual(doseget.prices.doctor.note, '+1 IV set');
assert.strictEqual(doseget.prices.srp.unitPrice, 10800);
console.log('✓ Test 1 Passed: Products database integrity verified.\n');

// 2. Verify Division & Sub-division Mapping
console.log('[TEST 2] Verifying Division & Sub-division database mappings...');
assert.deepStrictEqual(products.SUB_DIVISIONS['B2C'], ['MD Telesales']);
assert.deepStrictEqual(products.SUB_DIVISIONS['STC'], ['MD Telesales']);
assert.deepStrictEqual(products.SUB_DIVISIONS['URO'], ['MD Telesales']);
assert.deepStrictEqual(products.SUB_DIVISIONS['B&B'], ['MD Telesales']);
assert.deepStrictEqual(products.SUB_DIVISIONS['B2B'], ['NBD', 'CRR']);
assert.deepStrictEqual(products.SUB_DIVISIONS['HOS'], ['Hospital', 'Telesales']);
assert.deepStrictEqual(products.SUB_DIVISIONS['BID'], ['Bidding']);
console.log('✓ Test 2 Passed: Division & Subdivision mappings match specification.\n');

// 3. Test B2C Pricing Constraints
console.log('[TEST 3] Testing B2C Constraints...');
// B2C with patient price (valid)
let err = products.validateOrderConstraints({
  division: 'B2C',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 425, priceType: 'patient' }],
});
assert.strictEqual(err, null, 'B2C with patient price should be valid');

// B2C with SRP (valid)
err = products.validateOrderConstraints({
  division: 'B2C',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 531.25, priceType: 'srp' }],
});
assert.strictEqual(err, null, 'B2C with SRP should be valid');

// B2C with Doctor price and NO Rx (invalid)
err = products.validateOrderConstraints({
  division: 'B2C',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 375, priceType: 'doctor' }],
});
assert(err && err.includes('Prescription / Rx'), `Expected prescription error, got: ${err}`);

// B2C with Doctor price and WITH Rx (valid)
err = products.validateOrderConstraints(
  {
    division: 'B2C',
    items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 375, priceType: 'doctor' }],
  },
  [{ kind: 'prescription' }]
);
assert.strictEqual(err, null, 'B2C with Doctor price and prescription should be valid');

// B2C with prescription and patient price (invalid - must have Doctor's price)
err = products.validateOrderConstraints(
  {
    division: 'B2C',
    items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 425, priceType: 'patient' }],
  },
  [{ kind: 'prescription' }]
);
assert(err && err.includes('must have Doctor\'s Price'), `Expected doctor price enforcement with Rx, got: ${err}`);

// B2C with unauthorized tier (e.g. hospital or distributor) (invalid)
err = products.validateOrderConstraints({
  division: 'B2C',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 250, priceType: 'hospital' }],
});
assert(err && err.includes('B2C only allows'), `Expected B2C unauthorized tier rejection, got: ${err}`);
console.log('✓ Test 3 Passed: B2C constraints (patient, SRP, doctor with Rx) verified.\n');

// 4. Test HOS, STC, B2B, BID Constraints
console.log('[TEST 4] Testing HOS, STC, B2B, and BID Pricing Constraints...');
// HOS allows hospital, patient, doctor, srp
for (const tier of ['hospital', 'patient', 'doctor', 'srp']) {
  err = products.validateOrderConstraints({
    division: 'HOS',
    items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 100, priceType: tier }],
  });
  assert.strictEqual(err, null, `HOS should allow tier ${tier}`);
}

// STC allows patient, doctor, srp (rejects hospital)
for (const tier of ['patient', 'doctor', 'srp']) {
  err = products.validateOrderConstraints({
    division: 'STC',
    items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 100, priceType: tier }],
  });
  assert.strictEqual(err, null, `STC should allow tier ${tier}`);
}
err = products.validateOrderConstraints({
  division: 'STC',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 100, priceType: 'hospital' }],
});
assert(err && err.includes('STC only allows'), `Expected STC tier rejection, got: ${err}`);

// B2B allows SRP and distributor (rejects doctor)
for (const tier of ['srp', 'distributor']) {
  err = products.validateOrderConstraints({
    division: 'B2B',
    items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 100, priceType: tier }],
  });
  assert.strictEqual(err, null, `B2B should allow tier ${tier}`);
}
err = products.validateOrderConstraints({
  division: 'B2B',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 100, priceType: 'doctor' }],
});
assert(err && err.includes('B2B only allows'), `Expected B2B tier rejection, got: ${err}`);

// BID: requires notes or remarks
err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'Custom Product', qty: 1, unitPrice: 500, priceType: 'bid' }],
  notes: '',
  remarks: '',
});
assert(err && err.includes('Division BID has no price list'), `Expected BID notes error, got: ${err}`);

err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'Custom Product', qty: 1, unitPrice: 500, priceType: 'bid' }],
  notes: 'Bid tender price agreed with procurement committee.',
});
assert.strictEqual(err, null, 'BID with notes should be valid');
console.log('✓ Test 4 Passed: HOS, STC, B2B, and BID constraints verified.\n');

// 5. Test Special Price and Government Price notes requirement in BID
console.log('[TEST 5] Testing Special Price and Government Price notes requirement...');
err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'special' }],
  notes: '',
});
assert(err && err.includes('Special Price requires an explanation in the Notes field'), `Expected special price notes error, got: ${err}`);

err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'special' }],
  notes: 'Discount authorized by VP of Sales for bulk purchase.',
});
assert.strictEqual(err, null, 'Special price with notes should be valid');

err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'government' }],
  notes: '',
});
assert(err && err.includes('Government Price requires an explanation in the Notes field'), `Expected government price notes error, got: ${err}`);

err = products.validateOrderConstraints({
  division: 'BID',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'government' }],
  notes: 'Government DOH procurement.',
});
assert.strictEqual(err, null, 'Government price with notes should be valid');

// Verify that other divisions strictly reject special price when customer does NOT have special price
err = products.validateOrderConstraints({
  division: 'HOS',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'special' }],
  notes: 'Notes provided',
});
assert(err && err.includes('not eligible for Special Price'), `Expected customer not eligible error, got: ${err}`);

// Verify that other divisions allow special price when customer DOES have special price
err = products.validateOrderConstraints({
  division: 'HOS',
  customerHasSpecialPrice: true,
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'special' }],
  notes: 'Special discount approved for hospital key account.',
});
assert.strictEqual(err, null, 'HOS with customer special price eligibility and notes should be valid');

// Special price with customerHasSpecialPrice but missing notes/remarks (invalid)
err = products.validateOrderConstraints({
  division: 'HOS',
  customerHasSpecialPrice: true,
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'special' }],
  notes: '',
});
assert(err && err.includes('Special Price requires an explanation in the Notes field'), `Expected missing notes error, got: ${err}`);

err = products.validateOrderConstraints({
  division: 'B2B',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 200, priceType: 'government' }],
  notes: 'Notes provided',
});
assert(err && err.includes('B2B only allows'), `Expected B2B rejection of government price, got: ${err}`);
console.log('✓ Test 5 Passed: Special and Government price notes constraint, customer eligibility, and division strictness verified.\n');

// 6. Test DSWD and PCSO Guarantee Letter constraint
console.log('[TEST 6] Testing DSWD and PCSO Guarantee Letter constraint...');
// Non-B2B with DSWD/PCSO and NO guarantee letter (invalid)
err = products.validateOrderConstraints({
  division: 'B2C',
  paymentTerms: 'DSWD/PCSO',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 425, priceType: 'patient' }],
}, []);
assert(err && err.includes('require a Guarantee Letter'), `Expected guarantee letter error on B2C, got: ${err}`);

err = products.validateOrderConstraints({
  division: 'HOS',
  paymentTerms: 'DSWD/PCSO',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 250, priceType: 'hospital' }],
}, [{ kind: 'payment_proof' }]);
assert(err && err.includes('require a Guarantee Letter'), `Expected guarantee letter error on HOS, got: ${err}`);

// Non-B2B with DSWD/PCSO and WITH guarantee letter (valid)
err = products.validateOrderConstraints({
  division: 'HOS',
  paymentTerms: 'DSWD/PCSO',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 250, priceType: 'hospital' }],
}, [{ kind: 'guarantee_letter' }]);
assert.strictEqual(err, null, 'HOS with guarantee letter should be valid');

// B2B with DSWD/PCSO does NOT require guarantee letter
err = products.validateOrderConstraints({
  division: 'B2B',
  paymentTerms: 'DSWD/PCSO',
  items: [{ product: 'AtraGet 10mg', qty: 1, unitPrice: 531.25, priceType: 'srp' }],
}, []);
assert.strictEqual(err, null, 'B2B should NOT require guarantee letter even with DSWD/PCSO');
console.log('✓ Test 6 Passed: DSWD/PCSO Guarantee letter constraint verified (applicable to all except B2B).\n');

console.log('=======================================');
console.log('ALL TESTS PASSED SUCCESSFULLY! (6/6)');
console.log('=======================================');
