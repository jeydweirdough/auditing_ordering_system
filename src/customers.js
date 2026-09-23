const configStore = require('./configStore');

function clean(val) {
  if (val == null) return '';
  return String(val).trim();
}

function normalize(val) {
  return clean(val).toLowerCase();
}

function searchCustomers(query) {
  const list = configStore.getCustomers() || [];
  if (!query || !query.trim()) {
    return list.slice(-15).reverse();
  }
  const q = normalize(query);
  return list.filter((c) => {
    const name = normalize(c.name);
    const contact = normalize(c.contactNumber);
    const address = normalize(c.address);
    return name.includes(q) || contact.includes(q) || address.includes(q);
  });
}

function findCustomerByName(name) {
  if (!name) return null;
  const q = normalize(name);
  return (configStore.getCustomers() || []).find((c) => normalize(c.name) === q) || null;
}

function addCustomer(data) {
  const name = clean(data.name || data.customerName);
  if (!name) {
    throw new Error('Customer name is required.');
  }

  const list = [...(configStore.getCustomers() || [])];
  const existing = list.find((c) => normalize(c.name) === normalize(name));
  if (existing) {
    let updated = false;
    for (const field of ['contactNumber', 'address', 'receiverName', 'receiverContact']) {
      if (data[field] !== undefined && clean(data[field]) !== clean(existing[field])) {
        existing[field] = clean(data[field]);
        updated = true;
      }
    }
    if (data.hasSpecialPrice !== undefined && Boolean(data.hasSpecialPrice) !== Boolean(existing.hasSpecialPrice)) {
      existing.hasSpecialPrice = Boolean(data.hasSpecialPrice);
      updated = true;
    }
    if (updated) {
      existing.updatedAt = new Date().toISOString();
      configStore.setCustomers(list);
    }
    return existing;
  }

  const nextId = (list.length ? Math.max(...list.map((c) => Number(c.id) || 0)) : 0) + 1;
  const customer = {
    id: nextId,
    name,
    contactNumber: clean(data.contactNumber),
    address: clean(data.address || data.deliveryAddress),
    receiverName: clean(data.receiverName),
    receiverContact: clean(data.receiverContact),
    hasSpecialPrice: Boolean(data.hasSpecialPrice),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  list.push(customer);
  configStore.setCustomers(list);
  return customer;
}

// Every client, for the admin directory — searchCustomers() caps at 15 for the order form's
// autocomplete, which is the wrong shape for a full listing.
function listAll() {
  return [...(configStore.getCustomers() || [])].sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
}

// Mocks the correction a real Zoho contact sync would apply on its own (see the sandbox's
// README, "What maps onto the real backend"): here it's a plain edit against the local list.
function updateCustomer(id, patch = {}) {
  const list = [...(configStore.getCustomers() || [])];
  const idx = list.findIndex((c) => Number(c.id) === Number(id));
  if (idx === -1) throw new Error('No such client.');
  const current = list[idx];
  const name = patch.name !== undefined ? clean(patch.name) : current.name;
  if (!name) throw new Error('Customer name is required.');

  const updated = { ...current, name };
  for (const field of ['contactNumber', 'address', 'receiverName', 'receiverContact']) {
    if (patch[field] !== undefined) updated[field] = clean(patch[field]);
  }
  if (patch.hasSpecialPrice !== undefined) updated.hasSpecialPrice = Boolean(patch.hasSpecialPrice);
  updated.updatedAt = new Date().toISOString();

  list[idx] = updated;
  configStore.setCustomers(list);
  return updated;
}

function seedFromOrders(ordersList = []) {
  if (!Array.isArray(ordersList) || ordersList.length === 0) return;
  for (const o of ordersList) {
    if (o.customerName && clean(o.customerName)) {
      addCustomer({
        name: o.customerName,
        contactNumber: o.contactNumber,
        address: o.address,
        receiverName: o.receiverName,
        receiverContact: o.receiverContact,
        hasSpecialPrice: Boolean(o.customerHasSpecialPrice || o.hasSpecialPrice),
      });
    }
  }
}

module.exports = {
  searchCustomers,
  findCustomerByName,
  findCustomer: findCustomerByName,
  addCustomer,
  updateCustomer,
  listAll,
  seedFromOrders,
};
