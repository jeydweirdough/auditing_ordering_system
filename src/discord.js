// One door to Discord: a webhook that posts through a queue kept within Discord's limits, and,
// with a bot token, reading the channel and its threads back. src/orderAudit.js makes one for
// #order-audit.
const { DiscordQueue } = require('./discordQueue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LiveDiscord {
  constructor(url, { botToken, ...limits } = {}) {
    if (!url) throw new Error('DISCORD_AUDIT_WEBHOOK_URL missing while DISCORD_MODE=live');
    this.url = url;
    this.hook = parseWebhookUrl(url);
    this.botToken = botToken;
    this.channelId = null;
    this.botLine = Promise.resolve();   // bot writes go one at a time, like the webhook queue
    this.queue = new DiscordQueue((job) => this.send(job), limits);
  }

  // Joins the queue. Resolves once Discord has stored the message, rejects if it never does.
  // threadId posts into that thread instead of the channel.
  async post(payload, { onUpdate, files = [], threadId } = {}) {
    const { attempts, text } = await this.queue.push({ kind: 'post', payload, files, threadId }, onUpdate);
    const message = text ? JSON.parse(text) : null;
    return { ok: true, attempts, messageId: message?.id ?? null, attachments: message?.attachments ?? [] };
  }

  // Replaces the content of a message this webhook posted. Goes through the same queue.
  async edit(messageId, payload, { onUpdate } = {}) {
    const { attempts } = await this.queue.push({ kind: 'edit', payload, files: [], messageId }, onUpdate);
    return { ok: true, attempts };
  }

  // Exactly one HTTP call, no retries. The queue decides when to call it and what the answer
  // means. ?wait=true makes Discord answer 200 with the stored message, which carries its id.
  // Files go as multipart/form-data, the way Discord takes uploads. Posting into an archived
  // thread reopens it.
  async send({ kind, payload, files, threadId, messageId }) {
    const url = new URL(this.url);
    if (kind === 'edit') url.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${messageId}`;
    else url.searchParams.set('wait', 'true');
    if (threadId) url.searchParams.set('thread_id', threadId);

    let body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (files.length) {
      body = new FormData();
      body.append('payload_json', JSON.stringify(payload));
      files.forEach((f, i) => body.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
      delete headers['Content-Type'];   // fetch sets the multipart boundary itself
    }
    const res = await fetch(url, {
      method: kind === 'edit' ? 'PATCH' : 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(files.length ? 60_000 : 10_000),   // a hung request would stall the whole queue
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  // One message this webhook posted in the channel, with fresh attachment links. Needs no bot token.
  fetchMessage(messageId) {
    const { api, id, token } = this.hook;
    return request('GET', `${api}/webhooks/${id}/${token}/messages/${messageId}`);
  }

  // The channel the webhook posts to, looked up once.
  async channel() {
    if (!this.channelId) {
      const { api, id, token } = this.hook;
      this.channelId = (await request('GET', `${api}/webhooks/${id}/${token}`)).channel_id;
    }
    return this.channelId;
  }

  // Starts a public thread on one of our messages. A thread started from a message has the
  // message's id. Needs the bot's Create Public Threads permission.
  startThread(messageId, name) {
    const run = async () => {
      const channelId = await this.channel();
      try {
        return await request('POST', `${this.hook.api}/channels/${channelId}/messages/${messageId}/threads`, this.botToken, {
          name,
          auto_archive_duration: 10080,   // a week without activity; posting reopens it
        });
      } catch (err) {
        if (err.code === 160004) return { id: messageId };   // already has a thread, e.g. on a retry
        throw err;
      }
    };
    const result = this.botLine.then(run, run);
    this.botLine = result.catch(() => {});
    return result;
  }

  // The bot's own user, to tell its messages from anyone else's.
  async me() {
    this.botUser ??= await request('GET', `${this.hook.api}/users/@me`, this.botToken);
    return this.botUser;
  }

  // Posts as the bot, one at a time with its other writes. A payload with message_reference is a
  // reply. Posting in a thread needs the bot's Send Messages in Threads permission.
  sendAsBot(channelId, payload) {
    const run = async () => {
      try {
        return await request('POST', `${this.hook.api}/channels/${channelId}/messages`, this.botToken, payload);
      } catch (err) {
        if (err.status === 403) err.message = "The bot can't post in the thread (403). Invite it again with Send Messages in Threads";
        throw err;
      }
    };
    const result = this.botLine.then(run, run);
    this.botLine = result.catch(() => {});
    return result;
  }

  // Every message in a thread, oldest first.
  async threadMessages(threadId) {
    const all = [];
    let before = null;
    for (;;) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const page = await request('GET', `${this.hook.api}/channels/${threadId}/messages?${query}`, this.botToken);
      all.push(...page);
      if (page.length < 100) break;
      before = page.at(-1).id;
    }
    return all.reverse();
  }

  // Every message this webhook posted in its channel. A webhook can post but can't list
  // messages, so this needs a bot token.
  async history() {
    const channelId = await this.channel();
    const messages = [];
    let scanned = 0;
    let before = null;
    for (;;) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const page = await request('GET', `${this.hook.api}/channels/${channelId}/messages?${query}`, this.botToken);
      scanned += page.length;
      messages.push(...page.filter((m) => m.webhook_id === this.hook.id));   // skip people, bots, other webhooks
      if (page.length < 100) break;
      before = page.at(-1).id;                                              // newest first, so page backwards
    }
    if (messages.length && messages.every((m) => !m.content && !m.embeds?.length)) {
      throw new Error('Discord sent the messages back empty. Turn on Message Content Intent on the bot page in the Developer Portal');
    }
    return { scanned, messages };
  }
}

// https://discord.com/api/webhooks/{id}/{token} -> its parts, plus the API base on the same host.
function parseWebhookUrl(url) {
  const u = new URL(url);
  const match = u.pathname.match(/\/webhooks\/(\d+)\/([^/]+)/);
  if (!match) throw new Error('DISCORD_AUDIT_WEBHOOK_URL does not look like a Discord webhook URL');
  return { api: `${u.origin}/api/v10`, id: match[1], token: match[2] };
}

// One Discord API call with its rate limits respected. Errors carry Discord's status and code
// but never the URL, because the webhook URL contains its token.
async function request(method, url, botToken, body) {
  for (let attempt = 1; ; attempt++) {
    const headers = {};
    if (botToken) headers.Authorization = `Bot ${botToken}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep((Number(res.headers.get('retry-after')) || 1) * 1000);
      continue;
    }
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      const err = new Error(explain(res.status, url));
      err.status = res.status;
      err.code = info.code;
      throw err;
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      await sleep((Number(res.headers.get('x-ratelimit-reset-after')) || 0) * 1000);
    }
    return res.json();
  }
}

function explain(status, url) {
  const what = url.includes('/threads') ? 'thread'
    : url.includes('/channels/') ? 'channel'
    : url.includes('/messages/') ? 'message'
    : 'webhook';
  if (status === 401 && (what === 'channel' || what === 'thread')) return 'Discord refused DISCORD_BOT_TOKEN (401). Copy it again from the bot page';
  if (status === 403 && what === 'thread') return "The bot can't start threads (403). Invite it again with Create Public Threads";
  if (status === 403) return "The bot can't see the channel (403). Add it to the server with View Channels and Read Message History";
  if (status === 404 && what === 'message') return 'Discord no longer has that message (404). It may have been deleted';
  if (status === 404 && what === 'webhook') return "Discord doesn't know this webhook (404). Check DISCORD_AUDIT_WEBHOOK_URL";
  if (status === 404) return 'Discord no longer has that message or thread (404). It may have been deleted';
  return `Discord answered ${status} while reading ${what === 'channel' ? 'the channel' : `a ${what}`}`;
}

module.exports = { LiveDiscord };
