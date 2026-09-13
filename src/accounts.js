// Sign-in for the orders app. Accounts live in data/users.json with scrypt-hashed passwords; a
// signed cookie keeps someone signed in for 8 hours. The role on the account decides which
// dashboard they see and which order steps they may take (src/orders.js).
//
// Every change Admin makes to an account is announced to onAccountChange listeners, which post it
// to the Admin log in #order-audit. Never passwords.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { createJsonStore } = require('./jsonStore');
const { hashPassword, checkPassword, generatePassword, passwordProblem } = require('./passwords');

const ROLES = ['salesperson', 'management', 'finance', 'dispatch', 'admin'];
const ROLE_LABELS = { salesperson: 'Salesperson', management: 'Management', finance: 'Finance', dispatch: 'Dispatch', admin: 'Admin' };

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const store = createJsonStore(path.join(DATA_DIR, 'users.json'), { nextId: 1, users: [] });

const COOKIE = 'rd_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('base64');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set, so sign-ins last only until the server restarts. `npm run accounts` adds one to .env.');
}

// Checked when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// Failed sign-ins per email: 10 in 15 minutes, then that email waits.
const failures = new Map();
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const findByEmail = (email) => store.data.users.find((u) => u.email === email);
const findUser = (id) => store.data.users.find((u) => u.id === id);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role], active: u.active, createdAt: u.createdAt });

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

async function createAccount({ name, email, role, password } = {}) {
  const clean = cleanName(name);
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) throw bad(`"${cleanEmail}" is not an email address.`);
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

// Changes only come as JSON. A form on another website can post to this server, but it cannot
// send application/json without the browser asking first, so this closes that door.
function jsonOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' });
  }
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

router.get('/users', requireUser, requireRole('admin'), (_req, res) => {
  res.json({ users: store.data.users.map(publicUser), roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) });
});

// A password left blank is generated and returned once, for the admin to hand over.
router.post('/users', jsonOnly, requireUser, requireRole('admin'), async (req, res, next) => {
  try {
    const { user, password } = await createAccount(req.body ?? {});
    announce(req.user, 'Account created', `${user.name} (${user.email}) as ${ROLE_LABELS[user.role]}`);
    res.status(201).json({ user: publicUser(user), password });
  } catch (err) {
    fail(err, res, next);
  }
});

router.patch('/users/:id', jsonOnly, requireUser, requireRole('admin'), async (req, res, next) => {
  try {
    const user = findUser(Number(req.params.id));
    if (!user) throw bad('No such account.', 404);
    const { name, role, active, resetPassword } = req.body ?? {};
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

module.exports = { router, requireUser, requireRole, jsonOnly, createAccount, findUser, publicUser, onAccountChange, ROLES, ROLE_LABELS };
