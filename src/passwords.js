// Passwords for the orders app.
//
// Accounts are the shared `users` table now, whose passwords getmeds-system
// hashes with bcrypt ("$2a$…"). The accounts this app used to keep were hashed
// with scrypt ("scrypt$<salt>$<hash>"), and scripts/import-from-discord.js
// carries those hashes across as they are, so nobody has to choose a new
// password at the switch. Both are checked; new and changed passwords are
// bcrypt, which getmeds-system can check too.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const KEY_LENGTH = 64;
const BCRYPT_ROUNDS = 10;   // getmeds-system's own

function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function checkScrypt(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkPassword(password, stored) {
  const s = String(stored || '');
  if (s.startsWith('scrypt$')) return checkScrypt(password, s);
  if (/^\$2[aby]\$/.test(s)) return bcrypt.compareSync(String(password), s);
  return false;
}

// The old format, for hashing a password the way the Discord-era accounts were.
function hashScrypt(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// 16 characters with upper, lower and a digit: for accounts an admin hands out.
function generatePassword() {
  for (;;) {
    const pw = crypto.randomBytes(12).toString('base64url');
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && !/^[-_]/.test(pw)) return pw;
  }
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'A password needs at least 10 characters.';
  if (password.length > 200) return 'A password can be at most 200 characters.';
  return null;
}

module.exports = { hashPassword, hashScrypt, checkPassword, generatePassword, passwordProblem };
