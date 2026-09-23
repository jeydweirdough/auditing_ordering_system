// Sign-in for the orders app. Accounts live in data/users.json with scrypt-hashed passwords, or in
// the ACCOUNTS setting on hosts without a disk (Vercel); a signed cookie keeps someone signed in
// for 8 hours. The role on the account decides which
// dashboard they see and which order steps they may take (src/orders.js).
//
// Every change Admin makes to an account is announced to onAccountChange listeners, which post it
// to the Admin log in #order-audit. Never passwords.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createJsonStore } = require('./jsonStore');
const { createDiscordStore } = require('./discordStore');
const { hashPassword, checkPassword, generatePassword, passwordProblem } = require('./passwords');
const configStore = require('./configStore');

const DEFAULT_ROLE_LABELS = { salesperson: 'Salesperson', team_leader: 'Team Leader', management: 'Management', finance: 'Finance', dispatch: 'Dispatch', admin: 'Admin' };
const ROLE_LABELS = new Proxy(DEFAULT_ROLE_LABELS, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop];
    const roleObj = configStore.getRbac().find((r) => r.id === prop);
    return roleObj ? roleObj.label : target[prop] || prop;
  },
});

const ROLES = new Proxy(['salesperson', 'team_leader', 'management', 'finance', 'dispatch', 'admin'], {
  get(target, prop) {
    const list = configStore.getRbac().map((r) => r.id);
    const active = list.length > 0 ? list : target;
    if (typeof active[prop] === 'function') return active[prop].bind(active);
    return active[prop];
  },
  has(target, prop) {
    const list = configStore.getRbac().map((r) => r.id);
    const active = list.length > 0 ? list : target;
    return prop in active;
  },
  ownKeys(target) {
    const list = configStore.getRbac().map((r) => r.id);
    const active = list.length > 0 ? list : target;
    return Reflect.ownKeys(active);
  },
  getOwnPropertyDescriptor(target, prop) {
    const list = configStore.getRbac().map((r) => r.id);
    const active = list.length > 0 ? list : target;
    return Object.getOwnPropertyDescriptor(active, prop);
  },
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(__dirname, '..', 'data.bak');

const COOKIE = 'rd_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('base64');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set, so sign-ins last only until the server restarts. `npm run accounts` adds one to .env.');
}

const env = process.env;
const botToken = env.DISCORD_BOT_TOKEN || null;

const userStore = createDiscordStore({
  webhookUrl: env.DISCORD_USER_WEBHOOK_TOKEN,
  botToken,
  category: 'user',
  threadName: 'Users',
});

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// With ACCOUNTS set, accounts come from it instead of users.json, so a host without a disk has
// them too. They're read-only then: the People screen lists them, and people are added, changed
// and removed by editing ACCOUNTS.
const FROM_ENV = Boolean(process.env.ACCOUNTS?.trim());
const ENV_MANAGED = 'Accounts are set in ACCOUNTS on the server. Change them there, then restart the server or redeploy.';
const ENV_PATH = path.join(__dirname, '..', '.env');

// The one write the People screen may still make while ACCOUNTS is set: a display name is
// cosmetic, unlike role, status or a password, so it's safe to let this rewrite the matching
// line's name segment in .env directly rather than sending someone to edit it by hand. Every
// other field on that line (id, email, password hash, role, teamLeaderId) is left untouched.
function renameInAccountsEnv(id, newName) {
  if (!fs.existsSync(ENV_PATH)) throw bad("Can't find .env to save this in.", 500);
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|').map((s) => s.trim());
    if (parts.length < 5 || Number(parts[0]) !== id) continue;
    const hasTeamLeader = parts.length >= 6 && /^\d+$/.test(parts.at(-1));
    parts[hasTeamLeader ? parts.length - 2 : parts.length - 1] = newName;
    lines[i] = parts.join(' | ');
    changed = true;
    break;
  }
  if (!changed) throw bad("Could not find this account's line in ACCOUNTS to rename it.", 500);
  fs.writeFileSync(ENV_PATH, lines.join(eol));
}

function loadInitialUsers() {
  if (fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8')); } catch {}
  }
  if (fs.existsSync(path.join(BACKUP_DIR, 'users.json'))) {
    try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'users.json'), 'utf8')); } catch {}
  }
  return { nextId: 1, users: [] };
}

const inMemoryUsers = loadInitialUsers();

async function saveStore() {
  if (FROM_ENV) return;
  try {
    await userStore.save(store.data);
  } catch (err) {
    console.warn(`[accounts] Failed to save users to Discord: ${err.message}`);
  }
}

async function loadFromDiscord() {
  try {
    const data = await userStore.load();
    if (data && Array.isArray(data.users)) {
      if (!FROM_ENV) {
        store.data = data;
      }
      console.log(`[accounts] Loaded ${data.users.length} accounts from Discord.`);
      return data;
    }
  } catch (err) {
    console.warn(`[accounts] Failed to load users from Discord: ${err.message}`);
  }
  return store.data;
}

const store = FROM_ENV
  ? { data: { users: readAccounts(process.env.ACCOUNTS) }, save: async () => {} }
  : { data: inMemoryUsers, save: saveStore };

// Checked when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// Failed sign-ins per email: 10 in 15 minutes, then that email waits.
const failures = new Map();
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const findByEmail = (email) => store.data.users.find((u) => u.email === email);
const findUser = (id) => store.data.users.find((u) => u.id === id);
const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  roleLabel: ROLE_LABELS[u.role],
  active: u.active,
  createdAt: u.createdAt,
  teamLeaderId: u.teamLeaderId ?? null,
  canRaiseOrders: u.role === 'admin' || configStore.hasPermission(u.role, 'raise_orders'),
  canManageSettings: u.role === 'admin' || configStore.hasPermission(u.role, 'manage_settings'),
  canManageUsers: u.role === 'admin' || configStore.hasPermission(u.role, 'manage_users'),
});

const accountListeners = [];
const onAccountChange = (fn) => accountListeners.push(fn);

function announce(actor, title, description) {
  const entry = { title, description, actor: { id: actor.id, name: actor.name, role: actor.role }, at: new Date().toISOString() };
  for (const fn of accountListeners) {
    try {
      fn(entry);
    } catch (err) {
      console.warn(`[auth] couldn't log "${title}": ${err.message}`);
    }
  }
}

function cleanName(name) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 80) throw bad('Give a name of up to 80 characters.');
  return clean;
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw bad(`Role must be one of: ${ROLES.join(', ')}.`);
  return role;
}

function isHash(password) {
  return /^scrypt\$[^$]+\$[^$]+$/.test(password);
}

// ACCOUNTS: one account per line, id | email | password | role | name. The password is plain text
// or a "scrypt$..." hash like users.json keeps; lines starting with # are skipped. A line that
// doesn't make sense is left out and logged by its line number, never its contents, so a typo
// locks out one person rather than everyone.
function readAccounts(text) {
  const users = [];
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    if (line.startsWith('#')) return;
    const rawParts = line.split('|').map((s) => s.trim());
    let teamLeaderId = null;
    if (rawParts.length >= 6 && /^\d+$/.test(rawParts.at(-1))) {
      teamLeaderId = Number(rawParts.pop());
    }
    const account = rawParts.length < 5 ? null : {
      id: rawParts[0],
      email: rawParts[1].toLowerCase(),
      password: rawParts.slice(2, -2).join('|').trim(),   // a password may contain |
      role: rawParts.at(-2),
      name: rawParts.at(-1),
      teamLeaderId,
    };
    const problem = account ? lineProblem(account, users) : 'write it as id | email | password | role | name [| teamLeaderId]';
    if (problem) {
      console.error(`[auth] ACCOUNTS line ${i + 1} was left out: ${problem}`);
      return;
    }
    const { id, email, password, role, name } = account;
    users.push({
      id: Number(id),
      name,
      email,
      role,
      teamLeaderId,
      passwordHash: isHash(password) ? password : hashPassword(password),
      active: true,
      // Changes with the line's email or password, which signs that person out everywhere.
      sessionVersion: crypto.createHmac('sha256', SECRET).update(`${id}\n${email}\n${password}`).digest('base64url').slice(0, 16),
      createdAt: null,
    });
  });
  console.log(`[auth] ${users.length} account(s) from ACCOUNTS`);
  return users;
}

// The id never changes: orders point at their salesperson by it.
function lineProblem({ id, email, password, role, name }, users) {
  if (!/^[1-9]\d*$/.test(id)) return 'the id must be a whole number, 1 or more';
  if (users.some((u) => u.id === Number(id))) return `id ${id} is already used above`;
  if (!EMAIL.test(email)) return "the email isn't an email address";
  if (users.some((u) => u.email === email)) return 'the email is already used above';
  if (!ROLES.includes(role)) return `the role must be one of: ${ROLES.join(', ')}`;
  if (!name || name.length > 80) return 'give a name of up to 80 characters';
  return isHash(password) ? null : passwordProblem(password);
}

async function createAccount({ name, email, role, password, teamLeaderId } = {}) {
  if (FROM_ENV) throw bad(ENV_MANAGED, 409);
  const clean = cleanName(name);
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(cleanEmail)) throw bad(`"${cleanEmail}" is not an email address.`);
  checkRole(role);
  if (findByEmail(cleanEmail)) throw bad(`${cleanEmail} already has an account.`, 409);

  const generated = password == null || password === '';
  const pw = generated ? generatePassword() : String(password);
  const problem = passwordProblem(pw);
  if (problem) throw bad(problem);

  const user = {
    id: store.data.nextId++,
    name: clean,
    email: cleanEmail,
    role,
    teamLeaderId: teamLeaderId != null && teamLeaderId !== '' ? (Number(teamLeaderId) || null) : null,
    passwordHash: hashPassword(pw),
    active: true,
    sessionVersion: 0,   // raised to sign someone out everywhere: deactivation, password reset
    createdAt: new Date().toISOString(),
  };
  store.data.users.push(user);
  await store.save();
  return { user, password: generated ? pw : null };
}

// ---------- sessions ----------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function currentUser(req) {
  const session = verify(readCookie(req, COOKIE));
  if (!session) return null;
  const user = findUser(session.uid);
  if (!user || !user.active || (user.sessionVersion ?? 0) !== session.v) return null;
  return user;
}

function setSession(res, user) {
  const token = sign({ uid: user.id, v: user.sessionVersion ?? 0, exp: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

// ---------- middleware ----------

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => (roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: `Only ${roles.map((r) => ROLE_LABELS[r]).join(' or ')} can do that.` }));
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || configStore.hasPermission(req.user.role, perm)) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
}

// Changes only come as JSON. A form on another website can post to this server, but it cannot
// send application/json without the browser asking first, so this closes that door.
function jsonOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.method === 'DELETE' && (!req.headers['content-length'] || req.headers['content-length'] === '0')) {
    return next();
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' });
  }
  next();
}

// With ACCOUNTS set, the People screen can look but not change.
function editable(_req, res, next) {
  if (FROM_ENV) return res.status(409).json({ error: ENV_MANAGED });
  next();
}

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// ---------- routes ----------

const router = express.Router();

router.post('/auth/login', jsonOnly, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const record = failures.get(email);
  if (record && record.count >= LOCK_AFTER && Date.now() - record.first < LOCK_MS) {
    return res.status(429).json({ error: 'Too many failed sign-ins for this email. Try again in 15 minutes.' });
  }

  const user = findByEmail(email);
  const matches = checkPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !matches || !user.active) {
    const fresh = !record || Date.now() - record.first >= LOCK_MS;
    failures.set(email, fresh ? { count: 1, first: Date.now() } : { ...record, count: record.count + 1 });
    return res.status(401).json({ error: "That email and password don't match an active account." });
  }

  failures.delete(email);
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', jsonOnly, (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/auth/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/auth/change-password', jsonOnly, requireUser, editable, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword) throw bad('Enter your current password.');
    if (!newPassword) throw bad('Enter a new password.');
    const user = store.data.users.find((u) => u.id === req.user.id);
    if (!user) throw bad('Account not found.', 404);
    if (!checkPassword(String(currentPassword), user.passwordHash ?? DUMMY_HASH)) {
      throw bad('Current password does not match.');
    }
    const problem = passwordProblem(String(newPassword));
    if (problem) throw bad(problem);
    user.passwordHash = hashPassword(String(newPassword));
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await store.save();
    setSession(res, user);
    announce(req.user, `Password changed: ${user.name}`, `${user.email} updated their account password`);
    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    fail(err, res, next);
  }
});

router.patch('/auth/me', jsonOnly, requireUser, editable, async (req, res, next) => {
  try {
    const { name } = req.body ?? {};
    if (name === undefined) throw bad('Give a name to update.');
    const user = store.data.users.find((u) => u.id === req.user.id);
    if (!user) throw bad('Account not found.', 404);
    const newName = cleanName(name);
    if (newName !== user.name) {
      const oldName = user.name;
      user.name = newName;
      await store.save();
      announce(req.user, `Name changed: ${oldName} → ${newName}`, `${user.email} updated their own display name`);
    }
    res.json({ user: publicUser(user) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get('/users', requireUser, requirePermission('manage_users'), (_req, res) => {
  res.json({
    users: store.data.users.map(publicUser),
    roles: configStore.getRbac().map((r) => ({ value: r.id, label: r.label, isSystem: r.isSystem, permissions: r.permissions })),
  });
});

// A password left blank is generated and returned once, for the admin to hand over.
router.post('/users', jsonOnly, requireUser, requirePermission('manage_users'), editable, async (req, res, next) => {
  try {
    const { user, password } = await createAccount(req.body ?? {});
    announce(req.user, 'Account created', `${user.name} (${user.email}) as ${ROLE_LABELS[user.role]}`);
    res.status(201).json({ user: publicUser(user), password });
  } catch (err) {
    fail(err, res, next);
  }
});

router.patch('/users/:id', jsonOnly, requireUser, requirePermission('manage_users'), async (req, res, next) => {
  try {
    const user = findUser(Number(req.params.id));
    if (!user) throw bad('No such account.', 404);
    const { name, role, active, resetPassword, teamLeaderId } = req.body ?? {};

    if (FROM_ENV) {
      const onlyRename = name !== undefined && role === undefined && active === undefined
        && !resetPassword && teamLeaderId === undefined;
      if (!onlyRename) throw bad(ENV_MANAGED, 409);
      const newName = cleanName(name);
      if (newName !== user.name) {
        const oldName = user.name;
        user.name = newName;
        renameInAccountsEnv(user.id, newName);
        announce(req.user, `Name changed: ${oldName} → ${newName}`, `${user.email}'s display name was updated`);
      }
      return res.json({ user: publicUser(user), password: null });
    }

    const self = user.id === req.user.id;
    if (self && (active === false || (role && role !== 'admin'))) {
      throw bad("You can't deactivate your own account or take away your own admin role.");
    }
    // Everything is checked before anything changes, so a refused request changes nothing.
    const newName = name !== undefined ? cleanName(name) : user.name;
    const newRole = role !== undefined ? checkRole(role) : user.role;

    const changes = [];
    if (newName !== user.name) {
      changes.push(`Name: ${user.name} → ${newName}`);
      user.name = newName;
    }
    if (newRole !== user.role) {
      changes.push(`Role: ${ROLE_LABELS[user.role]} → ${ROLE_LABELS[newRole]}`);
      user.role = newRole;
    }
    if (teamLeaderId !== undefined) {
      const parsedTl = teamLeaderId != null && teamLeaderId !== '' ? (Number(teamLeaderId) || null) : null;
      if (parsedTl !== user.teamLeaderId) {
        const tlUser = parsedTl ? findUser(parsedTl) : null;
        changes.push(`Team Leader: ${tlUser ? tlUser.name : 'Unassigned'}`);
        user.teamLeaderId = parsedTl;
      }
    }
    if (typeof active === 'boolean' && active !== user.active) {
      user.active = active;
      if (!active) user.sessionVersion = (user.sessionVersion ?? 0) + 1;   // signed out everywhere, now
      changes.push(active ? 'Reactivated' : 'Deactivated; signed out everywhere');
    }
    let password = null;
    if (resetPassword === true) {
      password = generatePassword();
      user.passwordHash = hashPassword(password);
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
      changes.push('Password reset; signed out everywhere');
    }
    await store.save();
    if (changes.length) announce(req.user, `Account changed: ${user.name}`, changes.join('\n'));
    res.json({ user: publicUser(user), password });
  } catch (err) {
    fail(err, res, next);
  }
});

const listUsers = () => store.data.users.map(publicUser);

module.exports = {
  router,
  requireUser,
  requireRole,
  requirePermission,
  jsonOnly,
  createAccount,
  findUser,
  listUsers,
  publicUser,
  onAccountChange,
  ROLES,
  ROLE_LABELS,
  loadFromDiscord,
  _store: userStore,
};
