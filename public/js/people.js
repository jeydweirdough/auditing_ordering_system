'use strict';

let peopleData = null;
let revealState = null;

async function fetchPeople() {
  const root = $('#people-content');
  if (!peopleData && root) {
    root.innerHTML = '<div class="loading-state"><div class="spinner"></div><p class="loading-text">Loading user accounts…</p></div>';
  }
  try {
    peopleData = await api('GET', '/api/users');
    renderPeopleView();
  } catch (err) {
    if (err instanceof SignedOut) return;
    root.innerHTML = `<div class="panel" id="people-panel"><p class="error">${esc(err.message)}</p></div>`;
  }
}

function renderPeopleView() {
  const root = $('#people-content');
  if (!root || !peopleData) return;

  const { users, roles } = peopleData;
  const roleOptions = (selected) => roles.map((r) => `<option value="${r.value}"${r.value === selected ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
  
  const rows = users.map((u) => {
    const isSelf = u.id === currentUser.id;
    return `<tr data-user="${u.id}" data-name="${esc(u.name)}" class="${u.active ? '' : 'inactive'}">
      <td>${esc(u.name)}${isSelf ? ' <small>(you)</small>' : ''}</td>
      <td class="mono">${esc(u.email)}</td>
      <td><select data-role aria-label="Role for ${esc(u.name)}"${isSelf ? ' disabled' : ''}>${roleOptions(u.role)}</select></td>
      <td><div class="status-cell">${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill stop">Deactivated</span>'}${isSelf ? '' : `<button type="button" class="link" data-toggle="${u.active ? 'off' : 'on'}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}</div></td>
      <td><button type="button" class="btn quiet small" data-reset>Reset password</button></td>
    </tr>`;
  }).join('');

  root.innerHTML = `<div class="panel" id="people-panel">
    <div class="side-head">
      <h2 class="title">People</h2>
      <p class="sub">Accounts are kept in data/users.json on this computer, with hashed passwords. Every change here is posted to the Admin log thread in #order-audit: who changed which account, and how. Never passwords.</p>
    </div>
    ${revealState ? `<div class="callout" role="status">
      <span>Password for <strong>${esc(revealState.email)}</strong>, shown only this once:</span>
      <code id="revealed-code">${esc(revealState.password)}</code>
      <button type="button" class="btn quiet small" data-copy>Copy</button>
      <button type="button" class="link" data-dismiss>Done</button>
    </div>` : ''}
    <div class="table-wrap"><table class="people">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th><span class="sr">Password</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <form id="person-form" class="person-form" novalidate>
      <h3 class="label">Add a person</h3>
      <div class="grid4">
        <label class="field" for="p-name"><span>Name</span><input id="p-name" name="name" type="text" maxlength="80" required></label>
        <label class="field" for="p-email"><span>Email</span><input id="p-email" name="email" type="email" autocomplete="off" required></label>
        <label class="field" for="p-role"><span>Role</span><select id="p-role" name="role">${roleOptions('salesperson')}</select></label>
        <label class="field" for="p-password"><span>Password <em>optional</em></span><input id="p-password" name="password" type="password" autocomplete="new-password" placeholder="Blank makes one for you"></label>
      </div>
      <p class="error" id="person-error" role="alert" hidden></p>
      <div class="actions"><button type="submit" class="btn" id="btn-add-person">Add person</button></div>
    </form>
  </div>`;
  initCustomSelects(root);
}

async function updatePerson(row, patch) {
  const name = row.dataset.name;
  try {
    const { user, password } = await api('PATCH', `/api/users/${row.dataset.user}`, patch);
    if (password) revealState = { email: user.email, password };
    toast(patch.resetPassword ? `New password made for ${name}. They're signed out everywhere.`
      : patch.active === false ? `${name} is deactivated and signed out.`
      : patch.active === true ? `${name} can sign in again.`
      : `${name} is now ${user.roleLabel}.`);
    await fetchPeople();
  } catch (err) {
    if (err instanceof SignedOut) return;
    toast(err.message, 'bad');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await ensureAuth();
  if (!user) return;

  if (user.role !== 'admin') {
    alert('Access restricted to administrators.');
    window.location.href = '/orders';
    return;
  }

  renderTopNav('people');
  await fetchPeople();

  const root = $('#people-content');

  root.addEventListener('change', async (e) => {
    if (e.target.matches('[data-role]')) {
      const row = e.target.closest('tr');
      await updatePerson(row, { role: e.target.value });
    }
  });

  root.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const row = toggle.closest('tr');
      const active = toggle.dataset.toggle === 'on';
      if (!active) {
        const ok = await confirmModal({
          title: 'Deactivate user',
          message: `Are you sure you want to deactivate ${row.dataset.name}? They will be immediately signed out and unable to log in.`,
          confirmText: 'Deactivate',
          cancelText: 'Cancel',
          danger: true,
        });
        if (!ok) return;
      }
      await updatePerson(row, { active });
      return;
    }

    const reset = e.target.closest('[data-reset]');
    if (reset) {
      const row = reset.closest('tr');
      const ok = await confirmModal({
        title: 'Reset password',
        message: `Make a new password for ${row.dataset.name}? Their current password stops working immediately and they will be signed out everywhere.`,
        confirmText: 'Reset password',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      await updatePerson(row, { resetPassword: true });
      return;
    }

    if (e.target.closest('[data-copy]')) {
      const code = $('#revealed-code');
      if (code) {
        navigator.clipboard.writeText(code.textContent);
        toast('Password copied to clipboard.');
      }
      return;
    }

    if (e.target.closest('[data-dismiss]')) {
      revealState = null;
      renderPeopleView();
      return;
    }
  });

  root.addEventListener('submit', async (e) => {
    if (e.target.id === 'person-form') {
      e.preventDefault();
      const form = e.target;
      const errorEl = $('#person-error');
      errorEl.hidden = true;
      const data = new FormData(form);
      const name = data.get('name').trim();
      const email = data.get('email').trim();
      const role = data.get('role');
      const password = data.get('password') || undefined;

      const btn = $('#btn-add-person');
      setButtonLoading(btn, true, 'Adding person…');

      try {
        const { user, password: newPassword } = await api('POST', '/api/users', { name, email, role, password });
        revealState = { email: user.email, password: newPassword };
        toast(`${user.name} added.`);
        await fetchPeople();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        setButtonLoading(btn, false);
      }
    }
  });
});
