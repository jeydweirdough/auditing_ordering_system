// Fills a LOCAL database with enough to try every step: one account per role,
// a few customers (some already in Zoho), products that are Zoho items, and the
// price list linked to them. Refuses to run against anything but this machine.
//
//   node scripts/dev-db.js &            (a local Postgres)
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres?sslmode=disable npm run migrate
//   DATABASE_URL=… node scripts/seed-dev.js
//
// The two salespeople carry Salesperson names the mock Zoho (ZOHO_MODE=mock) knows.
// Every account's password is "orders-dev-1" (change DEV_PASSWORD to pick another).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PASSWORD = process.env.DEV_PASSWORD || 'orders-dev-1';

const USERS = [
  { email: 'admin@dev.local', name: 'Ada Admin', role: 'admin' },
  { email: 'manager@dev.local', name: 'Mara Manager', role: 'management' },
  { email: 'leader@dev.local', name: 'Leo Leader', role: 'team_lead' },
  { email: 'sales@dev.local', name: 'Sam Sales', role: 'medrep', lead: 'leader@dev.local', salesperson: 'NORTH | Juan dela Cruz', division: 'B2C' },
  { email: 'sales2@dev.local', name: 'Sol Sales', role: 'medrep', salesperson: 'NORTH | Maria Santos', division: 'HOS' },
  { email: 'finance@dev.local', name: 'Fe Finance', role: 'finance' },
  { email: 'dispatch@dev.local', name: 'Dino Dispatch', role: 'dispatch' },
];

const CUSTOMERS = [
  { name: 'Juan Dela Cruz', type: 'direct', contact: '0917 555 0101', address: '12 Mabini St, Quezon City', zoho: 'ZC-1001' },
  { name: 'St. Luke Pharmacy', type: 'credit', contact: '02 8123 4567', address: '279 E Rodriguez Sr Ave, QC', zoho: 'ZC-1002' },
  { name: 'Maria Santos', type: 'direct', contact: '0918 555 0202', address: '45 Rizal Ave, Manila', zoho: 'ZC-1003' },
];

// When there is no price-list backup on this machine, three sample entries.
const SAMPLE_CATALOG = [
  { id: 'paracetamol-500', genericName: 'Paracetamol', brandName: 'Paracet 500mg', fullName: 'Paracet 500mg (Paracetamol) - BOX OF 100', unit: 'Tablet', count: 100,
    prices: { doctor: { unitPrice: 4, packPrice: 400 }, patient: { unitPrice: 5, packPrice: 500 }, srp: { unitPrice: 6, packPrice: 600 }, distributor: { unitPrice: 3, packPrice: 300 }, hospital: { unitPrice: 3.5, packPrice: 350 } } },
  { id: 'amoxicillin-500', genericName: 'Amoxicillin', brandName: 'Amoxi 500mg', fullName: 'Amoxi 500mg (Amoxicillin) - BOX OF 100', unit: 'Capsule', count: 100,
    prices: { doctor: { unitPrice: 9, packPrice: 900 }, patient: { unitPrice: 11, packPrice: 1100 }, srp: { unitPrice: 12, packPrice: 1200 }, distributor: { unitPrice: 7, packPrice: 700 }, hospital: { unitPrice: 8, packPrice: 800 } } },
  { id: 'atraget-10mg', genericName: 'Atracurium', brandName: 'AtraGet 10mg', fullName: "AtraGet 10mg (Atracurium) 10mg - PACK OF 5'S", unit: 'Ampoule', count: 5,
    prices: { doctor: { unitPrice: 375, packPrice: 1875 }, patient: { unitPrice: 425, packPrice: 2125 }, srp: { unitPrice: 531.25, packPrice: 2656.25 }, distributor: { unitPrice: 190, packPrice: 950 }, hospital: { unitPrice: 250, packPrice: 1250 } } },
];

function loadCatalog() {
  try {
    return require('../data.bak/products.json');
  } catch {
    return SAMPLE_CATALOG;
  }
}

async function seed(url = process.env.DATABASE_URL, { quiet = false } = {}) {
  if (!url || !/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error('seed-dev only runs against a database on this machine (127.0.0.1 / localhost).');
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  const q = (sql, params) => pool.query(sql, params);
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(PASSWORD, 10);
  try {
    const ids = {};
    for (const u of USERS) {
      const { rows } = await q(
        `INSERT INTO users (name, email, password_hash, role, is_active, approval_status, salesperson, division, created_at)
         VALUES ($1, $2, $3, $4, 1, 'approved', $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [u.name, u.email, hash, u.role, u.salesperson || null, u.division || null, now],
      );
      ids[u.email] = rows[0].id;
    }
    for (const u of USERS.filter((x) => x.lead)) {
      await q('UPDATE users SET team_lead_id = $1 WHERE id = $2', [ids[u.lead], ids[u.email]]);
    }
    for (const c of CUSTOMERS) {
      await q(
        `INSERT INTO customers (name, type, contact_number, address, zoho_contact_id, source, zoho_sync_status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'zoho', 'synced', $6)
         ON CONFLICT (zoho_contact_id) WHERE zoho_contact_id IS NOT NULL DO NOTHING`,
        [c.name, c.type, c.contact, c.address, c.zoho, now],
      );
    }
    // Each price-list entry becomes a Zoho item (products row), and is linked to it.
    const catalog = loadCatalog();
    for (const [i, p] of catalog.entries()) {
      const sku = `SKU-${String(p.id).toUpperCase()}`.slice(0, 60);
      const { rows } = await q(
        `INSERT INTO products (name, sku, unit_price, unit, stock, zoho_item_id, tax_name, tax_percentage, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'VAT', 12, 1)
         ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [p.fullName || p.brandName, sku, p.prices?.srp?.unitPrice ?? 0, p.unit || 'pc', 500, `ZI-${1000 + i}`],
      );
      p.productId = rows[0].id;
    }
    await q(
      `INSERT INTO app_config (table_name, row_id, data) VALUES ('catalog', 'products', $1::jsonb)
       ON CONFLICT (table_name, row_id) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(catalog)],
    );
    if (!quiet) {
      console.log(`Seeded ${USERS.length} accounts (password "${PASSWORD}"), ${CUSTOMERS.length} customers, ${catalog.length} products.`);
      for (const u of USERS) console.log(`  ${u.role.padEnd(10)} ${u.email}`);
    }
    return { userIds: ids, catalog };
  } finally {
    await pool.end();
  }
}

module.exports = { seed, USERS, CUSTOMERS, PASSWORD };

if (require.main === module) {
  seed().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
