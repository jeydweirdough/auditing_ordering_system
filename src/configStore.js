'use strict';

// Config store backed strictly by Discord Database Tables.
// Table "settings"   -> rows: divisions, headquarters, invoicing_from, payment_methods, sources, payment_terms, delivery_methods, customers, recycle_bin
// Table "rbac"       -> rows: admin, management, finance, salesperson, dispatch, (and custom roles)
// Table "promotions" -> rows: bundles, promos, discounts

const { createDiscordTable } = require('./discordTable');

const env = process.env;
const botToken = env.DISCORD_BOT_TOKEN || null;

const settingsTable = createDiscordTable({
  webhookUrl: env.DISCORD_SETTING_WEBHOOK_TOKEN,
  botToken,
  tableName: 'settings',
});

const rbacTable = createDiscordTable({
  webhookUrl: env.DISCORD_RBAC_WEBHOOK_ID,
  botToken,
  tableName: 'rbac',
});

const promotionsTable = createDiscordTable({
  webhookUrl: env.DISCORD_PROMOTION_WEBHOOK_TOKEN,
  botToken,
  tableName: 'promotions',
});

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

// Hydrate from Discord on server startup
async function loadFromDiscord() {
  await Promise.all([
    settingsTable.loadRows(),
    rbacTable.loadRows(),
    promotionsTable.loadRows(),
  ]);

  // Support legacy bundle migration if a single "Settings" / "Promotions" / "RBAC Roles" row exists
  const legacySettings = settingsTable.getRow('Settings');
  if (legacySettings && typeof legacySettings === 'object') {
    if (legacySettings.divisions && !settingsTable.getRow('divisions')) settingsTable.setRowData('divisions', legacySettings.divisions);
    if (legacySettings.headquarters && !settingsTable.getRow('headquarters')) settingsTable.setRowData('headquarters', legacySettings.headquarters);
    if (legacySettings.invoicingFrom && !settingsTable.getRow('invoicing_from')) settingsTable.setRowData('invoicing_from', legacySettings.invoicingFrom);
    if (legacySettings.paymentMethods && !settingsTable.getRow('payment_methods')) settingsTable.setRowData('payment_methods', legacySettings.paymentMethods);
    if (legacySettings.sources && !settingsTable.getRow('sources')) settingsTable.setRowData('sources', legacySettings.sources);
    if (legacySettings.paymentTerms && !settingsTable.getRow('payment_terms')) settingsTable.setRowData('payment_terms', legacySettings.paymentTerms);
    if (legacySettings.deliveryMethods && !settingsTable.getRow('delivery_methods')) settingsTable.setRowData('delivery_methods', legacySettings.deliveryMethods);
    if (legacySettings.customers && !settingsTable.getRow('customers')) settingsTable.setRowData('customers', legacySettings.customers);
    if (legacySettings.recycleBin && !settingsTable.getRow('recycle_bin')) settingsTable.setRowData('recycle_bin', legacySettings.recycleBin);
  }

  const legacyPromos = promotionsTable.getRow('Promotions');
  if (legacyPromos && typeof legacyPromos === 'object') {
    if (legacyPromos.bundles && !promotionsTable.getRow('bundles')) promotionsTable.setRowData('bundles', legacyPromos.bundles);
    if (legacyPromos.promos && !promotionsTable.getRow('promos')) promotionsTable.setRowData('promos', legacyPromos.promos);
    if (legacyPromos.discounts && !promotionsTable.getRow('discounts')) promotionsTable.setRowData('discounts', legacyPromos.discounts);
  }

  const legacyRbac = rbacTable.getRow('RBAC Roles');
  if (Array.isArray(legacyRbac)) {
    for (const role of legacyRbac) {
      if (role.id && !rbacTable.getRow(role.id)) {
        rbacTable.setRowData(role.id, role);
      }
    }
  }

  // Ensure management and finance roles explicitly have edit_orders enabled
  const mgmt = rbacTable.getRow('management');
  if (mgmt && mgmt.permissions && mgmt.permissions.edit_orders !== true) {
    mgmt.permissions.edit_orders = true;
    rbacTable.saveRow('management', mgmt).catch(() => {});
  }
  const fin = rbacTable.getRow('finance');
  if (fin && fin.permissions && fin.permissions.edit_orders !== true) {
    fin.permissions.edit_orders = true;
    rbacTable.saveRow('finance', fin).catch(() => {});
  }

  // Ensure team_leader role exists with supervisory permissions
  if (!rbacTable.getRow('team_leader')) {
    const tlRole = {
      id: 'team_leader',
      label: 'Team Leader',
      description: 'Supervise salespeople, review and endorse orders before management approval.',
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
    };
    rbacTable.setRowData('team_leader', tlRole);
    rbacTable.saveRow('team_leader', tlRole).catch(() => {});
  }

  // 'admin' is a role in the table now, not a way past it. The one thing that
  // cannot come from the table is reaching the table itself: an Administrator
  // locked out of the RBAC screen can never be let back in by anybody. So those
  // two are guaranteed, and every other thing an admin does is a tick you can
  // see, and untick.
  const admin = rbacTable.getRow('admin') || { id: 'admin', label: 'Administrator', isSystem: true, permissions: {} };
  if (!admin.permissions?.manage_users || !admin.permissions?.manage_settings) {
    admin.permissions = { ...(admin.permissions || {}), manage_users: true, manage_settings: true };
    rbacTable.setRowData('admin', admin);
    rbacTable.saveRow('admin', admin).catch(() => {});
  }

  console.log('[configStore] Loaded from Discord tables (settings, rbac, promotions).');
}

// ---------------- Settings Table Getters & Setters ----------------

function getDivisions() {
  return settingsTable.getRow('divisions') || [];
}
function setDivisions(list) {
  settingsTable.saveRow('divisions', list);
}

function getHeadquarters() {
  return settingsTable.getRow('headquarters') || [];
}
function setHeadquarters(list) {
  settingsTable.saveRow('headquarters', list);
}

function getInvoicingFrom() {
  return settingsTable.getRow('invoicing_from') || [];
}
function setInvoicingFrom(list) {
  settingsTable.saveRow('invoicing_from', list);
}

function getPaymentMethods() {
  return settingsTable.getRow('payment_methods') || [];
}
function setPaymentMethods(list) {
  settingsTable.saveRow('payment_methods', list);
}

function getSources() {
  return settingsTable.getRow('sources') || [];
}
function setSources(list) {
  settingsTable.saveRow('sources', list);
}

function getPaymentTerms() {
  return settingsTable.getRow('payment_terms') || [];
}
function setPaymentTerms(list) {
  settingsTable.saveRow('payment_terms', list);
}

function getDeliveryMethods() {
  return settingsTable.getRow('delivery_methods') || [];
}
function setDeliveryMethods(list) {
  settingsTable.saveRow('delivery_methods', list);
}

function getCustomers() {
  const c = settingsTable.getRow('customers');
  if (Array.isArray(c)) return c;
  if (c && Array.isArray(c.customers)) return c.customers;
  return [];
}
function setCustomers(list) {
  settingsTable.saveRow('customers', list);
}

function getSettings() {
  return {
    divisions: getDivisions(),
    headquarters: getHeadquarters(),
    invoicingFrom: getInvoicingFrom(),
    paymentMethods: getPaymentMethods(),
    sources: getSources(),
    paymentTerms: getPaymentTerms(),
    deliveryMethods: getDeliveryMethods(),
    customers: getCustomers(),
    recycleBin: settingsTable.getRow('recycle_bin') || [],
  };
}

function saveSettings(settings = null) {
  if (!settings) return;
  if (settings.divisions) setDivisions(settings.divisions);
  if (settings.headquarters) setHeadquarters(settings.headquarters);
  if (settings.invoicingFrom) setInvoicingFrom(settings.invoicingFrom);
  if (settings.paymentMethods) setPaymentMethods(settings.paymentMethods);
  if (settings.sources) setSources(settings.sources);
  if (settings.paymentTerms) setPaymentTerms(settings.paymentTerms);
  if (settings.deliveryMethods) setDeliveryMethods(settings.deliveryMethods);
  if (settings.customers) setCustomers(settings.customers);
  if (settings.recycleBin) settingsTable.saveRow('recycle_bin', settings.recycleBin);
}

// ---------------- RBAC Table Getters & Setters ----------------

function getRbac() {
  const roles = rbacTable.getAllRowValues().filter((r) => r && typeof r === 'object' && r.id && r.id !== 'RBAC Roles');
  if (roles.length > 0) return roles;
  return [];
}

function setRbac(list) {
  for (const role of list) {
    if (role.id) {
      rbacTable.saveRow(role.id, role);
    }
  }
}

function hasPermission(roleId, permissionKey) {
  // No role is above the table. 'admin' used to return true here whatever the
  // RBAC screen said, which made that screen decorative for the one role most
  // worth being able to read — you could untick everything and nothing changed.
  // If an admin should take an order step, tick it for them like anyone else.
  const role = rbacTable.getRow(roleId) || getRbac().find((r) => r.id === roleId);
  if (!role) return false;
  return Boolean(role.permissions && role.permissions[permissionKey]);
}

// ---------------- Promotions Table Getters & Setters ----------------

function getPromotions() {
  return {
    bundles: promotionsTable.getRow('bundles') || [],
    promos: promotionsTable.getRow('promos') || [],
    discounts: promotionsTable.getRow('discounts') || [],
  };
}

function setPromotions(promos) {
  if (promos.bundles) promotionsTable.saveRow('bundles', promos.bundles);
  if (promos.promos) promotionsTable.saveRow('promos', promos.promos);
  if (promos.discounts) promotionsTable.saveRow('discounts', promos.discounts);
}

// ---------------- Order Fields (Custom Fields) ----------------

function getOrderFields() {
  const fields = settingsTable.getRow('order_fields');
  if (Array.isArray(fields)) return fields;
  if (fields && Array.isArray(fields.fields)) return fields.fields;
  return [];
}

function setOrderFields(fields) {
  settingsTable.saveRow('order_fields', Array.isArray(fields) ? fields : []);
}

function getAllConfigs() {
  const divisions = getDivisions();
  const divisionList = divisions.map((d) => d.name);
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
    orderFields: getOrderFields(),
    permissionDefinitions: PERMISSION_DEFINITIONS,
  };
}

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
  getOrderFields,
  setOrderFields,
  getPromotions,
  setPromotions,
  getRbac,
  setRbac,
  hasPermission,
  getAllConfigs,
  getSettings,
  saveSettings,
  PERMISSION_DEFINITIONS,
  _tables: { settingsTable, rbacTable, promotionsTable },
};
