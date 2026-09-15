#!/usr/bin/env node
'use strict';

// Migration script: transfers all datasets from the data/ folder into their respective
// Discord channels (via webhooks + bot token) into threads with JSON messages/files,
// then backs up / deletes the local data folder.

const fs = require('fs');
const path = require('path');

// Auto-load .env if present
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
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

const configStore = require('../src/configStore');
const products = require('../src/products');
const accounts = require('../src/accounts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(__dirname, '..', 'data.bak');

function readJsonSafe(filename) {
  let file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) {
    file = path.join(BACKUP_DIR, filename);
  }
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[migrate] Could not read ${filename}: ${err.message}`);
    return null;
  }
}

async function migrate() {
  console.log('=== Starting Discord-as-Database Migration ===\n');

  const settingsData = readJsonSafe('settings.json');
  const productsData = readJsonSafe('products.json');
  const promotionsData = readJsonSafe('promotions.json');
  const rbacData = readJsonSafe('rbac.json');
  const usersData = readJsonSafe('users.json');

  console.log(`Datasets found:`);
  console.log(`- settings.json:   ${settingsData ? 'YES' : 'NO'}`);
  console.log(`- products.json:   ${productsData ? `${productsData.length} items` : 'NO'}`);
  console.log(`- promotions.json: ${promotionsData ? 'YES' : 'NO'}`);
  console.log(`- rbac.json:       ${rbacData ? `${rbacData.length} roles` : 'NO'}`);
  console.log(`- users.json:      ${usersData ? `${usersData.users?.length ?? 0} users` : 'NO'}`);
  console.log('');

  // 1. Settings
  if (settingsData) {
    console.log('[migrate] Uploading Settings to Discord (#setting)...');
    try {
      await configStore._stores.settingsStore.save(settingsData);
      console.log('  ✓ Settings saved to Discord thread.');
    } catch (err) {
      console.error('  ✗ Failed to save Settings:', err.message);
    }
  }

  // 2. Promotions
  if (promotionsData) {
    console.log('[migrate] Uploading Promotions to Discord (#promotion)...');
    try {
      await configStore._stores.promotionsStore.save(promotionsData);
      console.log('  ✓ Promotions saved to Discord thread.');
    } catch (err) {
      console.error('  ✗ Failed to save Promotions:', err.message);
    }
  }

  // 3. RBAC
  if (rbacData) {
    console.log('[migrate] Uploading RBAC to Discord (#rbac)...');
    try {
      await configStore._stores.rbacStore.save(rbacData);
      console.log('  ✓ RBAC saved to Discord thread.');
    } catch (err) {
      console.error('  ✗ Failed to save RBAC:', err.message);
    }
  }

  // 4. Products
  if (productsData) {
    console.log('[migrate] Uploading Products to Discord (#product)...');
    try {
      await products._store.save(productsData);
      console.log(`  ✓ ${productsData.length} Products saved to Discord thread.`);
    } catch (err) {
      console.error('  ✗ Failed to save Products:', err.message);
    }
  }

  // 5. Users / Accounts
  if (usersData) {
    console.log('[migrate] Uploading Users / Accounts to Discord (#user)...');
    try {
      await accounts._store.save(usersData);
      console.log(`  ✓ ${usersData.users?.length ?? 0} Users saved to Discord thread.`);
    } catch (err) {
      console.error('  ✗ Failed to save Users:', err.message);
    }
  }

  console.log('\n=== Upload Complete ===\n');

  // Verify by loading back from Discord
  console.log('[migrate] Verifying read-back from Discord...');
  try {
    await configStore.loadFromDiscord();
    await products.loadFromDiscord();
    await accounts.loadFromDiscord();
    console.log('  ✓ Successfully verified read-back from Discord stores.');
  } catch (err) {
    console.error('  ✗ Verification failed:', err.message);
  }

  // Backup data/ directory
  if (fs.existsSync(DATA_DIR)) {
    console.log(`\n[migrate] Backing up ${DATA_DIR} to ${BACKUP_DIR}...`);
    try {
      if (fs.existsSync(BACKUP_DIR)) {
        fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
      }
      fs.cpSync(DATA_DIR, BACKUP_DIR, { recursive: true });
      console.log('  ✓ Backup created at data.bak/');
    } catch (err) {
      console.error('  ✗ Backup failed:', err.message);
    }

    const deleteArg = process.argv.includes('--delete');
    if (deleteArg) {
      console.log(`[migrate] Deleting ${DATA_DIR}...`);
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
        console.log('  ✓ data/ directory deleted successfully.');
      } catch (err) {
        console.error('  ✗ Failed to delete data/ directory:', err.message);
      }
    } else {
      console.log('[migrate] (To delete data/ folder completely, run with --delete flag)');
    }
  }

  console.log('\n=== Migration Done ===');
}

migrate().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
