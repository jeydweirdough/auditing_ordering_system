'use strict';

const S = {
  user: null,
  meta: null,
  staged: [],     // files picked for a new order: { name, size, kind, file }
  orderFor: null, // who a new order is for: null for me, or { id, name } of a salesperson
};

function findCatalogProduct(query) {
  if (!query || !S.meta?.products) return null;
  const q = String(query).trim().toLowerCase();
  return S.meta.products.find((p) =>
    (p.id && p.id.toLowerCase() === q) ||
    (p.fullName && p.fullName.toLowerCase() === q) ||
    (p.brandName && p.brandName.toLowerCase() === q) ||
    (p.genericName && p.genericName.toLowerCase() === q)
  ) || null;
}

function getAllowedTiersForDivision(division, hasPrescription = false, hasSpecialPrice = false) {
  const rule = S.meta?.divisionRules?.[division];
  const allTiers = S.meta?.priceTiers || {};
  if (!rule) return [];
  let keys;
  if (division === 'B2C') {
    keys = hasPrescription ? ['doctor'] : ['patient', 'srp'];
  } else {
    keys = [...(rule.allowed || [])];
  }
  if ((hasSpecialPrice || S.currentCustomer?.hasSpecialPrice) && !keys.includes('special')) {
    keys.push('special');
  }
  return keys.map((k) => allTiers[k]).filter(Boolean);
}

function itemRow(it = { product: '', qty: 1, unitPrice: '', priceType: '', unitType: 'unit' }, division = null) {
  const div = division || document.querySelector('#order-form [name=division]')?.value || 'B2C';
  const p = findCatalogProduct(it.product);
  const hasPrescription = S.staged?.some((f) => f.kind === 'prescription') || false;
  const hasSpecialPrice = Boolean(S.currentCustomer?.hasSpecialPrice);
  const tiers = getAllowedTiersForDivision(div, hasPrescription, hasSpecialPrice);

  let selectedTier = it.priceType;
  if (!selectedTier || !tiers.some((t) => t.key === selectedTier)) {
    if (div === 'BID') selectedTier = 'bid';
    else if (div === 'B2B') selectedTier = 'srp';
    else if (div === 'HOS') selectedTier = 'hospital';
    else selectedTier = 'patient';
  }

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

  const isSalesperson = S.user?.role === 'salesperson';
  const isBid = div === 'BID';
  const isSpecial = selectedTier === 'special';
  const priceLock = isSalesperson && !isBid && !isSpecial
    ? ' readonly style="background:var(--sunk);cursor:not-allowed;" title="Product price is fixed from the catalog and cannot be changed in salesperson view."'
    : '';

  if (selectedTier === 'special' || selectedTier === 'government' || div === 'BID') {
    hintBadges.push(`<span class="badge warn-badge">⚠️ Notes required</span>`);
  } else if (div === 'B2C' && selectedTier === 'doctor' && !hasPrescription) {
    hintBadges.push(`<span class="badge warn-badge">⚠️ Prescription / Rx attachment required</span>`);
  }
  if (selectedTier === 'special') {
    hintBadges.push(`<span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;font-weight:700;">Special Price Request</span>`);
  } else if (isSalesperson && !isBid) {
    hintBadges.push(`<span class="badge info-badge">Fixed Catalog Price</span>`);
  }

  return `<div class="item-row" data-product-id="${p ? esc(p.id) : ''}">
    <label class="field ip"><span>Product</span><input type="text" name="product" list="products-catalog-list" maxlength="120" value="${esc(it.product)}" placeholder="Search catalog by brand or generic name..."></label>
    <label class="field it"><span>Price tier</span><select name="priceType">${tierOptions}</select></label>
    <label class="field ik"><span>Unit/Pack</span><select name="unitType">
      <option value="unit"${unitType === 'unit' ? ' selected' : ''}>Unit</option>
      <option value="pack"${unitType === 'pack' ? ' selected' : ''}>Pack</option>
    </select></label>
    <label class="field iq"><span>Qty</span><input type="number" name="qty" min="1" step="1" inputmode="numeric" value="${esc(it.qty)}"></label>
    <label class="field iu"><span>Unit price</span><input type="number" name="unitPrice" min="0" step="0.01" inputmode="decimal" value="${esc(it.unitPrice)}" placeholder="0.00"${priceLock}></label>
    <div class="field ia"><span>Amount</span><output class="line-amt">${peso(0)}</output></div>
    <button type="button" class="remove" data-remove-item aria-label="Remove this item">×</button>
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

  const isSalesperson = S.user?.role === 'salesperson';
  const isBid = div === 'BID';
  if (priceInput) {
    if (isSalesperson && !isBid) {
      priceInput.readOnly = true;
      priceInput.style.background = 'var(--sunk)';
      priceInput.style.cursor = 'not-allowed';
      priceInput.title = 'Product price is fixed from the catalog and cannot be changed in salesperson view.';
    } else {
      priceInput.readOnly = false;
      priceInput.style.background = '';
      priceInput.style.cursor = '';
      priceInput.title = '';
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
  if (isBid) {
    badges.push(`<span class="badge warn-badge">⚠️ Bidding notes required</span>`);
  } else if (tier === 'special' || tier === 'government') {
    badges.push(`<span class="badge warn-badge">⚠️ Notes required</span>`);
  }
  if (isSalesperson && !isBid) {
    badges.push(`<span class="badge info-badge">Fixed Catalog Price</span>`);
  }
  if (hintEl) hintEl.innerHTML = badges.join(' ');
  // Dispatch's word on this product, if it has an open stock notice.
  if (p?.productId && hintEl) {
    stockNoticeFor(p.productId).then((n) => {
      if (!n || prodInput.value !== p.fullName && findCatalogProduct(prodInput.value) !== p) return;
      hintEl.insertAdjacentHTML('beforeend', ` <span class="badge warn-badge">⚠️ ${esc(STOCK_KIND[n.kind])}${n.message ? `: ${esc(n.message)}` : ''}</span>`);
    });
  }
}

function refreshFormDivision(form) {
  const div = form.querySelector('[name=division]')?.value || 'B2C';
  const hasPrescription = S.staged?.some((f) => f.kind === 'prescription');
  const hasSpecialPrice = Boolean(S.currentCustomer?.hasSpecialPrice);
  const allowed = getAllowedTiersForDivision(div, hasPrescription, hasSpecialPrice);

  const subSelect = form.querySelector('[name=subDivision]');
  const lists = S.meta?.fields?.subDivision?.optionsBy?.lists || S.meta?.fields?.subDivision?.suggestionsBy?.lists || {};
  const opts = lists[div] ?? [];
  if (subSelect) {
    if (subSelect.tagName === 'SELECT') {
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
    } else {
      const defaultSub = opts[0];
      if (defaultSub && (!subSelect.value || Object.values(lists).flat().includes(subSelect.value))) {
        subSelect.value = defaultSub;
      }
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
  refreshFiles();
}

function fieldHtml(f, value, id, placeholder, name = f.name, ctx = null) {
  const v = value ?? '';
  const req = f.required ? ' required' : '';
  const ph = placeholder ? ` placeholder="${esc(placeholder)}"` : '';
  const optional = f.required ? '' : ' <em>optional</em>';
  const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
  if (f.type === 'choice') {
    const choices = f.options.map((opt) => `<label class="choice-label"><input type="radio" name="${name}" value="${esc(opt)}"${opt === v ? ' checked' : ''}> <span>${esc(opt)}</span></label>`).join('');
    const clearBtn = `<button type="button" class="choice-clear-btn" data-clear-choice="${esc(name)}"${v ? '' : ' hidden'} title="Remove selection">Remove selection</button>`;
    return `<fieldset class="field choice" data-choice-field="${esc(name)}"><legend><span>${esc(f.label)}${optional}</span>${clearBtn}</legend><div class="choices">${choices}</div>${help}</fieldset>`;
  }
  let control;
  const suggestions = f.suggestions ?? (f.suggestionsBy && (f.suggestionsBy.lists[ctx?.[f.suggestionsBy.field]] ?? []));
  if (suggestions) {
    const by = f.suggestionsBy ? ` data-suggest-by="${esc(f.suggestionsBy.field)}"` : '';
    control = `<input id="${id}" name="${name}" type="text" list="${id}-list"${by} autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(v)}"${req}${ph}>`
      + `<datalist id="${id}-list">${suggestions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
  } else if (f.type === 'select') {
    const list = f.optionsBy ? (f.optionsBy.lists[ctx?.[f.optionsBy.field] ?? 'B2C'] ?? f.options) : f.options;
    const by = f.optionsBy ? ` data-options-by="${esc(f.optionsBy.field)}"` : '';
    const choose = list.includes(v) ? '' : '<option value="">Choose…</option>';
    control = `<select id="${id}" name="${name}"${by}${req}>${choose}${list.map((opt) => `<option${opt === v ? ' selected' : ''}>${esc(opt)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    control = `<textarea id="${id}" name="${name}" maxlength="${f.max}" rows="3"${req}${ph}>${esc(v)}</textarea>`;
  } else if (f.type === 'number') {
    control = `<input id="${id}" name="${name}" type="number" step="0.01" min="${f.min}" inputmode="decimal" value="${esc(v)}"${req}${ph}>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${f.type}"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(v)}"${req}${ph}>`;
  }
  let extraFeedback = '';
  if (f.name === 'customerName') {
    control = `<div class="search-input-wrap">
      ${control}
      <button type="button" class="btn-search-cust" data-search-customer title="Search customer in database">Search</button>
      <button type="button" class="btn-new-cust" data-open-add-customer title="Add new customer with full details in popup modal">+ Add Customer</button>
    </div>`;
    extraFeedback = `<div id="customer-search-feedback" class="cust-feedback"></div>`;
  }
  return `<label class="field${f.type === 'textarea' ? ' wide' : ''}" for="${id}"><span>${esc(f.label)}${optional}</span>${control}${extraFeedback}${help}</label>`;
}

function autofillCustomer(c) {
  if (!c) return;
  S.currentCustomer = c;
  const form = $('#order-form');
  if (!form) return;

  const setVal = (name, val) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (el && val != null) el.value = val;
  };

  setVal('customerName', c.name || '');
  setVal('contactNumber', c.contactNumber || '');
  setVal('address', c.address || '');
  setVal('receiverName', c.receiverName || c.name || '');
  setVal('receiverContact', c.receiverContact || c.contactNumber || '');

  // Note: Customers do not have division, sub-division, or headquarters.
  refreshAllItemRows();
  updateCustomerSpecialBadge();
}

function refreshAllItemRows() {
  const form = $('#order-form');
  const div = form?.querySelector('[name=division]')?.value || 'B2C';
  const hasPrescription = S.staged?.some((f) => f.kind === 'prescription') || false;
  const hasSpecial = Boolean(S.currentCustomer?.hasSpecialPrice);
  const tiers = getAllowedTiersForDivision(div, hasPrescription, hasSpecial);

  document.querySelectorAll('#item-rows .item-row').forEach((row) => {
    const tierSelect = row.querySelector('[name=priceType]');
    if (!tierSelect) return;
    const currentVal = tierSelect.value;
    tierSelect.innerHTML = tiers.map((t) => `<option value="${t.key}"${t.key === currentVal ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  });
}

function updateCustomerSpecialBadge() {
  let badge = $('#cust-special-price-badge');
  const feedback = $('#customer-search-feedback');
  if (!feedback) return;

  if (S.currentCustomer?.hasSpecialPrice) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'cust-special-price-badge';
      badge.style.marginTop = '6px';
      feedback.parentNode.insertBefore(badge, feedback.nextSibling);
    }
    badge.innerHTML = `
      <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-size:12.5px;color:#065f46;font-weight:600;">
        <span>⭐ Special Price Eligible: Special Price tier is unlocked for items on this order.</span>
      </div>
    `;
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }
}

async function handleCustomerSearch(query) {
  const q = String(query ?? '').trim();
  const feedback = $('#customer-search-feedback');
  if (!feedback) return;

  if (!q) {
    feedback.innerHTML = `<span class="badge warn-badge">Please enter a customer name, contact, or address to search.</span>`;
    return;
  }

  feedback.innerHTML = `<span class="badge info-badge">Searching customer database...</span>`;

  try {
    const { customers } = await api('GET', `/api/orders/customers?q=${encodeURIComponent(q)}`);
    S.lastCustomerResults = customers || [];

    if (!customers || customers.length === 0) {
      feedback.innerHTML = `
        <div class="cust-not-found">
          <span>Customer "<strong>${esc(q)}</strong>" was not found in records.</span>
          <button type="button" class="btn small" data-open-add-customer="${esc(q)}">+ Add "${esc(q)}" as New Customer</button>
        </div>`;
    } else if (customers.length === 1 && customers[0].name.toLowerCase() === q.toLowerCase()) {
      autofillCustomer(customers[0]);
      feedback.innerHTML = `
        <div class="cust-match-found">
          <span>✓ Customer found & applied: <strong>${esc(customers[0].name)}</strong> ${customers[0].contactNumber ? `(${esc(customers[0].contactNumber)})` : ''}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <button type="button" class="link small" data-open-add-customer="${esc(customers[0].name)}">+ Add New</button>
            <button type="button" class="link small" data-clear-cust-feedback>Dismiss</button>
          </div>
        </div>`;
    } else {
      feedback.innerHTML = `
        <div class="cust-results-menu">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong>Found ${customers.length} matching customer(s):</strong>
            <button type="button" class="btn quiet small" data-open-add-customer="${esc(q)}">+ Add as New Customer</button>
          </div>
          <ul class="cust-list">
            ${customers.map((c, i) => `
              <li data-select-customer-idx="${i}">
                <b>${esc(c.name)}</b>${c.inZoho === false ? ' <span class="tag warn">not in Zoho yet</span>' : ''}
                ${c.contactNumber ? ` · <small>${esc(c.contactNumber)}</small>` : ''}
                ${c.division ? ` · <span class="badge">${esc(c.division)}</span>` : ''}
                ${c.address ? `<div style="font-size:12px;color:var(--ink-2);">${esc(c.address)}</div>` : ''}
              </li>
            `).join('')}
          </ul>
        </div>`;
    }
  } catch (err) {
    feedback.innerHTML = `<span class="badge warn-badge">Search error: ${esc(err.message)}</span>`;
  }
}

async function quickAddCustomer(name) {
  const cleanName = String(name || $('#o-customerName')?.value || '').trim();
  if (!cleanName) return;
  const form = $('#order-form');
  const payload = {
    name: cleanName,
    contactNumber: form?.querySelector('[name=contactNumber]')?.value || '',
    address: form?.querySelector('[name=address]')?.value || '',
    receiverName: form?.querySelector('[name=receiverName]')?.value || '',
    receiverContact: form?.querySelector('[name=receiverContact]')?.value || '',
    division: form?.querySelector('[name=division]')?.value || '',
    subDivision: form?.querySelector('[name=subDivision]')?.value || '',
    headQuarter: form?.querySelector('[name=headQuarter]')?.value || '',
  };
  try {
    const { customer } = await api('POST', '/api/orders/customers/quick', payload);
    autofillCustomer(customer);
    const feedback = $('#customer-search-feedback');
    if (feedback) {
      feedback.innerHTML = `
        <div class="cust-match-found">
          <span>✓ Added to database: <strong>${esc(customer.name)}</strong></span>
          <button type="button" class="link small" data-clear-cust-feedback>Dismiss</button>
        </div>`;
    }
    toast(`Customer "${customer.name}" saved to database!`, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function openCustomerDialog(initialName = '') {
  const d = $('#customer-dialog');
  if (!d) return;

  const form = $('#order-form');
  const curName = initialName || form?.querySelector('[name=customerName]')?.value || '';
  const curContact = form?.querySelector('[name=contactNumber]')?.value || '';
  const curAddr = form?.querySelector('[name=address]')?.value || '';
  const curRecvName = form?.querySelector('[name=receiverName]')?.value || '';
  const curRecvContact = form?.querySelector('[name=receiverContact]')?.value || '';
  const curSpecial = Boolean(S.currentCustomer?.hasSpecialPrice);

  d.innerHTML = `
    <form id="customer-form" class="cust-dialog-body" novalidate>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2px;">
        <div>
          <h2 class="title" id="cust-dialog-title" style="margin:0 0 4px;">Add New Customer</h2>
          <p class="sub" style="margin:0;">Register customer details. This customer will be saved to your database and applied to this order.</p>
        </div>
        <button type="button" class="btn quiet small" data-close-customer-dialog style="padding:2px 8px;font-size:16px;line-height:1;min-height:auto;" aria-label="Close dialog">✕</button>
      </div>

      <label class="field" for="c-name">
        <span>Customer Name <em>*</em></span>
        <input id="c-name" name="name" type="text" maxlength="120" required value="${esc(curName)}" placeholder="e.g. Maria Santos / St. Jude Hospital">
      </label>

      <div class="grid2">
        <label class="field" for="c-contact">
          <span>Contact Number</span>
          <input id="c-contact" name="contactNumber" type="text" maxlength="30" value="${esc(curContact)}" placeholder="e.g. 09171234567">
        </label>
        <label class="field" for="c-receiver-name">
          <span>Receiver Name</span>
          <input id="c-receiver-name" name="receiverName" type="text" maxlength="120" value="${esc(curRecvName)}" placeholder="Person receiving package">
        </label>
      </div>

      <label class="field" for="c-address">
        <span>Delivery Address <em>*</em></span>
        <textarea id="c-address" name="address" rows="2" maxlength="300" required placeholder="Complete delivery address...">${esc(curAddr)}</textarea>
      </label>

      <label class="field" for="c-receiver-contact">
        <span>Receiver Contact</span>
        <input id="c-receiver-contact" name="receiverContact" type="tel" maxlength="30" value="${esc(curRecvContact)}" placeholder="Receiver's contact number">
      </label>

      <!-- Special Price Eligibility Option: Management clears a customer for it -->
      <div ${['management', 'admin'].includes(currentUser?.role) ? '' : 'hidden '}style="background:var(--sunk); padding:12px 14px; border-radius:8px; border:1px solid var(--line-soft); margin-top:6px;">
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin:0;">
          <input type="checkbox" id="c-special-price" name="hasSpecialPrice" style="width:18px; height:18px; margin-top:2px; accent-color:var(--navy);"${curSpecial ? ' checked' : ''}>
          <div>
            <strong style="font-size:13.5px; color:var(--ink);">Customer Eligible for Special Price</strong>
            <p style="font-size:12px; color:var(--ink-2); margin:2px 0 0 0;">
              Enables requesting custom Special Price tier on items upon order submission. Special Price requires notes explanation.
            </p>
          </div>
        </label>
      </div>

      <div id="cust-dup-box" hidden></div>
      <p class="error" id="cust-dialog-error" role="alert" hidden></p>

      <div class="actions" style="margin-top:12px;">
        <button type="submit" class="btn">Save & Apply Customer</button>
        <button type="button" class="btn quiet" data-close-customer-dialog>Cancel</button>
      </div>
    </form>
  `;

  d.showModal();
  d.querySelector('#c-name')?.focus();
}

const forLine = () => {
  const myName = currentUser?.name || S.user?.name || 'You';
  const isOther = Boolean(S.orderFor);
  const displayName = isOther ? `${S.orderFor.name} (Salesperson)` : `${myName} (You)`;
  const helpText = isOther ? `This order is assigned to salesperson ${S.orderFor.name}.` : `You are the creator and owner of this order.`;

  return `
    <label class="field wide order-for-field" id="for-line" for="o-order-for">
      <span>Order Raised For</span>
      <div class="search-input-wrap">
        <input id="o-order-for" type="text" readonly value="${esc(displayName)}" class="order-for-input" style="background:#f8fafc;font-weight:600;color:var(--navy);cursor:default;">
        <button type="button" class="btn quiet" data-change-for title="Change salesperson / creator">Change</button>
      </div>
      <small class="help">${esc(helpText)}</small>
    </label>`;
};

async function askWhoFor() {
  let salespeople;
  try {
    ({ salespeople } = await api('GET', '/api/orders/owners'));
  } catch (err) {
    if (!(err instanceof SignedOut)) toast(err.message, 'bad');
    return;
  }
  const d = $('#for-dialog');
  if (d.open) return;
  const picked = S.orderFor?.id;
  const myName = currentUser?.name || S.user?.name || 'you';
  const options = salespeople.map((u) => `<option value="${u.id}"${u.id === picked ? ' selected' : ''}>${esc(u.name)}</option>`).join('');
  d.innerHTML = `<form id="for-form" novalidate>
      <h2 class="title" id="for-title">Who is this order for?</h2>
      <label class="for-choice"><input type="radio" name="for" value="me"${picked ? '' : ' checked'}>
        <span><b>For me (${esc(myName)})</b><small>The order is yours and assigned to you.</small></span></label>
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

function isImageFile(name, type) {
  if (type && type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(name || '');
}

function filesBlock() {
  const { max, maxBytes, kinds } = S.meta.files;
  const div = document.querySelector('#order-form [name=division]')?.value;
  const terms = document.querySelector('#order-form [name=paymentTerms]')?.value || '';
  const isDswdPcso = div !== 'B2B' && (terms.toUpperCase().includes('DSWD') || terms.toUpperCase().includes('PCSO'));
  const hasGl = S.staged.some((f) => f.kind === 'guarantee_letter');

  const rows = S.staged.map((f, i) => {
    const isImg = isImageFile(f.name, f.file?.type);
    if (!f.previewUrl && f.file && isImg) {
      try { f.previewUrl = URL.createObjectURL(f.file); } catch {}
    }
    const url = f.previewUrl || '';
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
        </div>
      </div>
      <div class="file-actions">
        <select data-file-kind="${i}" aria-label="What ${esc(f.name)} is">${Object.entries(kinds).map(([k, label]) => `<option value="${k}"${k === f.kind ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <button type="button" class="remove" data-remove-file="${i}" aria-label="Remove ${esc(f.name)}" title="Remove file">×</button>
      </div>
    </li>`;
  }).join('');
  return `<fieldset class="items-edit" id="files-block">
      <legend class="label">Attachments</legend>
      ${isDswdPcso && !hasGl ? `<p class="warn"><strong>Guarantee letter required:</strong> Orders with DSWD / PCSO payment terms must have an attached file tagged as 'Guarantee letter (DSWD/PCSO)' (applicable to all divisions except B2B).</p>` : ''}
      <div class="upload-dropzone" id="upload-dropzone" role="button" tabindex="0" aria-label="Drop attachments here or click to browse">
        <input type="file" id="file-input" multiple accept="${esc(S.meta.files.accept)}" hidden>
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
            <p class="upload-limits">Up to ${max} files, ${Math.round(maxBytes / 1048576)} MB each. Big photos are made smaller automatically.</p>
          </div>
          <button type="button" class="btn quiet small upload-btn" data-pick-files>Choose files</button>
        </div>
        <div class="upload-status-bar">
          ${S.staged.length > 0 ? `<span class="upload-count-info">${S.staged.length} file${S.staged.length > 1 ? 's' : ''} attached</span>` : ''}
        </div>
      </div>
      ${rows ? `<ul class="file-rows">${rows}</ul>` : ''}
    </fieldset>`;
}

function refreshFiles() {
  const block = $('#files-block');
  if (block) {
    block.outerHTML = filesBlock();
    initCustomSelects($('#files-block'));
  }
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

async function addFiles(fileList) {
  const { max, maxBytes } = S.meta.files;
  for (const raw of fileList) {
    if (S.staged.length >= max) {
      toast(`At most ${max} files per order.`, 'bad');
      break;
    }
    const file = await shrink(raw);
    if (file.size > maxBytes) {
      toast(`${file.name} is too large. Each file can be up to ${Math.round(maxBytes / 1048576)} MB.`, 'bad');
      continue;
    }
    let kind = 'other';
    const lower = file.name.toLowerCase();
    if (lower.includes('rx') || lower.includes('prescrip')) kind = 'prescription';
    else if (lower.includes('po') || lower.includes('purchase')) kind = 'purchase_order';
    else if (lower.includes('gl') || lower.includes('guarantee') || lower.includes('pcso') || lower.includes('dswd')) kind = 'guarantee_letter';
    let previewUrl = '';
    if (file.type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(file.name)) {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {}
    }
    S.staged.push({ name: file.name, size: file.size, kind, file, previewUrl });
  }
  refreshFiles();
  const form = $('#order-form');
  if (form) refreshFormDivision(form);
}

function orderForm(o, mode) {
  const fields = S.meta.orderFields;
  const notes = fields.find((f) => f.name === 'notes');
  const items = o?.items?.length ? o.items : [undefined];
  const back = '<button type="button" class="link" data-close-new-order>← Back to orders</button>';
  const [title, intro, submit] = ['New order', 'Your Team Leader and Management review it; approving it creates the Sales Order in Zoho. Then Finance verifies payment and Dispatch ships it.', 'Submit for approval'];
  const catalogDatalist = `<datalist id="products-catalog-list">${(S.meta?.products ?? []).map((p) => `<option value="${esc(p.fullName)}" label="${esc(p.brandName || p.genericName)} · ${esc(p.classification)}">`).join('')}</datalist>`;

  const activeFields = fields.filter((f) => f !== notes && f.active !== false);
  const mainFields = activeFields.filter((f) => !f.isCustom || (f.section && f.section !== 'additional'));
  const additionalFields = activeFields.filter((f) => f.isCustom && (f.section || 'additional') === 'additional');

  return `
    <div class="side-head">
      ${back}
      <h2 class="title">${title}</h2>
      <p class="sub">${esc(intro)}</p>
    </div>
    ${catalogDatalist}
    <form id="order-form" class="block" data-mode="${mode}" novalidate>
      <div class="grid2">
        ${forLine()}
        ${mainFields.map((f) => fieldHtml(f, o?.[f.name], `o-${f.name}`, PLACEHOLDERS[f.name] || f.help, f.name, o)).join('')}
      </div>
      ${additionalFields.length > 0 ? `
        <fieldset class="field choice" style="margin-top:16px; border:1px solid var(--line); border-radius:8px; padding:14px;">
          <legend style="padding:0 8px; font-weight:700; color:var(--navy); font-size:13px;">Additional Information</legend>
          <div class="grid2">
            ${additionalFields.map((f) => fieldHtml(f, o?.[f.name], `o-${f.name}`, PLACEHOLDERS[f.name] || f.help, f.name, o)).join('')}
          </div>
        </fieldset>
      ` : ''}
      <fieldset class="items-edit">
        <legend class="label">Items</legend>
        <div class="item-rows" id="item-rows">${items.map((it) => itemRow(it, o?.division)).join('')}</div>
        <div class="items-foot">
          <button type="button" class="btn quiet small" data-add-item>Add item</button>
          <p>Total <strong id="form-total">${peso(0)}</strong></p>
        </div>
      </fieldset>
      ${notes ? `<div class="grid2">${fieldHtml(notes, o?.notes, 'o-notes', PLACEHOLDERS.notes)}</div>` : ''}
      ${filesBlock()}
      <p class="error" id="order-error" role="alert" hidden></p>
      <div class="actions">
        <button type="submit" class="btn">${submit}</button>
        <button type="button" class="btn quiet" data-close-new-order>Discard</button>
      </div>
    </form>`;
}

async function submitOrder(form) {
  const data = new FormData(form);
  const body = Object.fromEntries(S.meta.orderFields.map((f) => [f.name, data.get(f.name) ?? '']));
  body.items = [...form.querySelectorAll('.item-row')]
    .map((row) => ({
      product: row.querySelector('[name=product]').value,
      qty: row.querySelector('[name=qty]').value,
      unitPrice: row.querySelector('[name=unitPrice]').value,
      priceType: row.querySelector('[name=priceType]')?.value || undefined,
      unitType: row.querySelector('[name=unitType]')?.value || undefined,
    }))
    .filter((it) => it.product.trim() || it.unitPrice !== '');

  const division = body.division;
  const paymentTerms = String(body.paymentTerms || '').toUpperCase();
  const source = String(body.source || '').toUpperCase();
  const notes = String(body.notes || '').trim();
  const remarks = String(body.remarks || '').trim();
  const hasPrescription = S.staged.some((f) => f.kind === 'prescription');
  const hasGuaranteeLetter = S.staged.some((f) => f.kind === 'guarantee_letter');

  if (division !== 'B2B' && (paymentTerms.includes('DSWD') || paymentTerms.includes('PCSO') || source.includes('DSWD') || source.includes('PCSO'))) {
    if (!hasGuaranteeLetter) {
      throw new Error(`Orders with terms or source "${body.paymentTerms || body.source}" require an attached file tagged as 'Guarantee letter (DSWD/PCSO)'.`);
    }
  }

  if (division === 'BID' && !notes && !remarks) {
    throw new Error('Division BID has no price list; notes or customer remarks explaining the bidding pricing are required.');
  }

  const customerHasSpecial = Boolean(S.currentCustomer?.hasSpecialPrice);
  body.customerHasSpecialPrice = customerHasSpecial;

  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (it.priceType === 'special') {
      if (!customerHasSpecial && division !== 'BID') {
        throw new Error(`Item ${i + 1}: Special Price is only allowed for customers eligible for Special Price or BID division.`);
      }
      if (!notes && !remarks) {
        throw new Error(`Item ${i + 1}: Special Price requires an explanation in the Notes or Customer Remarks field.`);
      }
      continue;
    }
    if (division === 'B2C') {
      if (hasPrescription && it.priceType !== 'doctor') {
        throw new Error(`Item ${i + 1}: B2C order with prescription/rx must have Doctor's Price.`);
      }
      if (!hasPrescription && !['patient', 'srp'].includes(it.priceType)) {
        throw new Error(`Item ${i + 1}: B2C without prescription only allows Patient's Price or SRP.`);
      }
    } else if (division === 'HOS') {
      if (!['hospital', 'patient', 'doctor', 'srp'].includes(it.priceType)) {
        throw new Error(`Item ${i + 1}: HOS only allows Drugstore/Hospital Price, Patient's Price, Doctor's Price, or SRP.`);
      }
    } else if (division === 'STC' || division === 'URO' || division === 'B&B') {
      if (!['patient', 'doctor', 'srp'].includes(it.priceType)) {
        throw new Error(`Item ${i + 1}: ${division} only allows Patient's Price, Doctor's Price, or SRP.`);
      }
    } else if (division === 'B2B') {
      if (!['srp', 'distributor'].includes(it.priceType)) {
        throw new Error(`Item ${i + 1}: B2B only allows SRP or Distributor's Price.`);
      }
    } else if (division === 'BID') {
      if (!['bid', 'special', 'government'].includes(it.priceType)) {
        throw new Error(`Item ${i + 1}: Division BID has no price list; pricing must be entered as bidding price, Special Price, or Government Price with notes.`);
      }
    }
    if (it.priceType === 'government' && !notes && !remarks) {
      throw new Error(`Item ${i + 1}: Government Price requires an explanation in the Notes field.`);
    }
  }

  if (S.user?.role === 'salesperson' && division !== 'BID') {
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i];
      const p = findCatalogProduct(it.product);
      if (!p) {
        throw new Error(`Item ${i + 1}: Products cannot be changed in the salesperson view. Please select a valid product from the official catalog.`);
      }
    }
  }

  if (S.orderFor) body.ownerId = S.orderFor.id;
  // The customer picked from the list, if the name still matches it.
  if (S.currentCustomer?.id && S.currentCustomer.name.trim().toLowerCase() === String(body.customerName).trim().toLowerCase()) {
    body.customerId = S.currentCustomer.id;
  }
  // The server checks the Guarantee Letter and prescription rules against these now, and against
  // the uploaded files when the order is submitted.
  body.fileKinds = S.staged.map((f) => f.kind);

  const btn = form.querySelector('button[type=submit]');
  const say = (text) => { if (btn?.lastChild) btn.lastChild.textContent = text; };

  // 1. Saved as a draft. If a file fails to upload below, pressing Submit again carries on with
  //    this same draft rather than making a second order.
  if (!S.draft) {
    say('Saving…');
    S.draft = (await api('POST', '/api/orders', body)).order;
  }
  const id = S.draft.id;
  // 2. Each file straight to storage.
  try {
    const pending = S.staged.filter((f) => !f.uploaded);
    for (const [i, f] of pending.entries()) {
      say(`Uploading file ${i + 1} of ${pending.length}…`);
      await uploadOrderFile(id, f.file, f.kind);
      f.uploaded = true;
    }
  } catch (err) {
    throw new Error(`${err.message} The order is saved as draft ${id}: press Submit to try the upload again.`);
  }
  // 3. Submitted, once its files are there.
  say('Submitting…');
  const { order } = await api('POST', `/api/orders/${encodeURIComponent(id)}/actions/submit`, {});
  S.draft = null;
  toast(`${order.id} submitted: ${order.statusLabel}.`);
  window.location.href = `/order?id=${encodeURIComponent(order.id)}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  S.user = user;
  S.meta = currentMeta;

  if (!CREATORS.includes(user.role)) {
    alert('Your role does not have permission to raise new orders.');
    window.location.href = '/orders';
    return;
  }

  renderTopNav('new-order');
  $('#role-line').textContent = INTRO[user.role] || '';

  const params = new URLSearchParams(window.location.search);
  const ownerId = params.get('ownerId');
  const ownerName = params.get('ownerName');
  if (ownerId && ownerName) {
    S.orderFor = { id: Number(ownerId), name: ownerName };
  }

  const side = $('#side');
  side.innerHTML = orderForm(null, 'new');
  initCustomSelects(side);
  recalc();
  refreshFormDivision($('#order-form'));

  let radioWasChecked = false;
  side.addEventListener('pointerdown', (e) => {
    const radio = e.target.closest('input[type="radio"]') || e.target.closest('label')?.querySelector('input[type="radio"]');
    if (radio && radio.name !== 'for') {
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
    if (clickedRadio && clickedRadio.name !== 'for') {
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

    if (e.target.closest('[data-close-new-order]')) {
      window.location.href = '/orders';
      return;
    }

    if (e.target.closest('[data-change-for]')) {
      await askWhoFor();
      return;
    }

    if (e.target.closest('[data-add-item]')) {
      const div = $('#order-form [name=division]')?.value || 'B2C';
      const rows = $('#item-rows');
      const temp = document.createElement('div');
      temp.innerHTML = itemRow(undefined, div);
      const newRow = temp.firstElementChild;
      rows.appendChild(newRow);
      initCustomSelects(newRow);
      updateItemRowPrice(newRow);
      recalc();
      newRow.querySelector('[name=product]').focus();
      return;
    }

    const removeBtn = e.target.closest('[data-remove-item]');
    if (removeBtn) {
      removeBtn.closest('.item-row').remove();
      recalc();
      return;
    }

    if (e.target.closest('[data-search-customer]')) {
      const q = $('#o-customerName')?.value || '';
      await handleCustomerSearch(q);
      return;
    }

    const openAddBtn = e.target.closest('[data-open-add-customer], [data-quick-add-cust]');
    if (openAddBtn) {
      const name = openAddBtn.dataset.openAddCustomer || openAddBtn.dataset.quickAddCust || $('#o-customerName')?.value || '';
      openCustomerDialog(name);
      return;
    }

    if (e.target.closest('[data-clear-cust-feedback]')) {
      const fb = $('#customer-search-feedback');
      if (fb) fb.innerHTML = '';
      return;
    }

    const custLi = e.target.closest('[data-select-customer-idx]');
    if (custLi) {
      const idx = Number(custLi.dataset.selectCustomerIdx);
      if (S.lastCustomerResults && S.lastCustomerResults[idx]) {
        const cust = S.lastCustomerResults[idx];
        autofillCustomer(cust);
        const fb = $('#customer-search-feedback');
        if (fb) {
          fb.innerHTML = `
            <div class="cust-match-found">
              <span>✓ Customer found & applied: <strong>${esc(cust.name)}</strong> ${cust.contactNumber ? `(${esc(cust.contactNumber)})` : ''}</span>
              <button type="button" class="link small" data-clear-cust-feedback>Dismiss</button>
            </div>`;
        }
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
      S.staged.splice(idx, 1);
      refreshFiles();
      refreshFormDivision($('#order-form'));
      return;
    }
  });

  let custSearchTimer = null;
  side.addEventListener('keydown', async (e) => {
    if (e.target.name === 'customerName' && e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(custSearchTimer);
      await handleCustomerSearch(e.target.value);
    }
  });

  side.addEventListener('input', (e) => {
    if (e.target.name === 'customerName') {
      clearTimeout(custSearchTimer);
      const q = e.target.value.trim();
      if (q.length >= 2) {
        custSearchTimer = setTimeout(() => handleCustomerSearch(q), 300);
      } else if (!q) {
        const fb = $('#customer-search-feedback');
        if (fb) fb.innerHTML = '';
      }
    }

    const row = e.target.closest('.item-row');
    if (row) {
      if (e.target.name === 'product') {
        updateItemRowPrice(row);
      }
      recalc();
    }
  });

  side.addEventListener('change', (e) => {
    if (e.target.name === 'division') {
      refreshFormDivision($('#order-form'));
      return;
    }
    if (e.target.name === 'paymentTerms') {
      refreshFiles();
      return;
    }
    const row = e.target.closest('.item-row');
    if (row) {
      if (e.target.name === 'priceType' || e.target.name === 'unitType') {
        updateItemRowPrice(row);
      }
      recalc();
      return;
    }
    if (e.target.dataset.fileKind != null) {
      const idx = Number(e.target.dataset.fileKind);
      if (S.staged[idx]) {
        S.staged[idx].kind = e.target.value;
        refreshFormDivision($('#order-form'));
      }
    }
  });

  side.addEventListener('change', async (e) => {
    if (e.target.id === 'file-input') {
      if (e.target.files && e.target.files.length) {
        await addFiles(e.target.files);
        e.target.value = '';
      }
      return;
    }
    if (e.target.type === 'radio' && e.target.name !== 'for') {
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
        await addFiles(e.dataTransfer.files);
      }
    }
  });

  side.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'upload-dropzone') {
      e.preventDefault();
      $('#file-input')?.click();
    }
  });

  side.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id !== 'order-form') return;
    const errorEl = $('#order-error');
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    const btn = form.querySelector('button[type=submit]');
    setButtonLoading(btn, true, 'Submitting order…');

    try {
      await submitOrder(form);
    } catch (err) {
      setButtonLoading(btn, false);
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  // Modal dialog events for "Who is this order for?"
  const forDialog = $('#for-dialog');
  forDialog.addEventListener('change', (e) => {
    if (e.target.name === 'for') $('#for-person-field').hidden = e.target.value !== 'other';
  });

  forDialog.addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-cancel]')) e.currentTarget.close();
  });

  forDialog.addEventListener('submit', (e) => {
    e.preventDefault();
    const { elements } = e.target;
    if (elements.for.value === 'other') {
      const select = elements.person;
      if (!select.value) {
        $('#for-error').textContent = 'Pick the salesperson this order is for.';
        $('#for-error').hidden = false;
        return select.focus();
      }
      S.orderFor = { id: Number(select.value), name: select.selectedOptions[0].textContent };
    } else {
      S.orderFor = null;
    }
    $('#for-dialog').close();
    if ($('#for-line')) $('#for-line').outerHTML = forLine();
  });

  // Modal dialog events for "Add New Customer"
  const custDialog = $('#customer-dialog');
  if (custDialog) {
    custDialog.addEventListener('click', (e) => {
      if (e.target === custDialog || e.target.closest('[data-close-customer-dialog]')) {
        custDialog.close();
        return;
      }
      const use = e.target.closest('[data-use-dup]');
      if (use) {
        const m = S.dupMatches[Number(use.dataset.useDup)];
        autofillCustomer({ id: m.id, name: m.name, contactNumber: m.contactNumber, address: m.address, inZoho: true });
        custDialog.close();
        toast(`Using ${m.name}, already in Zoho.`, 'ok');
        return;
      }
      if (e.target.closest('[data-add-anyway]')) {
        const form = $('#customer-form');
        form.dataset.dupChecked = '1';
        form.requestSubmit();
      }
    });

    custDialog.addEventListener('submit', async (e) => {
      if (e.target.id !== 'customer-form') return;
      e.preventDefault();
      const form = e.target;
      const errEl = $('#cust-dialog-error');
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = '';
      }

      const name = form.querySelector('[name=name]')?.value.trim();
      if (!name) {
        if (errEl) {
          errEl.textContent = 'Customer name is required.';
          errEl.hidden = false;
        }
        return;
      }
      const address = form.querySelector('[name=address]')?.value.trim();
      if (!address) {
        if (errEl) {
          errEl.textContent = 'Delivery address is required.';
          errEl.hidden = false;
        }
        return;
      }

      const hasSpecialPrice = form.querySelector('[name=hasSpecialPrice]')?.checked || false;
      const payload = {
        name,
        contactNumber: form.querySelector('[name=contactNumber]')?.value.trim() || '',
        address,
        receiverName: form.querySelector('[name=receiverName]')?.value.trim() || '',
        receiverContact: form.querySelector('[name=receiverContact]')?.value.trim() || '',
        hasSpecialPrice,
      };

      const btn = form.querySelector('button[type=submit]');
      setButtonLoading(btn, true, 'Checking…');
      try {
        // Customers already in Zoho that look like this one: pick one of them instead of adding a
        // duplicate. Asked once; "Add as new anyway" skips it.
        if (!form.dataset.dupChecked) {
          const { matches } = await api('POST', '/api/orders/customers/check-duplicates', payload);
          if (matches.length) {
            S.dupMatches = matches;
            const box = $('#cust-dup-box');
            const blocking = matches.some((m) => m.sameCustomer);
            const why = { same_name: 'same name', similar_name: 'similar name', phone: 'same phone', tin: 'same TIN', lto: 'same LTO licence', email: 'same email' };
            box.innerHTML = `<div class="flag-box warn"><b>${matches.length === 1 ? 'This customer may already be in Zoho' : `${matches.length} customers in Zoho look like this one`}</b>
              <ul class="dup-list">${matches.map((m, i) => `<li><b>${esc(m.name)}</b> · ${esc(m.matched.map((k) => why[k] || k).join(', '))}${m.orders ? ` · ${plural(m.orders, 'order')}` : ''}
                <br><small>${esc([m.contactNumber, m.address].filter(Boolean).join(' · '))}</small>
                <div><button type="button" class="btn small" data-use-dup="${i}">Use this customer</button></div></li>`).join('')}</ul>
              ${blocking ? '<p class="hint">One of these is the same customer, so a new one can’t be added.</p>' : '<button type="button" class="btn quiet small" data-add-anyway>Add as a new customer anyway</button>'}</div>`;
            box.hidden = false;
            return;
          }
        }
        setButtonLoading(btn, true, 'Saving customer…');
        const { customer } = await api('POST', '/api/orders/customers', payload);
        if (payload.hasSpecialPrice && ['management', 'admin'].includes(currentUser?.role)) {
          Object.assign(customer, (await api('PATCH', `/api/orders/customers/${customer.id}/special-price`, { hasSpecialPrice: true })).customer);
        }
        delete form.dataset.dupChecked;
        custDialog.close();
        autofillCustomer(customer);
        const fb = $('#customer-search-feedback');
        if (fb) {
          fb.innerHTML = `
            <div class="cust-match-found">
              <span>✓ Customer <strong>${esc(customer.name)}</strong> registered & applied!</span>
              <button type="button" class="link small" data-clear-cust-feedback>Dismiss</button>
            </div>`;
        }
        toast(`Customer "${customer.name}" registered and applied.`);
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Failed to save customer.';
          errEl.hidden = false;
        }
      } finally {
        setButtonLoading(btn, false);
      }
    });
  }
});
