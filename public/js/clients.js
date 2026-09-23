'use strict';

let clientsData = [];
let clientSearch = '';

async function loadClientsData() {
  const root = $('#clients-content');
  if (!clientsData.length && root) {
    root.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading client directory…</p></div>';
  }
  try {
    const res = await api('GET', '/api/orders/customers/all');
    clientsData = res.clients || [];
    renderClients();
  } catch (err) {
    if (err instanceof SignedOut) return;
    if (root) root.innerHTML = `<div class="panel"><p class="error">${esc(err.message)}</p></div>`;
  }
}

function filteredClients() {
  if (!clientSearch.trim()) return clientsData;
  const q = clientSearch.trim().toLowerCase();
  return clientsData.filter((c) =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.contactNumber || '').toLowerCase().includes(q) ||
    (c.address || '').toLowerCase().includes(q)
  );
}

function renderClients() {
  const root = $('#clients-content');
  if (!root) return;

  const list = filteredClients();

  if (clientsData.length === 0) {
    root.innerHTML = `
      <div class="panel empty-promo-state" style="text-align:center; padding: 48px 24px;">
        <div style="font-size:36px; margin-bottom:12px;">🏥</div>
        <h3 style="font-size:18px; font-weight:700; color:var(--navy); margin-bottom:6px;">No Clients Yet</h3>
        <p style="font-size:13.5px; color:var(--ink-2); max-width:420px; margin:0 auto 18px auto;">
          Clients appear here automatically once an order is raised for them, or add one directly below.
        </p>
        <button type="button" class="btn small" id="btn-add-client-empty">+ Add Client</button>
      </div>
    `;
    return;
  }

  const rows = list.map((c) => `
    <tr data-client="${esc(c.id)}">
      <td><strong>${esc(c.name)}</strong></td>
      <td class="mono">${esc(c.contactNumber || '—')}</td>
      <td style="max-width:260px;">${esc(c.address || '—')}</td>
      <td>${c.receiverName ? esc(c.receiverName) : '—'}</td>
      <td>${c.hasSpecialPrice ? '<span class="pill ok">Special Price</span>' : '<span class="pill quiet">Standard</span>'}</td>
      <td class="mono">${Number(c.orderCount) || 0}</td>
      <td><button type="button" class="btn quiet small" data-edit-client="${esc(c.id)}">Edit</button></td>
    </tr>
  `).join('');

  root.innerHTML = `
    <div class="panel" style="padding:0;">
      <div class="table-wrap">
        <table class="people" style="width:100%;">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Address</th>
              <th>Usual Receiver</th>
              <th>Pricing</th>
              <th>Orders</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="7" style="text-align:center; color:var(--ink-3); padding:24px;">No clients match "${esc(clientSearch)}".</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

function openClientModal(client = null) {
  const modal = $('#client-dialog');
  if (!modal) return;

  $('#client-form').reset();
  $('#client-form-error').hidden = true;

  if (client) {
    $('#client-dialog-title').textContent = 'Edit Client';
    $('#cli-id').value = client.id;
    $('#cli-name').value = client.name || '';
    $('#cli-contact').value = client.contactNumber || '';
    $('#cli-address').value = client.address || '';
    $('#cli-receiver').value = client.receiverName || '';
    $('#cli-receiver-contact').value = client.receiverContact || '';
    $('#cli-special').checked = Boolean(client.hasSpecialPrice);
  } else {
    $('#client-dialog-title').textContent = 'Add Client';
    $('#cli-id').value = '';
  }

  modal.showModal();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  const canAccess = user.role === 'admin' || Boolean(user.canManageSettings);
  if (!canAccess) {
    window.location.href = '/orders';
    return;
  }

  renderTopNav('clients');
  await loadClientsData();

  document.addEventListener('input', (e) => {
    if (e.target.id === 'client-search') {
      clientSearch = e.target.value;
      renderClients();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-add-client') || e.target.closest('#btn-add-client-empty')) {
      openClientModal();
      return;
    }
    if (e.target.closest('[data-cancel-modal]')) {
      const dialog = e.target.closest('dialog');
      if (dialog) dialog.close();
      return;
    }
    const editBtn = e.target.closest('[data-edit-client]');
    if (editBtn) {
      const client = clientsData.find((c) => String(c.id) === editBtn.dataset.editClient);
      if (client) openClientModal(client);
      return;
    }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'client-form') return;
    e.preventDefault();
    const errEl = $('#client-form-error');
    errEl.hidden = true;

    const id = $('#cli-id').value;
    const payload = {
      name: $('#cli-name').value.trim(),
      contactNumber: $('#cli-contact').value.trim(),
      address: $('#cli-address').value.trim(),
      receiverName: $('#cli-receiver').value.trim(),
      receiverContact: $('#cli-receiver-contact').value.trim(),
      hasSpecialPrice: $('#cli-special').checked,
    };

    try {
      const res = id
        ? await api('PATCH', `/api/orders/customers/${encodeURIComponent(id)}`, payload)
        : await api('POST', '/api/orders/customers', payload);
      const saved = res.customer;
      const idx = clientsData.findIndex((c) => String(c.id) === String(saved.id));
      if (idx >= 0) clientsData[idx] = { ...clientsData[idx], ...saved };
      else clientsData.push({ ...saved, orderCount: 0 });
      $('#client-dialog').close();
      toast(`Client "${saved.name}" saved.`, 'ok');
      renderClients();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
});
