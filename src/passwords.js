// Passwords for the orders app: scrypt, which is built into Node, with a random salt per password.
// Stored as "scrypt$<salt>$<hash>", so the scheme can change later without guessing.
const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
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

module.exports = { hashPassword, checkPassword, generatePassword, passwordProblem };
