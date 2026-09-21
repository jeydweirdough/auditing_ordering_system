'use strict';

// Shared utilities and state across all pages

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));

const TZ = 'Asia/Manila';
const pesoFormat = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const peso = (n) => pesoFormat.format(Number(n) || 0);
const PHP0 = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
const PHP_SHORT = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1 });
const php = (n) => PHP0.format(Math.round(Number(n) || 0));
const phpShort = (n) => (Math.abs(n) >= 100_000 ? PHP_SHORT.format(n) : php(n));
const signedPhp = (n) => `${n >= 0 ? '+' : '−'}${php(Math.abs(n))}`;
const whole = (n) => Number(n ?? 0).toLocaleString('en-PH');
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const rate100 = (x) => (x == null ? null : x * 100);
const points = (x) => `${Math.round(x)} pts`;
const howLong = (h) => (h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
const ageText = (days) => (days < 1 ? 'under a day' : plural(days, 'day'));
const UNIT = { month: 'day', last_month: 'day', '90d': 'week', all: 'month' };
const updatedText = (d) => `Updated ${briefTime.format(new Date(d.at))}`;
const bytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const stampFormat = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const stamp = (iso) => stampFormat.format(new Date(iso));
const dateKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const briefTime = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const briefDay = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, day: 'numeric', month: 'short' });
const brief = (iso) => {
  const d = new Date(iso);
  return dateKey(d) === dateKey(new Date()) ? briefTime.format(d) : briefDay.format(d);
};
const dayFormat = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const day = (ymd) => dayFormat.format(new Date(`${ymd}T00:00:00Z`));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return stamp(iso);
}

const DONE = new Set(['completed', 'cancelled', 'rejected']);
const IN_DISPATCH = ['ready_for_dispatch', 'picking', 'packed', 'dispatched'];
const TONE = {
  pending_approval: 'wait', returned: 'wait', awaiting_payment: 'wait', on_hold: 'bad',
  ready_for_dispatch: 'move', picking: 'move', packed: 'move', dispatched: 'move',
  completed: 'ok', rejected: 'stop', cancelled: 'stop', deleted: 'stop',
};
const pill = (status, label) => `<span class="pill ${TONE[status] ?? 'stop'}">${esc(label || status)}</span>`;

const CREATORS = ['salesperson', 'management', 'admin'];

const INTRO = {
  salesperson: 'Raise orders, and fix the ones Management sends back.',
  management: 'Approve new orders, send them back for changes, or reject them. You can raise orders too, for yourself or a salesperson.',
  finance: 'Verify payment on approved orders, or put them on hold.',
  dispatch: 'Pick, pack and dispatch paid orders, then mark them delivered.',
  admin: 'Create, edit, delete and restore any order, and manage who can sign in. Every change is logged in #order-audit.',
};

const LANES = [
  ['ready_for_dispatch', 'Ready for dispatch'],
  ['picking', 'Picking'],
  ['packed', 'Packed'],
  ['dispatched', 'Dispatched'],
];

const ROUTE = [
  { type: 'created', label: 'Raised', who: 'Salesperson' },
  { type: 'approve', label: 'Approved', who: 'Management' },
  { type: 'verify_payment', label: 'Payment verified', who: 'Finance' },
  { type: 'start_picking', label: 'Picking', who: 'Dispatch' },
  { type: 'mark_packed', label: 'Packed', who: 'Dispatch' },
  { type: 'dispatch', label: 'Dispatched', who: 'Dispatch' },
  { type: 'deliver', label: 'Delivered', who: 'Dispatch' },
];

const REACHED = {
  pending_approval: 1, returned: 1, rejected: 1, awaiting_payment: 2, on_hold: 2,
  ready_for_dispatch: 3, picking: 4, packed: 5, dispatched: 6, completed: 7,
};

const PLACEHOLDERS = {
  customerName: 'e.g. Sto. Niño Pharmacy',
  contactNumber: 'e.g. 0917 123 4567',
  address: 'Complete hospital, clinic, or residential shipping address',
  receiverName: 'Who will receive the delivery',
  receiverContact: '09XXXXXXXXX',
  subDivision: 'e.g. MD Telesales',
  paymentTerms: 'e.g. Net 15, 30 days',
  deliveryMethod: 'e.g. LBC, Grab Express, Own Rider',
  doctorName: 'Referring or prescribing doctor',
  remarks: "e.g. Attn: Dr. Santos, Room 302. Handle with cold chain packaging. Write 'None' if there are no special instructions.",
  notes: 'Anything Finance or Dispatch should know',
};

// Global Network Progress Indicator
let activeRequests = 0;

function showLoadingProgress() {
  let bar = $('#global-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'global-progress-bar';
    bar.className = 'global-progress-bar';
    document.body.appendChild(bar);
  }
  bar.classList.remove('done');
  bar.classList.add('active');
}

function hideLoadingProgress() {
  const bar = $('#global-progress-bar');
  if (!bar) return;
  bar.classList.remove('active');
  bar.classList.add('done');
  setTimeout(() => {
    if (activeRequests <= 0) {
      bar.classList.remove('done');
    }
  }, 350);
}

// Button loading state helper
function setButtonLoading(btn, loading, text) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.dataset.prevHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-sm"></span>${esc(text || 'Please wait…')}`;
    btn.classList.add('btn-loading');
  } else {
    btn.disabled = false;
    if (btn.dataset.prevHtml) {
      btn.innerHTML = btn.dataset.prevHtml;
      delete btn.dataset.prevHtml;
    }
    btn.classList.remove('btn-loading');
  }
}

// API Client
class SignedOut extends Error {}

async function api(method, url, body) {
  activeRequests++;
  showLoadingProgress();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Is it running?");
  } finally {
    activeRequests--;
    if (activeRequests <= 0) {
      activeRequests = 0;
      hideLoadingProgress();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (url !== '/api/auth/login' && url !== '/api/auth/me' && window.location.pathname !== '/login') {
      window.location.href = '/login?msg=' + encodeURIComponent('Your session has ended. Please sign in again.');
    }
    throw new SignedOut();
  }
  if (res.status === 413 && !data.error) throw new Error('The files are too large to send. Keep them under 3 MB in all.');
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

function toast(message, kind = '') {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

// Floating Confirmation Modal Dialog
let confirmDialogEl = null;

function ensureConfirmDialog() {
  if (confirmDialogEl) return confirmDialogEl;
  confirmDialogEl = document.createElement('dialog');
  confirmDialogEl.id = 'confirm-dialog';
  confirmDialogEl.className = 'confirm-dialog';
  confirmDialogEl.innerHTML = `
    <div class="confirm-card">
      <div class="confirm-head">
        <div class="confirm-icon-wrap" id="confirm-icon-wrap"></div>
        <div class="confirm-title-wrap">
          <h3 class="confirm-title" id="confirm-title">Are you sure?</h3>
        </div>
      </div>
      <div class="confirm-body" id="confirm-message"></div>
      <div class="confirm-actions">
        <button type="button" class="btn quiet" id="confirm-cancel">Cancel</button>
        <button type="button" class="btn danger" id="confirm-ok">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(confirmDialogEl);

  confirmDialogEl.addEventListener('click', (e) => {
    if (e.target === confirmDialogEl) {
      confirmDialogEl.close('cancel');
    }
  });

  return confirmDialogEl;
}

function confirmModal({
  title = 'Please confirm',
  message = 'Are you sure you want to proceed?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = true,
  icon = 'warning',
} = {}) {
  return new Promise((resolve) => {
    const dialog = ensureConfirmDialog();
    const titleEl = $('#confirm-title');
    const msgEl = $('#confirm-message');
    const okBtn = $('#confirm-ok');
    const cancelBtn = $('#confirm-cancel');
    const iconWrap = $('#confirm-icon-wrap');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) {
      msgEl.innerHTML = typeof message === 'string' ? `<p>${esc(message)}</p>` : '';
    }
    if (okBtn) {
      okBtn.textContent = confirmText;
      okBtn.className = danger ? 'btn danger' : 'btn';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    if (iconWrap) {
      iconWrap.className = `confirm-icon-wrap ${danger ? 'is-danger' : 'is-warning'}`;
      if (icon === 'logout') {
        iconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>`;
      } else {
        iconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>`;
      }
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
    };

    const onOk = () => { cleanup(); dialog.close('ok'); resolve(true); };
    const onCancel = () => { cleanup(); dialog.close('cancel'); resolve(false); };
    const onClose = () => { cleanup(); resolve(dialog.returnValue === 'ok'); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);

    dialog.showModal();
    cancelBtn.focus();
  });
}

// Authentication check for protected pages
let currentUser = null;
let currentMeta = null;

async function ensureAuth() {
  try {
    const data = await api('GET', '/api/auth/me');
    if (!data || !data.user) {
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return null;
    }
    currentUser = data.user;

    // Administration is Orbit’s, and so is anyone who does it. Sent there
    // before a page is drawn, so nobody lands on a dashboard of work that
    // isn’t theirs and nothing flashes up first.
    if (currentUser.belongsInOrbit) {
      if (currentUser.orbitUrl) {
        window.location.replace(currentUser.orbitUrl);
        return null;
      }
      document.body.innerHTML = [
        '<div style="font:16px/1.5 system-ui;margin:3rem;max-width:34rem">',
        '<h1 style="font-size:1.3rem">This app is for taking orders</h1>',
        '<p>Accounts, roles and settings are managed in Orbit, so there is nothing here for you.</p>',
        '<p>Set <code>ORBIT_WEB_URL</code> in this app’s <code>.env</code> and this page will take you straight there.</p>',
        '</div>',
      ].join('');
      return null;
    }

    currentMeta = await api('GET', '/api/orders/meta').catch(() => null);
    return currentUser;
  } catch {
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    return null;
  }
}

async function signOut() {
  const confirmed = await confirmModal({
    title: 'Sign out',
    message: 'Are you sure you want to sign out of your account?',
    confirmText: 'Sign out',
    cancelText: 'Stay signed in',
    danger: true,
    icon: 'logout',
  });
  if (!confirmed) return;

  const btn = $('#btn-sign-out');
  if (btn) setButtonLoading(btn, true, 'Signing out…');

  try {
    await api('POST', '/api/auth/logout', {});
  } finally {
    window.location.href = '/login';
  }
}

// Shared Vertical Left Sidebar & Mobile Bottom Navigation
function renderTopNav(activeTab = 'orders') {
  if (!currentUser) return;
  document.body.classList.add('has-sidebar');

  // 1. Desktop Vertical Left Sidebar
  let sidebar = $('#app-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('aside');
    sidebar.id = 'app-sidebar';
    sidebar.className = 'app-sidebar';
    document.body.insertBefore(sidebar, document.body.firstChild);
  }

  const initials = (currentUser.name || 'U')
    .split(/\s+/)
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const isSettingsActive = activeTab === 'settings' || activeTab === 'people';
  const isPromotionsActive = activeTab === 'promotions';
  const isOrdersActive = activeTab === 'orders' || activeTab === 'order';
  const isDashboardActive = activeTab === 'dashboard';
  const isNewOrderActive = activeTab === 'new-order';

  const canRaise = currentUser.canRaiseOrders !== undefined
    ? Boolean(currentUser.canRaiseOrders)
    : CREATORS.includes(currentUser.role);
  // Administration lives in Orbit. These are the way there, not a screen here:
  // the server redirects them, and the arrow says so before you click.
  const canSettings = Boolean(currentUser.canManageSettings || currentUser.canManageUsers);
  const OUT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.55"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>`;

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <a href="/dashboard" class="sidebar-logo">
        <span class="logo-mark">GM</span>
        <div class="logo-text">
          <strong>GetMeds</strong>
          <span class="logo-sub">Orders System</span>
        </div>
      </a>
      <span class="live-status-dot" title="System online"></span>
    </div>

    ${canRaise ? `
    <div class="sidebar-cta-wrap">
      <a href="/new-order" class="btn-sidebar-new-order" id="sidebar-new-order-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>New order</span>
      </a>
    </div>` : ''}

    <nav class="sidebar-nav" aria-label="Main Navigation">
      <span class="nav-heading">Menu</span>
      <a href="/dashboard" class="nav-item ${isDashboardActive ? 'active' : ''}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
        <span>Dashboard</span>
      </a>
      <a href="/orders" class="nav-item ${isOrdersActive ? 'active' : ''}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>
        <span>Orders</span>
      </a>
      ${canSettings ? `
      <span class="nav-heading" style="margin-top: 12px;">In Orbit</span>
      <a href="/promotions" class="nav-item ${isPromotionsActive ? 'active' : ''}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        <span>Promos & Pricing</span>${OUT}
      </a>
      <a href="/settings" class="nav-item ${isSettingsActive ? 'active' : ''}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Accounts & settings</span>${OUT}
      </a>` : ''}
    </nav>

    <div class="sidebar-footer">
      <div class="user-card">
        <div class="user-avatar">${esc(initials)}</div>
        <div class="user-details">
          <span class="user-name" title="${esc(currentUser.name)}">${esc(currentUser.name)}</span>
          <span class="user-role-badge">${esc(currentUser.roleLabel || currentUser.role)}</span>
        </div>
      </div>
      <div class="user-menu-container" id="user-menu-container">
        <button type="button" class="btn-user-menu" id="btn-sidebar-user-menu" title="Account settings & actions" aria-haspopup="true" aria-expanded="false">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="1.5"></circle>
            <circle cx="12" cy="5" r="1.5"></circle>
            <circle cx="12" cy="19" r="1.5"></circle>
          </svg>
        </button>
        <div class="user-dropdown-menu" id="sidebar-user-dropdown" hidden>
          <div class="user-dropdown-header">
            <div class="user-dropdown-name">${esc(currentUser.name)}</div>
            <div class="user-dropdown-role">${esc(currentUser.roleLabel || currentUser.role)}</div>
            ${currentUser.division ? `<div class="user-dropdown-meta">${esc(currentUser.division)}</div>` : ''}
          </div>
          <div class="user-dropdown-divider"></div>
          <button type="button" class="user-dropdown-item" id="btn-sidebar-user-profile">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>User Profile</span>
          </button>
          ${canSettings ? `
          <a href="/promotions" class="user-dropdown-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span>Promos & Pricing</span>${OUT}
          </a>
          <a href="/settings" class="user-dropdown-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>Accounts & settings</span>${OUT}
          </a>` : ''}
          <div class="user-dropdown-divider"></div>
          <button type="button" class="user-dropdown-item is-signout" id="btn-sidebar-dropdown-signout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  `;

  // 2. Mobile Top Bar
  let mobileTop = $('#mobile-top-bar');
  if (!mobileTop) {
    mobileTop = document.createElement('header');
    mobileTop.id = 'mobile-top-bar';
    mobileTop.className = 'mobile-top-bar';
    document.body.insertBefore(mobileTop, document.body.firstChild);
  }
  mobileTop.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span class="logo-mark" style="width: 28px; height: 28px; font-size: 12px;">GM</span>
      <strong style="color: var(--navy); font-size: 15px;">GetMeds</strong>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <span class="user-role-badge">${esc(currentUser.roleLabel || currentUser.role)}</span>
      <button type="button" class="btn-signout-icon" id="btn-mobile-signout" title="Sign out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>
  `;

  // 3. Mobile Bottom Navigation Bar
  let mobileBottom = $('#mobile-bottom-nav');
  if (!mobileBottom) {
    mobileBottom = document.createElement('nav');
    mobileBottom.id = 'mobile-bottom-nav';
    mobileBottom.className = 'mobile-bottom-nav';
    document.body.appendChild(mobileBottom);
  }
  mobileBottom.innerHTML = `
    <a href="/dashboard" class="mobile-nav-btn ${isDashboardActive ? 'active' : ''}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
      <span>Dashboard</span>
    </a>
    <a href="/orders" class="mobile-nav-btn ${isOrdersActive ? 'active' : ''}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
      <span>Orders</span>
    </a>
    ${canRaise ? `
    <a href="/new-order" class="mobile-nav-btn ${isNewOrderActive ? 'active' : ''}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      <span>New</span>
    </a>` : ''}
    ${canSettings ? `
    <a href="/promotions" class="mobile-nav-btn ${isPromotionsActive ? 'active' : ''}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      <span>Promos</span>
    </a>
    <a href="/settings" class="mobile-nav-btn ${isSettingsActive ? 'active' : ''}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>Settings</span>
    </a>` : ''}
  `;

  // Attach user menu popover & signout listeners
  const userMenuBtn = $('#btn-sidebar-user-menu');
  const userDropdown = $('#sidebar-user-dropdown');

  if (userMenuBtn && userDropdown) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = userDropdown.hidden;
      userDropdown.hidden = !isHidden;
      userMenuBtn.setAttribute('aria-expanded', String(isHidden));
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!userDropdown.hidden && !e.target.closest('#user-menu-container')) {
        userDropdown.hidden = true;
        userMenuBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !userDropdown.hidden) {
        userDropdown.hidden = true;
        userMenuBtn.setAttribute('aria-expanded', 'false');
        userMenuBtn.focus();
      }
    });
  }

  $('#btn-sidebar-user-profile')?.addEventListener('click', () => {
    if (userDropdown) {
      userDropdown.hidden = true;
      userMenuBtn?.setAttribute('aria-expanded', 'false');
    }
    openUserProfileModal();
  });

  $('#btn-sidebar-dropdown-signout')?.addEventListener('click', signOut);
  $('#btn-mobile-signout')?.addEventListener('click', signOut);
  $('#btn-sign-out')?.addEventListener('click', signOut);

  // If on orders page and askWhoFor is available, clicking New Order can trigger askWhoFor directly
  const newOrderBtn = $('#sidebar-new-order-btn') || $('#sidebar-new-order-link');
  if (newOrderBtn && typeof window.askWhoFor === 'function') {
    newOrderBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.askWhoFor();
    });
  }
}

// ==========================================================================
// User Profile Modal (Personal Information & Password Update)
// ==========================================================================

let userProfileDialogEl = null;

function ensureUserProfileDialog() {
  if (userProfileDialogEl) return userProfileDialogEl;
  userProfileDialogEl = document.createElement('dialog');
  userProfileDialogEl.id = 'user-profile-dialog';
  userProfileDialogEl.className = 'profile-modal-dialog';
  userProfileDialogEl.innerHTML = `
    <div class="profile-modal-card">
      <div class="profile-modal-head">
        <h3>User Profile</h3>
        <button type="button" class="profile-modal-close" id="profile-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="profile-modal-body" id="profile-modal-content"></div>
    </div>
  `;
  document.body.appendChild(userProfileDialogEl);

  userProfileDialogEl.addEventListener('click', (e) => {
    if (e.target === userProfileDialogEl) userProfileDialogEl.close();
  });
  userProfileDialogEl.querySelector('#profile-modal-close')?.addEventListener('click', () => {
    userProfileDialogEl.close();
  });

  return userProfileDialogEl;
}

function openUserProfileModal() {
  if (!currentUser) return;
  const dialog = ensureUserProfileDialog();
  const content = dialog.querySelector('#profile-modal-content');
  if (!content) return;

  const initials = (currentUser.name || 'U')
    .split(/\s+/)
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-big-avatar">${esc(initials)}</div>
      <div class="profile-hero-info">
        <h4 class="profile-user-name">${esc(currentUser.name)}</h4>
        <span class="user-role-badge">${esc(currentUser.roleLabel || currentUser.role)}</span>
      </div>
    </div>

    <div class="profile-section" style="margin-top: 14px;">
      <h5 class="profile-section-title">Personal Information</h5>
      <div class="profile-info-grid">
        <div class="profile-info-item">
          <label>Full Name</label>
          <div>${esc(currentUser.name)}</div>
        </div>
        <div class="profile-info-item">
          <label>Email Address</label>
          <div>${esc(currentUser.email)}</div>
        </div>
        <div class="profile-info-item">
          <label>Role</label>
          <div><strong>${esc(currentUser.roleLabel || currentUser.role)}</strong></div>
        </div>
        <div class="profile-info-item">
          <label>Account Status</label>
          <div><span class="status-indicator-active">● Active</span></div>
        </div>
      </div>
    </div>

    <div class="profile-section" style="margin-top: 14px;">
      <h5 class="profile-section-title">Change Password</h5>
      <form id="profile-change-pw-form" class="profile-pw-form">
        <div class="field">
          <label for="profile-current-pw">Current Password</label>
          <input type="password" id="profile-current-pw" required placeholder="Enter your current password">
        </div>
        <div class="field">
          <label for="profile-new-pw">New Password</label>
          <input type="password" id="profile-new-pw" required placeholder="At least 8 characters">
        </div>
        <div class="field">
          <label for="profile-confirm-new-pw">Confirm New Password</label>
          <input type="password" id="profile-confirm-new-pw" required placeholder="Repeat your new password">
        </div>
        <div class="form-feedback" id="profile-pw-feedback" hidden></div>
        <div style="margin-top: 6px; display: flex; justify-content: flex-end;">
          <button type="submit" class="btn" id="btn-update-password">Update Password</button>
        </div>
      </form>
    </div>

    <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
      <button type="button" class="btn quiet" id="btn-close-profile">Close</button>
    </div>
  `;

  dialog.querySelector('#btn-close-profile')?.addEventListener('click', () => dialog.close());

  const form = dialog.querySelector('#profile-change-pw-form');
  const feedback = dialog.querySelector('#profile-pw-feedback');
  const submitBtn = dialog.querySelector('#btn-update-password');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = form.querySelector('#profile-current-pw').value;
    const newPassword = form.querySelector('#profile-new-pw').value;
    const confirmNew = form.querySelector('#profile-confirm-new-pw').value;

    if (newPassword !== confirmNew) {
      feedback.textContent = 'New passwords do not match.';
      feedback.className = 'form-feedback is-error';
      feedback.hidden = false;
      return;
    }

    setButtonLoading(submitBtn, true, 'Updating…');
    feedback.hidden = true;

    try {
      await api('POST', '/api/auth/change-password', { currentPassword, newPassword });
      feedback.textContent = 'Password updated successfully!';
      feedback.className = 'form-feedback is-success';
      feedback.hidden = false;
      form.reset();
      toast('Your password has been changed successfully.', 'ok');
    } catch (err) {
      feedback.textContent = err.message;
      feedback.className = 'form-feedback is-error';
      feedback.hidden = false;
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  dialog.showModal();
}

// Render Route stations (used in login and order audit)
function renderRouteLegend(container) {
  if (!container) return;
  container.innerHTML = ROUTE.map((s) => `<li class="stn"><span class="dot" aria-hidden="true"></span><b>${esc(s.label)}</b><small>${esc(s.who)}</small></li>`).join('');
}

// ==========================================================================
// Interactive Image Viewer Modal with Zoom, Pan, and Rotate
// ==========================================================================

let imageModalEl = null;
let currentZoom = 1.0;
let currentPanX = 0;
let currentPanY = 0;
let currentRotation = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

function ensureImageViewerModal() {
  if (imageModalEl) return imageModalEl;

  imageModalEl = document.createElement('div');
  imageModalEl.id = 'image-modal';
  imageModalEl.className = 'image-modal-overlay';
  imageModalEl.setAttribute('role', 'dialog');
  imageModalEl.setAttribute('aria-modal', 'true');
  imageModalEl.setAttribute('aria-label', 'Image preview');
  imageModalEl.hidden = true;

  imageModalEl.innerHTML = `
    <div class="image-modal-topbar">
      <div class="image-modal-meta">
        <span class="image-modal-title" id="image-modal-title"></span>
        <span class="image-modal-badge" id="image-modal-badge" hidden></span>
      </div>
      <div class="image-modal-tools">
        <div class="zoom-btn-group">
          <button type="button" class="img-tool-btn" id="btn-zoom-out" title="Zoom out (– or wheel down)">–</button>
          <span class="img-zoom-val" id="img-zoom-val">100%</span>
          <button type="button" class="img-tool-btn" id="btn-zoom-in" title="Zoom in (+ or wheel up)">+</button>
        </div>
        <button type="button" class="img-tool-btn text-tool" id="btn-zoom-reset" title="Reset zoom and rotation">Fit</button>
        <button type="button" class="img-tool-btn text-tool" id="btn-rotate" title="Rotate 90° clockwise">⟳ Rotate</button>
        <a class="img-tool-btn text-tool" id="btn-img-open-tab" href="#" target="_blank" rel="noopener" title="Open original in new tab">↗ New tab</a>
        <button type="button" class="img-tool-btn close-btn" id="btn-img-modal-close" title="Close (Esc)">✕</button>
      </div>
    </div>
    <div class="image-modal-stage" id="image-modal-stage">
      <div class="image-modal-canvas" id="image-modal-canvas">
        <img id="image-modal-img" src="" alt="Preview image" draggable="false" />
      </div>
      <div class="image-modal-hint">Scroll to zoom · Drag to pan · Double-click to toggle Fit / 200%</div>
    </div>
  `;

  document.body.appendChild(imageModalEl);

  const canvasEl = $('#image-modal-canvas', imageModalEl);
  const stageEl = $('#image-modal-stage', imageModalEl);
  const zoomValEl = $('#img-zoom-val', imageModalEl);

  function applyTransform(animate = true) {
    canvasEl.style.transition = animate ? 'transform 0.15s ease-out' : 'none';
    canvasEl.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoom}) rotate(${currentRotation}deg)`;
    zoomValEl.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  function setZoom(factor, animate = true) {
    const newZoom = Math.min(6.0, Math.max(0.2, currentZoom * factor));
    if (newZoom !== currentZoom) {
      currentZoom = newZoom;
      applyTransform(animate);
    }
  }

  function resetView() {
    currentZoom = 1.0;
    currentPanX = 0;
    currentPanY = 0;
    currentRotation = 0;
    applyTransform(true);
  }

  // Toolbar clicks
  $('#btn-zoom-in', imageModalEl).addEventListener('click', (e) => {
    e.stopPropagation();
    setZoom(1.25);
  });
  $('#btn-zoom-out', imageModalEl).addEventListener('click', (e) => {
    e.stopPropagation();
    setZoom(0.8);
  });
  $('#btn-zoom-reset', imageModalEl).addEventListener('click', (e) => {
    e.stopPropagation();
    resetView();
  });
  $('#btn-rotate', imageModalEl).addEventListener('click', (e) => {
    e.stopPropagation();
    currentRotation = (currentRotation + 90) % 360;
    applyTransform(true);
  });
  $('#btn-img-modal-close', imageModalEl).addEventListener('click', (e) => {
    e.stopPropagation();
    closeImageViewer();
  });

  // Wheel zoom
  stageEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setZoom(factor, false);
  }, { passive: false });

  // Double click toggles fit and 200%
  stageEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.img-tool-btn')) return;
    if (currentZoom > 1.15) {
      currentZoom = 1.0;
      currentPanX = 0;
      currentPanY = 0;
    } else {
      currentZoom = 2.0;
    }
    applyTransform(true);
  });

  // Drag & pan
  stageEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.image-modal-topbar') || e.target.closest('.img-tool-btn')) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = currentPanX;
    dragStartPanY = currentPanY;
    stageEl.classList.add('panning');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging || imageModalEl.hidden) return;
    currentPanX = dragStartPanX + (e.clientX - dragStartX);
    currentPanY = dragStartPanY + (e.clientY - dragStartY);
    applyTransform(false);
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      stageEl.classList.remove('panning');
    }
  });

  // Touch support
  let touchStartDist = 0;
  stageEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      dragStartPanX = currentPanX;
      dragStartPanY = currentPanY;
      stageEl.classList.add('panning');
    } else if (e.touches.length === 2) {
      isDragging = false;
      touchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  stageEl.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
      currentPanX = dragStartPanX + (e.touches[0].clientX - dragStartX);
      currentPanY = dragStartPanY + (e.touches[0].clientY - dragStartY);
      applyTransform(false);
    } else if (e.touches.length === 2 && touchStartDist > 0) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / touchStartDist;
      touchStartDist = dist;
      setZoom(factor, false);
    }
  }, { passive: true });

  stageEl.addEventListener('touchend', () => {
    isDragging = false;
    touchStartDist = 0;
    stageEl.classList.remove('panning');
  }, { passive: true });

  // Backdrop click close
  stageEl.addEventListener('click', (e) => {
    if (e.target === stageEl || e.target === canvasEl) {
      closeImageViewer();
    }
  });

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    if (imageModalEl.hidden) return;
    if (e.key === 'Escape') {
      closeImageViewer();
    } else if (e.key === '+' || e.key === '=') {
      setZoom(1.25);
    } else if (e.key === '-' || e.key === '_') {
      setZoom(0.8);
    } else if (e.key === '0') {
      resetView();
    } else if (e.key === 'r' || e.key === 'R') {
      currentRotation = (currentRotation + 90) % 360;
      applyTransform(true);
    }
  });

  return imageModalEl;
}

function openImageViewer({ url, name = 'Image Preview', kind = '' }) {
  if (!url) return;
  const modal = ensureImageViewerModal();
  const imgEl = $('#image-modal-img', modal);
  const titleEl = $('#image-modal-title', modal);
  const badgeEl = $('#image-modal-badge', modal);
  const openTabBtn = $('#btn-img-open-tab', modal);

  imgEl.src = url;
  titleEl.textContent = name;
  if (kind) {
    badgeEl.textContent = kind;
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
  openTabBtn.href = url;

  let spinner = $('#img-modal-spinner', modal);
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.id = 'img-modal-spinner';
    spinner.className = 'img-stage-spinner';
    const stage = $('#image-modal-stage', modal);
    if (stage) stage.appendChild(spinner);
  }
  spinner.hidden = false;
  imgEl.style.opacity = '0';
  imgEl.onload = () => {
    spinner.hidden = true;
    imgEl.style.opacity = '1';
  };
  imgEl.onerror = () => {
    spinner.hidden = true;
    imgEl.style.opacity = '1';
  };

  imgEl.src = url;

  currentZoom = 1.0;
  currentPanX = 0;
  currentPanY = 0;
  currentRotation = 0;
  const canvasEl = $('#image-modal-canvas', modal);
  canvasEl.style.transform = 'translate(0px, 0px) scale(1) rotate(0deg)';
  $('#img-zoom-val', modal).textContent = '100%';

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeImageViewer() {
  if (!imageModalEl) return;
  imageModalEl.hidden = true;
  const imgEl = $('#image-modal-img', imageModalEl);
  if (imgEl) imgEl.src = '';
  document.body.style.overflow = '';
}

// Global click listener for [data-preview-image] and image thumbnails
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-preview-image]');
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    const url = trigger.dataset.previewImage;
    const name = trigger.dataset.previewName || trigger.getAttribute('title') || 'Image Preview';
    const kind = trigger.dataset.previewKind || '';
    openImageViewer({ url, name, kind });
    return;
  }

  const thumbWrap = e.target.closest('.file-thumb-wrap:not(.doc-icon)');
  if (thumbWrap && thumbWrap.href) {
    e.preventDefault();
    e.stopPropagation();
    const name = thumbWrap.closest('.file-row')?.querySelector('.file-name')?.textContent || 'Image Preview';
    const kind = thumbWrap.closest('.file-row')?.querySelector('.file-kind-badge')?.textContent || '';
    openImageViewer({ url: thumbWrap.href, name, kind });
  }
});

/**
 * Custom Dropdown Component
 * Replaces native OS dropdown styling with GetMeds design system while preserving
 * full native <select> integration for forms, FormData, and change/input events.
 */
function enhanceSelect(select) {
  if (!select || select.tagName !== 'SELECT') return null;
  if (select.dataset.customEnhanced === 'true') {
    if (select._customSelectWrapper && select._customSelectWrapper._sync) {
      select._customSelectWrapper._sync();
    }
    return select._customSelectWrapper;
  }
  if (select.matches('.no-custom')) return null;

  select.dataset.customEnhanced = 'true';
  select.classList.add('sr-select');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  if (select.disabled) wrapper.classList.add('is-disabled');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (select.disabled) trigger.disabled = true;

  const valueEl = document.createElement('span');
  valueEl.className = 'custom-select-value';

  const arrowEl = document.createElement('span');
  arrowEl.className = 'custom-select-arrow';
  arrowEl.setAttribute('aria-hidden', 'true');
  arrowEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

  trigger.appendChild(valueEl);
  trigger.appendChild(arrowEl);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');

  // Insert wrapper right before select and nest elements
  if (select.parentNode) {
    select.parentNode.insertBefore(wrapper, select);
  }
  wrapper.appendChild(select);
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);

  let focusedIndex = -1;

  function closeMenu() {
    wrapper.classList.remove('is-open');
    wrapper.classList.remove('opens-up');
    trigger.setAttribute('aria-expanded', 'false');
    focusedIndex = -1;
    menu.querySelectorAll('.custom-select-option.is-focused').forEach(el => el.classList.remove('is-focused'));
  }

  function openMenu() {
    if (select.disabled) return;
    document.querySelectorAll('.custom-select.is-open').forEach(w => {
      if (w !== wrapper && w._closeMenu) w._closeMenu();
    });

    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < 220 && spaceAbove > spaceBelow) {
      wrapper.classList.add('opens-up');
    } else {
      wrapper.classList.remove('opens-up');
    }

    wrapper.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');

    const activeOpt = menu.querySelector('.custom-select-option.is-selected');
    if (activeOpt) {
      activeOpt.scrollIntoView({ block: 'nearest' });
    }
  }

  function toggleMenu() {
    if (wrapper.classList.contains('is-open')) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function selectOption(val) {
    const prevVal = select.value;
    select.value = val;
    syncDisplay();
    if (prevVal !== val) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function rebuildMenu() {
    menu.innerHTML = '';
    const options = Array.from(select.options);
    let selectedOption = null;

    options.forEach((opt, idx) => {
      const optEl = document.createElement('div');
      optEl.className = 'custom-select-option';
      optEl.setAttribute('role', 'option');
      optEl.dataset.value = opt.value;
      optEl.dataset.index = String(idx);
      optEl.textContent = opt.textContent;

      if (opt.selected) {
        optEl.classList.add('is-selected');
        optEl.setAttribute('aria-selected', 'true');
        selectedOption = opt;
      }
      if (opt.disabled) {
        optEl.classList.add('is-disabled');
      }

      optEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opt.disabled) return;
        selectOption(opt.value);
        closeMenu();
        trigger.focus();
      });

      menu.appendChild(optEl);
    });

    if (!selectedOption && options.length > 0) {
      selectedOption = options[select.selectedIndex >= 0 ? select.selectedIndex : 0];
    }

    if (selectedOption) {
      valueEl.textContent = selectedOption.textContent;
      valueEl.classList.toggle('is-placeholder', selectedOption.value === '');
    } else {
      valueEl.textContent = '';
      valueEl.classList.add('is-placeholder');
    }

    if (select.disabled) {
      wrapper.classList.add('is-disabled');
      trigger.disabled = true;
    } else {
      wrapper.classList.remove('is-disabled');
      trigger.disabled = false;
    }
  }

  function syncDisplay() {
    const selectedOpt = select.options[select.selectedIndex];
    if (selectedOpt) {
      valueEl.textContent = selectedOpt.textContent;
      valueEl.classList.toggle('is-placeholder', selectedOpt.value === '');
    } else {
      valueEl.textContent = '';
      valueEl.classList.add('is-placeholder');
    }

    menu.querySelectorAll('.custom-select-option').forEach((el) => {
      const isMatch = el.dataset.value === select.value;
      el.classList.toggle('is-selected', isMatch);
      el.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    if (select.disabled) {
      wrapper.classList.add('is-disabled');
      trigger.disabled = true;
    } else {
      wrapper.classList.remove('is-disabled');
      trigger.disabled = false;
    }
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  });

  trigger.addEventListener('keydown', (e) => {
    const isOpen = wrapper.classList.contains('is-open');
    const items = Array.from(menu.querySelectorAll('.custom-select-option:not(.is-disabled)'));
    if (!items.length) return;

    if (e.key === 'ArrowDown' || e.key === 'Down') {
      e.preventDefault();
      if (!isOpen) {
        openMenu();
        focusedIndex = items.findIndex(el => el.classList.contains('is-selected'));
        if (focusedIndex < 0) focusedIndex = 0;
      } else {
        focusedIndex = (focusedIndex + 1) % items.length;
      }
      highlightItem(items, focusedIndex);
    } else if (e.key === 'ArrowUp' || e.key === 'Up') {
      e.preventDefault();
      if (!isOpen) {
        openMenu();
        focusedIndex = items.findIndex(el => el.classList.contains('is-selected'));
        if (focusedIndex < 0) focusedIndex = items.length - 1;
      } else {
        focusedIndex = (focusedIndex - 1 + items.length) % items.length;
      }
      highlightItem(items, focusedIndex);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isOpen && focusedIndex >= 0 && items[focusedIndex]) {
        selectOption(items[focusedIndex].dataset.value);
        closeMenu();
      } else {
        toggleMenu();
      }
    } else if (e.key === 'Escape' || e.key === 'Esc' || e.key === 'Tab') {
      if (isOpen) {
        closeMenu();
      }
    }
  });

  function highlightItem(items, index) {
    items.forEach((item, i) => {
      const active = i === index;
      item.classList.toggle('is-focused', active);
      if (active) item.scrollIntoView({ block: 'nearest' });
    });
  }

  select.addEventListener('focus', () => {
    trigger.focus();
  });

  select.addEventListener('change', syncDisplay);

  if (window.MutationObserver) {
    const observer = new MutationObserver(() => {
      rebuildMenu();
    });
    observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
    wrapper._observer = observer;
  }

  if (select.form) {
    select.form.addEventListener('reset', () => {
      setTimeout(syncDisplay, 0);
    });
  }

  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.set) {
      Object.defineProperty(select, 'value', {
        get() {
          return desc.get.call(this);
        },
        set(val) {
          desc.set.call(this, val);
          syncDisplay();
        },
        configurable: true
      });
    }
  } catch (_) {}

  rebuildMenu();

  wrapper._closeMenu = closeMenu;
  wrapper._openMenu = openMenu;
  wrapper._sync = () => { rebuildMenu(); };
  select._customSelectWrapper = wrapper;

  return wrapper;
}

function initCustomSelects(root = document) {
  if (!root) return;
  const selects = root.querySelectorAll ? root.querySelectorAll('select:not([data-custom-enhanced]):not(.no-custom)') : [];
  selects.forEach(sel => enhanceSelect(sel));
}

// Global click listener to dismiss any open custom dropdown
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-select')) {
    document.querySelectorAll('.custom-select.is-open').forEach(w => {
      if (w._closeMenu) w._closeMenu();
      else w.classList.remove('is-open');
    });
  }
});

// Auto-initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initCustomSelects());
} else {
  initCustomSelects();
}
