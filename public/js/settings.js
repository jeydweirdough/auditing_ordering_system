'use strict';

let currentTab = 'users';
let peopleData = null;
let configsData = null;
let revealState = null;

async function loadAllData() {
  const root = $('#settings-content');
  if (!peopleData && !configsData && root) {
    root.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading configuration settings…</p></div>';
  }
  try {
    const [usersRes, configsRes] = await Promise.all([
      api('GET', '/api/users'),
      api('GET', '/api/orders/configs'),
    ]);
    peopleData = usersRes;
    configsData = configsRes.configs;
    renderCurrentTab();
  } catch (err) {
    if (err instanceof SignedOut) return;
    if (root) {
      root.innerHTML = `<div class="panel"><p class="error">${esc(err.message)}</p></div>`;
    }
  }
}

function renderCurrentTab() {
  const root = $('#settings-content');
  if (!root) return;

  // Update tab buttons active state
  $$('.settings-tab-btn').forEach((btn) => {
    const isActive = btn.dataset.settingsTab === currentTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (currentTab === 'users') {
    renderUsersTab(root);
  } else if (currentTab === 'rbac') {
    renderRbacTab(root);
  } else if (currentTab === 'configs') {
    renderConfigsTab(root);
  }
}

// --------------------------------------------------------------------------
// Tab 1: User Accounts Management
// --------------------------------------------------------------------------
function renderUsersTab(root) {
  if (!peopleData) return;
  const { users, roles } = peopleData;
  const roleOptions = (selected) => roles.map((r) => `<option value="${esc(r.value)}"${r.value === selected ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

  const rows = users.map((u) => {
    const isSelf = u.id === currentUser.id;
    return `<tr data-user="${u.id}" data-name="${esc(u.name)}" class="${u.active ? '' : 'inactive'}">
      <td><strong>${esc(u.name)}</strong>${isSelf ? ' <small style="color:var(--ink-3);">(you)</small>' : ''}</td>
      <td class="mono">${esc(u.email)}</td>
      <td><select data-user-role aria-label="Role for ${esc(u.name)}"${isSelf ? ' disabled' : ''}>${roleOptions(u.role)}</select></td>
      <td>
        <div class="status-cell">
          ${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill stop">Deactivated</span>'}
          ${isSelf ? '' : `<button type="button" class="link" data-toggle-user="${u.active ? 'off' : 'on'}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}
        </div>
      </td>
      <td><button type="button" class="btn quiet small" data-reset-password>Reset password</button></td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="panel" style="display: grid; gap: 20px;">
      ${revealState ? `<div class="callout" role="status">
        <span>Password for <strong>${esc(revealState.email)}</strong>, shown only this once:</span>
        <code id="revealed-code" style="font-weight:700; font-size:15px; background:var(--surface); padding:2px 8px; border-radius:4px;">${esc(revealState.password)}</code>
        <button type="button" class="btn quiet small" data-copy-password>Copy</button>
        <button type="button" class="link" data-dismiss-password>Done</button>
      </div>` : ''}

      <div class="table-wrap">
        <table class="people" style="width:100%;">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th style="min-width: 170px;">Role</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <form id="person-form" class="person-form" novalidate style="border-top:1px solid var(--line-soft); padding-top:18px;">
        <h3 class="label" style="font-size: 15px; font-weight:700; margin-bottom:12px;">Add New User Account</h3>
        <div class="grid4">
          <label class="field" for="p-name"><span>Name</span><input id="p-name" name="name" type="text" maxlength="80" placeholder="Full name" required></label>
          <label class="field" for="p-email"><span>Email</span><input id="p-email" name="email" type="email" autocomplete="off" placeholder="name@getmeds.ph" required></label>
          <label class="field" for="p-role"><span>Role</span><select id="p-role" name="role">${roleOptions('salesperson')}</select></label>
          <label class="field" for="p-password"><span>Password <em>optional</em></span><input id="p-password" name="password" type="password" autocomplete="new-password" placeholder="Leave blank to auto-generate"></label>
        </div>
        <p class="error" id="person-error" role="alert" hidden style="margin-top:8px;"></p>
        <div class="actions" style="margin-top:12px;"><button type="submit" class="btn" id="btn-add-person">Add user account</button></div>
      </form>
    </div>
  `;

  initCustomSelects(root);
}

// --------------------------------------------------------------------------
// Tab 2: Role Permissions (RBAC) Management
// --------------------------------------------------------------------------
function renderRbacTab(root) {
  if (!configsData) return;
  const { rbac, permissionDefinitions } = configsData;

  const roleHeaders = rbac.map((r) => `
    <th class="center" style="min-width: 110px;">
      <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
        <span>${esc(r.label)}</span>
        ${!r.isSystem ? `<button type="button" class="link" data-delete-role="${esc(r.id)}" style="font-size:11px; color:var(--bad);" title="Delete custom role">Delete</button>` : '<small style="font-size:10px; color:var(--ink-3); text-transform:none;">(system)</small>'}
      </div>
    </th>
  `).join('');

  // Group permissions
  const groups = {};
  for (const p of permissionDefinitions) {
    groups[p.group] ??= [];
    groups[p.group].push(p);
  }

  let bodyRows = '';
  for (const [groupName, perms] of Object.entries(groups)) {
    bodyRows += `
      <tr style="background:var(--sunk);">
        <td colspan="${rbac.length + 1}" style="font-weight:700; font-size:12px; color:var(--ink-2); text-transform:uppercase; letter-spacing:0.06em; padding:6px 12px;">
          ${esc(groupName)}
        </td>
      </tr>
    `;
    for (const p of perms) {
      const checks = rbac.map((r) => {
        const isAdmin = r.id === 'admin';
        const checked = isAdmin || Boolean(r.permissions && r.permissions[p.key]);
        return `
          <td class="center">
            <input type="checkbox" class="rbac-checkbox" data-role-id="${esc(r.id)}" data-perm-key="${esc(p.key)}" ${checked ? 'checked' : ''} ${isAdmin ? 'disabled title="Admin always has all permissions"' : ''}>
          </td>
        `;
      }).join('');

      bodyRows += `
        <tr>
          <td>
            <div style="font-weight:600; color:var(--ink);">${esc(p.label)}</div>
            <code style="font-size:11px; color:var(--ink-3);">${esc(p.key)}</code>
          </td>
          ${checks}
        </tr>
      `;
    }
  }

  root.innerHTML = `
    <div style="display:grid; gap: 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <p class="sub" style="font-size:13.5px; color:var(--ink-2); margin:0;">
          Configure granular feature access per role. Changes take effect immediately.
        </p>
        <button type="button" class="btn small" id="btn-open-add-role">+ Add Custom Role</button>
      </div>

      <div class="rbac-table-wrap">
        <table class="rbac-table">
          <thead>
            <tr>
              <th style="min-width: 240px;">Permission</th>
              ${roleHeaders}
            </tr>
          </thead>
          <tbody>
            ${bodyRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Tab 3: Master Order Configurations
// --------------------------------------------------------------------------
function renderConfigsTab(root) {
  if (!configsData) return;
  const { divisions, headquarters, invoicingFrom, paymentMethods, sources, paymentTerms, deliveryMethods } = configsData;

  const renderPillList = (type, items) => `
    <div class="config-tag-list" data-config-type="${type}">
      ${(items || []).map((it) => `
        <span class="config-item-pill">
          <span>${esc(it)}</span>
          <button type="button" class="btn-pill-del" data-remove-item="${esc(it)}" data-type="${type}" title="Remove item">×</button>
        </span>
      `).join('')}
    </div>
    <form class="config-add-form" data-add-type="${type}">
      <input type="text" name="item" placeholder="Add new item..." required>
      <button type="submit" class="btn small">Add</button>
    </form>
  `;

  const divisionsHtml = divisions.map((d) => `
    <div class="division-card" data-division="${esc(d.name)}">
      <div class="division-card-header">
        <strong style="font-size:15px; color:var(--navy);">${esc(d.name)}</strong>
        <button type="button" class="link" data-remove-division="${esc(d.name)}" style="color:var(--bad); font-size:12px;">Remove Division</button>
      </div>
      <div class="subdiv-tags">
        ${(d.subDivisions || []).map((sub) => `
          <span class="subdiv-tag">
            ${esc(sub)}
            <button type="button" class="btn-pill-del" data-remove-subdiv="${esc(sub)}" data-for-div="${esc(d.name)}" style="margin-left:4px; font-weight:bold; color:var(--navy);" title="Remove sub-division">×</button>
          </span>
        `).join('')}
      </div>
      <form class="config-add-form" data-add-subdiv-for="${esc(d.name)}" style="margin-top:6px;">
        <input type="text" name="subDivision" placeholder="Add sub-division..." required style="min-height:30px; font-size:12px;">
        <button type="submit" class="btn quiet small" style="min-height:30px; padding:2px 8px; font-size:12px;">+ Add</button>
      </form>
    </div>
  `).join('');

  root.innerHTML = `
    <div style="display:grid; gap: 20px;">
      <!-- Divisions & Subdivisions Section -->
      <div class="config-card" style="grid-column: 1 / -1;">
        <div class="config-card-head">
          <div>
            <h2 class="config-card-title">Divisions & Sub-divisions</h2>
            <p class="config-card-sub">Hierarchical divisions and their respective operational sub-division tags.</p>
          </div>
          <button type="button" class="btn small" id="btn-open-add-div">+ Add Division</button>
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px;">
          ${divisionsHtml}
        </div>
      </div>

      <!-- Other Master Reference Data Grid -->
      <div class="config-grid">
        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Headquarters</h2>
              <p class="config-card-sub">Regional branches and main offices.</p>
            </div>
          </div>
          ${renderPillList('headquarters', headquarters)}
        </div>

        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Invoicing Entities</h2>
              <p class="config-card-sub">Entities an order can be invoiced under.</p>
            </div>
          </div>
          ${renderPillList('invoicing_from', invoicingFrom)}
        </div>

        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Payment Methods</h2>
              <p class="config-card-sub">Methods accepted for order settlement.</p>
            </div>
          </div>
          ${renderPillList('payment_methods', paymentMethods)}
        </div>

        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Order Sources</h2>
              <p class="config-card-sub">Origins and referral sources for orders.</p>
            </div>
          </div>
          ${renderPillList('sources', sources)}
        </div>

        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Payment Terms</h2>
              <p class="config-card-sub">Predefined payment agreement terms.</p>
            </div>
          </div>
          ${renderPillList('payment_terms', paymentTerms)}
        </div>

        <div class="config-card">
          <div class="config-card-head">
            <div>
              <h2 class="config-card-title">Delivery Methods</h2>
              <p class="config-card-sub">Available shipping and dispatch carriers.</p>
            </div>
          </div>
          ${renderPillList('delivery_methods', deliveryMethods)}
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Event Listeners and Actions
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  const canAccess = user.role === 'admin' || Boolean(user.canManageSettings || user.canManageUsers);
  if (!canAccess) {
    window.location.href = '/orders';
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const initialTab = urlParams.get('tab');
  if (initialTab && ['users', 'rbac', 'configs'].includes(initialTab)) {
    currentTab = initialTab;
  }

  renderTopNav('settings');
  await loadAllData();

  // Tab switcher
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-settings-tab]');
    if (tabBtn) {
      currentTab = tabBtn.dataset.settingsTab;
      const url = new URL(window.location);
      url.searchParams.set('tab', currentTab);
      window.history.replaceState({}, '', url);
      renderCurrentTab();
      return;
    }

    // Copy revealed password
    if (e.target.closest('[data-copy-password]')) {
      const code = $('#revealed-code')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code);
        toast('Password copied to clipboard.', 'ok');
      }
      return;
    }

    // Dismiss revealed password callout
    if (e.target.closest('[data-dismiss-password]')) {
      revealState = null;
      renderCurrentTab();
      return;
    }

    // Open add custom role modal
    if (e.target.closest('#btn-open-add-role')) {
      const modal = $('#role-dialog');
      if (modal) {
        $('#role-form').reset();
        $('#role-form-error').hidden = true;
        modal.showModal();
      }
      return;
    }

    // Close role modal
    if (e.target.closest('[data-cancel-role]')) {
      $('#role-dialog')?.close();
      return;
    }

    // Open add division modal
    if (e.target.closest('#btn-open-add-div')) {
      const modal = $('#division-dialog');
      if (modal) {
        $('#division-form').reset();
        $('#division-form-error').hidden = true;
        modal.showModal();
      }
      return;
    }

    // Close division modal
    if (e.target.closest('[data-cancel-div]')) {
      $('#division-dialog')?.close();
      return;
    }
  });

  // User Accounts Actions
  document.addEventListener('click', async (e) => {
    // Toggle active/inactive
    const toggleBtn = e.target.closest('[data-toggle-user]');
    if (toggleBtn) {
      const row = toggleBtn.closest('tr');
      const userId = row.dataset.user;
      const turnOn = toggleBtn.dataset.toggleUser === 'on';
      try {
        await api('PATCH', `/api/users/${userId}`, { active: turnOn });
        toast(`User ${turnOn ? 'reactivated' : 'deactivated'}.`, 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Reset password
    const resetBtn = e.target.closest('[data-reset-password]');
    if (resetBtn) {
      const row = resetBtn.closest('tr');
      const userId = row.dataset.user;
      const userName = row.dataset.name;
      if (!confirm(`Reset password for ${userName}? They will be signed out everywhere.`)) return;
      try {
        const { user, password } = await api('PATCH', `/api/users/${userId}`, { resetPassword: true });
        revealState = { email: user.email, password };
        toast(`Password reset for ${userName}.`, 'ok');
        renderCurrentTab();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Delete custom role
    const delRoleBtn = e.target.closest('[data-delete-role]');
    if (delRoleBtn) {
      const roleId = delRoleBtn.dataset.deleteRole;
      if (!confirm(`Delete role "${roleId}"? Users with this role must be reassigned.`)) return;
      try {
        await api('DELETE', `/api/orders/rbac/roles/${encodeURIComponent(roleId)}`);
        toast(`Role "${roleId}" deleted.`, 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Remove single config item (headquarters, payment terms, etc.)
    const removePillBtn = e.target.closest('[data-remove-item]');
    if (removePillBtn) {
      const type = removePillBtn.dataset.type;
      const item = removePillBtn.dataset.removeItem;
      if (!confirm(`Remove "${item}" from ${type.replace(/_/g, ' ')}?`)) return;
      try {
        await api('DELETE', `/api/orders/configs/${type}/${encodeURIComponent(item)}`);
        toast(`Removed "${item}".`, 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Remove division
    const removeDivBtn = e.target.closest('[data-remove-division]');
    if (removeDivBtn) {
      const divName = removeDivBtn.dataset.removeDivision;
      if (!confirm(`Delete division "${divName}" and all its sub-divisions?`)) return;
      try {
        await api('DELETE', `/api/orders/configs/divisions/${encodeURIComponent(divName)}`);
        toast(`Division "${divName}" removed.`, 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Remove sub-division from division
    const removeSubdivBtn = e.target.closest('[data-remove-subdiv]');
    if (removeSubdivBtn) {
      const divName = removeSubdivBtn.dataset.forDiv;
      const subName = removeSubdivBtn.dataset.removeSubdiv;
      const divObj = (configsData.divisions || []).find((d) => d.name === divName);
      if (!divObj) return;
      const nextSubs = (divObj.subDivisions || []).filter((s) => s !== subName);
      try {
        await api('PUT', '/api/orders/configs/divisions', {
          oldName: divName,
          name: divName,
          subDivisions: nextSubs,
        });
        toast(`Removed "${subName}" from ${divName}.`, 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
  });

  // Role change in user table
  document.addEventListener('change', async (e) => {
    if (e.target.matches('[data-user-role]')) {
      const row = e.target.closest('tr');
      const userId = row.dataset.user;
      const newRole = e.target.value;
      try {
        await api('PATCH', `/api/users/${userId}`, { role: newRole });
        toast('Role updated successfully.', 'ok');
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // RBAC checkbox change
    if (e.target.matches('.rbac-checkbox')) {
      const roleId = e.target.dataset.roleId;
      const permKey = e.target.dataset.permKey;
      const isChecked = e.target.checked;
      try {
        await api('PUT', `/api/orders/rbac/roles/${encodeURIComponent(roleId)}`, {
          permissions: { [permKey]: isChecked },
        });
        toast(`Updated permission for ${roleId}.`, 'ok');
        const rbacRole = configsData.rbac.find((r) => r.id === roleId);
        if (rbacRole) {
          rbacRole.permissions = rbacRole.permissions || {};
          rbacRole.permissions[permKey] = isChecked;
        }
      } catch (err) {
        e.target.checked = !isChecked;
        toast(err.message, 'bad');
      }
      return;
    }
  });

  // Submit new user form
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'person-form') {
      e.preventDefault();
      const errEl = $('#person-error');
      errEl.hidden = true;
      const data = new FormData(e.target);
      const payload = {
        name: data.get('name'),
        email: data.get('email'),
        role: data.get('role'),
        password: data.get('password') || undefined,
      };
      try {
        const { user, password } = await api('POST', '/api/users', payload);
        if (password) revealState = { email: user.email, password };
        toast(`Account created for ${user.name}.`, 'ok');
        e.target.reset();
        await loadAllData();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }

    // Submit new custom role form
    if (e.target.id === 'role-form') {
      e.preventDefault();
      const errEl = $('#role-form-error');
      errEl.hidden = true;
      const data = new FormData(e.target);
      const payload = {
        id: data.get('id'),
        label: data.get('label'),
        description: data.get('description'),
        permissions: {},
      };
      try {
        await api('POST', '/api/orders/rbac/roles', payload);
        $('#role-dialog').close();
        toast(`Role "${payload.label}" created!`, 'ok');
        await loadAllData();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }

    // Submit new division form
    if (e.target.id === 'division-form') {
      e.preventDefault();
      const errEl = $('#division-form-error');
      errEl.hidden = true;
      const data = new FormData(e.target);
      const subString = data.get('subDivisions') || '';
      const subDivisions = subString.split(',').map((s) => s.trim()).filter(Boolean);
      const payload = {
        name: data.get('name'),
        subDivisions,
      };
      try {
        await api('POST', '/api/orders/configs/divisions', payload);
        $('#division-dialog').close();
        toast(`Division "${payload.name}" added!`, 'ok');
        await loadAllData();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
      return;
    }

    // Submit single config item addition form (headquarters, payment terms, etc.)
    const addTypeForm = e.target.closest('[data-add-type]');
    if (addTypeForm) {
      e.preventDefault();
      const type = addTypeForm.dataset.addType;
      const input = addTypeForm.querySelector('[name=item]');
      const item = input?.value?.trim();
      if (!item) return;
      try {
        await api('POST', `/api/orders/configs/${type}`, { item });
        toast(`Added "${item}"!`, 'ok');
        input.value = '';
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }

    // Submit sub-division inline addition for a division
    const addSubdivForm = e.target.closest('[data-add-subdiv-for]');
    if (addSubdivForm) {
      e.preventDefault();
      const divName = addSubdivForm.dataset.addSubdivFor;
      const input = addSubdivForm.querySelector('[name=subDivision]');
      const subName = input?.value?.trim();
      if (!subName) return;
      const divObj = (configsData.divisions || []).find((d) => d.name === divName);
      if (!divObj) return;
      const nextSubs = [...(divObj.subDivisions || []), subName];
      try {
        await api('PUT', '/api/orders/configs/divisions', {
          oldName: divName,
          name: divName,
          subDivisions: nextSubs,
        });
        toast(`Added "${subName}" to ${divName}!`, 'ok');
        input.value = '';
        await loadAllData();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
  });
});
