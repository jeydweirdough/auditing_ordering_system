// Moves what this app kept in Discord into the shared database, once:
//
//   settings    the order form's lists (divisions, payment terms…)   -> app_config
//   roles       the roles and their permissions                     -> app_config
//   promotions  bundles, promos, discounts                          -> app_config
//   price list  the products with their five price tiers            -> app_config ("catalog"),
//               each linked to its Zoho item in `products` by name
//   customers   the dozen kept in settings                          -> customers (matched by name,
//               or added as 'pending' for Pending Customers to push to Zoho)
//   accounts    who could sign in                                   -> users (matched by email; the
//               old scrypt password hashes carry across, so nobody picks a new password)
//
// Orders are not moved here (a separate decision: see the plan).
//
// Reads Discord itself (the bot token and webhook URLs in .env), or a folder of
// the JSON backups with --from-backup data.bak. Writes nothing unless --apply
// is given: without it, it prints what it would do.
//
//   node scripts/import-from-discord.js                       read Discord, dry run
//   node scripts/import-from-discord.js --from-backup data.bak
//   node scripts/import-from-discord.js --apply               …and write it
//
// DATABASE_URL must be set. Accounts that already exist (same email) are left
// alone and reported: nothing already in the database is overwritten except
// app_config rows, which are this app's alone.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const backupAt = args.includes('--from-backup') ? args[args.indexOf('--from-backup') + 1] : null;

const ROLE_TO_DB = { salesperson: 'medrep', team_leader: 'team_lead' };
const DB_ROLES = ['medrep', 'finance', 'dispatch', 'management', 'admin', 'team_lead'];

// ---------- reading the old data ----------

async function fromBackup(dir) {
  const read = (f) => {
    const full = path.join(dir, f);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
  };
  const s = read('settings.json') || {};
  return {
    settings: {
      divisions: s.divisions, headquarters: s.headquarters, invoicing_from: s.invoicingFrom,
      payment_methods: s.paymentMethods, sources: s.sources, payment_terms: s.paymentTerms,
      delivery_methods: s.deliveryMethods, order_fields: s.orderFields || [],
    },
    customers: s.customers || [],
    rbac: read('rbac.json') || [],
    promotions: read('promotions.json') || {},
    products: read('products.json') || [],
    users: (read('users.json') || {}).users || [],
  };
}

async function fromDiscord() {
  Object.assign(process.env, { DISCORD_ENABLED: 'true', DISCORD_MODE: 'live' });
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN is not set: it is what reads the old threads back.');
  const { createDiscordTable } = require('./legacy-discord/discordTable');
  const { createDiscordStore } = require('./legacy-discord/discordStore');
  const env = process.env;
  const botToken = env.DISCORD_BOT_TOKEN;
  const settings = createDiscordTable({ webhookUrl: env.DISCORD_SETTING_WEBHOOK_TOKEN, botToken, tableName: 'settings' });
  const rbac = createDiscordTable({ webhookUrl: env.DISCORD_RBAC_WEBHOOK_ID, botToken, tableName: 'rbac' });
  const promotions = createDiscordTable({ webhookUrl: env.DISCORD_PROMOTION_WEBHOOK_TOKEN, botToken, tableName: 'promotions' });
  const productStore = createDiscordStore({ webhookUrl: env.DISCORD_PRODUCT_WEBHOOK_TOKEN, botToken, category: 'product', threadName: 'Products' });
  const userStore = createDiscordStore({ webhookUrl: env.DISCORD_USER_WEBHOOK_TOKEN, botToken, category: 'user', threadName: 'Users' });
  await Promise.all([settings.loadRows(), rbac.loadRows(), promotions.loadRows()]);
  const rows = settings.getAllRows();
  const customers = Array.isArray(rows.customers) ? rows.customers : rows.customers?.customers || [];
  return {
    settings: Object.fromEntries(Object.entries(rows).filter(([k]) => !['customers', 'recycle_bin', 'Settings'].includes(k))),
    customers,
    rbac: rbac.getAllRowValues().filter((r) => r && r.id && r.id !== 'RBAC Roles'),
    promotions: Object.fromEntries(Object.entries(promotions.getAllRows()).filter(([k]) => ['bundles', 'promos', 'discounts'].includes(k))),
    products: (await productStore.load()) || [],
    users: ((await userStore.load()) || {}).users || [],
  };
}

// ---------- writing ----------

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const old = backupAt ? await fromBackup(backupAt) : await fromDiscord();
  const url = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, max: 1, ssl: /127\.0\.0\.1|localhost|sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false } });
  const q = (sql, params) => pool.query(sql, params);
  const plan = [];
  const say = (line) => plan.push(line);
  const now = new Date().toISOString();

  try {
    await q('BEGIN');
    const config = async (table, rowId, data) => {
      if (data == null) return;
      say(`app_config ${table}.${rowId}`);
      await q(`INSERT INTO app_config (table_name, row_id, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)
               ON CONFLICT (table_name, row_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [table, rowId, JSON.stringify(data), now]);
    };

    for (const [rowId, data] of Object.entries(old.settings)) await config('settings', rowId, data);
    for (const role of old.rbac) await config('rbac', role.id, role);
    for (const [rowId, data] of Object.entries(old.promotions)) await config('promotions', rowId, data);

    // The price list, each entry linked to its Zoho item by name.
    const unmatched = [];
    for (const p of old.products) {
      const names = [p.fullName, p.brandName, p.genericName].filter(Boolean).map((s) => String(s).trim().toLowerCase());
      const { rows } = await q(
        `SELECT id, name FROM products WHERE is_active = 1 AND LOWER(TRIM(name)) = ANY($1) ORDER BY id LIMIT 1`, [names],
      );
      if (rows[0]) p.productId = rows[0].id;
      else unmatched.push(p.fullName || p.brandName || p.id);
    }
    await config('catalog', 'products', old.products);
    say(`  price list: ${old.products.length - unmatched.length} of ${old.products.length} linked to a Zoho item`);
    for (const name of unmatched) say(`    not linked (no Zoho item by that name — link it in the price list or rename): ${name}`);

    // Customers: the Zoho contact with that name gets the receiver and special-price flag;
    // one with no match is added as 'pending', for someone to push to Zoho.
    for (const c of old.customers) {
      const extra = JSON.stringify({ receiverName: c.receiverName || '', receiverContact: c.receiverContact || '', hasSpecialPrice: Boolean(c.hasSpecialPrice) });
      const { rows } = await q(`SELECT id, zoho_contact_id FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) ORDER BY (zoho_contact_id IS NULL), id LIMIT 1`, [c.name]);
      if (rows[0]) {
        say(`customer ${c.name}: matched #${rows[0].id}${rows[0].zoho_contact_id ? ' (in Zoho)' : ' (not in Zoho)'}`);
        await q('UPDATE customers SET app_data = app_data || $1::jsonb WHERE id = $2', [extra, rows[0].id]);
      } else {
        say(`customer ${c.name}: added as pending (not in Zoho yet)`);
        await q(`INSERT INTO customers (name, type, contact_number, address, source, zoho_sync_status, app_data, created_at)
                 VALUES ($1, 'direct', $2, $3, 'local', 'pending', $4::jsonb, $5)`,
        [c.name, c.contactNumber || null, c.address || null, extra, now]);
      }
    }

    // Accounts, matched by email. The old ids become the new ones via email.
    const idByOldId = new Map();
    for (const u of old.users) {
      const email = String(u.email || '').trim().toLowerCase();
      const role = ROLE_TO_DB[u.role] || u.role;
      if (!email) continue;
      const { rows } = await q('SELECT id, role FROM users WHERE LOWER(email) = $1', [email]);
      if (rows[0]) {
        idByOldId.set(u.id, rows[0].id);
        say(`account ${email}: already in the database as ${rows[0].role}${rows[0].role !== role ? ` (was ${u.role} here — left as it is)` : ''}`);
        continue;
      }
      if (!DB_ROLES.includes(role)) {
        say(`account ${email}: SKIPPED — role "${u.role}" has no place in the shared users table`);
        continue;
      }
      const ins = await q(
        `INSERT INTO users (name, email, password_hash, role, is_active, approval_status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'approved', $6) RETURNING id`,
        [u.name, email, u.passwordHash, role, u.active === false ? 0 : 1, u.createdAt || now],
      );
      idByOldId.set(u.id, ins.rows[0].id);
      say(`account ${email}: added as ${role}${u.active === false ? ' (inactive)' : ''}`);
    }
    for (const u of old.users.filter((x) => x.teamLeaderId)) {
      const me = idByOldId.get(u.id);
      const lead = idByOldId.get(u.teamLeaderId);
      if (me && lead) await q('UPDATE users SET team_lead_id = $1 WHERE id = $2 AND team_lead_id IS NULL', [lead, me]);
    }

    if (APPLY) {
      await q('COMMIT');
      console.log(plan.join('\n'));
      console.log('\n✅ Written.');
    } else {
      await q('ROLLBACK');
      console.log(plan.join('\n'));
      console.log('\nDry run: nothing was written. Run again with --apply to write it.');
    }
  } catch (err) {
    await q('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
