// Packs an order's data into the reply that follows each step in its #order-audit thread, and
// unpacks it again. Those replies are where orders are stored (src/orderAudit.js).
//
// The data is JSON anyone in the channel can read: the order as it stood after the step, and the
// step itself. Customer details, addresses, the receiver, the doctor, remarks, notes, reasons,
// payment references, who received a delivery and the list of attached files are moved into "x"
// and encrypted with RECORD_SECRET (AES-256-GCM). The order id and step number are bound in, so
// "x" can't be moved to another reply. The attached files themselves are encrypted with the same
// key (sealFile). Without RECORD_SECRET all of it stays readable, and the server warns about it.
const crypto = require('crypto');

const FORMAT = 'order/1';
const CONTENT_LIMIT = 2000;   // Discord's limit for a message's text

const HIDDEN = [
  ['order', 'customerName'],
  ['order', 'contactNumber'],
  ['order', 'address'],
  ['order', 'receiverName'],
  ['order', 'receiverContact'],
  ['order', 'doctorName'],
  ['order', 'remarks'],
  ['order', 'notes'],
  ['order', 'attachments'],   // file names can say who the customer is
  ['order', 'payment', 'reference'],
  ['order', 'shipment', 'receivedBy'],
  ['step', 'note'],
  ['step', 'details', 'reference'],
  ['step', 'details', 'receivedBy'],
  ['step', 'details', 'before'],   // what an Admin edit replaced
];

// Removes the value at path from obj and returns it; undefined when there's nothing there.
function take(obj, path) {
  const parent = path.slice(0, -1).reduce((node, k) => (node && typeof node === 'object' ? node[k] : undefined), obj);
  const key = path.at(-1);
  if (!parent || typeof parent !== 'object' || parent[key] == null) return undefined;
  const value = parent[key];
  delete parent[key];
  return value;
}

function put(obj, path, value) {
  let node = obj;
  for (const k of path.slice(0, -1)) node = node[k] ??= {};
  node[path.at(-1)] = value;
}

// Puts decrypted fields back where they came from.
function merge(target, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(target[k] ??= {}, v);
    else target[k] = v;
  }
}

// Pretty JSON, with each item and each person on one line, so an order fits in one message.
const STR = '"(?:[^"\\\\]|\\\\.)*"';
const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const ITEM = new RegExp(`\\{\\n\\s+"product": (${STR}),\\n\\s+"qty": (${NUM}),\\n\\s+"unitPrice": (${NUM})(?:,\\n\\s+"priceType": (${STR}))?(?:,\\n\\s+"unitType": (${STR}))?\\n\\s+\\}`, 'g');
const PERSON = new RegExp(`\\{\\n\\s+"id": (${NUM}),\\n\\s+"name": (${STR}),\\n\\s+"role": (${STR})\\n\\s+\\}`, 'g');
const tidy = (json) => json
  .replace(ITEM, (_m, p, q, u, pt, ut) => `{ "product": ${p}, "qty": ${q}, "unitPrice": ${u}${pt ? `, "priceType": ${pt}` : ''}${ut ? `, "unitType": ${ut}` : ''} }`)
  .replace(PERSON, '{ "id": $1, "name": $2, "role": $3 }');

const fileName = (orderId, seq) => `${orderId}-step-${seq}.json`;
const isDataFile = (name) => /^(?:GM|ORD)-\d{8}-\d{4}-step-\d+\.json$/.test(name ?? '');

// The JSON in a reply's text, or null.
function jsonIn(content) {
  const match = /```json\n([\s\S]+?)\n```/.exec(content ?? '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function createOrderCodec(secret) {
  const key = secret ? Buffer.from(secret, 'base64') : null;
  if (key && key.length !== 32) throw new Error('RECORD_SECRET must be 32 random bytes, base64-encoded');
  const aad = (orderId, seq) => Buffer.from(`order:${orderId}#${seq}`);

  function seal(value, orderId, seq) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(orderId, seq));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  function open(sealed, orderId, seq) {
    const buf = Buffer.from(sealed, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAAD(aad(orderId, seq));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }

  // A file an order carries: the same key, bound to the order and the file's number. Bytes in,
  // bytes out: the iv, the tag, then the data.
  function sealFile(data, orderId, n) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`file:${orderId}#${n}`));
    const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  }

  function openFile(buf, orderId, n) {
    if (!key) throw new Error("This file is encrypted and RECORD_SECRET isn't set.");
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(`file:${orderId}#${n}`));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  }

  // One step's data: { format, order, step, x }.
  function pack(order, step) {
    const data = structuredClone({ format: FORMAT, order, step });
    if (!key) return data;
    const hidden = {};
    for (const path of HIDDEN) {
      const value = take(data, path);
      if (value !== undefined) put(hidden, path, value);
    }
    if (Object.keys(hidden).length) data.x = seal(hidden, order.id, step.seq);
    return data;
  }

  // { order, step, locked } for data we wrote, null for anything else. locked: it has encrypted
  // fields but no key to open them. Throws if they don't decrypt (a different RECORD_SECRET).
  function unpack(data) {
    if (data?.format !== FORMAT || typeof data.order?.id !== 'string' || !Number.isInteger(data.step?.seq)) return null;
    const { x, format, ...rest } = data;
    if (x && !key) return { ...rest, locked: true };
    if (x) merge(rest, open(x, rest.order.id, rest.step.seq));
    return { ...rest, locked: false };
  }

  // The reply: pretty JSON in a code block when it fits in one message, compact JSON when that
  // fits, otherwise a .json file and a line saying so.
  function toMessage(data) {
    const pretty = tidy(JSON.stringify(data, null, 2));
    for (const text of [pretty, JSON.stringify(data)]) {
      const content = `\`\`\`json\n${text}\n\`\`\``;
      if (content.length <= CONTENT_LIMIT) return { content, file: null };
    }
    return {
      content: `Order data for ${data.order.id}, step ${data.step.seq}, is attached: it's too long for one message.`,
      file: { name: fileName(data.order.id, data.step.seq), type: 'application/json', data: Buffer.from(pretty) },
    };
  }

  return { pack, unpack, toMessage, sealFile, openFile, encrypts: Boolean(key) };
}

module.exports = { createOrderCodec, jsonIn, isDataFile, FORMAT };
