#!/usr/bin/env node
'use strict';

// Migration script: Restructures Discord database into strict Table (Webhook) / Row (Thread by ID) / Data (Messages)
// Removes hardcoded defaults.

const fs = require('fs');
const path = require('path');

// Auto-load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const configStore = require('../src/configStore');
const { createDiscordTable } = require('../src/discordTable');

const BACKUP_DIR = path.join(__dirname, '..', 'data.bak');

function readBackup(filename) {
  const file = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`Could not read ${filename}: ${err.message}`);
    return null;
  }
}

async function runMigration() {
  console.log('=== Migrating to Discord Table / Row-per-Thread Database ===\n');

  const settingsRaw = readBackup('settings.json') || {};
  const rbacRaw = readBackup('rbac.json') || [];
  const promosRaw = readBackup('promotions.json') || {};

  const { settingsTable, rbacTable, promotionsTable } = configStore._tables;

  // 1. SETTINGS TABLE: Each setting type is its own ROW (thread by ID)
  console.log('1. Migrating Settings Table (Thread per setting ID)...');
  const settingRows = {
    divisions: settingsRaw.divisions || [],
    headquarters: settingsRaw.headquarters || [],
    invoicing_from: settingsRaw.invoicingFrom || [],
    payment_methods: settingsRaw.paymentMethods || [],
    sources: settingsRaw.sources || [],
    payment_terms: settingsRaw.paymentTerms || [],
    delivery_methods: settingsRaw.deliveryMethods || [],
    customers: settingsRaw.customers || [],
    recycle_bin: settingsRaw.recycleBin || [],
  };

  for (const [rowId, data] of Object.entries(settingRows)) {
    try {
      await settingsTable.saveRow(rowId, data);
      console.log(`   ✓ settings.${rowId} saved to thread.`);
    } catch (err) {
      console.error(`   ✗ Failed settings.${rowId}:`, err.message);
    }
  }

  // 2. RBAC TABLE: Each role is its own ROW (thread by role ID)
  console.log('\n2. Migrating RBAC Table (Thread per role ID)...');
  for (const role of rbacRaw) {
    if (!role.id) continue;
    // Ensure management and finance have edit_orders: true
    if (['management', 'finance'].includes(role.id)) {
      role.permissions = role.permissions || {};
      role.permissions.edit_orders = true;
    }
    try {
      await rbacTable.saveRow(role.id, role);
      console.log(`   ✓ rbac.${role.id} (edit_orders: ${role.permissions?.edit_orders}) saved to thread.`);
    } catch (err) {
      console.error(`   ✗ Failed rbac.${role.id}:`, err.message);
    }
  }

  // 3. PROMOTIONS TABLE: Each promo type is its own ROW (thread by ID)
  console.log('\n3. Migrating Promotions Table (Thread per promo group ID)...');
  const promoRows = {
    bundles: promosRaw.bundles || [],
    promos: promosRaw.promos || [],
    discounts: promosRaw.discounts || [],
  };
  for (const [rowId, data] of Object.entries(promoRows)) {
    try {
      await promotionsTable.saveRow(rowId, data);
      console.log(`   ✓ promotions.${rowId} (${data.length} items) saved to thread.`);
    } catch (err) {
      console.error(`   ✗ Failed promotions.${rowId}:`, err.message);
    }
  }

  // 4. Verify readback
  console.log('\n4. Verifying read-back from Discord Tables...');
  await configStore.loadFromDiscord();

  console.log(`- Divisions:       ${configStore.getDivisions().length} rows`);
  console.log(`- Headquarters:    ${configStore.getHeadquarters().length} rows`);
  console.log(`- Payment Methods: ${configStore.getPaymentMethods().length} rows`);
  console.log(`- Customers:       ${configStore.getCustomers().length} rows`);
  console.log(`- RBAC Roles:      ${configStore.getRbac().length} roles`);
  console.log(`- Management can edit orders? ${configStore.hasPermission('management', 'edit_orders')}`);
  console.log(`- Finance can edit orders?    ${configStore.hasPermission('finance', 'edit_orders')}`);

  console.log('\n=== Table-Row Migration Complete ===');
}

runMigration().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
