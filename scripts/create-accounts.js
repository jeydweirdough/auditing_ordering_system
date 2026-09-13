// Creates the orders app's starting accounts: one per role, plus an admin who manages the rest from
// the People screen. Skips any that already exist. Passwords are random and written only to
// record-database-accounts.txt on your Desktop. Also adds SESSION_SECRET to .env if it's missing.
//
//   npm run accounts
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const OUT = path.join(os.homedir(), 'Desktop', 'record-database-accounts.txt');

const ACCOUNTS = [
  { name: 'Test Admin', email: 'admin.test@getmeds.ph', role: 'admin' },
  { name: 'Test Salesperson', email: 'salesperson.test@getmeds.ph', role: 'salesperson' },
  { name: 'Test Management', email: 'management.test@getmeds.ph', role: 'management' },
  { name: 'Test Finance', email: 'finance.test@getmeds.ph', role: 'finance' },
  { name: 'Test Dispatch', email: 'dispatch.test@getmeds.ph', role: 'dispatch' },
];

// Before accounts.js is loaded: it reads SESSION_SECRET when it starts.
function ensureSessionSecret() {
  const text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  if (/^\s*SESSION_SECRET\s*=\s*\S/m.test(text)) return false;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const secret = crypto.randomBytes(32).toString('base64');
  const lead = text && !text.endsWith('\n') ? eol : '';
  fs.appendFileSync(ENV, `${lead}${eol}# Signs the orders app's sign-in cookies. Changing it signs everyone out.${eol}SESSION_SECRET=${secret}${eol}`);
  process.env.SESSION_SECRET = secret;
  return true;
}

(async () => {
  if (ensureSessionSecret()) console.log('added SESSION_SECRET to .env');
  const { createAccount } = require('../src/accounts');

  const created = [];
  for (const account of ACCOUNTS) {
    try {
      const { user, password } = await createAccount(account);
      created.push({ ...account, password });
      console.log(`created  ${user.email} (${account.role})`);
    } catch (err) {
      if (err.status === 409) console.log(`skipped  ${account.email}: already has an account`);
      else throw err;
    }
  }

  if (created.length) {
    const lines = [
      '',
      `record_database orders app (http://localhost:4000/app) accounts, created ${new Date().toISOString()}`,
      'Save these passwords somewhere safe, then delete this file. Admin can reset any of them on the People screen.',
      ...created.map((a) => `${a.role.padEnd(12)} ${a.email.padEnd(30)} ${a.password}`),
      '',
    ];
    fs.appendFileSync(OUT, lines.join(os.EOL));
    console.log(`\npasswords for ${created.length} account(s) written to ${OUT}`);
  }
})().catch((err) => {
  console.error(`stopped: ${err.message}`);
  process.exitCode = 1;
});
