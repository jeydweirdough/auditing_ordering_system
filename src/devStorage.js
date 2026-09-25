// A stand-in for Supabase Storage on a developer's machine: the same calls
// src/core/services/paymentProofStorage.js makes (signed upload URL, signed
// view URL, download, remove), backed by a folder. Only loaded when
// SUPABASE_URL isn't set and DEV_STORAGE_DIR is, and never in production.
//
// The browser still PUTs the file to a signed URL and the API still only sees
// the path, so the upload flow is exercised exactly as it runs against Supabase.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
  throw new Error('devStorage is for local development only. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
}

const ROOT = () => path.resolve(process.env.DEV_STORAGE_DIR || path.join(__dirname, '..', 'data', 'storage'));
const SECRET = crypto.randomBytes(32);
const sign = (p, op, exp) => crypto.createHmac('sha256', SECRET).update(`${op}\n${p}\n${exp}`).digest('base64url');
const safe = (p) => {
  const full = path.resolve(ROOT(), p);
  if (!full.startsWith(ROOT() + path.sep)) throw new Error('path outside storage');
  return full;
};
const base = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');

function signedUrl(p, op, ttlSeconds, extra = '') {
  const exp = Date.now() + ttlSeconds * 1000;
  return `${base()}/dev-storage/${op}?path=${encodeURIComponent(p)}&exp=${exp}&sig=${sign(p, op, exp)}${extra}`;
}

function createDevStorageClient() {
  const bucket = {
    async createSignedUploadUrl(p) {
      return { data: { signedUrl: signedUrl(p, 'upload', 2 * 60 * 60), token: 'dev', path: p }, error: null };
    },
    async createSignedUrl(p, ttl, opts = {}) {
      const dl = opts.download ? `&download=${encodeURIComponent(opts.download === true ? path.basename(p) : opts.download)}` : '';
      return { data: { signedUrl: signedUrl(p, 'object', ttl, dl) }, error: null };
    },
    async remove(paths) {
      for (const p of paths) fs.rmSync(safe(p), { force: true });
      return { data: paths, error: null };
    },
    async download(p) {
      try {
        const buf = fs.readFileSync(safe(p));
        return { data: new Blob([buf]), error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
  };
  return { storage: { from: () => bucket } };
}

// The two URLs the fake client hands out. Checked like Supabase checks its own:
// the signature and the expiry, nothing else.
function router() {
  const r = express.Router();
  const check = (op) => (req, res, next) => {
    const { path: p, exp, sig } = req.query;
    if (!p || !exp || Number(exp) < Date.now()) return res.status(403).send('expired');
    const want = sign(String(p), op, String(exp));
    if (String(sig).length !== want.length || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(want))) {
      return res.status(403).send('bad signature');
    }
    req.storagePath = String(p);
    next();
  };
  r.put('/upload', check('upload'), express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const full = safe(req.storagePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.body);
    res.json({ Key: req.storagePath });
  });
  r.get('/object', check('object'), (req, res) => {
    const full = safe(req.storagePath);
    if (!fs.existsSync(full)) return res.status(404).send('not found');
    if (req.query.download) res.attachment(String(req.query.download));
    res.sendFile(full);
  });
  return r;
}

module.exports = { createDevStorageClient, router };
