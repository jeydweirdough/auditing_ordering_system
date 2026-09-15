'use strict';

const fs = require('fs');
const path = require('path');
const { createDiscordStore } = require('./discordStore');

const DATA_DIR = path.join(__dirname, '..', 'data');

const DEFAULT_DIVISIONS = [
  { name: 'B2C', subDivisions: ['MD Telesales'] },
  { name: 'STC', subDivisions: ['MD Telesales'] },
  { name: 'URO', subDivisions: ['MD Telesales'] },
  { name: 'B&B', subDivisions: ['MD Telesales'] },
  { name: 'B2B', subDivisions: ['NBD', 'CRR'] },
  { name: 'HOS', subDivisions: ['Hospital', 'Telesales'] },
  { name: 'BID', subDivisions: ['Bidding'] },
];

const DEFAULT_HEADQUARTERS = [
  'QC Central HQ',
  'Makati Regional HQ',
  'Cebu Branch',
  'Davao Branch',
];

const DEFAULT_INVOICING_FROM = [
  '2mg Incorporated',
  'Getmeds Philippines Inc.',
];

const DEFAULT_PAYMENT_METHODS = [
  'Cash on delivery',
  'Bank transfer',
  'GCash',
  'Credit terms',
  'Check',
  'Credit Card',
  'PDC',
];

const DEFAULT_SOURCES = [
  'Doctor order',
  'Patient order referred by doctor',
  'Patient order referred by patient',
  'Emergency purchase',
  'Hospital PO',
  'Distributor order',
];

const DEFAULT_PAYMENT_TERMS = [
  'Due end of next month', 'Due end of the month', 'Paid', 'Advanced Payment', 'Advanced Payment - Partial',
  'Donation/Charity', 'Samples', 'Due on Receipt', '60% DP 40% UPON DEL', 'CASH', 'COD', 'Net', 'Net 15',
  '30 days', '45 Day', 'BPO WALLET', '60 Day', 'DSWD/PCSO', 'OP', '90 Day', 'INITIAL STOCKING', '120 Day', '180 Day',
];

const DEFAULT_DELIVERY_METHODS = [
  'Own Rider / Company Vehicle',
  'LBC Express',
  'Grab Express',
  'J&T Express',
  'Lalamove',
  'Customer Pick-up',
  'Distributor Delivery',
];

const DEFAULT_PROMOTIONS = {
  bundles: [
    {
      id: 'bnd-starter-pack',
      name: 'Surgical Prep Bundle',
      code: 'BND-SURG-PREP',
      description: 'Essential anesthesia and pain relief starter kit for surgical clinics.',
      items: [
        { product: "AtraGet 10mg (Atracurium) 10mg - PACK OF 5'S", qty: 2, unitType: 'pack' },
        { product: 'TramolGet 50mg/ml (Tramadol) 50mg/ml 2ml - PACK OF 10\'S', qty: 1, unitType: 'pack' }
      ],
      bundlePrice: 4500,
      active: true
    },
    {
      id: 'bnd-antibiotic-duo',
      name: 'Antibiotic Care Duo',
      code: 'BND-ANTI-DUO',
      description: 'Combined broad-spectrum antibiotic regimen for hospital wards.',
      items: [
        { product: 'Ceftriaxone (Getaxone) 1g vial', qty: 5, unitType: 'unit' },
        { product: 'Cefuroxime (CefuGet) 750mg vial', qty: 5, unitType: 'unit' }
      ],
      bundlePrice: 2800,
      active: true
    }
  ],
  promos: [
    {
      id: 'prm-q3-surge',
      name: 'Q3 Hospital Surge Promo',
      code: 'HOSPQ3',
      description: 'Free cold-chain delivery and special priority packing on bulk hospital orders.',
      startDate: '2026-07-01',
      endDate: '2026-09-30',
      tag: 'Priority Shipping',
      active: true
    },
    {
      id: 'prm-clinics-launch',
      name: 'New Clinic Welcome Campaign',
      code: 'WELCOMECLINIC',
      description: 'Introductory campaign offering expedited verification for new medical centers.',
      startDate: '2026-08-01',
      endDate: '2026-10-31',
      tag: 'Fast-Track',
      active: true
    }
  ],
  discounts: [
    {
      id: 'dsc-bulk-5pct',
      name: 'Bulk Volume 5% Off',
      code: 'BULK5',
      type: 'percentage',
      value: 5,
      minSpend: 25000,
      description: '5% discount for orders reaching PHP 25,000 or above.',
      active: true
    },
    {
      id: 'dsc-fixed-1000',
      name: 'Hospital Partner ₱1,000 Off',
      code: 'HOSP1000',
      type: 'fixed',
      value: 1000,
      minSpend: 15000,
      description: 'Fixed ₱1,000 voucher deduction for partner institutional accounts.',
      active: true
    },
    {
      id: 'dsc-loyalty-10pct',
      name: 'VIP Medical Center 10% Off',
      code: 'VIP10',
      type: 'percentage',
      value: 10,
      minSpend: 50000,
      description: 'Exclusive 10% discount on high-volume institutional medical procurements.',
      active: true
    }
  ]
};

const DEFAULT_RBAC = [
  {
    id: 'admin',
    label: 'Administrator',
    description: 'Full access to create, edit, delete orders, manage users and configure system settings.',
    isSystem: true,
    permissions: {
      raise_orders: true,
      edit_orders: true,
      delete_orders: true,
      restore_orders: true,
      approve_orders: true,
      send_back_orders: true,
      reject_orders: true,
      verify_payment: true,
      hold_payment: true,
      pick_pack_dispatch: true,
      deliver_orders: true,
      manage_users: true,
      manage_settings: true,
    },
  },
  {
    id: 'management',
    label: 'Management',
    description: 'Approve new orders, send them back for changes, reject them, or raise orders.',
    isSystem: true,
    permissions: {
      raise_orders: true,
      edit_orders: true,
      delete_orders: false,
      restore_orders: false,
      approve_orders: true,
      send_back_orders: true,
      reject_orders: true,
      verify_payment: false,
      hold_payment: false,
      pick_pack_dispatch: false,
      deliver_orders: false,
      manage_users: false,
      manage_settings: false,
    },
  },
  {
    id: 'salesperson',
    label: 'Salesperson',
    description: 'Raise orders and fix the ones Management sends back.',
    isSystem: true,
    permissions: {
      raise_orders: true,
      edit_orders: false,
      delete_orders: false,
      restore_orders: false,
      approve_orders: false,
      send_back_orders: false,
      reject_orders: false,
      verify_payment: false,
      hold_payment: false,
      pick_pack_dispatch: false,
      deliver_orders: false,
      manage_users: false,
      manage_settings: false,
    },
  },
  {
    id: 'finance',
    label: 'Finance',
    description: 'Verify payment on approved orders or put them on hold.',
    isSystem: true,
    permissions: {
      raise_orders: false,
      edit_orders: false,
      delete_orders: false,
      restore_orders: false,
      approve_orders: false,
      send_back_orders: false,
      reject_orders: false,
      verify_payment: true,
      hold_payment: true,
      pick_pack_dispatch: false,
      deliver_orders: false,
      manage_users: false,
      manage_settings: false,
    },
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    description: 'Pick, pack and dispatch paid orders, then mark them delivered.',
    isSystem: true,
    permissions: {
      raise_orders: false,
      edit_orders: false,
      delete_orders: false,
      restore_orders: false,
      approve_orders: false,
      send_back_orders: false,
      reject_orders: false,
      verify_payment: false,
      hold_payment: false,
      pick_pack_dispatch: true,
      deliver_orders: true,
      manage_users: false,
      manage_settings: false,
    },
  },
];

const PERMISSION_DEFINITIONS = [
  { key: 'raise_orders', label: 'Raise New Orders', group: 'Orders' },
  { key: 'edit_orders', label: 'Edit Orders (Details, Items, Pricing)', group: 'Orders' },
  { key: 'delete_orders', label: 'Delete Orders', group: 'Orders' },
  { key: 'restore_orders', label: 'Restore Deleted Orders', group: 'Orders' },
  { key: 'approve_orders', label: 'Approve Orders', group: 'Approvals' },
  { key: 'send_back_orders', label: 'Send Back for Changes', group: 'Approvals' },
  { key: 'reject_orders', label: 'Reject Orders', group: 'Approvals' },
  { key: 'verify_payment', label: 'Verify Payment', group: 'Finance' },
  { key: 'hold_payment', label: 'Hold / Release Payment', group: 'Finance' },
  { key: 'pick_pack_dispatch', label: 'Start Picking, Pack & Dispatch', group: 'Fulfillment' },
  { key: 'deliver_orders', label: 'Mark Delivered', group: 'Fulfillment' },
  { key: 'manage_users', label: 'Manage User Accounts', group: 'Admin' },
  { key: 'manage_settings', label: 'Manage Reference Configs & RBAC', group: 'Admin' },
];

// ---- Legacy file helpers (used only for initial migration/fallback) ----

function readJsonFile(filename, defaultValue) {
  let filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    const backupPath = path.join(__dirname, '..', 'data.bak', filename);
    if (fs.existsSync(backupPath)) filePath = backupPath;
  }
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[configStore] Error reading ${filename}:`, err.message);
    return defaultValue;
  }
}

// ---- Discord stores for each data category ----

const env = process.env;
const botToken = env.DISCORD_BOT_TOKEN || null;

const settingsStore = createDiscordStore({
  webhookUrl: env.DISCORD_SETTING_WEBHOOK_TOKEN,
  botToken,
  category: 'setting',
  threadName: 'Settings',
});

const promotionsStore = createDiscordStore({
  webhookUrl: env.DISCORD_PROMOTION_WEBHOOK_TOKEN,
  botToken,
  category: 'promotion',
  threadName: 'Promotions',
});

const rbacStore = createDiscordStore({
  webhookUrl: env.DISCORD_RBAC_WEBHOOK_ID,
  botToken,
  category: 'rbac',
  threadName: 'RBAC Roles',
});

// In-memory settings cache
let cachedSettings = null;
let cachedRbac = null;
let cachedPromotions = null;

// Track whether Discord stores have been loaded
let discordLoaded = false;

// ---- Load from Discord (called at server startup) ----

async function loadFromDiscord() {
  const [settingsData, promosData, rbacData] = await Promise.all([
    settingsStore.load(),
    promotionsStore.load(),
    rbacStore.load(),
  ]);

  // Settings
  if (settingsData && typeof settingsData === 'object') {
    cachedSettings = {
      divisions: settingsData.divisions || DEFAULT_DIVISIONS,
      headquarters: settingsData.headquarters || DEFAULT_HEADQUARTERS,
      invoicingFrom: settingsData.invoicingFrom || DEFAULT_INVOICING_FROM,
      paymentMethods: settingsData.paymentMethods || DEFAULT_PAYMENT_METHODS,
      sources: settingsData.sources || DEFAULT_SOURCES,
      paymentTerms: settingsData.paymentTerms || DEFAULT_PAYMENT_TERMS,
      deliveryMethods: settingsData.deliveryMethods || DEFAULT_DELIVERY_METHODS,
      customers: Array.isArray(settingsData.customers) ? settingsData.customers : (settingsData.customers?.customers || []),
      recycleBin: Array.isArray(settingsData.recycleBin) ? settingsData.recycleBin : [],
    };
  }

  // Promotions
  if (promosData && typeof promosData === 'object') {
    cachedPromotions = promosData;
  }

  // RBAC
  if (rbacData && Array.isArray(rbacData)) {
    cachedRbac = rbacData;
  }

  // Fallback to local files if Discord had nothing (first run before migration)
  if (!cachedSettings) {
    const initial = readJsonFile('settings.json', null);
    if (initial && typeof initial === 'object') {
      cachedSettings = {
        divisions: initial.divisions || DEFAULT_DIVISIONS,
        headquarters: initial.headquarters || DEFAULT_HEADQUARTERS,
        invoicingFrom: initial.invoicingFrom || DEFAULT_INVOICING_FROM,
        paymentMethods: initial.paymentMethods || DEFAULT_PAYMENT_METHODS,
        sources: initial.sources || DEFAULT_SOURCES,
        paymentTerms: initial.paymentTerms || DEFAULT_PAYMENT_TERMS,
        deliveryMethods: initial.deliveryMethods || DEFAULT_DELIVERY_METHODS,
        customers: Array.isArray(initial.customers) ? initial.customers : (initial.customers?.customers || []),
        recycleBin: Array.isArray(initial.recycleBin) ? initial.recycleBin : [],
      };
    } else {
      cachedSettings = {
        divisions: DEFAULT_DIVISIONS,
        headquarters: DEFAULT_HEADQUARTERS,
        invoicingFrom: DEFAULT_INVOICING_FROM,
        paymentMethods: DEFAULT_PAYMENT_METHODS,
        sources: DEFAULT_SOURCES,
        paymentTerms: DEFAULT_PAYMENT_TERMS,
        deliveryMethods: DEFAULT_DELIVERY_METHODS,
        customers: [],
        recycleBin: [],
      };
    }
  }

  if (!cachedPromotions) {
    cachedPromotions = readJsonFile('promotions.json', DEFAULT_PROMOTIONS);
  }

  if (!cachedRbac) {
    cachedRbac = readJsonFile('rbac.json', DEFAULT_RBAC);
  }

  discordLoaded = true;
  console.log('[configStore] All config data loaded.');
}

// ---- Synchronous loaders (backwards compatible, use cached data) ----

function loadSettings() {
  if (cachedSettings) return cachedSettings;
  // Synchronous fallback for code that calls before Discord load finishes (shouldn't happen
  // after server.js awaits loadFromDiscord, but safety net).
  const initial = readJsonFile('settings.json', null);
  if (initial && typeof initial === 'object') {
    cachedSettings = {
      divisions: initial.divisions || DEFAULT_DIVISIONS,
      headquarters: initial.headquarters || DEFAULT_HEADQUARTERS,
      invoicingFrom: initial.invoicingFrom || DEFAULT_INVOICING_FROM,
      paymentMethods: initial.paymentMethods || DEFAULT_PAYMENT_METHODS,
      sources: initial.sources || DEFAULT_SOURCES,
      paymentTerms: initial.paymentTerms || DEFAULT_PAYMENT_TERMS,
      deliveryMethods: initial.deliveryMethods || DEFAULT_DELIVERY_METHODS,
      customers: Array.isArray(initial.customers) ? initial.customers : (initial.customers?.customers || []),
      recycleBin: Array.isArray(initial.recycleBin) ? initial.recycleBin : [],
    };
  } else {
    cachedSettings = {
      divisions: DEFAULT_DIVISIONS,
      headquarters: DEFAULT_HEADQUARTERS,
      invoicingFrom: DEFAULT_INVOICING_FROM,
      paymentMethods: DEFAULT_PAYMENT_METHODS,
      sources: DEFAULT_SOURCES,
      paymentTerms: DEFAULT_PAYMENT_TERMS,
      deliveryMethods: DEFAULT_DELIVERY_METHODS,
      customers: [],
      recycleBin: [],
    };
  }
  return cachedSettings;
}

function getSettings() {
  return loadSettings();
}

function saveSettings(settings = null) {
  if (settings) cachedSettings = settings;
  if (!cachedSettings) return;
  // Write to Discord asynchronously (fire-and-forget from the caller's perspective)
  settingsStore.save(cachedSettings).catch((err) => {
    console.warn(`[configStore] Failed to save settings to Discord: ${err.message}`);
  });
}

function getDivisions() {
  return loadSettings().divisions;
}

function setDivisions(list) {
  loadSettings().divisions = list;
  saveSettings();
}

function getHeadquarters() {
  return loadSettings().headquarters;
}

function setHeadquarters(list) {
  loadSettings().headquarters = list;
  saveSettings();
}

function getInvoicingFrom() {
  return loadSettings().invoicingFrom;
}

function setInvoicingFrom(list) {
  loadSettings().invoicingFrom = list;
  saveSettings();
}

function getPaymentMethods() {
  return loadSettings().paymentMethods;
}

function setPaymentMethods(list) {
  loadSettings().paymentMethods = list;
  saveSettings();
}

function getSources() {
  return loadSettings().sources;
}

function setSources(list) {
  loadSettings().sources = list;
  saveSettings();
}

function getPaymentTerms() {
  return loadSettings().paymentTerms;
}

function setPaymentTerms(list) {
  loadSettings().paymentTerms = list;
  saveSettings();
}

function getDeliveryMethods() {
  return loadSettings().deliveryMethods;
}

function setDeliveryMethods(list) {
  loadSettings().deliveryMethods = list;
  saveSettings();
}

function getCustomers() {
  return loadSettings().customers;
}

function setCustomers(list) {
  loadSettings().customers = list;
  saveSettings();
}

function getRbac() {
  if (!cachedRbac) {
    cachedRbac = readJsonFile('rbac.json', DEFAULT_RBAC);
  }
  return cachedRbac;
}

function setRbac(list) {
  cachedRbac = list;
  rbacStore.save(list).catch((err) => {
    console.warn(`[configStore] Failed to save RBAC to Discord: ${err.message}`);
  });
}

function getPromotions() {
  if (!cachedPromotions) {
    cachedPromotions = readJsonFile('promotions.json', DEFAULT_PROMOTIONS);
  }
  return cachedPromotions;
}

function setPromotions(promos) {
  cachedPromotions = promos;
  promotionsStore.save(promos).catch((err) => {
    console.warn(`[configStore] Failed to save promotions to Discord: ${err.message}`);
  });
}

function hasPermission(roleId, permissionKey) {
  if (roleId === 'admin') return true;
  const roles = getRbac();
  const role = roles.find(r => r.id === roleId);
  if (!role) return false;
  return Boolean(role.permissions && role.permissions[permissionKey]);
}

function getAllConfigs() {
  const divisions = getDivisions();
  const divisionList = divisions.map(d => d.name);
  const subDivisionMap = {};
  for (const d of divisions) {
    subDivisionMap[d.name] = d.subDivisions || [];
  }

  return {
    divisions,
    divisionList,
    subDivisionMap,
    headquarters: getHeadquarters(),
    invoicingFrom: getInvoicingFrom(),
    paymentMethods: getPaymentMethods(),
    sources: getSources(),
    paymentTerms: getPaymentTerms(),
    deliveryMethods: getDeliveryMethods(),
    promotions: getPromotions(),
    rbac: getRbac(),
    permissionDefinitions: PERMISSION_DEFINITIONS,
  };
}

// No longer auto-init on require — server.js calls loadFromDiscord() at startup
// function initStore() { loadSettings(); getPromotions(); getRbac(); }
// initStore();

module.exports = {
  loadFromDiscord,
  getDivisions,
  setDivisions,
  getHeadquarters,
  setHeadquarters,
  getInvoicingFrom,
  setInvoicingFrom,
  getPaymentMethods,
  setPaymentMethods,
  getSources,
  setSources,
  getPaymentTerms,
  setPaymentTerms,
  getDeliveryMethods,
  setDeliveryMethods,
  getCustomers,
  setCustomers,
  getPromotions,
  setPromotions,
  getRbac,
  setRbac,
  hasPermission,
  getAllConfigs,
  getSettings,
  saveSettings,
  PERMISSION_DEFINITIONS,
  // Expose stores for migration script
  _stores: { settingsStore, promotionsStore, rbacStore },
};
