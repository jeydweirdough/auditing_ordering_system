'use strict';

let dashState = {
  period: 'month',
  data: null,
};

function delta(now, prev, fmt, goodUp = true) {
  const compare = dashState.data?.period?.compare;
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
        foot: d.sentBack ? '<a href="/orders?tab=returned" class="link">Fix them</a>' : '',
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
        foot: w.count ? '<a href="/orders?tab=approval" class="link">Review them</a>' : '',
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
        foot: h.count ? '<a href="/orders?tab=hold" class="link">Open them</a>' : '',
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
      ${dashCard({ label: 'People', tag: 'Now', value: whole(active), sub: `<ul class="people-mini">${people}</ul>`, foot: '<a href="/people" class="link">Manage people</a>' })}
      ${dashCard({ label: 'Discord storage', tag: 'Now', value: dcValue, sub: `<p class="hint">${esc(dcHint)}</p>`, foot: dc.failed ? '<a href="/orders?tab=discord" class="link">See which</a>' : '' })}
    </div>`;
}

function dispatchDash(d) {
  const { pipeline, fulfillment: f, couriers, urgent } = d;
  const ready = pipeline.ready;
  const picking = pipeline.picking;
  const packed = pipeline.packed;
  const dispatched = pipeline.dispatched;

  const urgentList = urgent.length
    ? `<ul class="mini">${urgent.map((o) => `<li><button type="button" class="mini-row" data-open="${esc(o.id)}">
        <span class="id">${esc(o.id)}</span><span class="mini-name">${esc(o.customer ?? o.owner)}</span>
        <span class="pill ${o.status === 'ready_for_dispatch' ? 'wait' : 'ok'}">${esc(o.status === 'ready_for_dispatch' ? 'Ready to Pick' : 'Picking')}</span>
        <span class="num">${esc(php(o.total))}</span>
      </button></li>`).join('')}</ul>`
    : '<p class="quiet-box">No urgent orders awaiting dispatch action.</p>';

  const courierRows = couriers.length
    ? `<div class="table-wrap"><table class="dash-table">
        <thead><tr><th>Courier / Method</th><th class="num">Shipments</th></tr></thead>
        <tbody>${couriers.map((c) => `<tr><td><strong>${esc(c.courier)}</strong></td><td class="num">${c.count}</td></tr>`).join('')}</tbody>
      </table></div>`
    : '<p class="quiet-box">No deliveries in this period.</p>';

  return `
    ${dashHero({
      label: `Fulfillment & Deliveries · ${d.period.label}`,
      value: php(f.deliveredValue),
      sub: `${delta(f.deliveredValue, f.prevDeliveredValue, php)}<p class="hint">${plural(f.deliveredCount, 'order')} delivered${f.turnaroundHours != null ? ` · Median turnaround: ${esc(howLong(f.turnaroundHours))}` : ''}</p>`,
      body: `<div class="hero-list"><h3 class="label">Priority orders for dispatch</h3>${urgentList}</div>`,
    })}
    <div class="dash-cards">
      ${dashCard({
        label: 'Ready for dispatch',
        tag: 'Awaiting picking',
        value: whole(ready.count),
        sub: `<p class="hint">${esc(php(ready.value))} total</p>`,
        foot: '<a href="/orders?tab=board" class="link">Go to Dispatch Board</a>',
      })}
      ${dashCard({
        label: 'Picking in progress',
        tag: 'Warehouse',
        value: whole(picking.count),
        sub: `<p class="hint">${esc(php(picking.value))} total</p>`,
      })}
      ${dashCard({
        label: 'Packed & ready',
        tag: 'Handover',
        value: whole(packed.count),
        sub: `<p class="hint">${esc(php(packed.value))} total</p>`,
      })}
      ${dashCard({
        label: 'In transit',
        tag: 'With courier',
        value: whole(dispatched.count),
        sub: `<p class="hint">${esc(php(dispatched.value))} total</p>`,
      })}
    </div>
    <div class="hero-list" style="margin-top: var(--gap, 1.5rem);">
      <h3 class="label">Courier Breakdown (${d.period.label})</h3>
      ${courierRows}
    </div>`;
}

function teamLeaderDash(d) {
  const { now: n, prev: p, pendingReview, inProgress, team } = d;
  const maxSales = Math.max(0, ...team.map((s) => s.sales));
  const teamRows = team.length
    ? `<div class="table-wrap"><table class="dash-table">
        <thead><tr><th>Salesperson</th><th class="num">Pending review</th><th class="num">Raised</th><th>Sales</th><th class="num">Delivered</th></tr></thead>
        <tbody>${team.map((s) => `<tr>
          <td>${esc(s.name)}${s.active ? '' : ' <span class="tag">Inactive</span>'}</td>
          <td class="num">${s.pending ? `<span class="pill wait">${s.pending}</span>` : '0'}</td>
          <td class="num">${s.raised}</td>
          ${barCell(s.sales, maxSales)}
          <td class="num">${esc(php(s.deliveredValue))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<p class="quiet-box">No salespeople assigned to your team yet.</p>';

  const pendingList = pendingReview.items.length
    ? `<ul class="mini">${pendingReview.items.map((o) => `<li><button type="button" class="mini-row" data-open="${esc(o.id)}">
        <span class="id">${esc(o.id)}</span><span class="mini-name">${esc(o.customer ?? o.owner)}</span>
        <span class="pill wait">Needs Review</span>
        <span class="num">${esc(php(o.total))}</span>
      </button></li>`).join('')}</ul>`
    : '<p class="quiet-box">No orders currently waiting for your review.</p>';

  return `
    ${dashHero({
      label: `Team performance · ${d.period.label}`,
      value: php(n.sales),
      sub: `${delta(n.sales, p?.sales, php)}<p class="hint">Sales from your supervised salespeople in this period.</p>`,
      body: `<div class="hero-list"><h3 class="label">Supervised Salespeople</h3>${teamRows}</div>`,
    })}
    <div class="dash-cards">
      ${dashCard({
        label: 'Waiting for your review',
        tag: 'Needs action',
        value: whole(pendingReview.count),
        sub: `<p class="hint">${esc(php(pendingReview.value))} total</p>`,
        foot: '<a href="/orders?tab=tl_approval" class="link">Review orders</a>',
      })}
      ${dashCard({
        label: 'Orders raised',
        value: whole(n.raised),
        sub: `${delta(n.raised, p?.raised, whole)}${spark(running(d.trend.map((b) => b.count)))}`,
      })}
      ${dashCard({
        label: 'Team in progress',
        value: whole(inProgress.count),
        sub: `<p class="hint">${esc(php(inProgress.value))} active pipeline</p>`,
      })}
      ${dashCard({
        label: 'Delivered',
        value: php(n.deliveredValue),
        sub: `<p class="hint">${plural(n.delivered, 'order')} delivered</p>${delta(n.deliveredValue, p?.deliveredValue, php)}`,
      })}
    </div>
    <div class="hero-list" style="margin-top: var(--gap, 1.5rem);">
      <h3 class="label">Orders Awaiting Your Review</h3>
      ${pendingList}
    </div>`;
}

function dashboardHtml(d) {
  const periods = Object.entries(d.periods).map(([key, label]) => `<button type="button" class="seg-btn" data-period="${esc(key)}" aria-pressed="${key === d.period.key}">${esc(label)}</button>`).join('');
  const bodyFn = {
    salesperson: salespersonDash,
    team_leader: teamLeaderDash,
    management: managementDash,
    finance: financeDash,
    dispatch: dispatchDash,
    admin: adminDash,
  }[d.role];
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

async function loadDashboard() {
  const root = $('#dashboard-content');
  if (!root) return;
  const period = dashState.period;
  root.querySelector('.dash')?.classList.add('loading');
  try {
    const data = await api('GET', `/api/orders/dashboard?period=${encodeURIComponent(period)}`);
    dashState.data = data;
    hideTip();
    root.innerHTML = dashboardHtml(data);
  } catch (err) {
    if (err instanceof SignedOut) return;
    root.querySelector('.dash')?.classList.remove('loading');
    toast(err.message, 'bad');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;
  renderTopNav('dashboard');

  const root = $('#dashboard-content');
  root.innerHTML = '<div class="dash"><div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading dashboard figures…</p></div></div>';

  root.addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]');
    if (p) {
      dashState.period = p.dataset.period;
      loadDashboard();
      return;
    }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) {
      window.location.href = `/orders?open=${encodeURIComponent(openBtn.dataset.open)}`;
      return;
    }
  });

  root.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip-value]');
    if (el) showTip(el);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-tip-value]')) hideTip();
  });
  root.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip-value]');
    if (el) showTip(el);
  });
  root.addEventListener('focusout', (e) => {
    if (e.target.closest('[data-tip-value]')) hideTip();
  });

  loadDashboard();
});
