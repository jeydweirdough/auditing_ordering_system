'use strict';

const DISCORD_STATE = {
  sent: (d) => ['sent', `Stored in ${d.inThread ? "the order's thread" : '#order-audit'}, data ${d.asReply ? 'in a reply' : 'in the next message'}`],
  queued: () => ['wait', 'Waiting to be stored in Discord'],
  sending: () => ['wait', 'Storing in Discord'],
  failed: (d) => ['bad', `Not stored in Discord yet: ${d.error}`],
  mocked: () => ['off', 'Mock mode: in memory only'],
  off: () => ['off', 'In memory only'],
};

const S = {
  orderId: null,
  order: null,
  side: 'order', // 'order' | 'edit' | 'resubmit'
  formFor: null,
  staged: [],
  tabOrigin: null,
};

const DANGER_ACTIONS = ['cancel', 'delete_order', 'restore', 'reject', 'purge_order'];

const dl = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

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
      : `<a class="file-name" href="${url}" target="_blank" rel="noopener" title="${esc(f.name)}">${esc(f.name)}</a>`;
    const viewBtn = isImg
      ? `<button type="button" class="btn quiet small file-view-btn" data-preview-image="${url}" data-preview-name="${esc(f.name)}" data-preview-kind="${esc(kindLabel)}">View</button>`
      : `<a class="btn quiet small file-view-btn" href="${url}" target="_blank" rel="noopener">View</a>`;
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
    if (a.name === 'approve') {
      cls = 'btn btn-approve';
      icon = '✓ ';
    } else if (a.name === 'send_back') {
      cls = 'btn btn-sendback';
      icon = '↩ ';
    } else if (a.name === 'reject') {
      cls = 'btn btn-reject';
      icon = '✕ ';
    } else if (a.name === 'resubmit') {
      cls = 'btn';
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
  return `<label class="field${f.type === 'textarea' ? ' wide' : ''}" for="${id}"><span>${esc(f.label)}${optional}</span>${control}${help}${hiddenFallback}</label>`;
}

function actionForm(o, a) {
  const defaults = { method: o.paymentMethod, amount: o.total, paidOn: today() };
  const fields = a.fields.length ? `<div class="grid2">${a.fields.map((f) => fieldHtml(f, defaults[f.name], `act-${f.name}`)).join('')}</div>` : '';

  let contextCard = '';
  let chipPresets = '';

  if (a.name === 'send_back' || a.name === 'reject') {
    const rxFiles = (o.attachments || []).filter((f) => f.kind === 'prescription');
    const itemsSummary = (o.items || []).map((it) => `${it.product} (${it.qty} × ${peso(it.unitPrice)}${it.priceType ? ` · ${it.priceType}` : ''})`).join(', ');

    contextCard = `
      <div class="sendback-summary-card">
        <div class="summary-line"><span>Customer:</span> <strong>${esc(o.customerName || 'N/A')}</strong> (${esc(o.division || '')} · ${esc(o.subDivision || '')})</div>
        <div class="summary-line"><span>Items (${o.items?.length || 0}):</span> ${esc(itemsSummary || 'None')}</div>
        <div class="summary-line"><span>Total:</span> <strong>${peso(o.total || 0)}</strong> · ${esc(o.paymentMethod || '')} (${esc(o.paymentTerms || '')})</div>
        <div class="summary-line"><span>Prescription:</span> ${rxFiles.length ? `✓ Attached (${esc(rxFiles.map(f => f.name).join(', '))})` : '⚠️ None attached'}</div>
      </div>`;

    const presets = a.name === 'send_back' ? [
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

  const isApprove = a.name === 'approve';
  const isSendBack = a.name === 'send_back';
  const isReject = a.name === 'reject';

  const title = isApprove ? '✓ Approve order'
    : isSendBack ? '↩ Send back for changes'
    : isReject ? '✕ Reject order'
    : esc(a.label);

  const intro = isSendBack
    ? `Moves ${esc(o.id)} to <strong>Sent back</strong>. The reason will be clearly shown to the salesperson so they can correct it and resubmit.`
    : isApprove
      ? `Moves ${esc(o.id)} to <strong>${esc(a.to)}</strong>. You can optionally include an approval note below.`
      : `Moves ${esc(o.id)} to <strong>${esc(a.to)}</strong>. The audit trail records it as you, now.`;

  const btnCls = a.danger ? 'btn danger'
    : isApprove ? 'btn btn-approve'
    : isSendBack ? 'btn btn-sendback-submit'
    : 'btn';

  const submitLabel = isApprove ? '✓ Confirm Approval'
    : isSendBack ? '↩ Send back to Salesperson'
    : isReject ? '✕ Confirm Rejection'
    : esc(a.label);

  return `<form id="action-form" data-action="${esc(a.name)}" novalidate>
    <div style="margin-bottom:12px;">
      <h3 style="margin:0 0 4px; font-size:16px;">${title}</h3>
      <p class="hint" style="margin:0;">${intro}</p>
    </div>
    ${contextCard}
    ${chipPresets}
    ${fields}
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
  const ship = o.shipment && [
    ['Courier', o.shipment.courier],
    ['Tracking number', o.shipment.trackingNumber],
    ['Dispatched', o.shipment.dispatchedAt && stamp(o.shipment.dispatchedAt)],
    ['Received by', o.shipment.receivedBy],
    ['Delivered', o.shipment.deliveredAt && stamp(o.shipment.deliveredAt)],
  ].filter(([, v]) => v);

  const canEdit = o.actions?.some((a) => a.name === 'edit');
  const backHref = S.tabOrigin ? `/orders?tab=${encodeURIComponent(S.tabOrigin)}` : '/orders';

  return `
    <div class="side-head">
      <div class="side-head-nav" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <a class="link" href="${backHref}" style="display:inline-flex; align-items:center; gap:6px; font-weight:600; text-decoration:none;">← Back to orders</a>
        ${canEdit ? `<button type="button" class="btn quiet small" data-action="edit">Edit order</button>` : ''}
      </div>
      <div class="side-top">
        <h2 class="order-id">${esc(o.id)}</h2>
        ${pill(o.status, o.statusLabel)}
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
    <div class="route-wrap">${route(o)}</div>
    <div class="order-view-layout">
      <div class="order-main-col">
        ${stepBox(o)}
        <section class="block"><h3 class="label">Order</h3>${dl(facts)}</section>
        <section class="block"><h3 class="label">Items</h3>${itemsTable(o)}</section>
        ${o.attachments?.length ? `<section class="block"><h3 class="label">Attachments</h3>${filesList(o)}</section>` : ''}
        ${pay ? `<section class="block"><h3 class="label">Payment</h3>${dl(pay)}${short ? `<p class="warn">The amount received differs from the order total of ${peso(o.total)}.</p>` : ''}</section>` : ''}
        ${ship?.length ? `<section class="block"><h3 class="label">Shipment</h3>${dl(ship)}</section>` : ''}
        ${dangerZone(o)}
      </div>
      <aside class="order-audit-col">
        <section class="block" id="audit">${auditView(o)}</section>
      </aside>
    </div>`;
}

// ---------------- Order Form (Edit & Resubmit) ----------------

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

function refreshFiles() {
  const block = $('#files-block');
  if (block) block.outerHTML = filesBlock(S.order, S.side);
}

function filesBlock(o, mode) {
  const { max, maxBytes, kinds } = currentMeta?.files || { max: 10, maxBytes: 3_000_000, kinds: {} };
  const used = (S.staged || []).reduce((n, f) => n + f.size, 0);
  const form = document.querySelector('#order-form');
  const div = form?.querySelector('[name=division]')?.value || o?.division || 'B2C';
  const terms = form?.querySelector('[name=paymentTerms]')?.value || o?.paymentTerms || '';
  const isDswdPcso = div !== 'B2B' && (terms.toUpperCase().includes('DSWD') || terms.toUpperCase().includes('PCSO'));
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
        <select class="file-kind-select" data-file-kind="${i}">
          ${Object.entries(kinds).map(([k, label]) => `<option value="${esc(k)}"${f.kind === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <button type="button" class="remove" data-remove-file="${i}" aria-label="Remove ${esc(f.name)}">×</button>
      </div>
    </li>`;
  }).join('');

  return `
    <fieldset class="block" id="files-block">
      <legend class="label">Attachments</legend>
      ${isDswdPcso && !hasGl ? `<p class="warn" style="margin:6px 0 10px;">⚠️ <strong>Guarantee Letter Required:</strong> ${esc(terms)} requires a Guarantee Letter (GL) attached.</p>` : ''}
      ${div === 'B2C' && hasRx ? `<p class="hint" style="color:var(--navy);font-weight:600;margin:6px 0 10px;">✓ Prescription attached: Doctor price tier is unlocked for B2C items.</p>` : ''}
      <div class="upload-dropzone" id="upload-dropzone" role="button" tabindex="0" aria-label="Drop attachments here or click to browse">
        <input type="file" id="file-input" multiple accept="image/*,application/pdf" hidden>
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
            <p class="upload-hint">Proof of payment, purchase order, prescription, guarantee letter: photos, PDF, Word or Excel</p>
            <p class="upload-limits">Up to ${max} files, ${maxBytes / 1e6} MB total. Images shrink automatically. Click thumbnail to preview.</p>
          </div>
          <button type="button" class="btn quiet small upload-btn" data-pick-files>Choose files</button>
        </div>
        <div class="upload-status-bar">
          <span class="upload-limit-info">${esc(bytes(used))} of ${maxBytes / 1e6} MB used</span>
          <span class="upload-count-info">${(S.staged || []).length} of ${max} files attached</span>
        </div>
      </div>
      <ul class="file-rows" id="file-rows">${rows}</ul>
    </fieldset>`;
}

function orderForm(o, mode) {
  const isSalesperson = currentUser?.role === 'salesperson';
  const productsLocked = isSalesperson && mode === 'resubmit';
  const divisionLocked = isSalesperson && mode === 'resubmit';
  const fields = currentMeta.orderFields;
  const notes = fields.find((f) => f.name === 'notes');
  const items = o?.items?.length ? o.items : [undefined];
  const sentBack = mode === 'resubmit' && o.events.findLast((e) => e.type === 'send_back');
  const [title, intro, submit] = {
    resubmit: [`Fix and resubmit ${esc(o?.id)}`, 'Make the changes Management asked for, attach any missing files, then resubmit. It goes back to Management for approval.', 'Resubmit for approval'],
    edit: [`Edit ${esc(o?.id)}`, "Change anything, the status and files included. What you change goes into the order's thread in #order-audit as Edited by Admin, with a line in the Admin log.", 'Save changes'],
  }[mode] || ['Edit order', '', 'Save'];

  const catalogDatalist = `<datalist id="products-catalog-list">${(currentMeta?.products ?? []).map((p) => `<option value="${esc(p.fullName)}" label="${esc(p.brandName || p.genericName)} · ${esc(p.classification)}">`).join('')}</datalist>`;
  const ownerName = o.owner?.name || o.createdBy?.name || 'You';

  return `
    <div class="side-head">
      <div class="side-head-nav" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <button type="button" class="link" data-reopen>Back to ${esc(o.id)}</button>
      </div>
      <h2 class="title">${title}</h2>
      <p class="sub">${esc(intro)}</p>
    </div>
    ${sentBack?.note ? `<p class="warn"><strong>${esc(sentBack.actor.name)} sent it back:</strong> ${esc(sentBack.note)}</p>` : ''}
    ${catalogDatalist}
    <div class="order-view-layout">
      <div class="order-main-col">
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
            ${productsLocked ? '<p class="hint" style="color:var(--navy);font-weight:600;margin-bottom:6px;">🔒 Products cannot be changed in the salesperson view. Only Management or Admin can modify items on an order.</p>' : ''}
            <div class="item-rows" id="item-rows">${items.map((it) => itemRow(it, o?.division, productsLocked)).join('')}</div>
            <div class="items-foot">
              ${productsLocked ? '' : '<button type="button" class="btn quiet small" data-add-item>Add item</button>'}
              <p>Total <strong id="form-total">${peso(o?.total || 0)}</strong></p>
            </div>
          </fieldset>
          ${filesBlock(o, mode)}
          ${notes ? `<div class="grid2">${fieldHtml(notes, o?.notes, 'o-notes', PLACEHOLDERS.notes)}</div>` : ''}
          ${mode === 'edit' ? `<div class="grid2">${fieldHtml(currentMeta.fields.reason, '', 'e-reason', 'Why this change is needed. It goes in the audit trail.')}</div>` : ''}
          <p class="error" id="order-error" role="alert" hidden></p>
          <div class="actions">
            <button type="submit" class="${mode === 'resubmit' ? 'btn btn-sendback-submit' : 'btn'}">${submit}</button>
            <button type="button" class="btn quiet" data-reopen>Cancel</button>
          </div>
        </form>
      </div>
      <aside class="order-audit-col">
        <section class="block" id="audit">${auditView(o)}</section>
      </aside>
    </div>`;
}

function render() {
  const side = $('#side');
  if (!side || !S.order) return;
  if (S.side === 'order') {
    side.innerHTML = orderView(S.order);
  } else if (S.side === 'resubmit' || S.side === 'edit') {
    side.innerHTML = orderForm(S.order, S.side);
    recalc();
  }
  initCustomSelects(side);
}

async function loadOrder() {
  if (!S.orderId) {
    window.location.href = '/orders';
    return;
  }
  const side = $('#side');
  if (!S.order && side) {
    side.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading order details…</p></div>';
  }
  try {
    const { order } = await api('GET', `/api/orders/${encodeURIComponent(S.orderId)}`);
    S.order = order;
    document.title = `${order.id} · Order Details`;
    render();
  } catch (err) {
    if (err instanceof SignedOut) return;
    if (side) {
      side.innerHTML = `
        <div style="padding:20px; text-align:center;">
          <p class="error" style="margin-bottom:12px;">Could not load order "${esc(S.orderId)}": ${esc(err.message)}</p>
          <a class="link" href="/orders" style="font-weight:600;">← Return to orders</a>
        </div>`;
    }
    toast(err.message, 'bad');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  renderTopNav('orders');
  const roleLine = $('#role-line');
  if (roleLine) roleLine.textContent = INTRO[user.role] || '';

  const params = new URLSearchParams(window.location.search);
  S.orderId = params.get('id') || (location.hash.startsWith('#') ? location.hash.slice(1) : null);
  S.tabOrigin = params.get('tab');

  await loadOrder();

  const side = $('#side');
  if (!side) return;

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

    if (e.target.closest('[data-reopen]')) {
      S.side = 'order';
      S.staged = [];
      render();
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
        render();
        return;
      }
      const act = S.order?.actions?.find((a) => a.name === name);
      if (act && (act.form || (act.fields && act.fields.length > 0))) {
        S.formFor = name;
        render();
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
          window.location.href = '/orders?tab=deleted';
          return;
        }
        const { order } = res;
        S.order = order;
        toast(`${order.id}: ${order.events.at(-1)?.label || 'Updated'}.`);
        render();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        setButtonLoading(actionBtn, false);
      }
      return;
    }

    if (e.target.closest('[data-back]')) {
      S.formFor = null;
      render();
      return;
    }

    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) {
      setButtonLoading(retryBtn, true, 'Retrying…');
      try {
        const { order } = await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/audit/retry`, {});
        S.order = order;
        toast('Audit trail sent to Discord again.');
        render();
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
      if (rows) {
        const temp = document.createElement('div');
        temp.innerHTML = itemRow(undefined, div);
        const newRow = temp.firstElementChild;
        rows.appendChild(newRow);
        initCustomSelects(newRow);
        updateItemRowPrice(newRow);
        recalc();
      }
      return;
    }

    const removeBtn = e.target.closest('[data-remove-item]');
    if (removeBtn) {
      const rows = document.querySelectorAll('#item-rows .item-row');
      if (rows.length > 1) {
        removeBtn.closest('.item-row')?.remove();
        recalc();
      } else {
        toast('An order needs at least one item.', 'bad');
      }
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
    if (e.target.name === 'division') {
      const form = $('#order-form');
      if (form) refreshFormDivision(form);
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
      const errorEl = $('#action-error');
      if (errorEl) errorEl.hidden = true;
      setButtonLoading(submitBtn, true, 'Submitting…');
      try {
        const res = await api('POST', `/api/orders/${encodeURIComponent(S.order.id)}/actions/${name}`, body);
        if (name === 'purge_order') {
          toast(`Order ${S.order.id} permanently deleted and vanished from Discord database.`);
          window.location.href = '/orders?tab=deleted';
          return;
        }
        const { order } = res;
        S.order = order;
        S.formFor = null;
        toast(`${order.id}: ${order.events.at(-1)?.label || 'Updated'}.`);
        render();
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
        render();
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
    if (document.visibilityState === 'visible' && S.side === 'order' && S.orderId) {
      try {
        const { order } = await api('GET', `/api/orders/${encodeURIComponent(S.orderId)}`);
        if (order && order.updatedAt !== S.order?.updatedAt) {
          S.order = order;
          render();
        }
      } catch {}
    }
  }, 12000);
});
