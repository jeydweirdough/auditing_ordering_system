'use strict';

// Dispatch's stock notices: out of stock, back in stock, low stock, or an update, about one
// product. Everyone who raises or approves orders sees the open ones at the top of every page,
// and the order form warns when a flagged product is added. A new notice about a product
// replaces the one before it; "Take down" removes it.

let notices = [];

function kindOptions() {
  return Object.entries(STOCK_KIND).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
}

function render() {
  const canPost = ['dispatch', 'management', 'admin'].includes(currentUser.role);
  const products = (currentMeta?.products || []).filter((p) => p.productId);
  const rows = notices.map((a) => `<tr>
      <td><b>${esc(a.product_name)}</b>${a.sku ? `<br><small>${esc(a.sku)}</small>` : ''}</td>
      <td><span class="tag ${a.kind === 'out_of_stock' ? 'bad' : a.kind === 'back_in_stock' ? 'ok' : 'warn'}">${esc(STOCK_KIND[a.kind])}</span></td>
      <td>${esc(a.message || '')}</td>
      <td><small>${esc(a.created_by_name || '')}<br>${esc(ago(a.created_at))}</small></td>
      <td>${canPost ? `<button type="button" class="btn quiet small" data-resolve="${a.id}">Take down</button>` : ''}</td>
    </tr>`).join('');
  $('#main').innerHTML = `
    ${canPost ? `<form class="page-card" id="notice-form" novalidate style="margin-bottom:16px;">
      <div class="form-row">
        <label class="field"><span>Product</span>
          <input list="stock-products" id="n-product" placeholder="Start typing a product…" autocomplete="off" required>
          <datalist id="stock-products">${products.map((p) => `<option value="${esc(p.fullName)}">`).join('')}</datalist>
        </label>
        <label class="field" style="max-width:200px;"><span>What</span><select id="n-kind" class="no-custom">${kindOptions()}</select></label>
      </div>
      <div class="form-row" style="margin-top:10px;">
        <label class="field"><span>Message <em>optional</em></span><input id="n-message" maxlength="300" placeholder="e.g. Next delivery Oct 2"></label>
        <button type="submit" class="btn">Post notice</button>
      </div>
      <p class="error" id="n-error" hidden></p>
    </form>` : ''}
    <div class="table-wrap">
      <table class="simple-table">
        <thead><tr><th>Product</th><th>Notice</th><th>Message</th><th>Posted</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="hint">No open stock notices.</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function load() {
  const { data } = await api('GET', '/api/stock-announcements');
  notices = data.announcements || [];
  render();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;
  renderTopNav('stock');
  $('#role-line').textContent = 'Tell salespeople and Management what is out of stock or back in. Open notices show at the top of their pages.';
  await load().catch((err) => toast(err.message, 'bad'));

  $('#main').addEventListener('submit', async (e) => {
    if (e.target.id !== 'notice-form') return;
    e.preventDefault();
    const err = $('#n-error');
    err.hidden = true;
    const name = $('#n-product').value.trim().toLowerCase();
    const product = (currentMeta?.products || []).find((p) => p.productId && [p.fullName, p.brandName].some((n) => String(n || '').toLowerCase() === name));
    if (!product) {
      err.textContent = 'Pick the product from the list.';
      err.hidden = false;
      return;
    }
    const btn = e.target.querySelector('button[type=submit]');
    setButtonLoading(btn, true, 'Posting…');
    try {
      await api('POST', '/api/stock-announcements', { product_id: product.productId, kind: $('#n-kind').value, message: $('#n-message').value.trim() });
      toast('Notice posted.', 'ok');
      await load();
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      setButtonLoading(btn, false);
    }
  });

  $('#main').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resolve]');
    if (!btn) return;
    setButtonLoading(btn, true);
    try {
      await api('POST', `/api/stock-announcements/${btn.dataset.resolve}/resolve`, {});
      toast('Notice taken down.', 'ok');
      await load();
    } catch (x) {
      toast(x.message, 'bad');
      setButtonLoading(btn, false);
    }
  });
});
