'use strict';

// Admin: Sales Orders that didn't reach Zoho when their order was approved. Each waits in the
// retry queue (getmeds-system's zohoRetryService) with its last error. "Retry now" tries every
// waiting one at once, ignoring the back-off. Orders whose customer isn't in Zoho yet won't go
// through until the customer is pushed or linked on getmeds-system's Pending Customers page.

const STATUS_TAG = { pending: ['warn', 'Waiting to retry'], succeeded: ['ok', 'Went through'], failed_permanent: ['bad', 'Gave up'] };

async function load() {
  const { queue, summary } = await api('GET', '/api/zoho-sync/queue');
  const rows = queue.map((q) => {
    const [tone, text] = STATUS_TAG[q.status] || ['', q.status];
    const ref = q.getmeds_order_id || q.order_ref || null;
    return `<tr>
      <td>${ref ? `<a class="link" href="/order?id=${encodeURIComponent(ref)}"><b>${esc(ref)}</b></a>` : `Order #${esc(q.order_id)}`}${q.invoicing_from ? `<br><small>${esc(q.invoicing_from)}</small>` : ''}</td>
      <td><span class="tag ${tone}">${esc(text)}</span></td>
      <td class="num">${esc(q.attempts ?? 0)}</td>
      <td><small>${esc(q.last_error || '')}</small></td>
      <td><small>${q.status === 'pending' && q.next_attempt_at ? `next ${esc(ago(q.next_attempt_at).replace(' ago', ''))}` : ''}<br>${q.updated_at ? `updated ${esc(ago(q.updated_at))}` : ''}</small></td>
    </tr>`;
  }).join('');
  const z = currentMeta?.zoho || {};
  $('#main').innerHTML = `
    <div class="flag-box ${z.dryRun || z.mode !== 'live' ? 'warn' : ''}">Zoho mode: <b>${esc(z.dryRun ? 'dry run — nothing is sent to Zoho' : z.mode || 'mock')}</b>${z.mode !== 'live' && !z.dryRun ? ' (not the real Zoho)' : ''}.</div>
    <div class="list-tools">
      <span class="tag warn">${summary.pending} waiting</span>
      <span class="tag bad">${summary.failed_permanent} gave up</span>
      <span class="tag ok">${summary.succeeded} went through</span>
      <button type="button" class="btn small" id="retry-now"${summary.pending ? '' : ' disabled'}>Retry now</button>
    </div>
    <div class="table-wrap">
      <table class="simple-table">
        <thead><tr><th>Order</th><th>State</th><th class="num">Tries</th><th>Last error</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="hint">Nothing in the retry queue: every approved order reached Zoho.</td></tr>'}</tbody>
      </table>
    </div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;
  renderTopNav('zoho-sync');
  $('#role-line').textContent = 'Sales Orders that didn’t reach Zoho, and why. They are retried automatically when the retry job is on.';
  if (user.role !== 'admin') {
    $('#main').innerHTML = '<p class="quiet-box">Only Admin can see this page.</p>';
    return;
  }
  await load().catch((err) => toast(err.message, 'bad'));
  $('#main').addEventListener('click', async (e) => {
    const btn = e.target.closest('#retry-now');
    if (!btn) return;
    setButtonLoading(btn, true, 'Retrying…');
    try {
      const { processed, results } = await api('POST', '/api/zoho-sync/retry', {});
      const ok = (results || []).filter((r) => r.ok || r.status === 'succeeded').length;
      toast(`Tried ${plural(processed, 'order')}: ${ok} went through.`, ok ? 'ok' : 'bad');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
      setButtonLoading(btn, false);
    }
  });
});
