'use strict';

const TABS = {
  salesperson: [
    { key: 'returned', label: 'Sent back to you', needs: true, match: (o) => o.status === 'returned', empty: 'Nothing has been sent back to you.' },
    { key: 'active', label: 'In progress', match: (o) => !DONE.has(o.status) && o.status !== 'returned', empty: 'No orders in progress. Raise one with New order.' },
    { key: 'done', label: 'Finished', match: (o) => DONE.has(o.status), empty: 'No finished orders yet.' },
  ],
  team_leader: [
    { key: 'tl_approval', label: 'Team review', needs: true, match: (o) => o.status === 'pending_tl_approval', empty: 'Nothing waiting for team review.' },
    { key: 'active', label: 'In progress', match: (o) => !DONE.has(o.status) && o.status !== 'pending_tl_approval', empty: 'No team orders in progress.' },
    { key: 'done', label: 'Finished', match: (o) => DONE.has(o.status), empty: 'No finished orders yet.' },
  ],
  management: [
    { key: 'approval', label: 'Waiting for approval', needs: true, match: (o) => o.status === 'pending_approval', empty: 'Nothing is waiting for approval.' },
    { key: 'active', label: 'In progress', match: (o) => !DONE.has(o.status) && o.status !== 'pending_approval', empty: 'No approved orders are in progress.' },
    { key: 'done', label: 'Finished', match: (o) => DONE.has(o.status), empty: 'No finished orders yet.' },
  ],
  finance: [
    { key: 'payment', label: 'Awaiting payment', needs: true, match: (o) => o.status === 'awaiting_payment', empty: 'No approved orders are waiting for payment.' },
    { key: 'hold', label: 'On hold', needs: true, match: (o) => o.status === 'on_hold', empty: 'No orders are on hold.' },
    { key: 'verified', label: 'Payment verified', match: (o) => [...IN_DISPATCH, 'completed'].includes(o.status), empty: 'No payments verified yet.' },
  ],
  dispatch: [
    { key: 'board', label: 'Dispatch board', needs: true, board: true, match: (o) => IN_DISPATCH.includes(o.status) },
    { key: 'delivered', label: 'Delivered', match: (o) => o.status === 'completed', empty: 'Nothing delivered yet.' },
  ],
  admin: [
    { key: 'all', label: 'All orders', match: (o) => o.status !== 'deleted', empty: 'No orders yet. Raise one with New order.' },
    { key: 'discord', label: 'Not in Discord', needs: true, match: (o) => o.discordProblem, empty: 'Every step is stored in #order-audit.' },
    { key: 'deleted', label: 'Recycle Bin 🗑️', match: (o) => o.status === 'deleted', empty: 'Recycle Bin is empty. Deleted items stay for 30 days before vanishing from Discord.' },
    { key: 'people', label: 'People' },
  ],
};

const DISCORD_STATE = {
  sent: (d) => ['sent', `Stored in ${d.inThread ? "the order's thread" : '#order-audit'}, data ${d.asReply ? 'in a reply' : 'in the next message'}`],
  queued: () => ['wait', 'Waiting to be stored in Discord'],
  sending: () => ['wait', 'Storing in Discord'],
  failed: (d) => ['bad', `Not stored in Discord yet: ${d.error}`],
  mocked: () => ['off', 'Mock mode: in memory only'],
  off: () => ['off', 'In memory only'],
};

const S = {
  tab: null,
  openId: null,
  order: null,
  side: null, // 'order' | 'edit' | 'resubmit'
  formFor: null,
  expanded: false,
  orders: [],
  pollTimer: null,
  staged: [],
  dash: { period: 'month', data: null },
};

function currentTab() {
  const list = TABS[currentUser.role] || [];
  return list.find((t) => t.key === S.tab) || list[0];
}

function renderTabs() {
  const tabs = $('#tabs');
  if (!tabs) return;
  const list = TABS[currentUser.role] || [];
  tabs.innerHTML = list.map((t) => {
    const count = t.match ? S.orders.filter(t.match).length : null;
    const active = t.key === currentTab().key;
    const badge = count != null && count > 0 ? `<span class="count${t.needs && count && !active ? ' hot' : ''}">${count}</span>` : '';
    return `<button type="button" class="tab" role="tab" data-tab="${esc(t.key)}" aria-selected="${active}">${esc(t.label)}${badge}</button>`;
  }).join('');
}

function renderMain() {
  const tab = currentTab();
  const main = $('#main');
  if (!main) return;
  if (tab.key === 'dashboard') {
    renderDashboard();
    return;
  }
  const list = S.orders.filter(tab.match);
  main.innerHTML = tab.board ? board(list) : table(list, tab.empty);
}

function layout() {
  const work = $('#work');
  const side = $('#side');
  work.classList.toggle('split', Boolean(S.side));
  work.classList.toggle('expanded', Boolean(S.side && S.expanded));
  side.hidden = !S.side;
  renderTabs();
  renderMain();
}

function table(list, empty) {
  if (!list.length) return `<div class="orders"><p class="empty">${esc(empty)}</p></div>`;
  const showOwner = currentUser.role !== 'salesperson';
  const isRecycleBin = S.tab === 'deleted';
  const emptyBinHeader = (isRecycleBin && currentUser.role === 'admin' && list.length)
    ? `<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem;"><button type="button" class="btn danger small" id="empty-recycle-bin-btn">🗑️ Empty Recycle Bin (${list.length})</button></div>`
    : '';
  const rows = list.map((o) => {
    let daysBadge = '';
    if (o.status === 'deleted') {
      const diff = new Date(o.purgeAt || (new Date(o.deletedAt || o.updatedAt).getTime() + 30 * 86400000)).getTime() - Date.now();
      const days = Math.max(0, Math.ceil(diff / 86400000));
      daysBadge = `<span class="badge warn-badge" style="margin-left:4px;">🗑️ ${days}d left</span>`;
    }
    return `
    <button type="button" class="row" data-open="${esc(o.id)}" aria-current="${o.id === S.openId}">
      <span class="id">${esc(o.id)}</span>
      <span class="cust"><strong>${esc(o.customerName)}</strong><small>${esc(o.division)} · ${plural(o.items, 'item')}${showOwner ? ` · by ${esc(o.owner)}` : ''}</small></span>
      <span class="amt">${peso(o.total)}</span>
      <span class="st">${pill(o.status, o.statusLabel)}${daysBadge}${o.discordProblem ? '<small class="dcflag">Not in Discord</small>' : ''}</span>
      <span class="age">${esc(ago(o.updatedAt))}</span>
    </button>`;
  }).join('');
  return `${emptyBinHeader}<div class="orders">
    <div class="row head" aria-hidden="true"><span class="id">Order</span><span class="cust">Customer</span><span class="amt">Total</span><span class="st">Status</span><span class="age">Updated</span></div>
    ${rows}
  </div>`;
}

function board(list) {
  return `<div class="board">${LANES.map(([status, label]) => {
    const cards = list.filter((o) => o.status === status);
    const body = cards.map((o) => `
      <button type="button" class="card" data-open="${esc(o.id)}" aria-current="${o.id === S.openId}">
        <span class="id">${esc(o.id)}</span>
        <strong>${esc(o.customerName)}</strong>
        <small>${esc(o.division)} · ${plural(o.items, 'item')}</small>
        <small>${esc(ago(o.updatedAt))}${o.discordProblem ? ' · <span class="dcflag">Not in Discord</span>' : ''}</small>
      </button>`).join('');
    return `<section class="lane"><h3 class="label"><span>${esc(label)}</span><span class="count">${cards.length}</span></h3>${body || '<p class="lane-empty">Nothing here.</p>'}</section>`;
  }).join('')}</div>`;
}

// ---------- Dashboards ----------

function delta(now, prev, fmt, goodUp = true) {
  const compare = S.dash.data?.period?.compare;
  if (!compare || now == null || prev == null) return '';
  const diff = now - prev;
  if (Math.abs(diff) < 0.005) return `<p class="delta">No change vs ${esc(compare)}</p>`;
  const tone = (diff > 0) === goodUp ? 'good' : 'bad';
  return `<p class="delta ${tone}"><span aria-hidden="true">${diff > 0 ? '▲' : '▼'}</span> ${diff > 0 ? '+' : '−'}${esc(fmt(Math.abs(diff)))} vs ${esc(compare)}</p>`;
}

function niceMax(v) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

const dashHero = ({ label, tag = '', value, sub = '', body = '' }) => `
  <section class="dash-hero">
    <div class="hero-head">
      <h2 class="label">${esc(label)}${tag ? ` <span class="tag">${esc(tag)}</span>` : ''}</h2>
      <p class="hero-fig">${esc(value)}</p>
      ${sub}
    </div>
    ${body}
  </section>`;

const dashCard = ({ label, tag = '', value, sub = '', foot = '' }) => `
  <section class="dash-card">
    <h3 class="label">${esc(label)}${tag ? ` <span class="tag">${esc(tag)}</span>` : ''}</h3>
    <p class="card-fig">${esc(value)}</p>
    <div class="card-sub">${sub}</div>
    ${foot ? `<div class="card-foot">${foot}</div>` : ''}
  </section>`;

function colChart(trend, unit) {
  const max = niceMax(Math.max(0, ...trend.map((b) => b.value)));
  const every = Math.ceil(trend.length / 6);
  const cols = trend.map((b) => `<button type="button" class="col" style="--h:${max ? (b.value / max) * 100 : 0}%"
      data-tip-value="${esc(php(b.value))}" data-tip-label="${esc(`${b.label} · ${plural(b.count, 'order')}`)}"
      aria-label="${esc(`${b.label}: ${php(b.value)}, ${plural(b.count, 'order')}`)}"><span></span></button>`).join('');
  const xs = trend.map((b, i) => `<span>${i % every === 0 ? esc(b.label) : ''}</span>`).join('');
  const rows = trend.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${esc(php(b.value))}</td><td class="num">${b.count}</td></tr>`).join('');
  return `<figure class="viz" aria-label="Sales by ${esc(unit)}">
      <div class="viz-plot">
        <div class="viz-y" aria-hidden="true"><span style="top:0">${esc(phpShort(max))}</span><span style="top:50%">${esc(phpShort(max / 2))}</span><span style="top:100%">₱0</span></div>
        <div class="viz-area">
          <div class="viz-grid" aria-hidden="true"><i style="top:0"></i><i style="top:50%"></i><i class="base" style="top:100%"></i></div>
          <div class="viz-cols" style="--n:${trend.length}">${cols}</div>
          <div class="viz-x" style="--n:${trend.length}" aria-hidden="true">${xs}</div>
        </div>
      </div>
      <details class="viz-table"><summary>Show as a table</summary>
        <div class="table-wrap"><table class="dash-table">
          <thead><tr><th>${esc(unit[0].toUpperCase() + unit.slice(1))}</th><th class="num">Sales</th><th class="num">Orders</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </details>
    </figure>`;
}

function spark(values) {
  const max = Math.max(0, ...values);
  if (values.length < 2 || !max) return '';
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(29 - (v / max) * 27).toFixed(2)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

const running = (xs) => {
  let sum = 0;
  return xs.map((x) => (sum += x));
};

function agingBar(aging) {
  const total = aging.reduce((s, b) => s + b.value, 0);
  const segs = aging.map((b, i) => (b.value ? `<button type="button" class="seg a${i}" style="flex-grow:${b.value}"
      data-tip-value="${esc(php(b.value))}" data-tip-label="${esc(`${b.label} · ${b.days} · ${plural(b.count, 'order')}`)}"
      aria-label="${esc(`${b.label}, ${b.days}: ${php(b.value)}, ${plural(b.count, 'order')}`)}"></button>` : '')).join('');
  const legend = aging.map((b, i) => `<li><i class="sw a${i}" aria-hidden="true"></i><span>${esc(b.label)} <small>${esc(b.days)}</small></span><strong>${esc(php(b.value))}</strong><small>${plural(b.count, 'order')}</small></li>`).join('');
  return `<div class="aging">${total ? `<div class="stack">${segs}</div>` : '<p class="quiet-box">Nothing is waiting for payment.</p>'}<ul class="legend">${legend}</ul></div>`;
}

const barCell = (value, max) => `<td><span class="inbar-cell"><span class="inbar" aria-hidden="true"><i style="--w:${max ? (value / max) * 100 : 0}%"></i></span><span class="num">${esc(php(value))}</span></span></td>`;

const orderLinks = (list, right) => `<ul class="mini">${list.map((o) => `<li><button type="button" class="mini-row" data-open="${esc(o.id)}">
    <span class="id">${esc(o.id)}</span><span class="mini-name">${esc(o.customer ?? o.owner)}</span><span class="num">${right(o)}</span>
  </button></li>`).join('')}</ul>`;

function salespersonDash(d) {
  const { now: n, prev: p } = d;
  return `
    ${dashHero({
      label: `Your sales · ${d.period.label}`,
      value: php(n.sales),
      sub: `${delta(n.sales, p?.sales, php)}<p class="hint">Orders you raised in this period, less any cancelled or rejected.</p>`,
      body: n.raised ? colChart(d.trend, UNIT[d.period.key]) : '<p class="quiet-box">You haven’t raised an order in this period yet.</p>',
    })}
    <div class="dash-cards">
      ${dashCard({ label: 'Orders raised', value: whole(n.raised), sub: delta(n.raised, p?.raised, whole) })}
      ${dashCard({ label: 'Approval rate', value: pct(n.approvalRate), sub: `<p class="hint">${n.approved} approved of ${plural(n.decisions, 'decision')} by Management</p>${delta(rate100(n.approvalRate), rate100(p?.approvalRate), points)}` })}
      ${dashCard({ label: 'Delivered', value: php(n.deliveredValue), sub: `<p class="hint">${plural(n.delivered, 'order')} delivered</p>${delta(n.deliveredValue, p?.deliveredValue, php)}` })}
      ${dashCard({
        label: 'Sent back to you',
        tag: 'Now',
        value: whole(d.sentBack),
        sub: `<p class="hint">${d.sentBack ? 'Waiting for your changes.' : 'Nothing to fix.'}</p>`,
        foot: d.sentBack ? '<button type="button" class="link" data-go-tab="returned">Fix them</button>' : '',
      })}
    </div>`;
}

function managementDash(d) {
  const { now: n, prev: p } = d;
  const max = Math.max(0, ...d.team.map((t) => t.value));
  const rows = d.team.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.approved}</td>${barCell(t.value, max)}<td class="num">${t.sentBack}</td><td class="num">${t.rejected}</td><td class="num">${esc(php(t.delivered))}</td></tr>`).join('');
  const table = d.team.length ? `<div class="table-wrap"><table class="dash-table">
      <thead><tr><th>Salesperson</th><th class="num">Approved</th><th>Value approved</th><th class="num">Sent back</th><th class="num">Rejected</th><th class="num">Delivered</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : '<p class="quiet-box">You haven’t decided on any orders in this period yet.</p>';
  const w = d.waiting;
  return `
    ${dashHero({
      label: `Your team · ${d.period.label}`,
      value: php(n.approvedValue),
      sub: `${delta(n.approvedValue, p?.approvedValue, php)}<p class="hint">Approved by you, across ${plural(n.approved, 'order')}. Your team is the salespeople whose orders you decided on.</p>`,
      body: table,
    })}
    <div class="dash-cards">
      ${dashCard({
        label: 'Waiting for you',
        tag: 'Now',
        value: whole(w.count),
        sub: `<p class="hint">${w.count ? `${php(w.value)} · oldest ${ageText(w.oldestDays)}` : 'Nothing is waiting for approval.'}</p>`,
        foot: w.count ? '<button type="button" class="link" data-go-tab="approval">Review them</button>' : '',
      })}
      ${dashCard({ label: 'Approval rate', value: pct(n.approvalRate), sub: `<p class="hint">${n.approved} approved · ${n.sentBack} sent back · ${n.rejected} rejected</p>${delta(rate100(n.approvalRate), rate100(p?.approvalRate), points)}` })}
      ${dashCard({ label: 'Time to decide', value: howLong(n.decideHours), sub: `<p class="hint">Median, from an order reaching you to your decision</p>${delta(n.decideHours, p?.decideHours, howLong, false)}` })}
      ${dashCard({ label: 'Team delivered', value: php(n.delivered), sub: `<p class="hint">Orders you approved, delivered in this period</p>${delta(n.delivered, p?.delivered, php)}` })}
    </div>`;
}

function financeDash(d) {
  const { awaiting: a, large, mismatches: m, onHold: h, verified: v } = d;
  const dayPill = (days) => `<span class="pill ${days > 14 ? 'bad' : days > 7 ? 'wait' : 'stop'}">${ageText(days)}</span>`;
  const oldest = a.oldest.length ? `<div class="hero-list"><h3 class="label">Waiting longest</h3>${orderLinks(a.oldest, (o) => `${esc(php(o.total))} ${dayPill(o.days)}`)}</div>` : '';
  return `
    ${dashHero({
      label: 'Awaiting payment',
      tag: 'Now',
      value: php(a.value),
      sub: `<p class="hint">${plural(a.count, 'approved order')} waiting for payment, by days since approval.</p>`,
      body: `${agingBar(a.aging)}${oldest}`,
    })}
    <div class="dash-cards">
      ${dashCard({
        label: 'Large orders',
        tag: 'Now',
        value: whole(large.count),
        sub: `<p class="hint">Open orders of ${php(large.threshold)} or more${large.count ? `, ${php(large.value)} in all` : ''}. Give them a second look before verifying payment.</p>`,
        foot: large.top.length ? orderLinks(large.top, (o) => esc(php(o.total))) : '',
      })}
      ${dashCard({
        label: 'Amount mismatches',
        value: whole(m.count),
        sub: `<p class="hint">${m.count ? `Verified payments that differ from the order total: ${esc(signedPhp(m.net))} net.` : 'Every payment verified in this period matched its order total.'}</p>${delta(m.count, m.prevCount, whole, false)}`,
        foot: m.top.length ? orderLinks(m.top, (o) => esc(signedPhp(o.received - o.total))) : '',
      })}
      ${dashCard({
        label: 'On hold',
        tag: 'Now',
        value: whole(h.count),
        sub: `<p class="hint">${h.count ? `${php(h.value)} held · longest ${ageText(h.longestDays)}` : 'No orders are on hold.'}</p>`,
        foot: h.count ? '<button type="button" class="link" data-go-tab="hold">Open them</button>' : '',
      })}
      ${dashCard({ label: 'Payments verified', value: php(v.received), sub: `<p class="hint">${plural(v.count, 'payment')} verified in this period</p>${delta(v.received, v.prevReceived, php)}` })}
    </div>`;
}

function adminDash(d) {
  const { now: n, prev: p } = d;
  const inactive = (u) => (u.active ? '' : ' <span class="tag">Inactive</span>');
  const maxSales = Math.max(0, ...d.salespeople.map((s) => s.sales));
  const sales = d.salespeople.length ? `<div class="table-wrap"><table class="dash-table">
      <thead><tr><th>Salesperson</th><th class="num">Raised</th><th>Sales</th><th class="num">Delivered</th><th class="num">Approval rate</th></tr></thead>
      <tbody>${d.salespeople.map((s) => `<tr><td>${esc(s.name)}${inactive(s)}</td><td class="num">${s.raised}</td>${barCell(s.sales, maxSales)}<td class="num">${esc(php(s.deliveredValue))}</td><td class="num">${pct(s.approvalRate)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="quiet-box">No salespeople yet.</p>';
  const managers = d.managers.length ? `<div class="table-wrap"><table class="dash-table">
      <thead><tr><th>Manager</th><th class="num">Decisions</th><th class="num">Approved</th><th class="num">Sent back</th><th class="num">Rejected</th><th class="num">Time to decide</th></tr></thead>
      <tbody>${d.managers.map((m) => `<tr><td>${esc(m.name)}${inactive(m)}</td><td class="num">${m.decisions}</td><td class="num">${m.approved}</td><td class="num">${m.sentBack}</td><td class="num">${m.rejected}</td><td class="num">${esc(howLong(m.decideHours))}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="quiet-box">No managers yet.</p>';
  const people = (d.roles || []).filter(Boolean).map((r) => `<li><span>${esc(r.label || r.role)}</span><strong>${r.active || 0}</strong>${r.inactive ? `<small>+${r.inactive} inactive</small>` : ''}</li>`).join('');
  const active = (d.roles || []).filter(Boolean).reduce((s, r) => s + (r.active || 0), 0);
  const dc = d.discord;
  const [dcValue, dcHint] = dc.kind !== 'discord' ? ['Memory only', "Orders aren't stored in #order-audit, so they're lost when the server stops."]
    : dc.failed ? [plural(dc.failed, 'step'), 'not stored in #order-audit yet.']
    : dc.waiting ? ['On the way', `${plural(dc.waiting, 'step')} being stored in #order-audit.`]
    : ['All stored', 'Every step is in #order-audit.'];
  return `
    ${dashHero({
      label: `Overall performance · ${d.period.label}`,
      value: php(n.sales),
      sub: `${delta(n.sales, p?.sales, php)}<p class="hint">Sales across everyone, less cancelled or rejected orders, and how each person is doing.</p>`,
      body: `<div class="hero-list"><h3 class="label">Salespeople</h3>${sales}</div><div class="hero-list"><h3 class="label">Management</h3>${managers}</div>`,
    })}
    <div class="dash-cards">
      ${dashCard({ label: 'Orders raised', value: whole(n.raised), sub: `${delta(n.raised, p?.raised, whole)}${spark(running(d.trend.map((b) => b.count)))}` })}
      ${dashCard({ label: 'Delivered', value: php(n.deliveredValue), sub: `<p class="hint">${plural(n.delivered, 'order')} delivered</p>${delta(n.deliveredValue, p?.deliveredValue, php)}` })}
      ${dashCard({ label: 'People', tag: 'Now', value: whole(active), sub: `<ul class="people-mini">${people}</ul>`, foot: '<button type="button" class="link" data-go-tab="people">Manage people</button>' })}
      ${dashCard({ label: 'Discord storage', tag: 'Now', value: dcValue, sub: `<p class="hint">${esc(dcHint)}</p>`, foot: dc.failed ? '<button type="button" class="link" data-go-tab="discord">See which</button>' : '' })}
    </div>`;
}

function dashboardHtml(d) {
  const periods = Object.entries(d.periods).map(([key, label]) => `<button type="button" class="seg-btn" data-period="${esc(key)}" aria-pressed="${key === d.period.key}">${esc(label)}</button>`).join('');
  const bodyFn = { salesperson: salespersonDash, management: managementDash, finance: financeDash, admin: adminDash }[d.role];
  const body = bodyFn ? bodyFn(d) : `<p class="quiet-box">No dashboard for role ${esc(d.role)}.</p>`;
  return `<div class="dash">
      <div class="dash-bar">
        <div class="seg-group" role="group" aria-label="Period">${periods}</div>
        <p class="hint" id="dash-at">${esc(updatedText(d))}</p>
      </div>
      ${body}
    </div>`;
}

function showTip(el) {
  const tip = $('#viz-tip');
  if (!tip) return;
  const value = document.createElement('strong');
  value.textContent = el.dataset.tipValue;
  const label = document.createElement('span');
  label.textContent = el.dataset.tipLabel;
  tip.replaceChildren(value, label);
  tip.hidden = false;
  const box = (el.querySelector('span') ?? el).getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, box.top - tip.offsetHeight - 8)}px`;
}

function hideTip() {
  const tip = $('#viz-tip');
  if (tip) tip.hidden = true;
}

function renderDashboard() {
  const main = $('#main');
  if (!main) return;
  if (!main.querySelector('.dash')) {
    const cached = S.dash.data?.period?.key === S.dash.period ? S.dash.data : null;
    main.innerHTML = cached ? dashboardHtml(cached) : '<div class="dash"><div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading dashboard…</p></div></div>';
  }
  loadDashboard();
}

async function loadDashboard() {
  const main = $('#main');
  if (!main) return;
  const period = S.dash.period;
  main.querySelector('.dash')?.classList.add('loading');
  try {
    const data = await api('GET', `/api/orders/dashboard?period=${encodeURIComponent(period)}`);
    if (period !== S.dash.period || currentTab().key !== 'dashboard') return;
    const unchanged = S.dash.data && JSON.stringify({ ...S.dash.data, at: null }) === JSON.stringify({ ...data, at: null });
    S.dash.data = data;
    const shown = main.querySelector('.dash');
    if (unchanged && shown?.querySelector('.dash-hero')) {
      shown.classList.remove('loading');
      const atEl = $('#dash-at');
      if (atEl) atEl.textContent = updatedText(data);
      return;
    }
    hideTip();
    main.innerHTML = dashboardHtml(data);
  } catch (err) {
    if (err instanceof SignedOut) return;
    main.querySelector('.dash')?.classList.remove('loading');
    toast(err.message, 'bad');
  }
}

async function openOrder(id) {
  try {
    const { order } = await api('GET', `/api/orders/${encodeURIComponent(id)}`);
    S.openId = id;
    S.order = order;
    S.side = 'order';
    S.formFor = null;
    updateUrlParams();
    layout();
    renderSide();
    $('#side').scrollTop = 0;
  } catch (err) {
    if (err instanceof SignedOut) return;
    toast(err.message, 'bad');
    closeSide();
  }
}

function closeSide() {
  S.side = null;
  S.openId = null;
  S.order = null;
  S.formFor = null;
  S.expanded = false;
  S.staged = [];
  updateUrlParams();
  layout();
}

function updateUrlParams() {
  const params = new URLSearchParams();
  if (S.tab) params.set('tab', S.tab);
  if (S.openId) params.set('open', S.openId);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  if (S.side === 'order' && S.order) side.innerHTML = orderView(S.order);
  else if ((S.side === 'resubmit' || S.side === 'edit') && S.order) side.innerHTML = orderForm(S.order, S.side);
  if (S.side !== 'order') recalc();
}

const dl = (rows) => `<dl class="facts">${rows.map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>`;

function route(o) {
  let base = o.status;
  for (let i = o.events.length - 1; (base === 'cancelled' || base === 'deleted') && i >= 0; i--) base = o.events[i].from ?? 'pending_approval';
  const reached = REACHED[base] ?? 0;
  const halt = { cancelled: 'Cancelled', rejected: 'Rejected', deleted: 'Deleted' }[o.status];
  const flag = { returned: 'Sent back', on_hold: 'On hold' }[o.status];
  return `<ol class="route" aria-label="Where this order is">${ROUTE.map((s, i) => {
    let cls = '';
    let note = '';
    let title = '';
    if (i < reached) {
      const ev = s.type === 'created' ? o.events[0] : o.events.findLast((e) => e.type === s.type);
      cls = 'done';
      note = ev ? `${ev.actor.name.split(' ')[0]} · ${brief(ev.at)}` : '';
      title = ev ? `${ev.actor.name}, ${stamp(ev.at)}` : '';
    } else if (i === reached) {
      if (halt) {
        cls = 'halt';
        note = halt;
      } else {
        cls = flag ? 'now flag' : 'now';
        note = flag ?? (o.waitingOn ? `With ${o.waitingOn}` : 'Next');
      }
    }
    return `<li class="stn ${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="dot" aria-hidden="true"></span><b>${esc(s.label)}</b>${note ? `<small>${esc(note)}</small>` : ''}</li>`;
  }).join('')}</ol>`;
}

function orderView(o) {
  const facts = [
    ['Customer', o.customerName],
    ['Contact number', o.contactNumber],
    ['Delivery address', o.address || o.deliveryAddress],
    ['Receiver', [o.receiverName, o.receiverContact].filter(Boolean).join(' · ')],
    ['Division', o.division],
    ['Sub-division', o.subDivision],
    ['Head quarter', o.headQuarter],
    ['Invoicing from', o.invoicingFrom],
    ['Source', o.source],
    ['Payment method', o.paymentMethod],
    ['Payment terms', o.paymentTerms],
    ['Delivery method', o.deliveryMethod],
    ['Customer is the doctor', o.customerIsDoctor],
    ['Doctor', o.doctorName],
    ['Customer remarks', o.remarks],
    ['Notes', o.notes],
  ].filter(([, v]) => v);

  const pay = o.payment && [
    ['Paid by', o.payment.method],
    ['Reference number', o.payment.reference],
    ['Amount received', peso(o.payment.amount)],
    ['Paid on', day(o.payment.paidOn)],
    ['Verified by', `${o.payment.verifiedBy}, ${stamp(o.payment.verifiedAt)}`],
  ];
  const short = o.payment && Math.abs(o.payment.amount - o.total) >= 0.01;
  const trackingVal = o.shipment?.trackingNumber;
  const isUrl = Boolean(trackingVal && /^(https?:\/\/)/i.test(trackingVal.trim()));
  const trackingDisplay = isUrl
    ? `<a href="${esc(trackingVal.trim())}" target="_blank" rel="noopener noreferrer" style="color:var(--brand);font-weight:600;text-decoration:underline;word-break:break-all;">🔗 ${esc(trackingVal.trim())} ↗</a>`
    : trackingVal;

  const ship = o.shipment && [
    ['Courier', o.shipment.courier],
    ['Tracking / Ref ID', trackingDisplay, isUrl],
    ['Packed', [o.shipment.packedBy, o.shipment.packedAt && stamp(o.shipment.packedAt)].filter(Boolean).join(' · ')],
    ['Packing notes', o.shipment.packingNotes],
    ['Dispatched', [o.shipment.dispatchedBy, o.shipment.dispatchedAt && stamp(o.shipment.dispatchedAt)].filter(Boolean).join(' · ')],
    ['Received by', o.shipment.receivedBy],
    ['Delivered', [o.shipment.deliveredBy, o.shipment.deliveredAt && stamp(o.shipment.deliveredAt)].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);

  const shipProofFiles = (o.attachments || []).filter((f) => ['packing_proof', 'dispatch_proof', 'delivery_proof'].includes(f.kind));

  const canEdit = o.actions?.some((a) => a.name === 'edit');

  return `
    <div class="side-head">
      <div class="side-head-nav" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <button type="button" class="link" data-close>Back to the list</button>
        <button type="button" class="btn quiet small" data-toggle-expand>${S.expanded ? '⛶ Split view' : '⛶ Full view'}</button>
      </div>
      <div class="side-top">
        <h2 class="order-id">${esc(o.id)}</h2>
        ${pill(o.status, o.statusLabel)}
        ${canEdit ? `<button type="button" class="btn quiet small" data-action="edit" style="margin-left:auto;">Edit order</button>` : ''}
      </div>
      <p class="sub">Raised by ${esc(o.createdBy.name)}${o.owner && o.owner.id !== o.createdBy.id ? ` for ${esc(o.owner.name)}` : ''}, ${esc(stamp(o.createdAt))}${o.waitingOn ? ` · Next: <strong>${esc(o.waitingOn)}</strong>` : ''}</p>
    </div>
    ${o.status === 'deleted' ? (() => {
      const diff = new Date(o.purgeAt || (new Date(o.deletedAt || o.updatedAt).getTime() + 30 * 86400000)).getTime() - Date.now();
      const days = Math.max(0, Math.ceil(diff / 86400000));
      const purgeDate = new Date(o.purgeAt || (new Date(o.deletedAt || o.updatedAt).getTime() + 30 * 86400000)).toLocaleDateString();
      return `<div class="banner warn-banner" style="margin:12px 0;padding:10px 14px;border-radius:6px;background:rgba(234,179,8,0.12);border:1px solid rgba(234,179,8,0.3);color:var(--ink);">
        <strong>🗑️ In Recycle Bin</strong>: Retained in Discord for 30 days before automatic deletion.
        <br><small><strong>${days} days remaining</strong> (Will automatically vanish from Discord on ${purgeDate})</small>
      </div>`;
    })() : ''}
    ${o.status === 'returned' ? (() => {
      const sentBack = o.events.findLast((e) => e.type === 'send_back' || e.type === 'tl_send_back');
      const senderRole = sentBack?.actor?.role === 'team_leader' ? 'Team Leader' : 'Management';
      return `<div class="banner warn-banner" style="margin:12px 0;padding:12px 16px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:var(--ink);">
        <strong style="display:flex;align-items:center;gap:6px;font-size:14px;color:var(--bad, #dc2626);">↩ Order Sent Back for Changes</strong>
        <p style="margin:6px 0 0;font-size:13.5px;">${sentBack?.actor ? `<strong>${esc(sentBack.actor.name)} (${esc(senderRole)}) noted:</strong> ` : ''}"${esc(sentBack?.note || 'Please review and correct order details.')}"</p>
        <p class="hint" style="margin:6px 0 0;font-size:12px;">Review the requested changes below. You can update products, quantities, price tiers, customer information, or attachments and resubmit.</p>
      </div>`;
    })() : ''}
    <div class="route-wrap">${route(o)}</div>
    ${stepBox(o)}
    <section class="block"><h3 class="label">Order</h3>${dl(facts)}</section>
    <section class="block"><h3 class="label">Items</h3>${itemsTable(o)}</section>
    ${o.attachments?.length ? `<section class="block"><h3 class="label">Attachments</h3>${filesList(o)}</section>` : ''}
    ${pay ? `<section class="block"><h3 class="label">Payment</h3>${dl(pay)}${short ? `<p class="warn">The amount received differs from the order total of ${peso(o.total)}.</p>` : ''}</section>` : ''}
    ${ship?.length ? `
      <section class="block">
        <h3 class="label">Shipment & Delivery Proof</h3>
        ${dl(ship)}
        ${shipProofFiles.length ? `
          <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line);">
            <span class="sub" style="font-size:12px; font-weight:700; color:var(--navy); display:block; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.04em;">Proof of Packing, Dispatch & Delivery (${shipProofFiles.length})</span>
            ${filesList({ id: o.id, attachments: shipProofFiles })}
          </div>` : ''}
      </section>` : ''}
    <section class="block" id="audit">${auditView(o)}</section>
    ${dangerZone(o)}`;
}

function isImageFile(name, type) {
  if (type && type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(name || '');
}

function filesList(o) {
  const kinds = currentMeta?.files?.kinds || {};
  return `<ul class="file-rows">${(o.attachments || []).map((f) => {
    const isImg = isImageFile(f.name);
    const url = `/api/orders/${encodeURIComponent(o.id)}/files/${f.n}`;
    const ext = (f.name.split('.').pop() || 'FILE').toUpperCase();
    const kindLabel = kinds[f.kind] ?? f.kind;
    const thumb = isImg
      ? `<button type="button" class="file-thumb-wrap" data-preview-image="${url}" data-preview-name="${esc(f.name)}" data-preview-kind="${esc(kindLabel)}" title="Click to view & zoom">
           <img class="file-thumb-img" src="${url}" alt="${esc(f.name)}" loading="lazy" onerror="this.parentElement.className+=' doc-icon';this.parentElement.innerHTML='<span class=\\'doc-icon-ext\\'>IMG</span>'" />
         </button>`
      : `<a class="file-thumb-wrap doc-icon" href="${url}" target="_blank" rel="noopener" title="Open ${esc(f.name)}">
           <span class="doc-icon-ext">${esc(ext.slice(0, 4))}</span>
         </a>`;
    const nameEl = isImg
      ? `<button type="button" class="file-name-btn" data-preview-image="${url}" data-preview-name="${esc(f.name)}" data-preview-kind="${esc(kindLabel)}" title="Click to view & zoom">${esc(f.name)}</button>`
      : `<span class="file-name-text" title="${esc(f.name)}">${esc(f.name)}</span>`;
    const viewBtn = `<a class="btn quiet small file-view-btn" href="${url}" target="_blank" rel="noopener">Open</a>`;
    return `<li class="file-row">
      ${thumb}
      <div class="file-info">
        ${nameEl}
        <div class="file-meta">
          <span class="file-kind-badge">${esc(kindLabel)}</span>
          <span>·</span>
          <span>${esc(bytes(f.size))}</span>
        </div>
      </div>
      ${viewBtn}
    </li>`;
  }).join('')}</ul>`;
}

function itemsTable(o) {
  return `<div class="table-wrap"><table class="items">
    <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>${o.items.map((it) => `<tr><td>${esc(it.product)}</td><td class="num">${it.qty}</td><td class="num">${peso(it.unitPrice)}</td><td class="num">${peso(it.qty * it.unitPrice)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Total</td><td class="num">${peso(o.total)}</td></tr></tfoot>
  </table></div>`;
}

const DANGER_ACTIONS = ['cancel', 'delete_order', 'restore', 'reject', 'purge_order'];

function dangerZone(o) {
  const dangerActions = o.actions?.filter((a) => DANGER_ACTIONS.includes(a.name)) || [];
  if (!dangerActions.length) return '';
  const open = dangerActions.find((a) => a.name === S.formFor);
  if (open) {
    return `<div class="step-danger-zone">${actionForm(o, open)}</div>`;
  }
  const buttons = dangerActions.map((a) => {
    const lbl = a.name === 'reject' ? 'Reject order' : a.label;
    return `<button type="button" class="btn danger quiet small" data-action="${esc(a.name)}">${esc(lbl)}</button>`;
  }).join(' ');
  return `
    <div class="step-danger-zone">
      <h4 class="label danger-title">Danger zone</h4>
      <p class="hint">Cancelling, rejecting, or deleting this order is logged in the audit trail and notifies stakeholders.</p>
      <div class="actions">${buttons}</div>
    </div>`;
}

function stepBox(o) {
  const workflowActions = o.actions?.filter((a) => !DANGER_ACTIONS.includes(a.name) && a.name !== 'edit') || [];
  if (!workflowActions.length) {
    const text = DONE.has(o.status)
      ? `This order is ${o.statusLabel.toLowerCase()}. Nothing more to do.`
      : `Nothing for you to do on this order right now.${o.waitingOn ? ` It's with ${o.waitingOn}.` : ''}`;
    return `<p class="quiet-box">${esc(text)}</p>`;
  }

  const open = workflowActions.find((a) => a.name === S.formFor);
  if (open) {
    return `<section class="step-workflow" aria-label="Review and decision">${actionForm(o, open)}</section>`;
  }

  const buttons = workflowActions.map((a) => {
    let cls = 'btn quiet';
    let icon = '';
    if (a.name === 'approve' || a.name === 'tl_approve') {
      cls = 'btn btn-approve';
      icon = '✓ ';
    } else if (a.name === 'send_back' || a.name === 'tl_send_back') {
      cls = 'btn btn-sendback';
      icon = '↩ ';
    } else if (a.name === 'reject' || a.name === 'tl_reject') {
      cls = 'btn btn-reject';
      icon = '✕ ';
    } else if (a.name === 'resubmit') {
      cls = 'btn btn-sendback-submit';
      icon = '↺ ';
    } else if (!a.danger) {
      cls = 'btn';
    }
    return `<button type="button" class="${cls}" data-action="${esc(a.name)}">${icon}${esc(a.label)}</button>`;
  }).join(' ');

  return `
    <section class="step-workflow" aria-label="Review and decision">
      <div class="step-workflow-head">
        <h3 class="label" style="margin:0; font-size:14px; text-transform:uppercase; letter-spacing:0.04em;">Review & Decision</h3>
        ${o.waitingOn ? `<span class="sub" style="font-size:12px; color:var(--ink-2);">Awaiting: <strong>${esc(o.waitingOn)}</strong></span>` : ''}
      </div>
      <p class="hint" style="margin:4px 0 12px; font-size:13px;">Review customer details, items, attachments, and payment below before deciding.</p>
      <div class="workflow-actions">${buttons}</div>
    </section>`;
}

function fieldHtml(f, value, id, placeholder, name = f.name, ctx = null, locked = false) {
  const v = value ?? '';
  const req = f.required ? ' required' : '';
  const ph = placeholder ? ` placeholder="${esc(placeholder)}"` : '';
  const optional = f.required ? '' : ' <em>optional</em>';
  const help = locked
    ? '<small class="help" style="color:var(--navy);font-weight:600;">🔒 Locked (Admin only)</small>'
    : f.help ? `<small class="help">${esc(f.help)}</small>` : '';
  const lockAttrs = locked ? ' disabled style="background:var(--sunk);cursor:not-allowed;"' : '';
  const hiddenFallback = locked ? `<input type="hidden" name="${name}" value="${esc(v)}">` : '';

  if (f.type === 'choice') {
    const choices = f.options.map((opt) => `<label class="choice-label"><input type="radio" name="${name}" value="${esc(opt)}"${opt === v ? ' checked' : ''}${lockAttrs}> <span>${esc(opt)}</span></label>`).join('');
    const clearBtn = locked ? '' : `<button type="button" class="choice-clear-btn" data-clear-choice="${esc(name)}"${v ? '' : ' hidden'} title="Remove selection">Remove selection</button>`;
    return `<fieldset class="field choice" data-choice-field="${esc(name)}"><legend><span>${esc(f.label)}${optional}</span>${clearBtn}</legend><div class="choices">${choices}</div>${help}${hiddenFallback}</fieldset>`;
  }
  if (f.type === 'checkbox') {
    return `<div class="field wide">
      <label style="display:flex; align-items:center; gap:7px; cursor:pointer; margin:0;" for="${id}">
        <input type="checkbox" id="${id}" name="${name}" value="Yes" style="width:15px; height:15px; margin:0; accent-color:var(--navy);"${v === 'Yes' || v === true ? ' checked' : ''}${lockAttrs}>
        <span style="font-size:13px; font-weight:600; color:var(--ink);">${esc(f.label)}</span>
      </label>
      ${help}${hiddenFallback}
    </div>`;
  }
  let control;
  const suggestions = f.suggestions ?? (f.suggestionsBy && (f.suggestionsBy.lists[ctx?.[f.suggestionsBy.field]] ?? []));
  if (suggestions) {
    const by = f.suggestionsBy ? ` data-suggest-by="${esc(f.suggestionsBy.field)}"` : '';
    control = `<input id="${id}" name="${name}" type="text" list="${id}-list"${by} autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(v)}"${req}${ph}${lockAttrs}>`
      + `<datalist id="${id}-list">${suggestions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
  } else if (f.type === 'select') {
    const list = f.optionsBy ? (f.optionsBy.lists[ctx?.[f.optionsBy.field] ?? 'B2C'] ?? f.options) : f.options;
    const by = f.optionsBy ? ` data-options-by="${esc(f.optionsBy.field)}"` : '';
    const choose = list.includes(v) ? '' : '<option value="">Choose…</option>';
    control = `<select id="${id}" name="${name}"${by}${req}${lockAttrs}>${choose}${list.map((opt) => `<option${opt === v ? ' selected' : ''}>${esc(opt)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    control = `<textarea id="${id}" name="${name}" maxlength="${f.max}" rows="3"${req}${ph}${lockAttrs}>${esc(v)}</textarea>`;
  } else if (f.type === 'number') {
    control = `<input id="${id}" name="${name}" type="number" step="0.01" min="${f.min}" inputmode="decimal" value="${esc(v)}"${req}${ph}${lockAttrs}>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${f.type}"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(v)}"${req}${ph}${lockAttrs}>`;
  }
  const fieldLabel = `<label class="field${f.type === 'textarea' ? ' wide' : ''}" for="${id}"><span>${esc(f.label)}${optional}</span>${control}${help}${hiddenFallback}</label>`;
  if (name === 'papProvider' || name === 'glNumber') {
    const papOn = ctx?.isPap === 'Yes' || ctx?.isPap === true;
    return `<div data-pap-field${papOn ? '' : ' hidden'}>${fieldLabel}</div>`;
  }
  return fieldLabel;
}

function togglePapFields(form) {
  const on = Boolean(form.querySelector('[name=isPap]')?.checked);
  form.querySelectorAll('[data-pap-field]').forEach((el) => { el.hidden = !on; });
}

function actionForm(o, a) {
  const defaults = { method: o.paymentMethod, amount: o.total, paidOn: today() };
  const fields = a.fields.length ? `<div class="grid2">${a.fields.map((f) => fieldHtml(f, defaults[f.name], `act-${f.name}`)).join('')}</div>` : '';

  let contextCard = '';
  let chipPresets = '';

  const isApprove = a.name === 'approve' || a.name === 'tl_approve';
  const isSendBack = a.name === 'send_back' || a.name === 'tl_send_back';
  const isReject = a.name === 'reject' || a.name === 'tl_reject';

  if (isSendBack || isReject) {
    const rxFiles = (o.attachments || []).filter((f) => f.kind === 'prescription');
    const itemsSummary = (o.items || []).map((it) => `${it.product} (${it.qty} × ${peso(it.unitPrice)}${it.priceType ? ` · ${it.priceType}` : ''})`).join(', ');

    contextCard = `
      <div class="sendback-summary-card">
        <div class="summary-line"><span>Customer:</span> <strong>${esc(o.customerName || 'N/A')}</strong> (${esc(o.division || '')} · ${esc(o.subDivision || '')})</div>
        <div class="summary-line"><span>Items (${o.items?.length || 0}):</span> ${esc(itemsSummary || 'None')}</div>
        <div class="summary-line"><span>Total:</span> <strong>${peso(o.total || 0)}</strong> · ${esc(o.paymentMethod || '')} (${esc(o.paymentTerms || '')})</div>
        <div class="summary-line"><span>Prescription:</span> ${rxFiles.length ? `✓ Attached (${esc(rxFiles.map(f => f.name).join(', '))})` : '⚠️ None attached'}</div>
      </div>`;

    const presets = isSendBack ? [
      'Missing valid prescription (Rx) for B2C order',
      'Incorrect price tier applied for this division',
      'Missing official guarantee letter / bidding documents',
      'Incomplete delivery address or missing contact info',
      'Price discrepancy with catalog price list',
      'Please attach payment proof / deposit slip',
    ] : [
      'Customer cancelled request',
      'Duplicate order submitted',
      'Items out of stock / unavailable',
      'Unverified customer credentials',
    ];

    chipPresets = `
      <div style="margin-bottom: 8px;">
        <span class="sub" style="font-size:12px; font-weight:600; color:var(--ink-2);">Quick reasons (click to add):</span>
        <div class="preset-chips">
          ${presets.map((p) => `<button type="button" class="chip-btn" data-add-reason="${esc(p)}">+ ${esc(p)}</button>`).join('')}
        </div>
      </div>`;
  }

  let actionFilesHtml = '';
  if (['mark_packed', 'dispatch', 'deliver'].includes(a.name)) {
    const config = {
      mark_packed: {
        title: 'Attach Packing Proof',
        help: 'Upload photos of packed box, bubble wrap, item expiration labels, or parcel seal.',
        kind: 'packing_proof',
        icon: '📦',
      },
      dispatch: {
        title: 'Attach Waybill / Dispatch Proof',
        help: 'Upload photos of courier waybill, tracking slip, delivery receipt, or rider handover.',
        kind: 'dispatch_proof',
        icon: '🚚',
      },
      deliver: {
        title: 'Attach Proof of Delivery (POD) Image',
        help: 'Upload delivery photos, recipient receiving the parcel, or signed receipt for proof.',
        kind: 'delivery_proof',
        icon: '🏠',
      },
    }[a.name];

    const staged = S.actionStaged || [];
    const filesRows = staged.map((f, i) => {
      return `<li class="file-row" style="padding:6px 10px; margin-bottom:6px; background:var(--surface); border:1px solid var(--line); border-radius:6px; display:flex; align-items:center; gap:8px;">
        ${f.previewUrl ? `<img src="${f.previewUrl}" style="width:36px; height:36px; object-fit:cover; border-radius:4px;" />` : `<span style="font-size:18px;">📄</span>`}
        <div style="flex:1; min-width:0;">
          <span style="display:block; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(f.name)}</span>
          <span style="font-size:11px; color:var(--ink-2);">${esc(bytes(f.size))}</span>
        </div>
        <button type="button" class="btn quiet small" data-remove-action-file="${i}" style="padding:2px 8px; color:var(--bad);">✕</button>
      </li>`;
    }).join('');

    actionFilesHtml = `
      <fieldset class="field" style="margin:14px 0; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:var(--bg);">
        <legend style="padding:0 6px; font-size:13px; font-weight:700; color:var(--navy);">${config.icon} ${config.title}</legend>
        <p class="hint" style="margin:0 0 8px; font-size:12px;">${config.help}</p>
        ${staged.length ? `<ul style="list-style:none; padding:0; margin:0 0 10px;">${filesRows}</ul>` : ''}
        <label class="btn quiet small" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
          <span>+ Upload Image / Document</span>
          <input type="file" accept="image/*,.pdf" multiple style="display:none;" data-action-file-input data-kind="${config.kind}" />
        </label>
      </fieldset>`;
  }

  const title = isApprove ? '✓ Approve order'
    : isSendBack ? '↩ Send back for changes'
    : isReject ? '✕ Reject order'
    : a.name === 'mark_packed' ? '📦 Pack Order & Attach Proof'
    : a.name === 'dispatch' ? '🚚 Dispatch Order & Waybill'
    : a.name === 'deliver' ? '🏠 Mark Delivered & Attach Proof'
    : esc(a.label);

  const intro = isSendBack
    ? `Moves ${esc(o.id)} to <strong>Sent back</strong>. The reason will be clearly shown to the salesperson so they can correct it and resubmit.`
    : isApprove
      ? `Moves ${esc(o.id)} to <strong>${esc(a.to || 'next stage')}</strong>. You can optionally include an approval note below.`
      : a.name === 'mark_packed'
        ? `Marks ${esc(o.id)} as <strong>Packed</strong>. You can attach photos of the packed parcel/box below for auditing.`
        : a.name === 'dispatch'
          ? `Dispatches ${esc(o.id)}. Provide the courier, tracking number or URL, and upload waybill/handover images.`
          : a.name === 'deliver'
            ? `Marks ${esc(o.id)} as <strong>Delivered</strong>. Enter the recipient name and upload Proof of Delivery (POD) photos.`
            : `Moves ${esc(o.id)} to <strong>${esc(a.to || 'next stage')}</strong>. The audit trail records it as you, now.`;

  const btnCls = a.danger ? 'btn danger'
    : isApprove ? 'btn btn-approve'
    : isSendBack ? 'btn btn-sendback-submit'
    : ['mark_packed', 'dispatch', 'deliver'].includes(a.name) ? 'btn btn-approve'
    : 'btn';

  const submitLabel = isApprove ? '✓ Confirm Approval'
    : isSendBack ? '↩ Send back to Salesperson'
    : isReject ? '✕ Confirm Rejection'
    : a.name === 'mark_packed' ? '📦 Confirm Packed'
    : a.name === 'dispatch' ? '🚚 Confirm Dispatch'
    : a.name === 'deliver' ? '🏠 Confirm Delivered'
    : esc(a.label);

  return `<form id="action-form" data-action="${esc(a.name)}" novalidate>
    <div style="margin-bottom:12px;">
      <h3 style="margin:0 0 4px; font-size:16px;">${title}</h3>
      <p class="hint" style="margin:0;">${intro}</p>
    </div>
    ${contextCard}
    ${chipPresets}
    ${fields}
    ${actionFilesHtml}
    <p class="error" id="action-error" role="alert" hidden></p>
    <div class="actions">
      <button type="submit" class="${btnCls}">${submitLabel}</button>
      <button type="button" class="btn quiet" data-back>Cancel</button>
    </div>
  </form>`;
}

function detailsText(details) {
  return Object.entries(details).map(([k, v]) => {
    if (k === 'changed') return `Changed: ${v.join(', ')}`;
    if (k === 'before') return `Before: ${Object.entries(v).map(([field, old]) => `${field}: ${old}`).join(' · ')}`;
    const value = k === 'amount' || k === 'total' ? peso(v) : k === 'paidOn' ? day(v) : v;
    return `${currentMeta.fieldLabels?.[k] ?? k}: ${value}`;
  }).join(' · ');
}

function auditView(o) {
  const d = currentMeta.discord;
  const store = currentMeta.storage;
  const where = store?.kind === 'discord'
    ? "Each step is posted to this order's thread in #order-audit, followed by a reply holding the order's data as JSON. Those replies are where the order is stored: the server reads them back when it starts."
    : store?.kind === 'discord-write-only'
      ? "Each step and its data are posted in #order-audit, but without the bot's token they can't be read back, so orders are lost when the server stops."
      : d?.mode === 'mock' ? 'Mock mode: orders are kept in memory only and are lost when the server stops.'
      : 'Sending to Discord is off: orders are kept in memory only and are lost when the server stops.';
  const privacy = store?.kind === 'memory' ? ''
    : store?.encrypts ? ' Customer details, notes and reasons in the data are encrypted.'
    : ' RECORD_SECRET is not set, so customer details in the data are readable by everyone in the channel.';
  const failed = o.events.some((e) => e.discord?.state === 'failed');
  const canRetry = failed && ['management', 'admin'].includes(currentUser.role);
  const steps = o.events.map((e) => {
    const [tone, text] = (DISCORD_STATE[e.discord?.state] ?? DISCORD_STATE.off)(e.discord ?? {});
    const change = e.from && e.from !== e.to ? `${currentMeta.statuses[e.from]} → ${currentMeta.statuses[e.to]}` : currentMeta.statuses[e.to];
    return `<li>
      <span class="tick${tone === 'bad' ? ' bad' : ''}" aria-hidden="true"></span>
      <div>
        <p class="what">${esc(e.label)} <span class="change">${esc(change)}</span></p>
        <p class="by">${esc(e.actor.name)} · ${esc(currentMeta.roles[e.actor.role] ?? e.actor.role)} · <time datetime="${esc(e.at)}">${esc(stamp(e.at))}</time></p>
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
        ${e.details ? `<p class="details">${esc(detailsText(e.details))}</p>` : ''}
        <span class="dc ${tone}">${esc(text)}</span>
      </div>
    </li>`;
  }).join('');
  return `
    <div class="audit-head">
      <h3 class="label">Audit trail</h3>
      ${canRetry ? '<button type="button" class="btn quiet small" data-retry>Send again</button>' : ''}
    </div>
    <p class="hint">${esc(where + privacy)}</p>
    ${o.discord?.threadError && d.threads ? `<p class="warn">No thread yet: ${esc(o.discord.threadError)}. Steps go into the channel until it works.</p>` : ''}
    <ol class="trail">${steps}</ol>`;
}

function findCatalogProduct(query) {
  if (!query || !currentMeta?.products) return null;
  const q = String(query).trim().toLowerCase();
  return currentMeta.products.find((p) =>
    (p.id && p.id.toLowerCase() === q) ||
    (p.fullName && p.fullName.toLowerCase() === q) ||
    (p.brandName && p.brandName.toLowerCase() === q) ||
    (p.genericName && p.genericName.toLowerCase() === q)
  ) || null;
}

function getAllowedTiersForDivision(division, hasPrescription = false, hasSpecialPrice = false) {
  const rule = currentMeta?.divisionRules?.[division];
  const allTiers = currentMeta?.priceTiers || {};
  if (!rule) return [];
  let keys;
  if (division === 'B2C') {
    keys = hasPrescription ? ['doctor'] : ['patient', 'srp'];
  } else {
    keys = [...(rule.allowed || [])];
  }
  if (hasSpecialPrice && allTiers['special'] && !keys.includes('special')) {
    keys.push('special');
  }
  return keys.map((k) => allTiers[k]).filter(Boolean);
}

function itemRow(it = { product: '', qty: 1, unitPrice: '', priceType: '', unitType: 'unit' }, division = null, locked = false) {
  const div = division || document.querySelector('#order-form [name=division]')?.value || 'B2C';
  const p = findCatalogProduct(it.product);
  const hasPrescription = (S.staged || []).some((f) => f.kind === 'prescription') || S.order?.attachments?.some((f) => f.kind === 'prescription');
  const hasSpecialPrice = Boolean(S.order?.customerHasSpecialPrice || S.order?.hasSpecialPrice);
  const tiers = getAllowedTiersForDivision(div, hasPrescription, hasSpecialPrice);

  let selectedTier = it.priceType;
  if (!selectedTier || !tiers.some((t) => t.key === selectedTier)) {
    if (div === 'BID') selectedTier = 'bid';
    else if (div === 'B2B') selectedTier = 'srp';
    else if (div === 'HOS') selectedTier = 'hospital';
    else selectedTier = 'patient';
  }

  const isSalesperson = currentUser?.role === 'salesperson';
  const isBid = div === 'BID';
  const isSpecial = selectedTier === 'special';
  const lockAttrs = locked ? ' readonly style="background:var(--sunk);cursor:not-allowed;" tabindex="-1"' : '';
  const priceLock = locked || (isSalesperson && !isBid && !isSpecial) ? ' readonly style="background:var(--sunk);cursor:not-allowed;"' : '';
  const tierLock = locked ? ' disabled style="background:var(--sunk);cursor:not-allowed;"' : '';

  const tierOptions = tiers.map((t) => `<option value="${t.key}"${t.key === selectedTier ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const unitType = it.unitType || 'unit';

  let hintBadges = [];
  if (p) {
    if (p.classification) hintBadges.push(`<span class="badge info-badge">${esc(p.classification)}</span>`);
    if (p.dosageStrength) hintBadges.push(`<span class="badge">${esc(p.dosageStrength)}</span>`);
    if (p.packSize) hintBadges.push(`<span class="badge">${esc(p.packSize)}</span>`);
    if (p.tax) hintBadges.push(`<span class="badge">${esc(p.tax)}</span>`);
    const tierNote = p.prices?.[selectedTier]?.note;
    if (tierNote) hintBadges.push(`<span class="badge warn-badge">Note: ${esc(tierNote)}</span>`);
  }
  if (locked) {
    hintBadges.push(`<span class="badge">Locked in salesperson view</span>`);
  } else if (isSpecial) {
    hintBadges.push(`<span class="badge warn-badge">Special Price Request</span>`);
  } else if (isSalesperson && !isBid) {
    hintBadges.push(`<span class="badge info-badge">Fixed Catalog Price</span>`);
  }

  return `<div class="item-row" data-product-id="${p ? esc(p.id) : ''}">
    <label class="field ip"><span>Product</span><input type="text" name="product" list="products-catalog-list" maxlength="120" value="${esc(it.product)}" placeholder="Search catalog..."${lockAttrs}></label>
    <label class="field it"><span>Price tier</span><select name="priceType"${tierLock}>${tierOptions}</select></label>
    <label class="field ik"><span>Unit/Pack</span><select name="unitType"${tierLock}>
      <option value="unit"${unitType === 'unit' ? ' selected' : ''}>Unit</option>
      <option value="pack"${unitType === 'pack' ? ' selected' : ''}>Pack</option>
    </select></label>
    <label class="field iq"><span>Qty</span><input type="number" name="qty" min="1" step="1" inputmode="numeric" value="${esc(it.qty)}"${lockAttrs}></label>
    <label class="field iu"><span>Unit price</span><input type="number" name="unitPrice" min="0" step="0.01" inputmode="decimal" value="${esc(it.unitPrice)}" placeholder="0.00"${priceLock}></label>
    <div class="field ia"><span>Amount</span><output class="line-amt">${peso((Number(it.qty) || 0) * (Number(it.unitPrice) || 0))}</output></div>
    ${locked ? '' : '<button type="button" class="remove" data-remove-item aria-label="Remove this item">×</button>'}
    <div class="ih">${hintBadges.join(' ')}</div>
  </div>`;
}

function updateItemRowPrice(row) {
  const form = row.closest('form');
  const div = form?.querySelector('[name=division]')?.value || 'B2C';
  const prodInput = row.querySelector('[name=product]');
  const tierSelect = row.querySelector('[name=priceType]');
  const unitSelect = row.querySelector('[name=unitType]');
  const priceInput = row.querySelector('[name=unitPrice]');
  const hintEl = row.querySelector('.ih');

  const p = findCatalogProduct(prodInput?.value);
  const tier = tierSelect?.value;
  const unitType = unitSelect?.value || 'unit';

  const isSpecial = tier === 'special';
  const isSalesperson = currentUser?.role === 'salesperson';
  if (isSalesperson && div !== 'BID') {
    if (isSpecial) {
      priceInput.removeAttribute('readonly');
      priceInput.style.background = '';
      priceInput.style.cursor = '';
    } else {
      priceInput.setAttribute('readonly', 'readonly');
      priceInput.style.background = 'var(--sunk)';
      priceInput.style.cursor = 'not-allowed';
    }
  }

  if (p) {
    row.dataset.productId = p.id;
    if (tier !== 'special' && tier !== 'government' && tier !== 'bid') {
      const priceObj = p.prices?.[tier];
      const val = unitType === 'pack' ? priceObj?.packPrice : priceObj?.unitPrice;
      if (val != null && !Number.isNaN(Number(val))) {
        priceInput.value = val;
      }
    }
  }

  let badges = [];
  if (p) {
    if (p.classification) badges.push(`<span class="badge info-badge">${esc(p.classification)}</span>`);
    if (p.dosageStrength) badges.push(`<span class="badge">${esc(p.dosageStrength)}</span>`);
    if (p.packSize) badges.push(`<span class="badge">${esc(p.packSize)}</span>`);
    if (p.tax) badges.push(`<span class="badge">${esc(p.tax)}</span>`);
    const tierNote = p.prices?.[tier]?.note;
    if (tierNote) badges.push(`<span class="badge warn-badge">Note: ${esc(tierNote)}</span>`);
  }
  if (div === 'BID') {
    badges.push(`<span class="badge warn-badge">⚠️ Bidding notes required</span>`);
  } else if (tier === 'special') {
    badges.push(`<span class="badge warn-badge">Special Price Request</span>`);
    badges.push(`<span class="badge warn-badge">⚠️ Notes required</span>`);
  } else if (tier === 'government') {
    badges.push(`<span class="badge warn-badge">⚠️ Notes required</span>`);
  }
  if (isSalesperson && !isBid && !isSpecial) {
    badges.push(`<span class="badge info-badge">Fixed Catalog Price</span>`);
  }
  if (hintEl) hintEl.innerHTML = badges.join(' ');
}

function recalc() {
  const rows = document.querySelectorAll('#item-rows .item-row');
  let total = 0;
  for (const row of rows) {
    const amount = (Number(row.querySelector('[name=qty]').value) || 0) * (Number(row.querySelector('[name=unitPrice]').value) || 0);
    total += amount;
    row.querySelector('.line-amt').textContent = peso(amount);
    row.querySelector('[data-remove-item]').disabled = rows.length === 1;
  }
  const t = $('#form-total');
  if (t) t.textContent = peso(total);
}

function refreshFormDivision(form) {
  const div = form.querySelector('[name=division]')?.value || 'B2C';
  const hasPrescription = (S.staged || []).some((f) => f.kind === 'prescription') || S.order?.attachments?.some((f) => f.kind === 'prescription');
  const hasSpecialPrice = Boolean(S.order?.customerHasSpecialPrice || S.order?.hasSpecialPrice);
  const allowed = getAllowedTiersForDivision(div, hasPrescription, hasSpecialPrice);

  const subSelect = form.querySelector('[name=subDivision]');
  const lists = currentMeta?.fields?.subDivision?.optionsBy?.lists || {};
  const opts = lists[div] ?? [];
  if (subSelect && subSelect.tagName === 'SELECT') {
    const curVal = subSelect.value;
    subSelect.innerHTML = (opts.includes(curVal) ? '' : '<option value="">Choose…</option>') +
      opts.map((s) => `<option value="${esc(s)}"${s === curVal ? ' selected' : ''}>${esc(s)}</option>`).join('');
    if (opts.length === 1) {
      subSelect.value = opts[0];
    } else if (opts.includes(curVal)) {
      subSelect.value = curVal;
    } else {
      subSelect.value = opts[0] ?? '';
    }
  }

  for (const row of form.querySelectorAll('.item-row')) {
    const tierSelect = row.querySelector('[name=priceType]');
    if (!tierSelect) continue;
    const curTier = tierSelect.value;
    tierSelect.innerHTML = allowed.map((t) => `<option value="${t.key}"${t.key === curTier ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
    if (div === 'B2C' && hasPrescription) {
      tierSelect.value = 'doctor';
    } else if (!allowed.some((t) => t.key === curTier)) {
      if (div === 'BID') tierSelect.value = 'bid';
      else if (div === 'B2B') tierSelect.value = 'srp';
      else if (div === 'HOS') tierSelect.value = 'hospital';
      else tierSelect.value = 'patient';
    }
    updateItemRowPrice(row);
  }
  recalc();
  togglePapFields(form);
}

async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= 1_000_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

const base64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(new Error(`${file.name} couldn't be read. Attach it again.`));
  reader.readAsDataURL(file);
});

async function addFiles(fileList) {
  const { max, maxBytes } = currentMeta?.files || { max: 10, maxBytes: 3_000_000 };
  S.staged = S.staged || [];
  for (const raw of fileList) {
    if (S.staged.length >= max) {
      toast(`At most ${max} files per order.`, 'bad');
      break;
    }
    const file = await shrink(raw);
    const used = S.staged.reduce((n, f) => n + f.size, 0);
    if (used + file.size > maxBytes) {
      toast(`${file.name} is too large. All files together must be under ${maxBytes / 1e6} MB.`, 'bad');
      continue;
    }
    let kind = 'other';
    const lower = file.name.toLowerCase();
    if (lower.includes('rx') || lower.includes('prescrip')) kind = 'prescription';
    else if (lower.includes('po') || lower.includes('purchase')) kind = 'purchase_order';
    else if (lower.includes('gl') || lower.includes('guarantee') || lower.includes('pcso') || lower.includes('dswd')) kind = 'guarantee_letter';
    else if (lower.includes('receipt') || lower.includes('pay') || lower.includes('deposit')) kind = 'payment_proof';

    let previewUrl = '';
    if (file.type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(file.name)) {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {}
    }
    S.staged.push({ name: file.name, size: file.size, kind, file, previewUrl, existing: false });
  }
  refreshFiles();
  const form = $('#order-form');
  if (form) refreshFormDivision(form);
}

function filesBlock(o, mode) {
  const { max, maxBytes, kinds } = currentMeta?.files || { max: 10, maxBytes: 3_000_000, kinds: {} };
  const used = (S.staged || []).reduce((n, f) => n + f.size, 0);
  const form = document.querySelector('#order-form');
  const div = form?.querySelector('[name=division]')?.value || o?.division || 'B2C';
  const isPap = Boolean(form?.querySelector('[name=isPap]')?.checked ?? (o?.isPap === 'Yes'));
  const hasGl = (S.staged || []).some((f) => f.kind === 'guarantee_letter');
  const hasRx = (S.staged || []).some((f) => f.kind === 'prescription');

  const rows = (S.staged || []).map((f, i) => {
    const isImg = isImageFile(f.name, f.file?.type);
    if (!f.previewUrl && f.file && isImg) {
      try { f.previewUrl = URL.createObjectURL(f.file); } catch {}
    }
    const url = f.previewUrl || (f.existing && o?.id ? `/api/orders/${encodeURIComponent(o.id)}/files/${f.n}` : '');
    const ext = (f.name.split('.').pop() || 'FILE').toUpperCase();

    const thumb = isImg && url
      ? `<button type="button" class="file-thumb-wrap" data-preview-image="${url}" data-preview-name="${esc(f.name)}" data-preview-kind="${esc(kinds[f.kind] ?? f.kind)}" title="Click to view & zoom">
           <img class="file-thumb-img" src="${url}" alt="${esc(f.name)}" loading="lazy" onerror="this.parentElement.className+=' doc-icon';this.parentElement.innerHTML='<span class=\\'doc-icon-ext\\'>IMG</span>'" />
         </button>`
      : (url
          ? `<a class="file-thumb-wrap doc-icon" href="${url}" target="_blank" rel="noopener" title="Open ${esc(f.name)}"><span class="doc-icon-ext">${esc(ext.slice(0, 4))}</span></a>`
          : `<div class="file-thumb-wrap doc-icon" title="${esc(f.name)}"><span class="doc-icon-ext">${esc(ext.slice(0, 4))}</span></div>`
        );

    const nameLink = isImg && url
      ? `<button type="button" class="file-name-btn" data-preview-image="${url}" data-preview-name="${esc(f.name)}" data-preview-kind="${esc(kinds[f.kind] ?? f.kind)}" title="Click to view & zoom">${esc(f.name)}</button>`
      : (url
          ? `<a class="file-name" href="${url}" target="_blank" rel="noopener" title="${esc(f.name)}">${esc(f.name)}</a>`
          : `<span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>`
        );

    return `<li class="file-row">
      ${thumb}
      <div class="file-info">
        ${nameLink}
        <div class="file-meta">
          <span>${esc(bytes(f.size))}</span>
          ${f.existing ? '' : '<span style="color:var(--ok);font-weight:600;">(new)</span>'}
        </div>
      </div>
      <div class="file-actions">
        <select data-file-kind="${i}" aria-label="What ${esc(f.name)} is">
          ${Object.entries(kinds).map(([k, label]) => `<option value="${k}"${k === f.kind ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <button type="button" class="remove" data-remove-file="${i}" aria-label="Remove ${esc(f.name)}" title="Remove file">×</button>
      </div>
    </li>`;
  }).join('');

  return `<fieldset class="items-edit" id="files-block">
      <legend class="label">Attachments</legend>
      ${isPap && !hasGl ? `<p class="warn"><strong>Guarantee letter required:</strong> A Patient Assistance Program order must have an attached file tagged as 'Guarantee letter (DSWD/PCSO/OP)'.</p>` : ''}
      ${div === 'B2C' && hasRx ? `<p class="hint" style="color:var(--ok);font-weight:600;margin-bottom:6px;">✓ Prescription attached: Doctor's Price tier unlocked for B2C items.</p>` : ''}
      <div class="upload-dropzone" id="upload-dropzone" role="button" tabindex="0" aria-label="Drop attachments here or click to browse">
        <input type="file" id="file-input" multiple accept="${esc(currentMeta?.files?.accept || '.jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx')}" hidden>
        <div class="upload-dropzone-inner">
          <div class="upload-icon-circle" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div class="upload-text-content">
            <p class="upload-title">Drop your files here, or <span class="upload-browse-link">browse</span></p>
            <p class="upload-hint">Proof of payment, purchase order, prescription, guarantee letter: JPG, PNG, PDF, Word or Excel</p>
            <p class="upload-limits">Up to ${max} files, ${maxBytes / 1e6} MB total. Big photos are optimized automatically.</p>
          </div>
          <button type="button" class="btn quiet small upload-btn" data-pick-files>Choose files</button>
        </div>
        <div class="upload-status-bar">
          <span class="upload-limit-info">${esc(bytes(used))} of ${maxBytes / 1e6} MB used</span>
          ${(S.staged || []).length > 0 ? `<span class="upload-count-info">${(S.staged || []).length} file${(S.staged || []).length > 1 ? 's' : ''} attached</span>` : ''}
        </div>
      </div>
      ${rows ? `<ul class="file-rows">${rows}</ul>` : '<p class="empty-hint" style="color:var(--ink-2);font-size:13px;margin:8px 0;">No attachments on this order yet.</p>'}
    </fieldset>`;
}

function refreshFiles() {
  const block = $('#files-block');
  if (block) block.outerHTML = filesBlock(S.order, S.side);
}

function orderForm(o, mode) {
  const isSalesperson = currentUser?.role === 'salesperson';
  const divisionLocked = isSalesperson && mode === 'resubmit';
  const fields = currentMeta.orderFields;
  const notes = fields.find((f) => f.name === 'notes');
  const items = o?.items?.length ? o.items : [undefined];
  const sentBack = mode === 'resubmit' && o.events.findLast((e) => e.type === 'send_back' || e.type === 'tl_send_back');
  const senderRole = sentBack?.actor?.role === 'team_leader' ? 'Team Leader' : 'Management';
  const [title, intro, submit] = {
    resubmit: [`Fix and resubmit ${esc(o?.id)}`, 'Make the changes requested, attach any missing files, then resubmit for approval.', 'Resubmit for approval'],
    edit: [`Edit ${esc(o?.id)}`, "Change anything, the status and files included. What you change goes into the order's thread in #order-audit as Edited by Admin, with a line in the Admin log.", 'Save changes'],
  }[mode] || ['Edit order', '', 'Save'];

  const catalogDatalist = `<datalist id="products-catalog-list">${(currentMeta?.products ?? []).map((p) => `<option value="${esc(p.fullName)}" label="${esc(p.brandName || p.genericName)} · ${esc(p.classification)}">`).join('')}</datalist>`;
  const ownerName = o.owner?.name || o.createdBy?.name || 'You';

  return `
    <div class="side-head">
      <button type="button" class="link" data-reopen>Back to ${esc(o.id)}</button>
      <h2 class="title">${title}</h2>
      <p class="sub">${esc(intro)}</p>
    </div>
    ${sentBack?.note ? `<div class="warn" style="margin-bottom:14px;padding:10px 14px;border-radius:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);">
      <strong>↩ ${esc(sentBack.actor.name)} (${esc(senderRole)}) sent it back:</strong>
      <p style="margin:4px 0 0;">${esc(sentBack.note)}</p>
    </div>` : ''}
    ${catalogDatalist}
    <form id="order-form" class="block" data-mode="${mode}" novalidate>
      <div class="for-line-box" style="margin-bottom:12px; padding:10px 14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; font-size:13.5px; display:flex; justify-content:space-between; align-items:center;">
        <span>Order identity: <strong>${esc(o.id)}</strong> · Salesperson: <strong>${esc(ownerName)}</strong></span>
        <span class="badge ${mode === 'resubmit' ? 'warn-badge' : 'info-badge'}">${mode === 'resubmit' ? 'Salesperson Fix & Resubmit' : 'Admin Edit'}</span>
      </div>
      <div class="grid2">${fields.filter((f) => f !== notes).map((f) => {
        const isDivLock = divisionLocked && ['division', 'subDivision', 'headQuarter'].includes(f.name);
        return fieldHtml(f, o?.[f.name], `o-${f.name}`, PLACEHOLDERS[f.name], f.name, o, isDivLock);
      }).join('')}</div>
      <fieldset class="items-edit">
        <legend class="label">Items</legend>
        <div class="item-rows" id="item-rows">${items.map((it) => itemRow(it, o?.division, false)).join('')}</div>
        <div class="items-foot">
          <button type="button" class="btn quiet small" data-add-item>Add item</button>
          <p>Total <strong id="form-total">${peso(o?.total || 0)}</strong></p>
        </div>
      </fieldset>
      ${filesBlock(o, mode)}
      ${notes ? `<div class="grid2">${fieldHtml(notes, o?.notes, 'o-notes', PLACEHOLDERS.notes)}</div>` : ''}
      ${mode === 'edit' ? `<div class="grid2">${fieldHtml(currentMeta.fields.reason, '', 'e-reason', 'Why this change is needed. It goes in the audit trail.')}</div>` : ''}
      <p class="error" id="order-error" role="alert" hidden></p>
      <div class="actions">
        <button type="submit" class="btn">${submit}</button>
        <button type="button" class="btn quiet" data-reopen>Back</button>
      </div>
    </form>`;
}

async function loadOrders() {
  const main = $('#main');
  if (!S.orders && main && currentTab().key !== 'dashboard') {
    main.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading orders…</p></div>';
  }
  try {
    const { orders } = await api('GET', '/api/orders');
    S.orders = orders;
    renderTabs();
    renderMain();
  } catch (err) {
    if (err instanceof SignedOut) return;
  }
}

async function askWhoFor() {
  let salespeople;
  try {
    ({ salespeople } = await api('GET', '/api/orders/owners'));
  } catch (err) {
    if (!(err instanceof SignedOut)) toast(err.message, 'bad');
    return;
  }
  const d = $('#for-dialog');
  if (!d || d.open) return;
  const picked = S.orderFor?.id;
  const options = salespeople.map((u) => `<option value="${u.id}"${u.id === picked ? ' selected' : ''}>${esc(u.name)}</option>`).join('');
  d.innerHTML = `<form id="for-form" novalidate>
      <h2 class="title" id="for-title">Who is this order for?</h2>
      <label class="for-choice"><input type="radio" name="for" value="me"${picked ? '' : ' checked'}>
        <span><b>For me</b><small>The order is yours.</small></span></label>
      <label class="for-choice"><input type="radio" name="for" value="other"${picked ? ' checked' : ''}${salespeople.length ? '' : ' disabled'}>
        <span><b>For a salesperson</b><small>${salespeople.length ? "It's theirs. You still see it, and either of you can fix it if Management sends it back." : 'There are no other active salespeople to pick.'}</small></span></label>
      <label class="field" for="for-person" id="for-person-field"${picked ? '' : ' hidden'}><span>Salesperson</span>
        <select id="for-person" name="person"><option value="">Choose…</option>${options}</select></label>
      <p class="error" id="for-error" role="alert" hidden></p>
      <div class="actions">
        <button type="submit" class="btn">Continue</button>
        <button type="button" class="btn quiet" data-cancel>Cancel</button>
      </div>
    </form>`;
  initCustomSelects(d);
  d.showModal();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  renderTopNav('orders');
  $('#role-line').textContent = INTRO[user.role] || '';

  const forDialog = $('#for-dialog');
  if (forDialog) {
    forDialog.addEventListener('change', (e) => {
      if (e.target.name === 'for') $('#for-person-field').hidden = e.target.value !== 'other';
    });

    forDialog.addEventListener('click', (e) => {
      if (e.target === forDialog || e.target.closest('[data-cancel]')) forDialog.close();
    });

    forDialog.addEventListener('submit', (e) => {
      e.preventDefault();
      const { elements } = e.target;
      let query = '';
      if (elements.for.value === 'other') {
        const select = elements.person;
        if (!select.value) {
          $('#for-error').textContent = 'Pick the salesperson this order is for.';
          $('#for-error').hidden = false;
          return select.focus();
        }
        query = `?ownerId=${encodeURIComponent(select.value)}&ownerName=${encodeURIComponent(select.selectedOptions[0].textContent)}`;
      }
      forDialog.close();
      window.location.href = `/new-order${query}`;
    });
  }

  const newOrderBtn = $('#new-order');
  if (newOrderBtn) {
    const canRaise = user?.canRaiseOrders !== undefined ? Boolean(user.canRaiseOrders) : CREATORS.includes(user.role);
    newOrderBtn.hidden = !canRaise;
    newOrderBtn.addEventListener('click', askWhoFor);
  }

  const params = new URLSearchParams(window.location.search);
  const requestedTab = params.get('tab');
  const requestedOpen = params.get('open') || (location.hash.startsWith('#') ? location.hash.slice(1) : null);

  const roleTabs = TABS[user.role] || [];
  if (requestedTab && roleTabs.some((t) => t.key === requestedTab)) {
    S.tab = requestedTab;
  } else {
    S.tab = roleTabs[0]?.key || null;
  }

  if (requestedOpen) {
    window.location.href = `/order?id=${encodeURIComponent(requestedOpen)}${requestedTab ? `&tab=${encodeURIComponent(requestedTab)}` : ''}`;
    return;
  }

  await loadOrders();
  layout();

  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    if (t.dataset.tab === 'people') {
      window.location.href = '/people';
      return;
    }
    S.tab = t.dataset.tab;
    updateUrlParams();
    renderTabs();
    renderMain();
  });

  $('#main').addEventListener('click', (e) => {
    const periodBtn = e.target.closest('[data-period]');
    if (periodBtn) {
      S.dash.period = periodBtn.dataset.period;
      loadDashboard();
      return;
    }
    const goTabBtn = e.target.closest('[data-go-tab]');
    if (goTabBtn) {
      const tab = goTabBtn.dataset.goTab;
      if (tab === 'people') {
        window.location.href = '/people';
      } else {
        S.tab = tab;
        updateUrlParams();
        renderTabs();
        renderMain();
      }
      return;
    }
    const btn = e.target.closest('[data-open]');
    if (btn) {
      window.location.href = `/order?id=${encodeURIComponent(btn.dataset.open)}${S.tab ? `&tab=${encodeURIComponent(S.tab)}` : ''}`;
    }
  });

  $('#main').addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip-value]');
    if (el) showTip(el);
  });
  $('#main').addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-tip-value]')) hideTip();
  });
  $('#main').addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip-value]');
    if (el) showTip(el);
  });
  $('#main').addEventListener('focusout', (e) => {
    if (e.target.closest('[data-tip-value]')) hideTip();
  });

  const side = $('#side');
  let radioWasChecked = false;
  side.addEventListener('pointerdown', (e) => {
    const radio = e.target.closest('input[type="radio"]') || e.target.closest('label')?.querySelector('input[type="radio"]');
    if (radio && !radio.disabled) {
      radioWasChecked = radio.checked;
    }
  });

  side.addEventListener('click', async (e) => {
    const clearChoiceBtn = e.target.closest('[data-clear-choice]');
    if (clearChoiceBtn) {
      const fieldName = clearChoiceBtn.dataset.clearChoice;
      const fs = clearChoiceBtn.closest('fieldset.field.choice') || $(`[data-choice-field="${fieldName}"]`);
      if (fs) {
        fs.querySelectorAll(`input[name="${fieldName}"]`).forEach((r) => { r.checked = false; });
      }
      clearChoiceBtn.hidden = true;
      return;
    }

    const clickedRadio = e.target.closest('input[type="radio"]');
    if (clickedRadio && !clickedRadio.disabled) {
      const fs = clickedRadio.closest('fieldset.field.choice');
      if (radioWasChecked) {
        clickedRadio.checked = false;
        radioWasChecked = false;
        if (fs) {
          const clearBtn = fs.querySelector('.choice-clear-btn');
          if (clearBtn) clearBtn.hidden = true;
        }
        clickedRadio.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (fs) {
        const clearBtn = fs.querySelector('.choice-clear-btn');
        if (clearBtn) clearBtn.hidden = false;
      }
    }

    if (e.target.closest('[data-close]')) {
      closeSide();
      return;
    }

    if (e.target.closest('[data-toggle-expand]')) {
      S.expanded = !S.expanded;
      layout();
      renderSide();
      return;
    }

    if (e.target.closest('[data-reopen]')) {
      S.side = 'order';
      S.staged = [];
      renderSide();
      return;
    }

    const chip = e.target.closest('[data-add-reason]');
    if (chip) {
      const text = chip.dataset.addReason;
      const form = chip.closest('form');
      const reasonInput = form?.querySelector('[name=reason]');
      if (reasonInput) {
        const cur = reasonInput.value.trim();
        if (!cur) {
          reasonInput.value = text;
        } else if (!cur.includes(text)) {
          reasonInput.value = `${cur}\n- ${text}`;
        }
        reasonInput.focus();
      }
      chip.classList.toggle('chip-active');
      return;
    }

    const emptyBtn = e.target.closest('#empty-recycle-bin-btn');
    if (emptyBtn) {
      const ok = await confirmModal({
        title: 'Empty Recycle Bin',
        message: 'Are you sure you want to empty the Recycle Bin?\n\nAll deleted orders and items will immediately vanish from the Discord database and storage. This action CANNOT be undone.',
        confirmText: 'Empty Recycle Bin',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      try {
        setButtonLoading(emptyBtn, true, 'Emptying…');
        const res = await api('POST', '/api/orders/recycle-bin/empty');
        toast(res.message || 'Recycle Bin emptied.');
        S.openId = null;
        S.order = null;
        renderSide();
        await loadOrders();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        setButtonLoading(emptyBtn, false);
      }
      return;
    }

    const actionBtn = e.target.closest('button[data-action]');
    if (actionBtn) {
      const name = actionBtn.dataset.action;
      if (name === 'edit' || name === 'resubmit') {
        S.side = name;
        S.staged = (S.order?.attachments || []).map((f) => ({
          existing: true,
          n: f.n,
          name: f.name,
          size: f.size,
          kind: f.kind,
          previewUrl: `/api/orders/${encodeURIComponent(S.order.id)}/files/${f.n}`,
        }));
        renderSide();
        return;
      }
      const act = S.order?.actions?.find((a) => a.name === name);
      if (act && (act.form || (act.fields && act.fields.length > 0) || ['mark_packed', 'dispatch', 'deliver'].includes(name))) {
        S.formFor = name;
        S.actionStaged = [];
        renderSide();
        return;
      }
      if (DANGER_ACTIONS.includes(name)) {
        const isPurge = name === 'purge_order';
        const label = isPurge ? 'Permanently delete' : (act?.label || (name === 'reject' ? 'Reject' : name));
        const ok = await confirmModal({
          title: isPurge ? 'Delete permanently from Discord' : `${label} order`,
          message: isPurge
            ? `Are you sure you want to permanently delete order ${S.order.id}? This will immediately delete its thread and records from the Discord database and cannot be recovered.`
            : `Are you sure you want to ${label.toLowerCase()} order ${S.order.id}? This will be recorded in the audit trail.`,
          confirmText: label,
          cancelText: 'Cancel',
          danger: true,
        });
        if (!ok) return;
      }
      setButtonLoading(actionBtn, true, 'Updating…');
      try {
        const res = await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/actions/${name}`, {});
        if (name === 'purge_order') {
          toast(`Order ${S.order.id} permanently deleted and vanished from Discord database.`);
          S.openId = null;
          S.order = null;
          renderSide();
          await loadOrders();
          return;
        }
        const { order } = res;
        S.order = order;
        toast(`${order.id}: ${order.events.at(-1)?.label || 'Updated'}.`);
        renderSide();
        await loadOrders();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        setButtonLoading(actionBtn, false);
      }
      return;
    }

    const removeActFile = e.target.closest('[data-remove-action-file]');
    if (removeActFile) {
      const idx = Number(removeActFile.dataset.removeActionFile);
      if (!Number.isNaN(idx) && S.actionStaged?.[idx]) {
        S.actionStaged.splice(idx, 1);
        renderSide();
      }
      return;
    }

    if (e.target.closest('[data-back]')) {
      S.formFor = null;
      S.actionStaged = [];
      renderSide();
      return;
    }

    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) {
      setButtonLoading(retryBtn, true, 'Retrying…');
      try {
        const { order } = await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/audit/retry`, {});
        S.order = order;
        toast('Audit trail sent to Discord again.');
        renderSide();
        await loadOrders();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        setButtonLoading(retryBtn, false);
      }
      return;
    }

    if (e.target.closest('[data-pick-files]')) {
      $('#file-input')?.click();
      return;
    }

    const dropzone = e.target.closest('#upload-dropzone');
    if (dropzone && !e.target.closest('button, select, a, input, .file-row')) {
      $('#file-input')?.click();
      return;
    }

    const removeFileBtn = e.target.closest('[data-remove-file]');
    if (removeFileBtn) {
      const idx = Number(removeFileBtn.dataset.removeFile);
      if (!Number.isNaN(idx) && S.staged?.[idx]) {
        S.staged.splice(idx, 1);
        refreshFiles();
        const form = $('#order-form');
        if (form) refreshFormDivision(form);
      }
      return;
    }

    if (e.target.closest('[data-add-item]')) {
      const div = S.order?.division || 'B2C';
      const rows = $('#item-rows');
      const temp = document.createElement('div');
      temp.innerHTML = itemRow(undefined, div);
      const newRow = temp.firstElementChild;
      rows.appendChild(newRow);
      updateItemRowPrice(newRow);
      recalc();
      return;
    }

    const removeBtn = e.target.closest('[data-remove-item]');
    if (removeBtn) {
      removeBtn.closest('.item-row').remove();
      recalc();
      return;
    }
  });

  side.addEventListener('input', (e) => {
    const row = e.target.closest('.item-row');
    if (row) {
      if (e.target.name === 'product') {
        updateItemRowPrice(row);
      }
      recalc();
    }
  });

  side.addEventListener('change', (e) => {
    if (e.target.id === 'file-input') {
      if (e.target.files?.length) {
        addFiles(e.target.files);
        e.target.value = '';
      }
      return;
    }
    if (e.target.type === 'radio') {
      const fs = e.target.closest('fieldset.field.choice');
      if (fs) {
        const anyChecked = fs.querySelector('input[type="radio"]:checked');
        const clearBtn = fs.querySelector('.choice-clear-btn');
        if (clearBtn) clearBtn.hidden = !anyChecked;
      }
    }
  });

  side.addEventListener('dragover', (e) => {
    const dz = e.target.closest('#upload-dropzone');
    if (dz) {
      e.preventDefault();
      dz.classList.add('is-dragover');
    }
  });

  side.addEventListener('dragleave', (e) => {
    const dz = e.target.closest('#upload-dropzone');
    if (dz && !dz.contains(e.relatedTarget)) {
      dz.classList.remove('is-dragover');
    }
  });

  side.addEventListener('drop', async (e) => {
    const dz = e.target.closest('#upload-dropzone');
    if (dz) {
      e.preventDefault();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) {
        addFiles(e.dataTransfer.files);
      }
    }
  });

  side.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'upload-dropzone') {
      e.preventDefault();
      $('#file-input')?.click();
    }
  });

  side.addEventListener('change', (e) => {
    if (e.target.dataset.fileKind != null) {
      const idx = Number(e.target.dataset.fileKind);
      if (!Number.isNaN(idx) && S.staged?.[idx]) {
        S.staged[idx].kind = e.target.value;
        refreshFiles();
        const form = $('#order-form');
        if (form) refreshFormDivision(form);
      }
      return;
    }
    if (e.target.matches('[data-action-file-input]')) {
      const input = e.target;
      const kind = input.dataset.kind || 'other';
      if (input.files?.length) {
        S.actionStaged = S.actionStaged || [];
        for (const file of input.files) {
          let previewUrl = '';
          if (file.type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(file.name)) {
            try { previewUrl = URL.createObjectURL(file); } catch {}
          }
          S.actionStaged.push({ name: file.name, size: file.size, kind, file, previewUrl });
        }
        renderSide();
      }
      return;
    }
    if (e.target.name === 'division') {
      const form = $('#order-form');
      if (form) refreshFormDivision(form);
      return;
    }
    if (e.target.name === 'paymentTerms') {
      refreshFiles();
      return;
    }
    if (e.target.name === 'isPap') {
      const form = $('#order-form');
      if (form) togglePapFields(form);
      refreshFiles();
      return;
    }
    const row = e.target.closest('.item-row');
    if (row) {
      if (e.target.name === 'priceType' || e.target.name === 'unitType') {
        updateItemRowPrice(row);
      }
      recalc();
    }
  });

  side.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === 'action-form') {
      const name = form.dataset.action;
      const submitBtn = form.querySelector('button[type=submit]');
      if (DANGER_ACTIONS.includes(name)) {
        const isPurge = name === 'purge_order';
        const act = S.order?.actions?.find((a) => a.name === name);
        const label = isPurge ? 'Permanently delete' : (act?.label || (name === 'reject' ? 'Reject' : name));
        const ok = await confirmModal({
          title: isPurge ? 'Delete permanently from Discord' : `${label} order`,
          message: isPurge
            ? `Are you sure you want to permanently delete order ${S.order.id}?\n\nThis will immediately delete its thread and records from the Discord database and cannot be recovered.`
            : `Are you sure you want to ${label.toLowerCase()} order ${S.order.id}? This will update the order status and notify stakeholders.`,
          confirmText: `Yes, ${label.toLowerCase()}`,
          cancelText: 'Cancel',
          danger: true,
        });
        if (!ok) return;
      }
      const body = Object.fromEntries(new FormData(form));
      if (S.actionStaged && S.actionStaged.length > 0) {
        body.attachments = await Promise.all(
          S.actionStaged.map(async (f) => ({
            name: f.name,
            kind: f.kind,
            data: await base64(f.file),
          }))
        );
      }
      const errorEl = $('#action-error');
      if (errorEl) errorEl.hidden = true;
      setButtonLoading(submitBtn, true, 'Submitting…');
      try {
        const res = await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/actions/${name}`, body);
        if (name === 'purge_order') {
          toast(`Order ${S.order.id} permanently deleted and vanished from Discord database.`);
          S.openId = null;
          S.order = null;
          S.formFor = null;
          S.actionStaged = [];
          renderSide();
          await loadOrders();
          return;
        }
        const { order } = res;
        S.order = order;
        S.formFor = null;
        S.actionStaged = [];
        toast(`${order.id}: ${order.events.at(-1)?.label || 'Updated'}.`);
        renderSide();
        await loadOrders();
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        } else {
          toast(err.message, 'bad');
        }
      } finally {
        setButtonLoading(submitBtn, false);
      }
    } else if (form.id === 'order-form') {
      const mode = form.dataset.mode;
      const submitBtn = form.querySelector('button[type=submit]');
      const data = new FormData(form);
      const body = Object.fromEntries(currentMeta.orderFields.map((f) => [f.name, data.get(f.name) ?? '']));
      body.items = [...form.querySelectorAll('.item-row')]
        .map((row) => ({
          product: row.querySelector('[name=product]').value,
          qty: row.querySelector('[name=qty]').value,
          unitPrice: row.querySelector('[name=unitPrice]').value,
          priceType: row.querySelector('[name=priceType]')?.value || undefined,
          unitType: row.querySelector('[name=unitType]')?.value || undefined,
        }))
        .filter((it) => it.product.trim() || it.unitPrice !== '');
      if (mode === 'edit') {
        body.reason = data.get('reason');
      }
      if (S.staged && S.staged.length > 0) {
        const newStaged = S.staged.filter((f) => !f.existing);
        if (newStaged.length > 0) {
          body.attachments = await Promise.all(
            newStaged.map(async (f) => ({
              name: f.name,
              kind: f.kind,
              data: await base64(f.file),
            }))
          );
        }
        body.keepExistingAttachmentIndices = S.staged
          .filter((f) => f.existing)
          .map((f) => f.n);
      }
      const errorEl = $('#order-error');
      if (errorEl) errorEl.hidden = true;
      setButtonLoading(submitBtn, true, mode === 'edit' ? 'Saving…' : 'Submitting…');
      try {
        const { order } = mode === 'edit'
          ? await api('PATCH', `/api/orders/${encodeURIComponent(S.order.id)}`, body)
          : await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/actions/resubmit`, body);
        S.order = order;
        S.side = 'order';
        toast(`${order.id} ${mode === 'edit' ? 'saved' : 'resubmitted'}.`);
        renderSide();
        await loadOrders();
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        } else {
          toast(err.message, 'bad');
        }
      } finally {
        setButtonLoading(submitBtn, false);
      }
    }
  });

  // Background polling every 12 seconds
  setInterval(async () => {
    if (document.visibilityState === 'visible' && S.side !== 'edit' && S.side !== 'resubmit') {
      if (currentTab().key === 'dashboard') {
        await loadDashboard();
      } else {
        await loadOrders();
      }
    }
  }, 12000);
});
