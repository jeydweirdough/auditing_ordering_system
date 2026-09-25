// The price list: each product with its five price tiers (doctor, patient,
// SRP, distributor, hospital), by unit and by pack. Kept in the database
// (app_config, table "catalog", row "products"); until Sep 25, 2026 it was a
// Discord thread.
//
// Each entry may carry `productId`, the id of the matching row in the shared
// `products` table (the Zoho item). An order line has to point at one of those,
// because that is what becomes the line on the Zoho Sales Order;
// scripts/import-from-discord.js links them, by name.
const db = require('./db');
const { createDbTable } = require('./dbTable');

const catalogTable = createDbTable({ tableName: 'catalog' });

let cachedProducts = null;
let productsById = null;
let productsByName = null;

function initIndexes(products) {
  cachedProducts = Array.isArray(products) ? products : [];
  productsById = new Map();
  productsByName = new Map();
  for (const p of cachedProducts) {
    if (p.id) productsById.set(p.id.toLowerCase(), p);
    if (p.brandName) productsByName.set(p.brandName.toLowerCase(), p);
    if (p.fullName) productsByName.set(p.fullName.toLowerCase(), p);
    if (p.genericName) {
      const gn = p.genericName.toLowerCase();
      if (!productsByName.has(gn)) productsByName.set(gn, p);
    }
  }
}

// Read the price list from the database: on start, and again when src/server.js
// finds the copy older than a minute.
async function load() {
  await catalogTable.loadRows();
  initIndexes(catalogTable.getRow('products') || []);
  return cachedProducts;
}
const loadedAt = () => catalogTable.loadedAt();

// Replace the whole price list (the import scripts).
async function saveCatalog(list) {
  await catalogTable.saveRow('products', list);
  initIndexes(list);
}

function loadProducts() {
  if (!cachedProducts) initIndexes([]);
  return cachedProducts;
}

// The `products` row (Zoho item) an order line is for: the price-list entry's
// linked productId, else a product with exactly that name or SKU. BID can sell
// what isn't on the price list, but it still has to be a Zoho item to reach
// the Sales Order. Returns null when nothing matches.
async function resolveProductRow(label) {
  const entry = findProduct(label);
  if (entry?.productId) {
    const row = await db.prepare('SELECT id, name, sku, unit_price, stock, zoho_item_id FROM products WHERE id = ?').get(entry.productId);
    if (row) return row;
  }
  const names = [label, entry?.fullName, entry?.brandName].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  return (await db.prepare(
    `SELECT id, name, sku, unit_price, stock, zoho_item_id FROM products
      WHERE is_active = 1 AND (LOWER(name) = ANY(?) OR LOWER(sku) = ANY(?))
      ORDER BY id LIMIT 1`,
  ).get(names, names)) || null;
}

const DIVISIONS = ['B2C', 'STC', 'URO', 'B&B', 'B2B', 'HOS', 'BID'];

const SUB_DIVISIONS = {
  'B2C': ['MD Telesales'],
  'STC': ['MD Telesales'],
  'URO': ['MD Telesales'],
  'B&B': ['MD Telesales'],
  'B2B': ['NBD', 'CRR'],
  'HOS': ['Hospital', 'Telesales'],
  'BID': ['Bidding'],
};

// Price tier metadata
const PRICE_TIERS = {
  patient: { key: 'patient', label: "Patient's Price" },
  srp: { key: 'srp', label: 'SRP' },
  doctor: { key: 'doctor', label: "Doctor's Price" },
  hospital: { key: 'hospital', label: 'Drugstore/Hospital Price' },
  distributor: { key: 'distributor', label: "Distributor's Price" },
  special: { key: 'special', label: 'Special Price', requiresNotes: true },
  government: { key: 'government', label: 'Government Price', requiresNotes: true },
  bid: { key: 'bid', label: 'Bidding / Custom Price', requiresNotes: true },
};

// Division-specific pricing constraints
const DIVISION_PRICE_RULES = {
  'B2C': {
    description: "Patient's Price and SRP only. If prescription / Rx is attached, must have Doctor's Price only.",
    allowed: ['patient', 'srp'],
    withPrescription: ['doctor'],
    allowsSpecialGov: false,
  },
  'HOS': {
    description: "Drugstore/Hospital Price, Patient's Price, Doctor's Price, and SRP only.",
    allowed: ['hospital', 'patient', 'doctor', 'srp'],
    allowsSpecialGov: false,
  },
  'STC': {
    description: "Patient's Price, Doctor's Price, and SRP only.",
    allowed: ['patient', 'doctor', 'srp'],
    allowsSpecialGov: false,
  },
  'URO': {
    description: "Patient's Price, Doctor's Price, and SRP only.",
    allowed: ['patient', 'doctor', 'srp'],
    allowsSpecialGov: false,
  },
  'B&B': {
    description: "Patient's Price, Doctor's Price, and SRP only.",
    allowed: ['patient', 'doctor', 'srp'],
    allowsSpecialGov: false,
  },
  'B2B': {
    description: "SRP and Distributor's Price only.",
    allowed: ['srp', 'distributor'],
    allowsSpecialGov: false,
  },
  'BID': {
    description: 'No fixed price list. Pricing entered manually with notes. Special Price and Government Price require notes.',
    allowed: ['bid', 'special', 'government'],
    requiresNotes: true,
    noPriceList: true,
    allowsSpecialGov: true,
  },
};

function getProducts() {
  return loadProducts();
}

function findProduct(query) {
  loadProducts();
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  return productsById.get(q) || productsByName.get(q) || null;
}

function getAllowedPriceTiers(division, options = {}) {
  const rule = DIVISION_PRICE_RULES[division] || { allowed: ['patient', 'srp'] };
  let keys;
  if (division === 'B2C') {
    keys = options.hasPrescription ? ['doctor'] : ['patient', 'srp'];
  } else {
    keys = [...rule.allowed];
  }
  if (options.hasSpecialPrice && !keys.includes('special')) {
    keys.push('special');
  }
  return keys.map((k) => PRICE_TIERS[k]).filter(Boolean);
}

function isGuaranteeLetterRequired(order) {
  const paymentTerms = String(order.paymentTerms ?? '').toUpperCase();
  const source = String(order.source ?? '').toUpperCase();
  const division = String(order.division ?? '').trim();

  // Applicable to all division, but not in B2B
  if (division === 'B2B') return false;

  const isDswdPcso = paymentTerms.includes('DSWD') ||
                     paymentTerms.includes('PCSO') ||
                     source.includes('DSWD') ||
                     source.includes('PCSO');

  return isDswdPcso;
}

function validateOrderConstraints(order, attachments = []) {
  const division = String(order.division ?? '').trim();
  const notes = String(order.notes ?? '').trim();
  const remarks = String(order.remarks ?? '').trim();
  const hasPrescription = attachments.some((f) => f.kind === 'prescription');
  const hasGuaranteeLetter = attachments.some((f) => f.kind === 'guarantee_letter');

  // The caller looks the customer up (src/customers.js) and passes the flag in.
  const customerHasSpecialPrice = Boolean(order.customerHasSpecialPrice || order.hasSpecialPrice);

  // 1. DSWD & PCSO Guarantee letter constraint (applicable to all division, but not in B2B)
  if (isGuaranteeLetterRequired(order)) {
    if (!hasGuaranteeLetter) {
      return `Orders with payment terms or source "${order.paymentTerms || order.source}" require a Guarantee Letter attached (mandatory for all divisions except B2B).`;
    }
  }

  // 2. Check items and price tiers per division
  if (Array.isArray(order.items)) {
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      const priceType = item.priceType; // e.g. 'doctor', 'patient', 'srp', 'hospital', 'distributor', 'special', 'government', 'bid'

      // Special Price or Government Price requires notes
      if (priceType === 'special' || priceType === 'government') {
        if (!notes && !remarks) {
          const label = priceType === 'special' ? 'Special Price' : 'Government Price';
          return `Item ${i + 1}: ${label} requires an explanation in the Notes field.`;
        }
      }

      if (priceType) {
        if (priceType === 'special') {
          if (!customerHasSpecialPrice && division !== 'BID') {
            return `Item ${i + 1}: Customer "${order.customerName || 'Customer'}" is not eligible for Special Price.`;
          }
        } else if (division === 'B2C') {
          // B2C has only the Patients Price, SRP. If B2C has prescription/rx it must have Doctors Price.
          if (hasPrescription) {
            if (priceType !== 'doctor') {
              return `Item ${i + 1}: B2C order with prescription/rx must have Doctor's Price.`;
            }
          } else {
            if (priceType === 'doctor') {
              return `Item ${i + 1}: Doctor's Price for B2C requires a Prescription / Rx attachment.`;
            }
            if (!['patient', 'srp'].includes(priceType)) {
              return `Item ${i + 1}: B2C only allows Patient's Price or SRP (or Doctor's Price with prescription).`;
            }
          }
        } else if (division === 'HOS') {
          // HOS has only the drugstore/hospital price, patients price, doctors price, SRP
          if (!['hospital', 'patient', 'doctor', 'srp'].includes(priceType)) {
            return `Item ${i + 1}: HOS only allows Drugstore/Hospital Price, Patient's Price, Doctor's Price, or SRP.`;
          }
        } else if (division === 'STC' || division === 'URO' || division === 'B&B') {
          // STC has only patients price, doctors price, SRP
          if (!['patient', 'doctor', 'srp'].includes(priceType)) {
            return `Item ${i + 1}: ${division} only allows Patient's Price, Doctor's Price, or SRP.`;
          }
        } else if (division === 'B2B') {
          // B2B has only SRP and distributors price
          if (!['srp', 'distributor'].includes(priceType)) {
            return `Item ${i + 1}: B2B only allows SRP or Distributor's Price.`;
          }
        } else if (division === 'BID') {
          // BID has no price list, they input their notes
          if (!['bid', 'special', 'government'].includes(priceType)) {
            return `Item ${i + 1}: Division BID has no price list; pricing must be entered as bidding price, Special Price, or Government Price with notes.`;
          }
        }
      }
    }
  }

  // 3. BID division constraint: no price list, they input their notes
  if (division === 'BID') {
    if (!notes && !remarks) {
      return 'Division BID has no price list; notes or customer remarks explaining the bidding pricing are required.';
    }
  }

  return null; // All valid
}

module.exports = {
  DIVISIONS,
  SUB_DIVISIONS,
  PRICE_TIERS,
  DIVISION_PRICE_RULES,
  getProducts,
  findProduct,
  getAllowedPriceTiers,
  isGuaranteeLetterRequired,
  validateOrderConstraints,
  resolveProductRow,
  load,
  loadedAt,
  saveCatalog,
};
