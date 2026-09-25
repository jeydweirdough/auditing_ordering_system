'use strict';

// The pharmacist's queue: orders with a prescription, from "waiting on Finance" until packed.
// An order can't be picked or dispatched while its prescription is pending or rejected.
// Dispatch (the pharmacy) and Admin decide; Management can look.

const P = { state: 'pending', data: null };
const STATE_LABEL = { pending: 'Waiting for review', rejected: 'Rejected', verified: 'Verified', all: 'All' };

async function load() {
  const main = $('#main');
  try {
    const { data } = await api('GET', `/api/dispatch/pharmacy/queue?state=${encodeURIComponent(P.state)}`);
    P.data = data;
    render();
  } catch (err) {
    if (!(err instanceof SignedOut)) main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function render() {
  const { orders, counts, can_decide: canDecide } = P.data;
  const tabs = ['pending', 'rejected', 'verified', 'all'].map((s) => `<button type="button" class="tab" role="tab" data-state="${s}" aria-selected="${s === P.state}">${esc(STATE_LABEL[s])}${counts[s] ? `<span class="count${s === 'pending' ? ' hot' : ''}">${counts[s]}</span>` : ''}</button>`).join('');
  const rows = orders.map((o) => {
    const files = o.prescriptions.filter((p) => !p.superseded);
    return `<tr>
      <td><a class="link" href="/order?id=${encodeURIComponent(o.getmeds_order_id)}"><b>${esc(o.getmeds_order_id)}</b></a><br><small>${esc(o.customer_name || '')} · ${esc(o.medrep_name || '')}</small></td>
      <td>${esc(o.division || '—')}<br><small>${o.finance_cleared ? '<span class="tag ok">Finance cleared</span>' : '<span class="tag">Awaiting Finance</span>'}</small></td>
      <td>${files.map((p) => `<div><span class="tag ${p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}">${esc(p.status)}</span> ${esc(p.file_name || 'prescription')}${p.rejection_reason ? `<br><small>${esc(p.rejection_reason)}</small>` : ''}</div>`).join('')}
        <button type="button" class="link" data-files="${esc(o.getmeds_order_id)}">Open the files</button></td>
      <td>${canDecide && o.rx_state === 'pending' ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn small" data-verify="${o.id}">Verify</button>
          <button type="button" class="btn danger quiet small" data-reject="${o.id}">Reject</button>
        </div>` : `<small class="hint">${o.rx_state === 'pending' ? 'Dispatch decides' : ''}</small>`}</td>
    </tr>`;
  }).join('');
  $('#main').innerHTML = `
    <nav class="tabs" role="tablist" aria-label="Prescriptions">${tabs}</nav>
    <div class="table-wrap" style="margin-top:12px;">
      <table class="simple-table">
        <thead><tr><th>Order</th><th>Division</th><th>Prescription</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="hint">No prescriptions ${P.state === 'all' ? '' : esc(STATE_LABEL[P.state].toLowerCase())} right now.</td></tr>`}</tbody>
      </table>
    </div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;
  renderTopNav('pharmacy');
  $('#role-line').textContent = 'Check each prescription against its order. Until it is verified, the order can’t be picked or dispatched.';
  await load();

  $('#main').addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-state]');
    if (tab) {
      P.state = tab.dataset.state;
      return load();
    }
    const files = e.target.closest('[data-files]');
    if (files) {
      const links = await orderFileLinks(files.dataset.files);
      const rx = [...links.values()].filter((f) => f.kind === 'prescription');
      if (!rx.length) return toast('No prescription file found on this order.', 'bad');
      for (const f of rx) window.open(f.viewUrl, '_blank', 'noopener');
      return;
    }
    const verify = e.target.closest('[data-verify]');
    const reject = e.target.closest('[data-reject]');
    if (!verify && !reject) return;
    const id = (verify || reject).dataset.verify || (verify || reject).dataset.reject;
    try {
      if (verify) {
        setButtonLoading(verify, true);
        await api('POST', `/api/dispatch/pharmacy/orders/${id}/verify`, {});
        toast('Prescription verified.', 'ok');
      } else {
        const reason = await askText({ title: 'Reject the prescription', label: 'Reason', placeholder: 'e.g. Expired — dated more than 6 months ago', confirmText: 'Reject' });
        if (reason == null) return;
        await api('POST', `/api/dispatch/pharmacy/orders/${id}/reject`, { reason });
        toast('Prescription rejected. The salesperson was told.', 'ok');
      }
      await load();
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message, 'bad');
      if (verify) setButtonLoading(verify, false);
    }
  });
  setInterval(() => { if (!document.hidden) load(); }, 30_000);
});
