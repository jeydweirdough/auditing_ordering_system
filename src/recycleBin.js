// Recycle Bin manager: 30-day retention and persistent Discord database deletion.
const configStore = require('./configStore');
const discordHub = require('./discordHub');

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getRecycleBinSettings() {
  const settings = configStore.getSettings ? configStore.getSettings() : {};
  return Array.isArray(settings.recycleBin) ? settings.recycleBin : [];
}

function saveRecycleBinSettings(list) {
  if (!configStore.getSettings || !configStore.saveSettings) return;
  const settings = configStore.getSettings();
  settings.recycleBin = list;
  configStore.saveSettings(settings);
}

function calculateDaysLeft(purgeAt) {
  if (!purgeAt) return 0;
  const diff = new Date(purgeAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

function isExpired(itemOrDate) {
  if (!itemOrDate) return false;
  const purgeAt = typeof itemOrDate === 'string' ? itemOrDate : itemOrDate.purgeAt;
  if (!purgeAt) return false;
  return Date.now() >= new Date(purgeAt).getTime();
}

function createRecycleRecord(optionsOrType, id, data = {}) {
  const opts = (typeof optionsOrType === 'object' && optionsOrType !== null)
    ? optionsOrType
    : { type: optionsOrType, id, ...data };
  const now = new Date();
  const purgeAt = new Date(now.getTime() + RETENTION_MS);
  return {
    id: String(opts.id),
    type: opts.type, // 'order' | 'customer' | 'bundle' | 'promo' | 'discount' | 'role'
    name: opts.name || `Item ${opts.id}`,
    data: opts.data ?? null,
    deletedAt: now.toISOString(),
    purgeAt: purgeAt.toISOString(),
    deletedBy: opts.user ? { id: opts.user.id, name: opts.user.name, role: opts.user.role } : null,
    reason: String(opts.reason || '').trim(),
    discord: {
      threadId: opts.discord?.threadId || null,
      starterMessageId: opts.discord?.starterMessageId || null,
      category: opts.discord?.category || 'audit',
    },
  };
}

function addRecycledItem(record) {
  const list = getRecycleBinSettings();
  const existingIdx = list.findIndex((it) => it.id === record.id && it.type === record.type);
  if (existingIdx >= 0) {
    list[existingIdx] = record;
  } else {
    list.push(record);
  }
  saveRecycleBinSettings(list);
  return record;
}

function removeRecycledItem(id, type = null) {
  const list = getRecycleBinSettings();
  const filtered = list.filter((it) => !(it.id === String(id) && (!type || it.type === type)));
  saveRecycleBinSettings(filtered);
}

function findRecycledItem(id, type = null) {
  const list = getRecycleBinSettings();
  return list.find((it) => it.id === String(id) && (!type || it.type === type)) || null;
}

// Persistently purges a recycled record from the Discord database and storage
async function permanentlyPurgeRecycledItem(item) {
  if (!item) return { ok: false, error: 'Item not found' };

  // 1. Purge from Discord database
  if (item.discord?.threadId || item.discord?.starterMessageId) {
    await discordHub.purgeRecordFromDiscord({
      threadId: item.discord.threadId,
      starterMessageId: item.discord.starterMessageId,
      category: item.discord.category || 'audit',
    });
  }

  // 2. Remove from recycle bin store
  removeRecycledItem(item.id, item.type);

  // 3. Notify category channel in Discord that item was permanently purged
  const category = item.discord?.category || (item.type === 'order' ? 'audit' : item.type === 'role' ? 'rbac' : item.type === 'customer' ? 'setting' : 'promotion');
  await discordHub.notifyCategory(category, {
    title: `🗑️ Permanently Purged from Discord: ${item.name}`,
    description: `Item **${item.name}** (${item.type}) has been permanently purged and vanished from the Discord database.`,
    color: 0xcc0000,
    actor: item.deletedBy || { name: 'System', role: 'admin' },
  }).catch(() => {});

  return { ok: true, id: item.id };
}

// Scans and automatically purges items past 30 days
async function purgeExpiredRecycledItems() {
  const list = getRecycleBinSettings();
  const expired = list.filter(isExpired);
  const results = [];
  for (const item of expired) {
    const res = await permanentlyPurgeRecycledItem(item);
    results.push(res);
  }
  return results;
}

module.exports = {
  RETENTION_DAYS,
  RETENTION_MS,
  getRecycleBinSettings,
  saveRecycleBinSettings,
  calculateDaysLeft,
  isExpired,
  createRecycleRecord,
  addRecycledItem,
  removeRecycledItem,
  findRecycledItem,
  permanentlyPurgeRecycledItem,
  purgeExpiredRecycledItems,
};
