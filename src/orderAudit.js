// Discord is where orders are kept. Each order has a thread in #order-audit, named with its order
// id, and every step is two posts in it:
//   1. the step, for people: what happened, the status change, who took it and when;
//   2. a reply holding the order's data as JSON: the whole order as it stood after that step, and
//      the step itself (src/orderCodec.js).
// The newest reply is the order, and the replies together are its history. On startup the server
// reads the channel and each order's thread and rebuilds every order from them. That needs
// DISCORD_BOT_TOKEN; without it orders are only in memory and are lost when the server stops.
//
// The reply is a real Discord reply from the bot when the bot may post in threads (Send Messages
// in Threads). Otherwise the webhook posts it as the next message, which reads back the same way.
// While the bot can't start an order's thread, both posts go into the channel, with the order id
// in the step's title.
//
// A step is only stored once both posts are in Discord. Until then it's in memory, shown as
// waiting on the page, and sent again, in order, with the order's next step or from Send again.
//
// Changes made on the Admin side (orders created, edited, deleted or restored; accounts) also get a
// line in the "Admin log" thread in the same channel. It's a log for people, not storage.
const { LiveDiscord } = require('./discord');
const { jsonIn, isDataFile } = require('./orderCodec');

const COLOR = 0x1f3864;
const ORDER_ID = /^ORD-\d{8}-\d{4}$/;
const CHANNEL_STEP = /^(ORD-\d{8}-\d{4}) · /;
const ADMIN_LOG = 'Admin log';

// Follows the same switches as the records: DISCORD_ENABLED, then DISCORD_MODE.
function buildTransport(env = process.env) {
  if (env.DISCORD_ENABLED !== 'true') return { mode: 'off', threads: false };
  if ((env.DISCORD_MODE || 'mock').toLowerCase() !== 'live') return { mode: 'mock', threads: false };
  if (!env.DISCORD_AUDIT_WEBHOOK_URL) {
    console.warn('[orders] DISCORD_AUDIT_WEBHOOK_URL is not set, so orders are kept in memory only.');
    return { mode: 'off', threads: false };
  }
  const perMinute = Number(env.DISCORD_MAX_PER_MINUTE);
  try {
    const live = new LiveDiscord(env.DISCORD_AUDIT_WEBHOOK_URL, {
      botToken: env.DISCORD_BOT_TOKEN || undefined,
      ...(perMinute > 0 && { perMinute }),
    });
    return { mode: 'live', live, threads: Boolean(env.DISCORD_BOT_TOKEN) };
  } catch {
    console.warn("[orders] DISCORD_AUDIT_WEBHOOK_URL doesn't look like a Discord webhook URL, so orders are kept in memory only.");
    return { mode: 'off', threads: false };
  }
}

// Where orders live: in Discord, written to Discord but not readable back, or in memory only.
const storageKind = (t) => (t.mode !== 'live' ? 'memory' : t.threads ? 'discord' : 'discord-write-only');

// The order's own fields as they stand now: what a data reply holds, without the step history.
function snapshotOf(order) {
  const { events, discord, locked, ...fields } = order;
  return structuredClone(fields);
}

// A step without its Discord bookkeeping. Its snapshot isn't enumerable, so it's left out too.
const publicStep = ({ discord, ...step }) => step;

async function eachLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function createOrderAudit({ transport, codec, getOrder, statusLabel, roleLabel }) {
  const lines = new Map();   // order id, or the Admin log -> the promise its next send waits on
  let replyAsBot = transport.threads;   // off for the rest of this run if the bot may not post in threads
  const adminLog = { starterMessageId: null, threadId: null, pending: [] };

  // One thing at a time per key, in order. Never rejects.
  function inLine(key, fn) {
    const previous = lines.get(key) ?? Promise.resolve();
    const next = previous.then(fn).catch((err) => {
      console.warn(`[orders] ${key}: ${err.message}`);
    });
    lines.set(key, next);
    next.then(() => { if (lines.get(key) === next) lines.delete(key); });
    return next;
  }

  const starterPayload = (title, description) => ({
    allowed_mentions: { parse: [] },
    embeds: [{ title, description, color: COLOR }],
  });

  // "A → B" for a status change, and which fields an Admin edit changed (names, never values).
  function changeText(step) {
    const parts = [];
    if (step.from && step.to && step.from !== step.to) parts.push(`${statusLabel(step.from)} → ${statusLabel(step.to)}`);
    const changed = (step.details?.changed ?? []).filter((c) => c !== 'Status');
    if (changed.length) parts.push(`Changed: ${changed.join(', ')}`);
    if (!parts.length && step.to) parts.push(`Status: ${statusLabel(step.to)}`);
    return parts.join('\n');
  }

  // What people read. Only the fields named here go into the step's post.
  function stepPayload(order, step, inThread) {
    const text = changeText(step);
    return {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: (inThread ? step.label : `${order.id} · ${step.label}`).slice(0, 256),
        ...(text && { description: text.slice(0, 4096) }),
        color: COLOR,
        footer: { text: `${String(step.actor.name).slice(0, 200)} · ${roleLabel(step.actor.role)}` },
        timestamp: step.at,
      }],
    };
  }

  async function threadFor(order) {
    if (!transport.threads) return null;
    order.discord ??= {};
    if (order.discord.threadId) return order.discord.threadId;
    try {
      // The starter is kept before the thread is started, so a failure between the two retries
      // on the same message rather than posting a second starter.
      order.discord.starterMessageId ??= (await transport.live.post(
        starterPayload(order.id, 'Audit trail. Every step on this order is posted in its thread.'),
      )).messageId;
      const thread = await transport.live.startThread(order.discord.starterMessageId, order.id);
      order.discord.threadId = thread.id;
      order.discord.threadError = null;
      return thread.id;
    } catch (err) {
      order.discord.threadError = err.message;
      console.warn(`[orders] ${order.id}: no thread yet (${err.message}), so steps go into the channel.`);
      return null;
    }
  }

  // The data for one step, as a reply to its post when the bot may, otherwise as the next message.
  async function postData(order, step, threadId) {
    const { content, file } = codec.toMessage(codec.pack(step.snapshot ?? snapshotOf(order), publicStep(step)));
    if (threadId && replyAsBot && !file) {
      try {
        const reply = await transport.live.sendAsBot(threadId, {
          content,
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: { message_id: step.discord.messageId, fail_if_not_exists: false },
        });
        return { id: reply.id, asReply: true };
      } catch (err) {
        if (err.status !== 403) throw err;
        replyAsBot = false;
        console.warn(`[orders] ${err.message}. Order data is posted by the webhook as the next message instead.`);
      }
    }
    const payload = { allowed_mentions: { parse: [] }, content, ...(file && { attachments: [{ id: 0, filename: file.name }] }) };
    const { messageId } = await transport.live.post(payload, { files: file ? [file] : [], ...(threadId && { threadId }) });
    return { id: messageId, asReply: false };
  }

  async function run(orderId) {
    const order = getOrder(orderId);
    if (!order) return;

    if (transport.mode === 'mock') {
      for (const step of order.events) {
        if (step.discord?.state !== 'mocked' || step.discord.logged) continue;
        const e = stepPayload(order, step, true).embeds[0];
        console.log(`[discord:mock] ${order.id} thread: ${e.title}${e.description ? ` · ${e.description.replace(/\n/g, ' · ')}` : ''} · ${e.footer.text}, then its data`);
        step.discord.logged = true;
      }
      return;
    }
    if (transport.mode !== 'live') return;

    const pending = order.events.filter((s) => ['queued', 'sending', 'failed'].includes(s.discord?.state));
    if (!pending.length) return;
    const threadId = await threadFor(order);

    for (let i = 0; i < pending.length; i++) {
      const step = pending[i];
      step.discord = { ...step.discord, state: 'sending', error: null };
      try {
        if (!step.discord.messageId) {
          const { messageId } = await transport.live.post(stepPayload(order, step, Boolean(threadId)), threadId ? { threadId } : {});
          Object.assign(step.discord, { messageId, inThread: Boolean(threadId) });
        }
        if (!step.discord.dataMessageId) {
          const data = await postData(order, step, step.discord.inThread ? threadId : null);
          Object.assign(step.discord, { dataMessageId: data.id, asReply: data.asReply });
        }
        step.discord.state = 'sent';
        delete step.snapshot;
      } catch (err) {
        Object.assign(step.discord, { state: 'failed', error: err.message });
        console.warn(`[orders] ${order.id} step ${step.seq} (${step.label}) not stored in Discord: ${err.message}`);
        // Later steps wait, so the thread stays in the order things happened.
        for (const later of pending.slice(i + 1)) Object.assign(later.discord, { state: 'failed', error: 'Waiting for an earlier step to reach Discord.' });
        return;
      }
    }
  }

  // Sends whatever this order hasn't stored yet.
  const sync = (orderId) => inLine(orderId, () => run(orderId));

  function retry(orderId) {
    const order = getOrder(orderId);
    for (const step of order?.events ?? []) if (step.discord?.state === 'failed') step.discord.state = 'queued';
    if (order?.discord) order.discord.threadError = null;
    return sync(orderId);
  }

  // ---------- the Admin log ----------

  function adminPayload(entry, inThread) {
    return {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: (inThread ? entry.title : `${ADMIN_LOG} · ${entry.title}`).slice(0, 256),
        ...(entry.description && { description: String(entry.description).slice(0, 4096) }),
        color: COLOR,
        footer: { text: `${String(entry.actor.name).slice(0, 200)} · ${roleLabel(entry.actor.role)}` },
        timestamp: entry.at,
      }],
    };
  }

  async function adminThread() {
    if (!transport.threads) return null;
    if (adminLog.threadId) return adminLog.threadId;
    try {
      adminLog.starterMessageId ??= (await transport.live.post(starterPayload(ADMIN_LOG,
        'Changes made on the Admin side: orders created, edited, deleted or restored, and accounts. Never passwords.'))).messageId;
      adminLog.threadId = (await transport.live.startThread(adminLog.starterMessageId, ADMIN_LOG)).id;
      return adminLog.threadId;
    } catch (err) {
      console.warn(`[orders] no Admin log thread yet (${err.message}), so its entries go into the channel.`);
      return null;
    }
  }

  async function postAdminLog() {
    if (!adminLog.pending.length) return;
    const threadId = await adminThread();
    while (adminLog.pending.length) {
      try {
        await transport.live.post(adminPayload(adminLog.pending[0], Boolean(threadId)), threadId ? { threadId } : {});
        adminLog.pending.shift();
      } catch (err) {
        console.warn(`[orders] an Admin log entry wasn't posted; it goes with the next one: ${err.message}`);
        return;
      }
    }
  }

  // entry: { title, description, actor: { name, role }, at }.
  function logAdmin(entry) {
    if (transport.mode === 'mock') {
      console.log(`[discord:mock] ${ADMIN_LOG}: ${entry.title}${entry.description ? ` · ${String(entry.description).replace(/\n/g, ' · ')}` : ''} · ${entry.actor.name}`);
      return Promise.resolve();
    }
    if (transport.mode !== 'live') return Promise.resolve();
    adminLog.pending.push(entry);
    return inLine(ADMIN_LOG, postAdminLog);
  }

  // ---------- reading back ----------

  // Rebuilds every order from #order-audit: the channel for each order's starter and any data
  // posted there, then each order's thread. Only our webhook's and our bot's messages count, so
  // nobody else in the channel can add to an order.
  async function load() {
    const { live } = transport;
    const [bot, { scanned, messages }] = await Promise.all([live.me(), live.history()]);
    const found = new Map();   // order id -> { starterMessageId, threadId, steps: Map(seq -> data) }
    const ids = new Set();     // every order id seen, so new ids carry on after them
    let locked = 0;
    let unreadable = 0;
    const entry = (id) => {
      ids.add(id);
      if (!found.has(id)) found.set(id, { id, starterMessageId: null, threadId: null, steps: new Map() });
      return found.get(id);
    };

    async function read(m, where) {
      let data = jsonIn(m.content);
      if (!data) {
        const file = (m.attachments ?? []).find((a) => isDataFile(a.filename));
        if (!file) return;
        const res = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`Discord's link to ${file.filename} answered ${res.status}`);
        try {
          data = JSON.parse(await res.text());
        } catch {
          return;
        }
      }
      let unpacked;
      try {
        unpacked = codec.unpack(data);
      } catch {
        unreadable += 1;
        return;
      }
      if (!unpacked) return;
      if (unpacked.locked) locked += 1;
      const e = entry(unpacked.order.id);
      if (!e.steps.has(unpacked.step.seq)) e.steps.set(unpacked.step.seq, { ...unpacked, messageId: m.id, where, asReply: m.type === 19 });
    }

    for (const m of messages.reverse()) {   // oldest first
      const title = m.embeds?.[0]?.title ?? '';
      if (ORDER_ID.test(title)) {
        const e = entry(title);
        e.starterMessageId = m.id;
        if (m.thread?.id) e.threadId = m.thread.id;
      } else if (title === ADMIN_LOG) {
        if (!adminLog.starterMessageId) Object.assign(adminLog, { starterMessageId: m.id, threadId: m.thread?.id ?? null });
      } else if (CHANNEL_STEP.test(title)) {
        ids.add(title.match(CHANNEL_STEP)[1]);
      } else {
        await read(m, 'channel');
      }
    }

    await eachLimit([...found.values()].filter((e) => e.threadId), 3, async (e) => {
      let thread;
      try {
        thread = await live.threadMessages(e.threadId);
      } catch (err) {
        if (err.status !== 404) throw err;
        console.warn(`[orders] ${e.id}: its thread is gone from Discord, so only data posted in the channel is loaded.`);
        return;
      }
      for (const m of thread) {
        if (m.webhook_id === live.hook.id || m.author?.id === bot.id) await read(m, 'thread');
      }
    });

    const orders = {};
    for (const [id, e] of found) {
      if (!e.steps.size) continue;
      const steps = [...e.steps.values()].sort((a, b) => a.step.seq - b.step.seq);
      const latest = steps.at(-1);
      orders[id] = {
        ...latest.order,
        events: steps.map((s) => ({
          ...s.step,
          discord: { state: 'sent', dataMessageId: s.messageId, inThread: s.where === 'thread', asReply: s.asReply },
        })),
        discord: { starterMessageId: e.starterMessageId, threadId: e.threadId },
        ...(latest.locked && { locked: true }),
      };
    }
    return { orders, ids: [...ids], scanned, locked, unreadable };
  }

  return {
    sync,
    retry,
    load,
    logAdmin,
    initialState: () => ({ live: 'queued', mock: 'mocked' }[transport.mode] ?? 'off'),
    describe: () => ({ mode: transport.mode, threads: transport.threads, replies: replyAsBot ? 'bot' : 'webhook' }),
  };
}

module.exports = { buildTransport, createOrderAudit, storageKind, snapshotOf };
