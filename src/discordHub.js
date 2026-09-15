// Hub managing the 6 Discord webhooks and Discord database operations (sending, deleting, purging).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getWebhooks(env = process.env) {
  return {
    audit: env.DISCORD_AUDIT_WEBHOOK_URL || null,
    rbac: env.DISCORD_RBAC_WEBHOOK_ID || null,
    promotion: env.DISCORD_PROMOTION_WEBHOOK_TOKEN || null,
    product: env.DISCORD_PRODUCT_WEBHOOK_TOKEN || null,
    user: env.DISCORD_USER_WEBHOOK_TOKEN || null,
    setting: env.DISCORD_SETTING_WEBHOOK_TOKEN || null,
  };
}

function parseWebhookUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/webhooks\/(\d+)\/([^/]+)/);
    if (!match) return null;
    return { api: `${u.origin}/api/v10`, id: match[1], token: match[2] };
  } catch {
    return null;
  }
}

async function sendWebhook(url, payload, options = {}) {
  if (!url) return null;
  const isMock = (process.env.DISCORD_MODE || 'mock').toLowerCase() !== 'live' || process.env.DISCORD_ENABLED !== 'true';
  if (isMock) {
    console.log(`[discord:mock] webhook send:`, payload?.embeds?.[0]?.title || payload?.content || 'no content');
    return { ok: true, mock: true, id: `mock-${Date.now()}` };
  }

  const parsed = new URL(url);
  parsed.searchParams.set('wait', 'true');
  if (options.threadId) parsed.searchParams.set('thread_id', options.threadId);

  const res = await fetch(parsed.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[discordHub] Webhook post failed (${res.status}): ${errText}`);
    return null;
  }
  return res.json().catch(() => ({ ok: true }));
}

async function deleteDiscordMessage(urlOrCategory, messageId, threadId = null) {
  if (!messageId) return { ok: false, error: 'No messageId provided' };
  const hooks = getWebhooks();
  const url = hooks[urlOrCategory] || urlOrCategory;
  const isMock = (process.env.DISCORD_MODE || 'mock').toLowerCase() !== 'live' || process.env.DISCORD_ENABLED !== 'true';

  if (isMock) {
    console.log(`[discord:mock] delete message ${messageId} from ${urlOrCategory}`);
    return { ok: true, mock: true };
  }

  const parsed = parseWebhookUrl(url);
  if (parsed) {
    const query = threadId ? `?thread_id=${threadId}` : '';
    const deleteUrl = `${parsed.api}/webhooks/${parsed.id}/${parsed.token}/messages/${messageId}${query}`;
    try {
      const res = await fetch(deleteUrl, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
      if (res.status === 204 || res.status === 200 || res.status === 404) {
        return { ok: true, status: res.status };
      }
      console.warn(`[discordHub] Webhook message delete answered ${res.status}`);
    } catch (err) {
      console.warn(`[discordHub] Webhook message delete failed: ${err.message}`);
    }
  }

  // Fallback to bot token if available
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (botToken && threadId) {
    try {
      const botUrl = `https://discord.com/api/v10/channels/${threadId}/messages/${messageId}`;
      const res = await fetch(botUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: res.status === 204 || res.status === 200 || res.status === 404, status: res.status };
    } catch (err) {
      console.warn(`[discordHub] Bot message delete failed: ${err.message}`);
    }
  }

  return { ok: false };
}

async function deleteDiscordThread(threadId) {
  if (!threadId) return { ok: false, error: 'No threadId provided' };
  const isMock = (process.env.DISCORD_MODE || 'mock').toLowerCase() !== 'live' || process.env.DISCORD_ENABLED !== 'true';

  if (isMock) {
    console.log(`[discord:mock] delete thread ${threadId}`);
    return { ok: true, mock: true };
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.warn(`[discordHub] Cannot delete thread ${threadId}: DISCORD_BOT_TOKEN not set`);
    return { ok: false, error: 'DISCORD_BOT_TOKEN not set' };
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200 || res.status === 204 || res.status === 404) {
      console.log(`[discordHub] Thread ${threadId} deleted from Discord (HTTP ${res.status}).`);
      return { ok: true, status: res.status };
    }
    const txt = await res.text().catch(() => '');
    console.warn(`[discordHub] Thread delete answered ${res.status}: ${txt}`);
    return { ok: false, status: res.status, error: txt };
  } catch (err) {
    console.warn(`[discordHub] Thread delete failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function purgeRecordFromDiscord({ threadId, starterMessageId, category = 'audit' }) {
  const results = { thread: null, starterMessage: null };
  const hooks = getWebhooks();
  const webhookUrl = hooks[category] || hooks.audit;

  if (threadId) {
    results.thread = await deleteDiscordThread(threadId);
  }
  if (starterMessageId && webhookUrl) {
    results.starterMessage = await deleteDiscordMessage(webhookUrl, starterMessageId);
  }
  return results;
}

async function notifyCategory(category, { title, description, color = 0x1f3864, fields = [], actor = null }) {
  const hooks = getWebhooks();
  const webhookUrl = hooks[category];
  if (!webhookUrl) return null;

  const embed = {
    title: String(title).slice(0, 256),
    description: description ? String(description).slice(0, 4096) : undefined,
    color,
    fields: fields.length ? fields : undefined,
    timestamp: new Date().toISOString(),
    ...(actor && {
      footer: { text: `${actor.name || 'System'} · ${actor.role || 'Admin'}`.slice(0, 200) },
    }),
  };

  return sendWebhook(webhookUrl, {
    allowed_mentions: { parse: [] },
    embeds: [embed],
  });
}

module.exports = {
  getWebhooks,
  parseWebhookUrl,
  sendWebhook,
  deleteDiscordMessage,
  deleteDiscordThread,
  purgeRecordFromDiscord,
  notifyCategory,
};
