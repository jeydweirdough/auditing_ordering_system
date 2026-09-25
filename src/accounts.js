// Sign-in for the orders app. Accounts are the shared `users` table, the same
// ones getmeds-system signs people into; a signed cookie keeps someone signed
// in for 8 hours. The role on the account decides which dashboard they see and
// which order steps they may take (src/orders.js).
//
// Two of the database's role names differ from this app's: a 'medrep' there is
// a Salesperson here, and a 'team_lead' is a Team Leader. They are translated at
// this boundary (fromDbRole / toDbRole) and nowhere else, so the rest of the app
// and its pages keep their own names.
//
// Adding people and changing roles is done where it always was for this table:
// getmeds-system's Users screen, until that screen moves here.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { hashPassword, checkPassword, passwordProblem } = require('./passwords');
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
    return prop in (list.length > 0 ? list : target);
  },
  ownKeys(target) {
    const list = configStore.getRbac().map((r) => r.id);
    return Reflect.ownKeys(list.length > 0 ? list : target);
  },
  getOwnPropertyDescriptor(target, prop) {
    const list = configStore.getRbac().map((r) => r.id);
    return Object.getOwnPropertyDescriptor(list.length > 0 ? list : target, prop);
  },
});

// The database's role names <-> this app's.
const FROM_DB = { medrep: 'salesperson', team_lead: 'team_leader' };
const TO_DB = { salesperson: 'medrep', team_leader: 'team_lead' };
const fromDbRole = (r) => FROM_DB[r] || r;
const toDbRole = (r) => TO_DB[r] || r;

const COOKIE = 'rd_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('base64');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set, so sign-ins last only until the server restarts.');
}

const USER_COLUMNS = `id, name, email, role, is_active, approval_status, team_lead_id, salesperson,
  division, sub_division, password_hash, session_version, created_at`;

// A users row as this app sees it. `db` keeps the row's own fields, which the
// core services (src/core) expect when they act as this person.
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: fromDbRole(row.role),
    active: Number(row.is_active) === 1 && (!row.approval_status || row.approval_status === 'approved'),
    teamLeaderId: row.team_lead_id ?? null,
    salesperson: row.salesperson ?? null,
    division: row.division ?? null,
    subDivision: row.sub_division ?? null,
    passwordHash: row.password_hash,
    sessionVersion: row.session_version ?? 0,
    createdAt: row.created_at ?? null,
    db: {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      is_active: row.is_active,
      approval_status: row.approval_status,
      salesperson: row.salesperson,
      division: row.division,
      sub_division: row.sub_division,
    },
  };
}

// Checked when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// Failed sign-ins per email: 10 in 15 minutes, then that email waits.
const failures = new Map();
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function findByEmail(email) {
  return fromRow(await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER(?)`).get(email));
}

async function findUser(id) {
  if (!Number.isInteger(Number(id))) return null;
  return fromRow(await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(Number(id)));
}

// Everyone, or everyone with one of these roles (this app's names).
async function listUsers({ roles = null } = {}) {
  const rows = roles
    ? await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE role = ANY(?) ORDER BY name`).all(roles.map(toDbRole))
    : await db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY name`).all();
  return rows.map(fromRow).map(publicUser);
}

// Every permission that is about an order rather than about administering the
// app. Someone with none of them has no work here.
const ORDER_PERMISSIONS = [
  'raise_orders', 'edit_orders', 'delete_orders', 'restore_orders',
  'approve_orders', 'send_back_orders', 'reject_orders',
  'verify_payment', 'hold_payment', 'pick_pack_dispatch', 'deliver_orders',
];
const ADMIN_PERMISSIONS = ['manage_users', 'manage_settings'];
const ORBIT_WEB = () => (process.env.ORBIT_WEB_URL || '').replace(/\/$/, '');

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  roleLabel: ROLE_LABELS[u.role],
  active: u.active,
  createdAt: u.createdAt,
  teamLeaderId: u.teamLeaderId ?? null,
  division: u.division ?? null,
  canRaiseOrders: configStore.hasPermission(u.role, 'raise_orders'),
  canManageSettings: configStore.hasPermission(u.role, 'manage_settings'),
  canManageUsers: configStore.hasPermission(u.role, 'manage_users'),
  canDeleteOrders: configStore.hasPermission(u.role, 'delete_orders'),
  canRestoreOrders: configStore.hasPermission(u.role, 'restore_orders'),
  // Whether this person's home is Orbit rather than here: only once Orbit is
  // actually set up (ORBIT_WEB_URL). Until then an administrator works here,
  // where the recycle bin and the Zoho sync screen are.
  belongsInOrbit: Boolean(ORBIT_WEB()) && (
    ADMIN_PERMISSIONS.some((perm) => configStore.hasPermission(u.role, perm))
    || !ORDER_PERMISSIONS.some((perm) => configStore.hasPermission(u.role, perm))
  ),
  orbitUrl: ORBIT_WEB(),
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

// The signed-in person, read fresh from the database on every request: a role
// change, a deactivation or a password change elsewhere takes effect at once.
async function currentUser(req) {
  const session = verify(readCookie(req, COOKIE));
  if (!session) return null;
  const user = await findUser(session.uid);
  if (!user || !user.active || (user.sessionVersion ?? 0) !== session.v) return null;
  return user;
}

function setSession(res, user) {
  const token = sign({ uid: user.id, v: user.sessionVersion ?? 0, exp: Date.now() + SESSION_MS });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}

// ---------- middleware ----------

async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => (roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: `Only ${roles.map((r) => ROLE_LABELS[r]).join(' or ')} can do that.` }));
}

function requirePermission(perm) {
  return (req, res, next) => {
    // No role is waved through. What an Administrator may do is what the RBAC
    // screen says they may do, the same as everybody else.
    if (configStore.hasPermission(req.user.role, perm)) return next();
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

function fail(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// ---------- routes ----------

const router = express.Router();

router.post('/auth/login', jsonOnly, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const record = failures.get(email);
    if (record && record.count >= LOCK_AFTER && Date.now() - record.first < LOCK_MS) {
      return res.status(429).json({ error: 'Too many failed sign-ins for this email. Try again in 15 minutes.' });
    }

    const user = await findByEmail(email);
    const matches = checkPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches || !user.active) {
      const fresh = !record || Date.now() - record.first >= LOCK_MS;
      failures.set(email, fresh ? { count: 1, first: Date.now() } : { ...record, count: record.count + 1 });
      return res.status(401).json({ error: "That email and password don't match an active account." });
    }

    failures.delete(email);
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/auth/logout', jsonOnly, (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/auth/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/auth/change-password', jsonOnly, requireUser, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword) throw bad('Enter your current password.');
    if (!newPassword) throw bad('Enter a new password.');
    if (!checkPassword(String(currentPassword), req.user.passwordHash ?? DUMMY_HASH)) {
      throw bad('Current password does not match.');
    }
    const problem = passwordProblem(String(newPassword));
    if (problem) throw bad(problem);
    // bcrypt, so getmeds-system accepts the new password too. Raising the
    // session version signs this person out everywhere else.
    await db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?')
      .run(hashPassword(String(newPassword)), req.user.id);
    setSession(res, await findUser(req.user.id));
    announce(req.user, `Password changed: ${req.user.name}`, `${req.user.email} updated their account password`);
    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    fail(err, res, next);
  }
});

// Who can sign in and with which role is set on getmeds-system's Users screen
// (the same table). These answer rather than disappear, in case anything still
// calls them.
const managedElsewhere = (_req, res) => res.status(410).json({
  error: "Accounts are managed on getmeds-system's Users screen for now.",
});
router.get('/users', requireUser, managedElsewhere);
router.post('/users', requireUser, managedElsewhere);
router.patch('/users/:id', requireUser, managedElsewhere);

module.exports = {
  router,
  requireUser,
  requireRole,
  requirePermission,
  jsonOnly,
  findUser,
  listUsers,
  publicUser,
  onAccountChange,
  fromDbRole,
  toDbRole,
  ROLES,
  ROLE_LABELS,
};
