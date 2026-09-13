// Packs a record into the text stored in its Discord message, and unpacks it again.
// This is what lets Discord act as the database: the embed is for people, this line is
// for the server.
//
// Fields on the redact.js allowlist are stored as they are; the embed shows them anyway.
// Everything else (customerName, notes, ...) is encrypted with RECORD_SECRET (AES-256-GCM),
// so channel members only see ciphertext, and a tampered or copied value fails to decrypt.
// Without RECORD_SECRET those fields are left out. They are never stored in the clear.

const crypto = require('crypto');
const { redact } = require('./redact');

const PREFIX = 'rd1 ';
const MAX_LENGTH = 2048;   // Discord's limit for embed footer text

function createCodec(secret) {
  const key = secret ? Buffer.from(secret, 'base64') : null;
  if (key && key.length !== 32) throw new Error('RECORD_SECRET must be 32 random bytes, base64-encoded');

  function encode(record) {
    const doc = redact(record);
    const hidden = Object.fromEntries(Object.entries(record).filter(([k, v]) => !(k in doc) && v != null));
    if (key && Object.keys(hidden).length) doc.x = seal(hidden, doc.recordId);
    const text = PREFIX + JSON.stringify(doc);
    if (text.length > MAX_LENGTH) {
      throw new Error(`record is too large to store in Discord (${text.length} of ${MAX_LENGTH} characters)`);
    }
    return text;
  }

  // { record, locked } for text we wrote, null for anything else. locked means the record has
  // encrypted fields but there's no key to open them. Throws if they don't decrypt.
  function decode(text) {
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
    const { x, ...doc } = JSON.parse(text.slice(PREFIX.length));
    if (!x) return { record: doc, locked: false };
    if (!key) return { record: doc, locked: true };
    return { record: { ...doc, ...open(x, doc.recordId) }, locked: false };
  }

  // The record id is bound in as associated data, so ciphertext can't be moved to another record.
  function seal(value, recordId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(recordId));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  function open(sealed, recordId) {
    const buf = Buffer.from(sealed, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(recordId));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }

  return { encode, decode, encrypts: Boolean(key) };
}

module.exports = { createCodec };
