#!/usr/bin/env node
'use strict';

// Script: Clean Discord Channels & Deduplicate Threads / Messages
// Rule: Each ID must have ONLY ONE thread. ID cannot be duplicated.
// If anything is existing, ID will be the basis. Any duplicate threads
// or redundant messages are cleaned up.

const fs = require('fs');
const path = require('path');

// Auto-load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const { getWebhooks, parseWebhookUrl } = require('../src/discordHub');
const botToken = process.env.DISCORD_BOT_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, endpoint, body = null) {
  for (let attempt = 1; ; attempt++) {
    const headers = {};
    if (botToken) headers.Authorization = `Bot ${botToken}`;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt < 5) {
      const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
      await sleep(wait);
      continue;
    }
    if (res.status === 204) return { ok: true, status: 204 };
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: err.message || res.statusText };
    }
    return { ok: true, status: res.status, data: await res.json().catch(() => null) };
  }
}

async function cleanChannel(name, webhookUrl) {
  console.log(`\n========================================`);
  console.log(`🔍 Inspecting Channel: #${name}`);
  console.log(`========================================`);

  const parsed = parseWebhookUrl(webhookUrl);
  if (!parsed) {
    console.log(`[${name}] Invalid webhook URL.`);
    return;
  }

  // 1. Get channel ID from webhook
  const hookRes = await fetch(webhookUrl).then((r) => r.json()).catch(() => null);
  if (!hookRes?.channel_id) {
    console.log(`[${name}] Could not retrieve channel_id from webhook.`);
    return;
  }
  const channelId = hookRes.channel_id;

  // 2. Fetch all channel messages
  const msgRes = await api('GET', `/channels/${channelId}/messages?limit=100`);
  if (!msgRes.ok) {
    console.log(`[${name}] Could not fetch channel messages (${msgRes.status}): ${msgRes.error}`);
    return;
  }
  const messages = msgRes.data || [];
  console.log(`Total messages found in channel: ${messages.length}`);

  // 3. Group messages by ID / Title
  // For orders: title is "GM-xxxx-xxxx" or "Admin log"
  // For settings: title is "Settings"
  // For promotions: title is "Promotions"
  // For rbac: title is "RBAC Roles"
  // For users: title is "Users"
  const byId = new Map();

  for (const m of messages) {
    const title = m.embeds?.[0]?.title ?? (m.content ? m.content.slice(0, 50) : `msg-${m.id}`);
    if (!byId.has(title)) byId.set(title, []);
    byId.get(title).push(m);
  }

  // 4. Process each ID / Title
  for (const [idTitle, list] of byId.entries()) {
    // Check if duplicate
    if (list.length > 1) {
      console.log(`\n⚠️  Duplicate found for [${idTitle}] (${list.length} instances):`);

      // Sort by newest first
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // If one of them has a thread with messages/data, prefer keeping that one as basis
      let keeper = list[0];
      for (const candidate of list) {
        if (candidate.thread?.id) {
          keeper = candidate;
          break;
        }
      }

      console.log(`  -> Keeping primary: Message ID ${keeper.id} (Thread: ${keeper.thread?.id || 'none'})`);

      // Delete all duplicates
      for (const duplicate of list) {
        if (duplicate.id === keeper.id) continue;

        // If duplicate has a thread, delete the thread first
        if (duplicate.thread?.id) {
          const tRes = await api('DELETE', `/channels/${duplicate.thread.id}`);
          if (tRes.ok) {
            console.log(`     ✓ Deleted duplicate thread: ${duplicate.thread.id}`);
          } else {
            console.log(`     ✗ Failed to delete thread ${duplicate.thread.id}: ${tRes.error}`);
          }
        }

        // Delete duplicate starter message
        const mRes = await api('DELETE', `/channels/${channelId}/messages/${duplicate.id}`);
        if (mRes.ok) {
          console.log(`     ✓ Deleted duplicate starter message: ${duplicate.id}`);
        } else {
          // Try webhook message delete
          const whDel = await fetch(`${parsed.api}/webhooks/${parsed.id}/${parsed.token}/messages/${duplicate.id}`, {
            method: 'DELETE',
          }).catch(() => null);
          if (whDel?.status === 204 || whDel?.status === 200) {
            console.log(`     ✓ Deleted duplicate starter message via webhook: ${duplicate.id}`);
          } else {
            console.log(`     ✗ Could not delete message ${duplicate.id}: ${mRes.error}`);
          }
        }
        await sleep(500); // respect rate limits
      }
    }

    // 5. Inside the thread for this ID: Ensure ONLY ONE data message exists
    const primary = list.find((m) => m.thread?.id) || list[0];
    const threadId = primary?.thread?.id;
    if (threadId) {
      const threadMsgsRes = await api('GET', `/channels/${threadId}/messages?limit=100`);
      if (threadMsgsRes.ok && Array.isArray(threadMsgsRes.data)) {
        const tMsgs = threadMsgsRes.data;
        // If it's a dataset thread (Settings, Promotions, RBAC Roles, Users), keep only the latest message
        const isDatasetThread = ['Settings', 'Promotions', 'RBAC Roles', 'Users'].includes(idTitle);
        if (isDatasetThread && tMsgs.length > 1) {
          console.log(`  Checking thread messages for [${idTitle}] in thread ${threadId}: ${tMsgs.length} messages found`);
          // Sort newest first
          tMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          const keepDataMsg = tMsgs[0];
          console.log(`  -> Keeping single latest data message: ${keepDataMsg.id}`);

          for (let i = 1; i < tMsgs.length; i++) {
            const delMsg = tMsgs[i];
            const dRes = await api('DELETE', `/channels/${threadId}/messages/${delMsg.id}`);
            if (dRes.ok) {
              console.log(`     ✓ Deleted redundant thread data message: ${delMsg.id}`);
            } else {
              console.log(`     ✗ Could not delete message ${delMsg.id}: ${dRes.error}`);
            }
            await sleep(400);
          }
        }
      }
    }
  }

  // 6. Clean redundant notification spam (e.g. repeated recycle bin purge notices)
  if (name === 'promotion' || name === 'setting') {
    const notifyRes = await api('GET', `/channels/${channelId}/messages?limit=100`);
    if (notifyRes.ok && Array.isArray(notifyRes.data)) {
      const seenNotifs = new Set();
      for (const m of notifyRes.data) {
        const title = m.embeds?.[0]?.title;
        if (!title || title === 'Settings' || title === 'Promotions') continue;
        if (seenNotifs.has(title)) {
          // Duplicate notification, delete it
          await api('DELETE', `/channels/${channelId}/messages/${m.id}`);
          console.log(`  ✓ Cleaned duplicate notification: "${title}" (msg: ${m.id})`);
          await sleep(300);
        } else {
          seenNotifs.add(title);
        }
      }
    }
  }

  console.log(`✓ Channel #${name} cleanup finished.`);
}

async function run() {
  console.log('=== DISCORD CLEANUP & DEDUPLICATION WORKER ===');
  console.log('Rule: Each ID has exactly ONE thread and ONE message. No duplicates.');

  const hooks = getWebhooks();
  for (const [name, url] of Object.entries(hooks)) {
    if (url) {
      await cleanChannel(name, url);
    }
  }

  console.log('\n========================================');
  console.log('🎉 ALL DISCORD CHANNELS CLEANED AND DEDUPLICATED!');
  console.log('========================================');
}

run().catch((err) => {
  console.error('Fatal error in cleanup worker:', err);
  process.exit(1);
});
