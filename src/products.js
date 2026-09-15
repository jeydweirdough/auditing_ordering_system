const fs = require('fs');
const path = require('path');
const { createDiscordStore } = require('./discordStore');

const PRODUCTS_FILE = path.join(__dirname, '..', 'data', 'products.json');

const env = process.env;
const botToken = env.DISCORD_BOT_TOKEN || null;

const productStore = createDiscordStore({
  webhookUrl: env.DISCORD_PRODUCT_WEBHOOK_TOKEN,
  botToken,
  category: 'product',
  threadName: 'Products',
});

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

async function loadFromDiscord() {
  const data = await productStore.load();
  if (data && Array.isArray(data)) {
    initIndexes(data);
    console.log(`[products] Loaded ${cachedProducts.length} products from Discord.`);
  } else if (!cachedProducts) {
    loadProductsFromFile();
  }
  return cachedProducts;
}

function loadProductsFromFile() {
  let file = PRODUCTS_FILE;
  if (!fs.existsSync(file)) {
    const backup = path.join(__dirname, '..', 'data.bak', 'products.json');
    if (fs.existsSync(backup)) file = backup;
  }
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      initIndexes(JSON.parse(raw));
      return cachedProducts;
    } catch (err) {
      console.error(`[products] Failed to load ${file}:`, err.message);
    }
  }
  initIndexes([]);
  return cachedProducts;
}

function loadProducts() {
  if (!cachedProducts) {
    loadProductsFromFile();
  }
  return cachedProducts;
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

  let customerHasSpecialPrice = Boolean(order.customerHasSpecialPrice || order.hasSpecialPrice);
  if (!customerHasSpecialPrice && order.customerName) {
    try {
      const customers = require('./customers');
      const cust = customers.findCustomerByName(order.customerName);
      if (cust?.hasSpecialPrice) customerHasSpecialPrice = true;
    } catch {}
  }

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
  loadFromDiscord,
  _store: productStore,
};
