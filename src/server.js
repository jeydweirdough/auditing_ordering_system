const path = require('path');
const express = require('express');
const {
  notify, editMessage, startThread, threadMessages, fetchMessage, readHistory,
  mode, queueStats, canReadBack, webhookId,
} = require('./discord');
const { redact, ALLOWED } = require('./redact');
const { createCodec } = require('./recordCodec');
const accounts = require('./accounts');
const orders = require('./orders');

const app = express();
app.use(express.json());

const PUBLIC = path.join(__dirname, '..', 'public');

// The orders app at /app, the first route: sign-in, a dashboard per role, and each order's audit
// trail, mirrored to its thread in #order-audit (src/orders.js). Accounts and orders stay in data/.
app.get('/app', (_req, res) => {
  res.set('Content-Security-Policy', "frame-ancestors 'none'");   // no other site can frame the sign-in
  res.sendFile(path.join(PUBLIC, 'app.html'));
});
app.use('/api', accounts.router);
app.use('/api/orders', orders.router);

// The test page at /. Named as a route, not left to express.static alone, so / still answers on
// hosts that skip express.static and serve public/ themselves (Vercel does).
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.use(express.static(PUBLIC));

// In live mode Discord is the database: each record lives in its own channel message, and this
// list is rebuilt from the channel on startup (needs DISCORD_BOT_TOKEN). In mock mode it's memory only.
const records = [];
let counter = 0;

// What happened to each record's channel message, keyed by recordId. The test page reads this.
const deliveries = new Map();

// Each record's thread, keyed by recordId: named after the record, holding a copy of it, its
// files, and every update since. `source` says where it lives:
//   thread  - a Discord thread on the record's message (live mode with the bot)
//   message - no thread; files ride on the record's message (live mode without the bot)
//   local   - memory only (mock mode, or sending switched off)
const threads = new Map();

const codec = createCodec(process.env.RECORD_SECRET);
const writesToDiscord = mode === 'live' && process.env.DISCORD_ENABLED === 'true';
const threadMode = writesToDiscord && canReadBack;
const storage = {
  kind: !writesToDiscord ? 'memory' : canReadBack ? 'discord' : 'discord-write-only',
  encrypts: codec.encrypts,
  loaded: 0,
  scanned: 0,
  locked: 0,       // records whose encrypted fields can't be opened without RECORD_SECRET
  unreadable: 0,   // records that didn't decrypt, most likely a different RECORD_SECRET
  error: null,     // set when reading the channel failed on startup
};

// Keeps one record inside one Discord message.
const LIMITS = { division: 100, customerName: 200, notes: 1000 };
// A thread post is one Discord message, at most 2000 characters with the status line.
const UPDATE_LIMITS = { message: 1800, status: 40 };

// Files ride on Discord messages, so Discord's limits apply per post: 10 files, and a total
// size set by the server's boost level (10 MB without boosts).
const UPLOADS = {
  maxFiles: 10,
  maxBytes: (Number(process.env.DISCORD_MAX_UPLOAD_MB) || 10) * 1_000_000,
};

// Uploaded files wait in memory until Discord has them. In mock mode memory is all there is.
let heldBytes = 0;
const MAX_HELD_BYTES = 200_000_000;

// Discord's file links expire after about a day, so the server refreshes them after an hour.
const LINK_TTL_MS = 60 * 60 * 1000;

// Image types Discord can show inside an embed. Other files, SVG and HEIC included, stay plain
// attachments; an embed pointing at one of those would hide the file instead of showing it.
const EMBEDDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const totalSize = (files) => files.reduce((n, f) => n + f.size, 0);
const meta = ({ name, type, size }) => ({ name, type, size });
const fromDiscord = (a) => ({ name: a.filename, type: a.content_type ?? 'application/octet-stream', size: a.size, url: a.url });

const nextId = () => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `RD-${d}-${String(++counter).padStart(4, '0')}`;
};

// One shape for records, whether just created or read back from Discord.
const makeRecord = (r) => ({
  recordId: r.recordId,
  division: r.division,
  itemCount: r.itemCount,
  customerName: r.customerName ?? null,   // stored encrypted, never in the visible embed
  notes: r.notes ?? null,
  status: r.status,
  occurredAt: r.occurredAt,
  fileCount: r.fileCount ?? r.attachments?.length ?? 0,   // files sent through the API
  attachments: r.attachments ?? [],                        // [{ name, type, size }], from the thread
});

const uploads = (files) => (files.length ? { attachments: files.map((f, id) => ({ id, filename: f.name })) } : {});

// The record's channel message. The embed shows only allowlisted fields; the footer carries the
// whole record for the server to read back (see recordCodec.js). With threads the files live in
// the thread and the embed counts them; without, they ride on this message.
function toPayload(record) {
  const { attachments, ...stored } = record;
  const safe = redact(stored);
  const withFiles = !threadMode && attachments.length > 0;
  const image = withFiles && attachments.find((a) => EMBEDDABLE.has(a.type));
  const fields = [
    { name: 'Division', value: safe.division, inline: true },
    { name: 'Items', value: String(safe.itemCount), inline: true },
  ];
  if (threadMode && safe.fileCount > 0) fields.push({ name: 'Files', value: `${safe.fileCount} in thread`, inline: true });
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${safe.recordId} — ${safe.status}`,
      color: 0x1f3864,
      fields,
      ...(image && { image: { url: `attachment://${image.name}` } }),
      footer: { text: codec.encode(stored) },
      timestamp: safe.occurredAt,
    }],
    ...(withFiles ? uploads(attachments) : {}),
  };
}

// The first post in a record's thread: what the channel shows, plus the files.
function copyPayload(record, files) {
  const { attachments, ...stored } = record;
  const safe = redact(stored);
  const image = files.find((f) => EMBEDDABLE.has(f.type));
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Copy of ${safe.recordId}`,
      color: 0x1f3864,
      fields: [
        { name: 'Division', value: safe.division, inline: true },
        { name: 'Items', value: String(safe.itemCount), inline: true },
        { name: 'Status', value: safe.status, inline: true },
      ],
      ...(image && { image: { url: `attachment://${image.name}` } }),
      timestamp: safe.occurredAt,
    }],
    ...uploads(files),
  };
}

// Later posts: the update's text and files. Mentions are off, so form text can't ping @everyone.
function updatePayload(post) {
  return { allowed_mentions: { parse: [] }, ...(post.text ? { content: post.text } : {}), ...uploads(post.files) };
}

// JSON as before, or multipart/form-data when files come along: the same fields plus files.
async function readRequest(req) {
  if (!req.is('multipart/form-data')) return { body: req.body ?? {}, files: [] };
  const form = await new Response(req.body, { headers: { 'content-type': req.get('content-type') } }).formData();
  const body = {};
  const files = [];
  for (const [key, value] of form) {
    if (typeof value === 'string') {
      body[key] = value;
    } else if (value.name) {
      const data = Buffer.from(await value.arrayBuffer());
      files.push({ name: value.name, type: value.type || 'application/octet-stream', size: data.length, data });
    }
  }
  if (typeof body.itemCount === 'string' && body.itemCount.trim() !== '') body.itemCount = Number(body.itemCount);
  return { body, files };
}

// Discord matches attachment://name exactly, so names are kept to plain characters and made unique.
function safeNames(files) {
  const taken = new Set();
  return files.map((file) => {
    const dot = file.name.lastIndexOf('.');
    const base = (dot > 0 ? file.name.slice(0, dot) : file.name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'file';
    const ext = dot > 0 ? file.name.slice(dot + 1).replace(/[^A-Za-z0-9]+/g, '').slice(0, 10) : '';
    const named = (suffix) => `${base}${suffix}${ext ? `.${ext}` : ''}`;
    let name = named('');
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = named(`-${i}`);
    taken.add(name.toLowerCase());
    return { ...file, name };
  });
}

// The same checks for files wherever they're uploaded. Returns an error response, or null.
function checkFiles(files) {
  if (files.length > UPLOADS.maxFiles) {
    return [400, `a post can have at most ${UPLOADS.maxFiles} attachments`];
  }
  const bytes = totalSize(files);
  if (bytes > UPLOADS.maxBytes) {
    return [413, `attachments add up to ${mb(bytes)}; Discord takes ${mb(UPLOADS.maxBytes)} per message on this server`];
  }
  if (heldBytes + bytes > MAX_HELD_BYTES) {
    return [503, 'too many attachments are still waiting to reach Discord. Try again in a minute'];
  }
  return null;
}

// ---------- threads ----------

const allFiles = (t) => (t?.posts ?? []).flatMap((p) => p.files);

function newPost(kind, text, files, local) {
  heldBytes += totalSize(files);
  return { id: null, at: new Date().toISOString(), kind, author: null, text, state: local ? 'local' : 'pending', error: null, files, linksAt: 0 };
}

// Discord has the files now, so their bytes can leave memory.
function dropData(post) {
  for (const f of post.files) {
    if (f.data) {
      heldBytes -= f.size;
      delete f.data;
    }
  }
}

function syncAttachments(record) {
  const t = threads.get(record.recordId);
  if (t?.posts) record.attachments = allFiles(t).map(meta);
}

async function sendPost(record, t, post) {
  const payload = post.kind === 'copy' ? copyPayload(record, post.files) : updatePayload(post);
  try {
    const result = await notify(payload, { files: post.files, threadId: t.id });
    post.id = result.messageId;
    post.state = 'sent';
    post.error = null;
    (result.attachments ?? []).forEach((a, i) => { if (post.files[i]) post.files[i].url = a.url; });
    post.linksAt = Date.now();
    dropData(post);
  } catch (err) {
    post.state = 'failed';
    post.error = err.message;
    throw err;
  }
}

// Makes sure a record's thread exists and holds every post: starts the thread on the record's
// message (named after the record), then sends whatever hasn't reached Discord yet, in order.
// Safe to call again; it picks up where it stopped.
function ensureThread(record) {
  const t = threads.get(record.recordId);
  const d = deliveries.get(record.recordId);
  if (!threadMode || t?.source !== 'thread' || !d?.messageId) return Promise.resolve();
  if (t.busy) return t.busy;
  t.busy = (async () => {
    try {
      if (!t.id) {
        t.state = 'creating';
        t.id = (await startThread(d.messageId, record.recordId)).id;
      }
      if (t.posts && !t.posts.some((p) => p.kind === 'copy')) t.posts.unshift(newPost('copy', '', [], false));
      t.state = 'posting';
      for (let i = 0; i < (t.posts?.length ?? 0); i++) {
        const post = t.posts[i];
        if (post.state === 'pending' || post.state === 'failed') await sendPost(record, t, post);
      }
      t.state = 'ready';
      t.error = null;
    } catch (err) {
      t.state = 'failed';
      t.error = err.message;
      console.warn(`[thread] ${record.recordId}: ${err.message}`);
    }
  })().finally(() => {
    t.busy = null;
    if (t.state === 'ready' && t.posts?.some((p) => p.state === 'pending')) ensureThread(record);
  });
  return t.busy;
}

// Keeps the channel message in step with the record: new status, new file count.
function updateMessage(record) {
  const d = deliveries.get(record.recordId);
  if (!d) return;
  if (!d.messageId) {   // not stored yet; edited as soon as it is
    d.needsEdit = true;
    return;
  }
  d.needsEdit = false;
  try {
    d.payload = toPayload(record);
  } catch (err) {
    d.editError = err.message;
    return;
  }
  editMessage(d.messageId, d.payload)
    .then(() => { d.editError = null; })
    .catch((err) => {
      d.editError = err.message;
      console.warn(`[discord] ${record.recordId}: editing the channel message failed: ${err.message}`);
    });
}

// Reads a record's thread back from Discord: the copy, every update, and anything people posted
// there themselves, with fresh file links. Posts not in Discord yet are kept at the end.
async function loadThread(record, t) {
  if (t.source === 'message') {
    const copy = t.posts[0];
    if (!copy?.id) return;
    const message = await fetchMessage(copy.id);
    copy.files = (message.attachments ?? []).map(fromDiscord);
    copy.linksAt = Date.now();
  } else if (t.source === 'thread' && t.id) {
    const messages = await threadMessages(t.id);
    const unsent = (t.posts ?? []).filter((p) => p.state !== 'sent');
    const now = Date.now();
    t.posts = messages
      .filter((m) => m.type === 0 || m.type === 19)   // normal messages and replies, not system notices
      .map((m) => {
        const ours = m.webhook_id === webhookId;
        return {
          id: m.id,
          at: m.timestamp,
          kind: !ours ? 'reply' : m.embeds?.[0]?.title?.startsWith('Copy of ') ? 'copy' : 'update',
          author: ours ? null : m.author?.global_name ?? m.author?.username ?? null,
          text: m.content ?? '',
          state: 'sent',
          error: null,
          files: (m.attachments ?? []).map(fromDiscord),
          linksAt: now,
        };
      })
      .concat(unsent);
  }
  t.loadedAt = Date.now();
  syncAttachments(record);
}

function threadView(t) {
  let n = 0;
  return {
    id: t.id,
    state: t.state,
    error: t.error,
    source: t.source,
    posts: t.posts === null ? null : t.posts.map((p) => ({
      id: p.id,
      at: p.at,
      kind: p.kind,
      author: p.author,
      text: p.text,
      state: p.state,
      error: p.error,
      files: p.files.map((f) => ({ ...meta(f), n: n++ })),   // n: its number for /files/:n
    })),
  };
}

const threadSummary = (t) => (t ? {
  id: t.id,
  state: t.state,
  error: t.error,
  source: t.source,
  posts: t.posts?.length ?? null,
  pending: t.posts?.filter((p) => p.state === 'pending').length ?? 0,
} : null);

const findRecord = (id) => records.find((r) => r.recordId === id);

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ ok: true, records: records.length }));

const multipart = express.raw({ type: 'multipart/form-data', limit: UPLOADS.maxBytes + 1_000_000 });

app.post('/api/records', multipart, async (req, res, next) => {
  try {
    if (writesToDiscord && storage.error) {
      return res.status(503).json({ error: `records couldn't be read from Discord, so a new one could reuse an existing id. ${storage.error}` });
    }

    let body;
    let uploaded;
    try {
      ({ body, files: uploaded } = await readRequest(req));
    } catch {
      return res.status(400).json({ error: "the uploaded form couldn't be read" });
    }
    const { division, itemCount, customerName, notes } = body;

    if (!division || typeof division !== 'string') {
      return res.status(400).json({ error: 'division is required' });
    }
    if (!Number.isInteger(itemCount) || itemCount < 1) {
      return res.status(400).json({ error: 'itemCount must be a positive integer' });
    }
    for (const [field, max] of Object.entries(LIMITS)) {
      const value = body[field];
      if (value != null && (typeof value !== 'string' || value.length > max)) {
        return res.status(400).json({ error: `${field} must be text of at most ${max} characters` });
      }
    }
    const problem = checkFiles(uploaded);
    if (problem) return res.status(problem[0]).json({ error: problem[1] });
    const files = safeNames(uploaded);

    const record = makeRecord({
      recordId: nextId(),
      division,
      itemCount,
      customerName,
      notes,
      status: 'received',
      occurredAt: new Date().toISOString(),
      fileCount: files.length,
      attachments: files.map(meta),
    });

    let payload;
    try {
      payload = toPayload(record);   // before answering, so a record too big for Discord is a 400
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    records.push(record);

    const source = threadMode ? 'thread' : writesToDiscord ? 'message' : 'local';
    const thread = {
      id: null,
      source,
      state: source === 'thread' ? 'waiting' : source,
      error: null,
      loadedAt: Date.now(),
      busy: null,
      posts: [newPost('copy', '', files, source === 'local')],
    };
    threads.set(record.recordId, thread);

    // 1. Answer the caller first. 2. Notify after. Never the other way round.
    // When Discord is the database that means 202: accepted, stored once Discord confirms.
    res.status(writesToDiscord ? 202 : 201).json({ recordId: record.recordId, status: record.status });

    const delivery = { recordId: record.recordId, state: 'queued', attempts: 0, note: null, error: null, messageId: null, payload };
    deliveries.set(record.recordId, delivery);

    notify(payload, { onUpdate: (update) => Object.assign(delivery, update), files: source === 'message' ? files : [] })
      .then((result) => {
        delivery.state = result.skipped ? 'skipped' : result.mocked ? 'mocked' : 'sent';
        delivery.attempts = result.attempts ?? 1;
        delivery.messageId = result.messageId ?? null;
        delivery.note = null;
        if (source === 'message' && result.messageId) {   // the files went with this message
          const copy = thread.posts[0];
          copy.id = result.messageId;
          copy.state = 'sent';
          (result.attachments ?? []).forEach((a, i) => { if (copy.files[i]) copy.files[i].url = a.url; });
          copy.linksAt = Date.now();
          dropData(copy);
        }
        if (delivery.needsEdit) updateMessage(record);
        ensureThread(record);
      })
      .catch((err) => {
        delivery.state = 'failed';
        delivery.error = err.message;
        delivery.note = null;
        console.warn('[discord] notify failed:', err.message);
      });
  } catch (err) {
    next(err);
  }
});

app.get('/api/records', (_req, res) => res.json({ count: records.length, records }));

// After a 202, this says whether the record has reached Discord yet.
app.get('/api/records/:id', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return res.status(404).json({ error: 'no such record' });
  const delivery = deliveries.get(record.recordId);
  res.json({
    record,
    inDiscord: delivery?.state === 'sent',
    messageId: delivery?.messageId ?? null,
    thread: threadSummary(threads.get(record.recordId)),
  });
});

// The record's thread: the copy, every update and every reply, with each file's number.
// Read from Discord the first time, after an hour, or with ?refresh=1.
app.get('/api/records/:id/thread', async (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return res.status(404).json({ error: 'no such record' });
  const t = threads.get(record.recordId);
  if (!t) return res.json({ recordId: record.recordId, thread: null });
  try {
    const stale = Date.now() - t.loadedAt > LINK_TTL_MS;
    if (t.source === 'thread' && t.id && !t.busy && (t.posts === null || stale || req.query.refresh)) {
      await loadThread(record, t);
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  res.json({ recordId: record.recordId, thread: threadView(t) });
});

// Adds to a record's thread: a message, a new status, files, or any mix. A new status also
// updates the record and its channel message.
app.post('/api/records/:id/thread', multipart, async (req, res, next) => {
  try {
    const record = findRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'no such record' });
    const t = threads.get(record.recordId);
    if (!t || t.source === 'message') {
      return res.status(409).json({ error: 'threads need DISCORD_BOT_TOKEN, so this record has none' });
    }
    if (t.source === 'thread' && !threadMode) {
      return res.status(409).json({ error: 'sending to Discord is off (DISCORD_ENABLED), so nothing can be posted' });
    }

    let body;
    let uploaded;
    try {
      ({ body, files: uploaded } = await readRequest(req));
    } catch {
      return res.status(400).json({ error: "the uploaded form couldn't be read" });
    }
    for (const [field, max] of Object.entries(UPDATE_LIMITS)) {
      const value = body[field];
      if (value != null && (typeof value !== 'string' || value.length > max)) {
        return res.status(400).json({ error: `${field} must be text of at most ${max} characters` });
      }
    }
    const message = (body.message ?? '').trim();
    const status = (body.status ?? '').trim();
    const problem = checkFiles(uploaded);
    if (problem) return res.status(problem[0]).json({ error: problem[1] });
    const changed = status && status !== record.status ? { from: record.status, to: status } : null;
    if (!message && !changed && uploaded.length === 0) {
      return res.status(400).json({ error: 'send a message, a new status or files' });
    }

    try {
      if (t.posts === null) await loadThread(record, t);   // keep the new post after what's already there
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const files = safeNames(uploaded);
    const text = [changed && `**Status:** ${changed.from} → ${changed.to}`, message].filter(Boolean).join('\n');
    t.posts.push(newPost('update', text, files, t.source === 'local'));
    if (changed) record.status = status;
    record.fileCount += files.length;
    syncAttachments(record);

    res.status(t.source === 'local' ? 201 : 202).json({ recordId: record.recordId, status: record.status, post: t.posts.length - 1 });

    if (t.source === 'thread') {
      if (changed || files.length) updateMessage(record);
      ensureThread(record);
    }
  } catch (err) {
    next(err);
  }
});

// Starts a missing thread, or finishes one that failed part way, e.g. after fixing permissions.
app.post('/api/records/:id/thread/retry', (req, res) => {
  const record = findRecord(req.params.id);
  const t = record && threads.get(record.recordId);
  if (!t) return res.status(404).json({ error: 'no such record' });
  if (t.source !== 'thread' || !threadMode) return res.status(409).json({ error: 'threads need live mode and DISCORD_BOT_TOKEN' });
  if (t.posts === null) t.posts = [];
  ensureThread(record);
  res.status(202).json({ recordId: record.recordId, thread: threadSummary(t) });
});

// Opens file n of a record (0 is the first), counting across its whole thread. Files still waiting
// for Discord come from memory; after that the server redirects to a fresh Discord link.
app.get('/api/records/:id/files/:n', async (req, res) => {
  const n = Number(req.params.n);
  const record = findRecord(req.params.id);
  const t = record && threads.get(record.recordId);
  if (!t) return res.status(404).json({ error: 'no such attachment' });
  try {
    if (t.posts === null) await loadThread(record, t);
    let file = allFiles(t)[n];
    if (!file) return res.status(404).json({ error: 'no such attachment' });
    if (file.data) {
      res.type(file.type);
      res.set('Content-Disposition', `inline; filename="${file.name}"`);
      return res.send(file.data);
    }
    const post = t.posts.find((p) => p.files.includes(file));
    if (!file.url || Date.now() - post.linksAt > LINK_TTL_MS) {
      await loadThread(record, t);
      file = allFiles(t)[n];
    }
    if (!file?.url) return res.status(404).json({ error: 'the file is no longer in Discord' });
    res.redirect(302, file.url);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Switch positions, storage, queue and delivery outcomes for the test page. Never the webhook URL.
app.get('/api/discord', (_req, res) => res.json({
  mode,
  enabled: process.env.DISCORD_ENABLED === 'true',
  webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL),
  threads: threadMode,
  allowed: [...ALLOWED],
  uploads: UPLOADS,
  storage,
  queue: queueStats(),
  deliveries: [...deliveries.values()].map((d) => ({ ...d, thread: threadSummary(threads.get(d.recordId)) })),
}));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "the request body isn't valid JSON" });
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `the request is too large; attachments can add up to ${mb(UPLOADS.maxBytes)}` });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// Rebuilds the list from the channel: every message our webhook posted carries its record.
// Threads are read later, when a record is opened, so startup stays one pass over the channel.
async function loadFromDiscord() {
  if (!canReadBack) return;
  try {
    const { scanned, messages } = await readHistory();
    for (const message of messages.reverse()) {   // oldest first
      const embed = message.embeds?.[0];
      const seq = embed?.title?.match(/^RD-\d{8}-(\d+)/)?.[1];
      if (seq) counter = Math.max(counter, Number(seq));   // even if unreadable, its id is taken

      let decoded;
      try {
        decoded = codec.decode(embed?.footer?.text);
      } catch {
        storage.unreadable += 1;
        continue;
      }
      if (!decoded) continue;   // not a record, e.g. a message from before this format

      const onMessage = (message.attachments ?? []).map(fromDiscord);   // files from before threads
      const record = makeRecord({ ...decoded.record, attachments: onMessage.map(meta) });
      if (decoded.locked) storage.locked += 1;
      records.push(record);

      let thread;
      if (message.thread?.id) {
        thread = { id: message.thread.id, source: 'thread', state: 'ready', posts: null };
      } else if (onMessage.length) {
        const copy = { id: message.id, at: message.timestamp, kind: 'copy', author: null, text: '', state: 'sent', error: null, files: onMessage, linksAt: Date.now() };
        thread = { id: null, source: 'message', state: 'message', posts: [copy] };
      } else {
        thread = { id: null, source: threadMode ? 'thread' : 'local', state: threadMode ? 'none' : 'local', posts: [] };
      }
      threads.set(record.recordId, { error: null, loadedAt: thread.posts ? Date.now() : 0, busy: null, ...thread });

      deliveries.set(record.recordId, {
        recordId: record.recordId,
        state: 'sent',
        attempts: 1,
        note: null,
        error: null,
        messageId: message.id,
        payload: { embeds: [embed] },
      });
    }
    storage.loaded = records.length;
    storage.scanned = scanned;
    console.log(`[store] loaded ${records.length} record(s) from Discord, ${scanned} message(s) scanned`);
    if (storage.unreadable) console.warn(`[store] ${storage.unreadable} record(s) didn't decrypt. Is RECORD_SECRET the one they were written with?`);
  } catch (err) {
    storage.error = err.message;
    console.error('[store] could not read records from Discord:', err.message);
  }
}

const port = process.env.PORT || 4000;
if (require.main === module) {
  if (writesToDiscord && !codec.encrypts) console.warn("[store] RECORD_SECRET isn't set: customerName and notes won't be stored in Discord");
  if (writesToDiscord && !canReadBack) console.warn("[store] DISCORD_BOT_TOKEN isn't set: records are written to Discord but can't be read back, and get no threads");
  // Read Discord before accepting records or orders, so new ids continue after the stored ones.
  Promise.all([loadFromDiscord(), orders.load()]).then(() => {
    app.listen(port, () => console.log(`record_database listening on :${port}`));
  });
}

module.exports = app;
