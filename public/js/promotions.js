'use strict';

let currentTab = 'bundles';
let promotionsData = null;
let catalogProducts = [];

async function loadPromotionsData() {
  const root = $('#promotions-content');
  if (!promotionsData && root) {
    root.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading promotions and pricing data…</p></div>';
  }
  try {
    const [promosRes, catalogRes] = await Promise.all([
      api('GET', '/api/orders/promotions'),
      api('GET', '/api/orders/catalog').catch(() => ({ products: [] })),
    ]);
    promotionsData = promosRes.promotions || { bundles: [], promos: [], discounts: [] };
    catalogProducts = catalogRes.products || [];
    renderCurrentTab();
  } catch (err) {
    if (err instanceof SignedOut) return;
    if (root) {
      root.innerHTML = `<div class="panel"><p class="error">${esc(err.message)}</p></div>`;
    }
  }
}

function renderCurrentTab() {
  const root = $('#promotions-content');
  if (!root || !promotionsData) return;

  $$('[data-promo-tab]').forEach((btn) => {
    const isActive = btn.dataset.promoTab === currentTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (currentTab === 'bundles') {
    renderBundlesTab(root);
  } else if (currentTab === 'promos') {
    renderPromosTab(root);
  } else if (currentTab === 'discounts') {
    renderDiscountsTab(root);
  }
}

// --------------------------------------------------------------------------
// Tab 1: Product Bundles
// --------------------------------------------------------------------------
function renderBundlesTab(root) {
  const bundles = promotionsData.bundles || [];

  if (bundles.length === 0) {
    root.innerHTML = `
      <div class="panel empty-promo-state" style="text-align:center; padding: 48px 24px;">
        <div style="font-size:36px; margin-bottom:12px;">📦</div>
        <h3 style="font-size:18px; font-weight:700; color:var(--navy); margin-bottom:6px;">No Bundles Configured</h3>
        <p style="font-size:13.5px; color:var(--ink-2); max-width:400px; margin:0 auto 18px auto;">
          Group multiple products into discounted packaged bundles for your customers.
        </p>
        <button type="button" class="btn small" data-open-modal="bundle">+ Create First Bundle</button>
      </div>
    `;
    return;
  }

  const cardsHtml = bundles.map((b) => {
    const itemsList = (b.items || []).map((it) => `
      <li style="display:flex; justify-content:space-between; align-items:center; font-size:13px; padding:3px 0; border-bottom:1px dashed var(--line-soft);">
        <span style="color:var(--ink); font-weight:500;">${esc(it.name)}</span>
        <span class="pill quiet" style="font-size:11px; padding:1px 6px;">×${Number(it.qty) || 1}</span>
      </li>
    `).join('');

    return `
      <div class="promo-card" data-bundle-id="${esc(b.id)}">
        <div class="promo-card-header">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
              <h3 class="promo-card-title">${esc(b.name)}</h3>
              ${b.active ? '<span class="pill ok">Active</span>' : '<span class="pill stop">Inactive</span>'}
            </div>
            ${b.code ? `<span class="promo-code-badge">${esc(b.code)}</span>` : ''}
          </div>
          <div class="promo-price-badge">
            ₱${Number(b.bundlePrice || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>

        ${b.description ? `<p class="promo-card-desc">${esc(b.description)}</p>` : ''}

        <div style="margin-top:10px; background:var(--sunk); border-radius:6px; padding:10px 12px;">
          <div style="font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-3); margin-bottom:6px;">
            Included Items (${(b.items || []).length})
          </div>
          ${itemsList ? `<ul style="list-style:none; padding:0; margin:0; display:grid; gap:3px;">${itemsList}</ul>` : '<span style="font-size:12px; color:var(--ink-3); font-style:italic;">No items listed</span>'}
        </div>

        <div class="promo-card-footer">
          <button type="button" class="btn quiet small" data-edit-bundle="${esc(b.id)}">Edit</button>
          <button type="button" class="link" data-delete-bundle="${esc(b.id)}" style="color:var(--bad); font-size:12.5px;">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `<div class="promo-grid">${cardsHtml}</div>`;
}

// --------------------------------------------------------------------------
// Tab 2: Promos & Campaigns
// --------------------------------------------------------------------------
function renderPromosTab(root) {
  const promos = promotionsData.promos || [];

  if (promos.length === 0) {
    root.innerHTML = `
      <div class="panel empty-promo-state" style="text-align:center; padding: 48px 24px;">
        <div style="font-size:36px; margin-bottom:12px;">🏷️</div>
        <h3 style="font-size:18px; font-weight:700; color:var(--navy); margin-bottom:6px;">No Campaigns Configured</h3>
        <p style="font-size:13.5px; color:var(--ink-2); max-width:400px; margin:0 auto 18px auto;">
          Set up seasonal marketing campaigns, promotional codes, and banners.
        </p>
        <button type="button" class="btn small" data-open-modal="promo">+ Create First Campaign</button>
      </div>
    `;
    return;
  }

  const cardsHtml = promos.map((p) => {
    let dateStr = 'Ongoing / Open';
    if (p.startDate && p.endDate) {
      dateStr = `${esc(p.startDate)} to ${esc(p.endDate)}`;
    } else if (p.startDate) {
      dateStr = `From ${esc(p.startDate)}`;
    } else if (p.endDate) {
      dateStr = `Until ${esc(p.endDate)}`;
    }

    return `
      <div class="promo-card" data-promo-id="${esc(p.id)}">
        <div class="promo-card-header">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
              <h3 class="promo-card-title">${esc(p.name)}</h3>
              ${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill stop">Inactive</span>'}
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              ${p.code ? `<span class="promo-code-badge">${esc(p.code)}</span>` : ''}
              ${p.tag ? `<span class="pill quiet" style="font-size:11px;">${esc(p.tag)}</span>` : ''}
            </div>
          </div>
        </div>

        ${p.description ? `<p class="promo-card-desc">${esc(p.description)}</p>` : ''}

        <div style="margin-top:auto; padding-top:12px; border-top:1px solid var(--line-soft); display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:12px; color:var(--ink-2);">
            <strong style="color:var(--ink);">Validity:</strong> ${dateStr}
          </div>
        </div>

        <div class="promo-card-footer">
          <button type="button" class="btn quiet small" data-edit-promo="${esc(p.id)}">Edit</button>
          <button type="button" class="link" data-delete-promo="${esc(p.id)}" style="color:var(--bad); font-size:12.5px;">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `<div class="promo-grid">${cardsHtml}</div>`;
}

// --------------------------------------------------------------------------
// Tab 3: Discounts & Rules
// --------------------------------------------------------------------------
function renderDiscountsTab(root) {
  const discounts = promotionsData.discounts || [];

  if (discounts.length === 0) {
    root.innerHTML = `
      <div class="panel empty-promo-state" style="text-align:center; padding: 48px 24px;">
        <div style="font-size:36px; margin-bottom:12px;">💸</div>
        <h3 style="font-size:18px; font-weight:700; color:var(--navy); margin-bottom:6px;">No Discount Rules Configured</h3>
        <p style="font-size:13.5px; color:var(--ink-2); max-width:400px; margin:0 auto 18px auto;">
          Set up institutional discounts, percentage-off deductions, or minimum-spend rewards.
        </p>
        <button type="button" class="btn small" data-open-modal="discount">+ Create First Discount</button>
      </div>
    `;
    return;
  }

  const cardsHtml = discounts.map((d) => {
    const isFixed = d.type === 'fixed';
    const valueDisplay = isFixed
      ? `₱${Number(d.value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} OFF`
      : `${Number(d.value || 0)}% OFF`;

    return `
      <div class="promo-card" data-discount-id="${esc(d.id)}">
        <div class="promo-card-header">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
              <h3 class="promo-card-title">${esc(d.name)}</h3>
              ${d.active ? '<span class="pill ok">Active</span>' : '<span class="pill stop">Inactive</span>'}
            </div>
            ${d.code ? `<span class="promo-code-badge">${esc(d.code)}</span>` : ''}
          </div>
          <div class="promo-discount-badge ${isFixed ? 'fixed' : 'percent'}">
            ${valueDisplay}
          </div>
        </div>

        ${d.description ? `<p class="promo-card-desc">${esc(d.description)}</p>` : ''}

        <div style="margin-top:auto; padding-top:12px; border-top:1px solid var(--line-soft); display:flex; justify-content:space-between; align-items:center; font-size:12.5px;">
          <span style="color:var(--ink-2);">
            <strong style="color:var(--ink);">Min. Spend:</strong>
            ${d.minSpend && Number(d.minSpend) > 0 ? `₱${Number(d.minSpend).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'No minimum'}
          </span>
          <span class="pill quiet" style="font-size:11px; text-transform:capitalize;">${esc(d.type)} rule</span>
        </div>

        <div class="promo-card-footer">
          <button type="button" class="btn quiet small" data-edit-discount="${esc(d.id)}">Edit</button>
          <button type="button" class="link" data-delete-discount="${esc(d.id)}" style="color:var(--bad); font-size:12.5px;">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `<div class="promo-grid">${cardsHtml}</div>`;
}

// --------------------------------------------------------------------------
// Bundle Modal Helpers
// --------------------------------------------------------------------------
function renderDatalist() {
  let list = $('#catalog-product-datalist');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'catalog-product-datalist';
    document.body.appendChild(list);
  }
  list.innerHTML = catalogProducts.map((p) => `<option value="${esc(p.name)}">`).join('');
}

function addBundleItemRow(item = { name: '', qty: 1 }) {
  const container = $('#bundle-items-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'bundle-item-row';
  row.style.cssText = 'display:flex; gap:8px; align-items:center;';
  row.innerHTML = `
    <input type="text" name="bundle_item_name" placeholder="Item name / SKU" value="${esc(item.name || '')}" list="catalog-product-datalist" required style="flex:1; min-width:0;">
    <input type="number" name="bundle_item_qty" value="${Number(item.qty) || 1}" min="1" step="1" required style="width:75px;" placeholder="Qty">
    <button type="button" class="btn quiet small btn-del-bundle-item" title="Remove item" style="color:var(--bad); padding:0 8px; min-height:36px;">×</button>
  `;
  container.appendChild(row);
}

function openBundleModal(bundle = null) {
  const modal = $('#bundle-dialog');
  if (!modal) return;

  renderDatalist();
  $('#bundle-form').reset();
  $('#bundle-form-error').hidden = true;
  $('#bundle-items-container').innerHTML = '';

  if (bundle) {
    $('#bundle-dialog-title').textContent = 'Edit Product Bundle';
    $('#bnd-id').value = bundle.id || '';
    $('#bnd-name').value = bundle.name || '';
    $('#bnd-code').value = bundle.code || '';
    $('#bnd-desc').value = bundle.description || '';
    $('#bnd-price').value = bundle.bundlePrice != null ? bundle.bundlePrice : '';
    $('#bnd-active').checked = bundle.active !== false;

    if (Array.isArray(bundle.items) && bundle.items.length > 0) {
      bundle.items.forEach((it) => addBundleItemRow(it));
    } else {
      addBundleItemRow();
    }
  } else {
    $('#bundle-dialog-title').textContent = 'Add Product Bundle';
    $('#bnd-id').value = '';
    $('#bnd-active').checked = true;
    addBundleItemRow();
  }

  modal.showModal();
}

function openPromoModal(promo = null) {
  const modal = $('#promo-dialog');
  if (!modal) return;

  $('#promo-form').reset();
  $('#promo-form-error').hidden = true;

  if (promo) {
    $('#promo-dialog-title').textContent = 'Edit Promo Campaign';
    $('#prm-id').value = promo.id || '';
    $('#prm-name').value = promo.name || '';
    $('#prm-code').value = promo.code || '';
    $('#prm-desc').value = promo.description || '';
    $('#prm-start').value = promo.startDate || '';
    $('#prm-end').value = promo.endDate || '';
    $('#prm-tag').value = promo.tag || '';
    $('#prm-active').checked = promo.active !== false;
  } else {
    $('#promo-dialog-title').textContent = 'Add Promo Campaign';
    $('#prm-id').value = '';
    $('#prm-active').checked = true;
  }

  modal.showModal();
}

function openDiscountModal(discount = null) {
  const modal = $('#discount-dialog');
  if (!modal) return;

  $('#discount-form').reset();
  $('#discount-form-error').hidden = true;

  if (discount) {
    $('#discount-dialog-title').textContent = 'Edit Discount Rule';
    $('#dsc-id').value = discount.id || '';
    $('#dsc-name').value = discount.name || '';
    $('#dsc-code').value = discount.code || '';
    $('#dsc-type').value = discount.type || 'percentage';
    $('#dsc-val').value = discount.value != null ? discount.value : '';
    $('#dsc-min').value = discount.minSpend != null ? discount.minSpend : '';
    $('#dsc-active').checked = discount.active !== false;
    $('#dsc-desc').value = discount.description || '';
  } else {
    $('#discount-dialog-title').textContent = 'Add Discount Rule';
    $('#dsc-id').value = '';
    $('#dsc-active').checked = true;
  }

  modal.showModal();
}

// --------------------------------------------------------------------------
// Lifecycle & Event Handling
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  const canAccess = user.role === 'admin' || Boolean(user.canManageSettings);
  if (!canAccess) {
    window.location.href = '/orders';
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const initialTab = urlParams.get('tab');
  if (initialTab && ['bundles', 'promos', 'discounts'].includes(initialTab)) {
    currentTab = initialTab;
  }

  renderTopNav('promotions');
  await loadPromotionsData();

  // Tab switching
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-promo-tab]');
    if (tabBtn) {
      currentTab = tabBtn.dataset.promoTab;
      const url = new URL(window.location);
      url.searchParams.set('tab', currentTab);
      window.history.replaceState({}, '', url);
      renderCurrentTab();
      return;
    }

    // Top right "+ Add New" button
    if (e.target.closest('#btn-create-item')) {
      if (currentTab === 'bundles') openBundleModal();
      else if (currentTab === 'promos') openPromoModal();
      else if (currentTab === 'discounts') openDiscountModal();
      return;
    }

    // Empty state trigger buttons
    const emptyBtn = e.target.closest('[data-open-modal]');
    if (emptyBtn) {
      const type = emptyBtn.dataset.openModal;
      if (type === 'bundle') openBundleModal();
      else if (type === 'promo') openPromoModal();
      else if (type === 'discount') openDiscountModal();
      return;
    }

    // Modal cancel button
    if (e.target.closest('[data-cancel-modal]')) {
      const dialog = e.target.closest('dialog');
      if (dialog) dialog.close();
      return;
    }

    // Add item row in bundle modal
    if (e.target.closest('#btn-add-bundle-item')) {
      addBundleItemRow();
      return;
    }

    // Remove item row in bundle modal
    if (e.target.closest('.btn-del-bundle-item')) {
      const row = e.target.closest('.bundle-item-row');
      if (row) {
        const container = $('#bundle-items-container');
        if (container.querySelectorAll('.bundle-item-row').length > 1) {
          row.remove();
        } else {
          toast('A bundle must contain at least one item.', 'bad');
        }
      }
      return;
    }

    // Edit Bundle
    const editBundleBtn = e.target.closest('[data-edit-bundle]');
    if (editBundleBtn) {
      const bndId = editBundleBtn.dataset.editBundle;
      const bundle = (promotionsData.bundles || []).find((b) => b.id === bndId);
      if (bundle) openBundleModal(bundle);
      return;
    }

    // Delete Bundle
    const delBundleBtn = e.target.closest('[data-delete-bundle]');
    if (delBundleBtn) {
      const bndId = delBundleBtn.dataset.deleteBundle;
      const bundle = (promotionsData.bundles || []).find((b) => b.id === bndId);
      if (!confirm(`Delete bundle "${bundle ? bundle.name : bndId}"?`)) return;
      api('DELETE', `/api/orders/promotions/bundle/${encodeURIComponent(bndId)}`)
        .then((res) => {
          promotionsData = res.promotions;
          toast('Bundle deleted.', 'ok');
          renderCurrentTab();
        })
        .catch((err) => toast(err.message, 'bad'));
      return;
    }

    // Edit Promo
    const editPromoBtn = e.target.closest('[data-edit-promo]');
    if (editPromoBtn) {
      const prmId = editPromoBtn.dataset.editPromo;
      const promo = (promotionsData.promos || []).find((p) => p.id === prmId);
      if (promo) openPromoModal(promo);
      return;
    }

    // Delete Promo
    const delPromoBtn = e.target.closest('[data-delete-promo]');
    if (delPromoBtn) {
      const prmId = delPromoBtn.dataset.deletePromo;
      const promo = (promotionsData.promos || []).find((p) => p.id === prmId);
      if (!confirm(`Delete campaign "${promo ? promo.name : prmId}"?`)) return;
      api('DELETE', `/api/orders/promotions/promo/${encodeURIComponent(prmId)}`)
        .then((res) => {
          promotionsData = res.promotions;
          toast('Campaign deleted.', 'ok');
          renderCurrentTab();
        })
        .catch((err) => toast(err.message, 'bad'));
      return;
    }

    // Edit Discount
    const editDiscountBtn = e.target.closest('[data-edit-discount]');
    if (editDiscountBtn) {
      const dscId = editDiscountBtn.dataset.editDiscount;
      const discount = (promotionsData.discounts || []).find((d) => d.id === dscId);
      if (discount) openDiscountModal(discount);
      return;
    }

    // Delete Discount
    const delDiscountBtn = e.target.closest('[data-delete-discount]');
    if (delDiscountBtn) {
      const dscId = delDiscountBtn.dataset.deleteDiscount;
      const discount = (promotionsData.discounts || []).find((d) => d.id === dscId);
      if (!confirm(`Delete discount "${discount ? discount.name : dscId}"?`)) return;
      api('DELETE', `/api/orders/promotions/discount/${encodeURIComponent(dscId)}`)
        .then((res) => {
          promotionsData = res.promotions;
          toast('Discount deleted.', 'ok');
          renderCurrentTab();
        })
        .catch((err) => toast(err.message, 'bad'));
      return;
    }
  });

  // Modal Form Submissions
  document.addEventListener('submit', async (e) => {
    // Bundle form
    if (e.target.id === 'bundle-form') {
      e.preventDefault();
      const errEl = $('#bundle-form-error');
      errEl.hidden = true;

      const form = e.target;
      const id = $('#bnd-id').value;
      const name = $('#bnd-name').value.trim();
      const code = $('#bnd-code').value.trim();
      const description = $('#bnd-desc').value.trim();
      const bundlePrice = parseFloat($('#bnd-price').value);
      const active = $('#bnd-active').checked;

      // Extract items
      const itemRows = form.querySelectorAll('.bundle-item-row');
      const items = [];
      itemRows.forEach((row) => {
        const itemInput = row.querySelector('[name=bundle_item_name]');
        const qtyInput = row.querySelector('[name=bundle_item_qty]');
        const itemName = itemInput ? itemInput.value.trim() : '';
        const itemQty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
        if (itemName) {
          items.push({ name: itemName, qty: itemQty || 1 });
        }
      });

      if (items.length === 0) {
        errEl.textContent = 'Please add at least one item with a valid name to the bundle.';
        errEl.hidden = false;
        return;
      }

      try {
        const res = await api('POST', '/api/orders/promotions/bundle', {
          id: id || undefined,
          name,
          code,
          description,
          bundlePrice,
          items,
          active,
        });
        promotionsData = res.promotions;
        $('#bundle-dialog').close();
        toast(`Bundle "${name}" saved successfully!`, 'ok');
        renderCurrentTab();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }

    // Promo form
    if (e.target.id === 'promo-form') {
      e.preventDefault();
      const errEl = $('#promo-form-error');
      errEl.hidden = true;

      const id = $('#prm-id').value;
      const name = $('#prm-name').value.trim();
      const code = $('#prm-code').value.trim();
      const description = $('#prm-desc').value.trim();
      const startDate = $('#prm-start').value || null;
      const endDate = $('#prm-end').value || null;
      const tag = $('#prm-tag').value.trim();
      const active = $('#prm-active').checked;

      try {
        const res = await api('POST', '/api/orders/promotions/promo', {
          id: id || undefined,
          name,
          code,
          description,
          startDate,
          endDate,
          tag,
          active,
        });
        promotionsData = res.promotions;
        $('#promo-dialog').close();
        toast(`Campaign "${name}" saved successfully!`, 'ok');
        renderCurrentTab();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }

    // Discount form
    if (e.target.id === 'discount-form') {
      e.preventDefault();
      const errEl = $('#discount-form-error');
      errEl.hidden = true;

      const id = $('#dsc-id').value;
      const name = $('#dsc-name').value.trim();
      const code = $('#dsc-code').value.trim();
      const type = $('#dsc-type').value;
      const value = parseFloat($('#dsc-val').value);
      const minSpend = parseFloat($('#dsc-min').value) || 0;
      const active = $('#dsc-active').checked;
      const description = $('#dsc-desc').value.trim();

      try {
        const res = await api('POST', '/api/orders/promotions/discount', {
          id: id || undefined,
          name,
          code,
          type,
          value,
          minSpend,
          active,
          description,
        });
        promotionsData = res.promotions;
        $('#discount-dialog').close();
        toast(`Discount "${name}" saved successfully!`, 'ok');
        renderCurrentTab();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }
  });
});
