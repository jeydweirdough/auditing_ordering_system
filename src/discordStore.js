// Generic Discord-as-database store: each data category gets a thread in its webhook's channel,
// and the latest message in the thread is the current state. Data that fits in 2000 characters
// goes as a ```json code block; larger data goes as a .json file attachment.
//
// Usage:
//   const store = createDiscordStore({ webhookUrl, botToken, category: 'settings', threadName: 'divisions' });
//   await store.load();          // read latest state from Discord on startup
//   await store.save(data);      // post updated state to the thread
//   store.getData();             // current in-memory data
//
// Follows the same patterns as src/orderAudit.js but simplified: no per-step history, just
// latest-state snapshots.

const { LiveDiscord } = require('./discord');

const CONTENT_LIMIT = 2000;
const DATA_FILE_RE = /^data-.*\.json$/;
const COLOR = 0x1f3864;

function jsonIn(content) {
  const match = /```json\n([\s\S]+?)\n```/.exec(content ?? '');
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch { return null; }
}

function toMessage(data, label) {
  const pretty = JSON.stringify(data, null, 2);
  for (const text of [pretty, JSON.stringify(data)]) {
    const content = `\`\`\`json\n${text}\n\`\`\``;
    if (content.length <= CONTENT_LIMIT) return { content, file: null };
  }
  return {
    content: `Data for ${label} is attached as a JSON file (too large for a message).`,
    file: { name: `data-${label.replace(/\s+/g, '-').toLowerCase()}.json`, type: 'application/json', data: Buffer.from(pretty) },
  };
}

function buildTransport(webhookUrl, botToken, env = process.env) {
  if (env.DISCORD_ENABLED !== 'true') return { mode: 'off', live: null, threads: false };
  if ((env.DISCORD_MODE || 'mock').toLowerCase() !== 'live') return { mode: 'mock', live: null, threads: false };
  if (!webhookUrl) return { mode: 'off', live: null, threads: false };

  try {
    const perMinute = Number(env.DISCORD_MAX_PER_MINUTE);
    const live = new LiveDiscord(webhookUrl, {
      botToken: botToken || undefined,
      ...(perMinute > 0 && { perMinute }),
    });
    return { mode: 'live', live, threads: Boolean(botToken) };
  } catch {
    console.warn(`[discordStore] Webhook URL doesn't look like a Discord webhook, running in memory only.`);
    return { mode: 'off', live: null, threads: false };
  }
}

function createDiscordStore({ webhookUrl, botToken, category, threadName, env }) {
  const transport = buildTransport(webhookUrl, botToken, env);
  let cachedData = null;
  let discord = { starterMessageId: null, threadId: null, latestDataMessageId: null };
  let line = Promise.resolve(); // serialize writes

  function inLine(fn) {
    const next = line.then(fn).catch((err) => {
      console.warn(`[discordStore:${category}/${threadName}] ${err.message}`);
    });
    line = next;
    return next;
  }

  // ---- Load from Discord ----
  async function load() {
    if (transport.mode !== 'live' || !transport.threads) {
      return cachedData;
    }

    const { live } = transport;
    let bot, messages;
    try {
      [bot, { messages }] = await Promise.all([live.me(), live.history()]);
    } catch (err) {
      console.warn(`[discordStore:${category}/${threadName}] Cannot read history (${err.message}), using in-memory data.`);
      return cachedData;
    }

    // Find our starter message and thread by matching the embed title
    for (const m of messages.reverse()) { // oldest first
      const title = m.embeds?.[0]?.title ?? '';
      if (title === threadName) {
        discord.starterMessageId = m.id;
        if (m.thread?.id) discord.threadId = m.thread.id;
        break;
      }
    }

    if (!discord.threadId) {
      // Check channel messages directly if thread doesn't exist
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.webhook_id !== live.hook.id && m.author?.id !== bot?.id) continue;
        let data = jsonIn(m.content);
        if (!data) {
          const file = (m.attachments ?? []).find((a) => DATA_FILE_RE.test(a.filename));
          if (file) {
            try {
              const res = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
              if (res.ok) data = JSON.parse(await res.text());
            } catch {}
          }
        }
        if (data !== null) {
          cachedData = data;
          discord.latestDataMessageId = m.id;
          console.log(`[discordStore:${category}/${threadName}] Loaded from channel.`);
          return cachedData;
        }
      }
      console.log(`[discordStore:${category}/${threadName}] No thread or channel data found in Discord.`);
      return cachedData;
    }

    // Read thread messages to find the latest data
    try {
      const threadMsgs = await live.threadMessages(discord.threadId);
      // Walk from newest to oldest to find the latest data message
      for (let i = threadMsgs.length - 1; i >= 0; i--) {
        const m = threadMsgs[i];
        // Only trust messages from our webhook or bot
        if (m.webhook_id !== live.hook.id && m.author?.id !== bot.id) continue;

        let data = jsonIn(m.content);
        if (!data) {
          // Check for file attachment
          const file = (m.attachments ?? []).find((a) => DATA_FILE_RE.test(a.filename));
          if (file) {
            const res = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
            if (res.ok) {
              try { data = JSON.parse(await res.text()); } catch { /* skip */ }
            }
          }
        }
        if (data !== null) {
          cachedData = data;
          discord.latestDataMessageId = m.id;
          break;
        }
      }
    } catch (err) {
      if (err.status === 404) {
        console.warn(`[discordStore:${category}/${threadName}] Thread gone from Discord.`);
      } else {
        console.warn(`[discordStore:${category}/${threadName}] Failed reading thread messages: ${err.message}`);
      }
    }

    if (cachedData !== null) {
      console.log(`[discordStore:${category}/${threadName}] Loaded from Discord.`);
    } else {
      console.log(`[discordStore:${category}/${threadName}] No data found in Discord thread.`);
    }

    return cachedData;
  }

  // ---- Ensure thread exists ----
  // RULE: ID cannot be duplicated. Check Discord first; if existing, ID is the basis!
  async function ensureThread() {
    if (transport.mode !== 'live') return null;
    const { live } = transport;

    if (discord.threadId) return discord.threadId;

    // Check Discord channel history FIRST to avoid creating duplicate threads!
    try {
      const { messages } = await live.history();
      for (const m of messages) {
        const title = m.embeds?.[0]?.title ?? '';
        if (title === threadName) {
          discord.starterMessageId = m.id;
          if (m.thread?.id) {
            discord.threadId = m.thread.id;
            return discord.threadId;
          }
        }
      }
    } catch (err) {
      console.warn(`[discordStore:${category}/${threadName}] Error looking up existing thread: ${err.message}`);
    }

    // Only post starter message if none exists in Discord
    if (!discord.starterMessageId) {
      try {
        const { messageId } = await live.post({
          allowed_mentions: { parse: [] },
          embeds: [{ title: threadName, description: `Data store for ${category}/${threadName}. The latest message in this thread is the current state.`, color: COLOR }],
        });
        discord.starterMessageId = messageId;
      } catch (err) {
        console.warn(`[discordStore:${category}/${threadName}] Could not post starter message: ${err.message}`);
      }
    }

    // Start thread on the starter message
    if (transport.threads && discord.starterMessageId) {
      try {
        const thread = await live.startThread(discord.starterMessageId, threadName);
        discord.threadId = thread.id;
      } catch (err) {
        console.warn(`[discordStore:${category}/${threadName}] Could not start thread (${err.message}), steps go into channel.`);
      }
    }

    return discord.threadId;
  }

  // ---- Save data to Discord ----
  // RULE: Each ID has only ONE thread message. Data is updated in-place (edited), never duplicated.
  async function save(data) {
    cachedData = data;

    if (transport.mode === 'mock') {
      console.log(`[discordStore:mock] ${category}/${threadName}: saved ${typeof data === 'object' ? JSON.stringify(data).slice(0, 100) : data}...`);
      return;
    }
    if (transport.mode !== 'live') return;

    return inLine(async () => {
      const threadId = await ensureThread();
      const { content, file } = toMessage(data, threadName);

      const payload = {
        allowed_mentions: { parse: [] },
        content,
        ...(file ? { attachments: [{ id: 0, filename: file.name }] } : {}),
      };
      const files = file ? [file] : [];

      // Find existing data message in thread if not already tracked
      if (!discord.latestDataMessageId && threadId) {
        try {
          const threadMsgs = await transport.live.threadMessages(threadId);
          for (let i = threadMsgs.length - 1; i >= 0; i--) {
            const m = threadMsgs[i];
            if (m.webhook_id === transport.live.hook.id) {
              discord.latestDataMessageId = m.id;
              break;
            }
          }
        } catch {}
      }

      // If we already have a data message in this thread and there are no new files, edit in place!
      if (discord.latestDataMessageId && !files.length) {
        try {
          await transport.live.edit(discord.latestDataMessageId, payload, { threadId });
          return;
        } catch (err) {
          console.warn(`[discordStore:${category}/${threadName}] In-place edit failed (${err.message}), replacing message.`);
        }
      }

      // Post new message and clean up old data message so only ONE message remains per ID
      const oldMessageId = discord.latestDataMessageId;
      const { messageId } = await transport.live.post(payload, { files, ...(threadId && { threadId }) });
      discord.latestDataMessageId = messageId;

      if (oldMessageId && oldMessageId !== messageId) {
        try {
          await transport.live.deleteMessage(oldMessageId, threadId);
        } catch {}
      }
    });
  }

  // ---- Delete thread from Discord (permanent purge) ----
  async function deleteThread() {
    if (transport.mode === 'mock') {
      console.log(`[discordStore:mock] ${category}/${threadName}: thread deleted`);
      return { ok: true };
    }
    if (transport.mode !== 'live' || !transport.live) return { ok: false };

    const results = {};
    if (discord.threadId && transport.live.deleteThread) {
      try {
        await transport.live.deleteThread(discord.threadId);
        results.thread = { ok: true };
      } catch (err) {
        console.warn(`[discordStore] Failed to delete thread ${discord.threadId}: ${err.message}`);
        results.thread = { ok: false, error: err.message };
      }
    }
    if (discord.starterMessageId && transport.live.deleteMessage) {
      try {
        await transport.live.deleteMessage(discord.starterMessageId);
        results.starter = { ok: true };
      } catch (err) {
        console.warn(`[discordStore] Failed to delete starter ${discord.starterMessageId}: ${err.message}`);
        results.starter = { ok: false, error: err.message };
      }
    }
    discord = { starterMessageId: null, threadId: null, latestDataMessageId: null };
    return results;
  }

  return {
    load,
    save,
    deleteThread,
    getData: () => cachedData,
    setData: (data) => { cachedData = data; },
    getDiscordInfo: () => ({ ...discord }),
    describe: () => ({ mode: transport.mode, threads: transport.threads, category, threadName }),
  };
}

module.exports = { createDiscordStore, buildTransport, jsonIn, toMessage };
