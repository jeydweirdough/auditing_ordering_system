'use strict';

// Discord Database Table Engine
// - Each Webhook represents a Table (e.g. settings, rbac, promotions, users, products).
// - Each Row in the table is represented by a Discord Thread whose name is the row's primary ID.
// - The Thread Messages hold the actual data (JSON snapshot, edited in-place on update).
// - Guarantees: Each ID has exactly ONE thread and ONE data message. Existing ID is always the basis.

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

function toMessage(data, rowId) {
  const pretty = JSON.stringify(data, null, 2);
  for (const text of [pretty, JSON.stringify(data)]) {
    const content = `\`\`\`json\n${text}\n\`\`\``;
    if (content.length <= CONTENT_LIMIT) return { content, file: null };
  }
  const safeName = String(rowId).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return {
    content: `Data for row "${rowId}" is attached as JSON file (payload exceeds 2000 characters).`,
    file: { name: `data-${safeName}.json`, type: 'application/json', data: Buffer.from(pretty) },
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
    console.warn(`[discordTable] Invalid webhook URL, running in memory only.`);
    return { mode: 'off', live: null, threads: false };
  }
}

function createDiscordTable({ webhookUrl, botToken, tableName, env }) {
  const transport = buildTransport(webhookUrl, botToken, env);
  const rows = new Map(); // rowId -> { data, threadId, starterMessageId, latestMessageId }
  let line = Promise.resolve();

  function inLine(fn) {
    const next = line.then(fn).catch((err) => {
      console.warn(`[discordTable:${tableName}] ${err.message}`);
    });
    line = next;
    return next;
  }

  // Load all rows (threads) from this table (channel)
  async function loadRows() {
    if (transport.mode !== 'live') return getAllRows();

    const { live } = transport;
    let bot, messages;
    try {
      [bot, { messages }] = await Promise.all([live.me(), live.history()]);
    } catch (err) {
      console.warn(`[discordTable:${tableName}] Cannot read table history (${err.message}).`);
      return getAllRows();
    }

    // Identify all starter messages by embed title (title = rowId)
    // Walk oldest first
    for (const m of messages.reverse()) {
      const rowId = m.embeds?.[0]?.title;
      if (!rowId) continue;

      let row = rows.get(rowId);
      if (!row) {
        row = { data: null, threadId: m.thread?.id || null, starterMessageId: m.id, latestMessageId: null };
        rows.set(rowId, row);
      } else {
        // If multiple starter messages exist with same rowId, keep the first/oldest
        if (!row.starterMessageId) row.starterMessageId = m.id;
        if (!row.threadId && m.thread?.id) row.threadId = m.thread.id;
      }
    }

    // Now fetch the data message inside each row's thread
    for (const [rowId, row] of rows.entries()) {
      if (!row.threadId) {
        // Fallback: check if the starter message itself had data
        const starter = messages.find((m) => m.id === row.starterMessageId);
        if (starter) {
          const d = jsonIn(starter.content);
          if (d !== null) row.data = d;
        }
        continue;
      }

      try {
        const threadMsgs = await live.threadMessages(row.threadId);
        for (let i = threadMsgs.length - 1; i >= 0; i--) {
          const tm = threadMsgs[i];
          if (tm.webhook_id !== live.hook.id && tm.author?.id !== bot?.id) continue;

          let data = jsonIn(tm.content);
          if (!data) {
            const file = (tm.attachments ?? []).find((a) => DATA_FILE_RE.test(a.filename));
            if (file) {
              try {
                const res = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
                if (res.ok) data = JSON.parse(await res.text());
              } catch {}
            }
          }
          if (data !== null) {
            row.data = data;
            row.latestMessageId = tm.id;
            break;
          }
        }
      } catch (err) {
        console.warn(`[discordTable:${tableName}] Error reading row "${rowId}": ${err.message}`);
      }
    }

    console.log(`[discordTable:${tableName}] Loaded ${rows.size} row(s) from Discord.`);
    return getAllRows();
  }

  // Ensure a thread exists for this row ID
  async function ensureRowThread(rowId) {
    if (transport.mode !== 'live') return null;
    const { live } = transport;

    let row = rows.get(rowId);
    if (!row) {
      row = { data: null, threadId: null, starterMessageId: null, latestMessageId: null };
      rows.set(rowId, row);
    }
    if (row.threadId) return row.threadId;

    // Check channel history first to prevent duplicate threads
    try {
      const { messages } = await live.history();
      for (const m of messages) {
        if (m.embeds?.[0]?.title === rowId) {
          row.starterMessageId = m.id;
          if (m.thread?.id) {
            row.threadId = m.thread.id;
            return row.threadId;
          }
        }
      }
    } catch {}

    // Post starter message for this row
    if (!row.starterMessageId) {
      try {
        const { messageId } = await live.post({
          allowed_mentions: { parse: [] },
          embeds: [{
            title: rowId,
            description: `Table: **${tableName}** | Row Identifier: **${rowId}**\nThis thread holds the data and audit for this row.`,
            color: COLOR,
          }],
        });
        row.starterMessageId = messageId;
      } catch (err) {
        console.warn(`[discordTable:${tableName}] Error creating row starter for "${rowId}": ${err.message}`);
      }
    }

    // Start thread on starter message
    if (transport.threads && row.starterMessageId) {
      try {
        const thread = await live.startThread(row.starterMessageId, rowId);
        row.threadId = thread.id;
      } catch (err) {
        console.warn(`[discordTable:${tableName}] Could not start thread for "${rowId}": ${err.message}`);
      }
    }

    return row.threadId;
  }

  // Save/Update a row in the table
  async function saveRow(rowId, data) {
    let row = rows.get(rowId);
    if (!row) {
      row = { data, threadId: null, starterMessageId: null, latestMessageId: null };
      rows.set(rowId, row);
    } else {
      row.data = data;
    }

    if (transport.mode === 'mock') {
      console.log(`[discordTable:mock] ${tableName}.${rowId} saved.`);
      return;
    }
    if (transport.mode !== 'live') return;

    return inLine(async () => {
      const threadId = await ensureRowThread(rowId);
      const { content, file } = toMessage(data, rowId);

      const payload = {
        allowed_mentions: { parse: [] },
        content,
        ...(file ? { attachments: [{ id: 0, filename: file.name }] } : {}),
      };
      const files = file ? [file] : [];

      // If we already have a data message in this row's thread and no file attachment, edit in place!
      if (row.latestMessageId && !files.length) {
        try {
          await transport.live.edit(row.latestMessageId, payload, { threadId });
          return;
        } catch (err) {
          console.warn(`[discordTable:${tableName}] Edit in-place failed for "${rowId}" (${err.message}), replacing.`);
        }
      }

      // Post new message and clean up previous message so only ONE message exists per row
      const oldMessageId = row.latestMessageId;
      const { messageId } = await transport.live.post(payload, { files, ...(threadId && { threadId }) });
      row.latestMessageId = messageId;

      if (oldMessageId && oldMessageId !== messageId) {
        try {
          await transport.live.deleteMessage(oldMessageId, threadId);
        } catch {}
      }
    });
  }

  // Delete a row (purge thread from Discord)
  async function deleteRow(rowId) {
    const row = rows.get(rowId);
    rows.delete(rowId);

    if (transport.mode === 'mock') {
      console.log(`[discordTable:mock] ${tableName}.${rowId} deleted.`);
      return { ok: true };
    }
    if (transport.mode !== 'live' || !transport.live) return { ok: false };

    const results = {};
    if (row?.threadId && transport.live.deleteThread) {
      try {
        await transport.live.deleteThread(row.threadId);
        results.thread = { ok: true };
      } catch (err) {
        results.thread = { ok: false, error: err.message };
      }
    }
    if (row?.starterMessageId && transport.live.deleteMessage) {
      try {
        await transport.live.deleteMessage(row.starterMessageId);
        results.starter = { ok: true };
      } catch (err) {
        results.starter = { ok: false, error: err.message };
      }
    }
    return results;
  }

  function getRow(rowId) {
    return rows.get(rowId)?.data ?? null;
  }

  function getAllRows() {
    const result = {};
    for (const [rowId, row] of rows.entries()) {
      if (row.data !== null) result[rowId] = row.data;
    }
    return result;
  }

  function getAllRowValues() {
    const list = [];
    for (const [, row] of rows.entries()) {
      if (row.data !== null) list.push(row.data);
    }
    return list;
  }

  return {
    loadRows,
    getRow,
    saveRow,
    deleteRow,
    getAllRows,
    getAllRowValues,
    setRowData: (rowId, data) => {
      let r = rows.get(rowId);
      if (!r) {
        r = { data, threadId: null, starterMessageId: null, latestMessageId: null };
        rows.set(rowId, r);
      } else {
        r.data = data;
      }
    },
    describe: () => ({ tableName, rowsCount: rows.size, mode: transport.mode }),
  };
}

module.exports = { createDiscordTable };
