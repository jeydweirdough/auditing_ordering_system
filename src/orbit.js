'use strict';

// Everything this app needs from Orbit, asked for rather than kept.
//
// Orbit owns people, what they may do, customers, products, prices and the
// order settings. This app owned a copy of all of it once (accounts.js,
// customers.js, products.js, configStore.js); it asks here instead, so a rule
// lives in one place and a change in Settings is true here the moment it is
// saved.
//
// Every call carries the signed-in person's own token, not the app's. Orbit
// then answers with that person's divisions and teams: this app never has to
// work out who may see what, and cannot get it wrong.

const ORBIT_URL = (process.env.ORBIT_API_URL || '').replace(/\/$/, '');
const API = '/orders-api/v1';

class OrbitError extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : `Orbit answered ${status}.`);
    this.name = 'OrbitError';
    this.status = status;
    this.detail = detail;
  }
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** One call to Orbit, as the signed-in person.
 *
 *  A 401 means their session ended (in either app: signing out of one ends
 *  both), and the caller should send them back through the sign-in handoff. A
 *  403 or 404 is Orbit saying no — it is never softened into an empty answer,
 *  because "you can't see this" and "there is nothing here" are different
 *  things and only Orbit knows which. */
async function ask(token, method, path, { params, body, timeoutMs = 10_000 } = {}) {
  if (!ORBIT_URL) throw new OrbitError(500, 'ORBIT_API_URL is not set, so there is no Orbit to ask.');
  if (!token) throw new OrbitError(401, 'Not signed in.');

  const stop = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(`${ORBIT_URL}${API}${path}${query(params)}`, {
      method,
      signal: stop,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // Orbit unreachable or too slow. Said plainly, because the person reading it
    // can do nothing about it and support needs to know which app was down.
    throw new OrbitError(503, `Couldn't reach Orbit: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new OrbitError(response.status, `Orbit sent something that isn't JSON (${response.status}).`);
    }
  }
  if (!response.ok) throw new OrbitError(response.status, data?.detail ?? response.statusText);
  return data;
}

// ---------- who's asking ----------

/** The person, their company, and which order steps they take in which teams.
 *  This is what replaces accounts.js: the roles are Orbit's. */
const me = (token) => ask(token, 'GET', '/me');

// ---------- customers ----------

/** Customers this person raises orders for. One list, Orbit's, scoped to their
 *  teams — there is no second customer list anywhere any more. */
const customers = (token, { q, division, team, limit } = {}) =>
  ask(token, 'GET', '/customers', { params: { q, division, team, limit } });

const customer = (token, id) => ask(token, 'GET', `/customers/${encodeURIComponent(id)}`);

/** A customer added while raising an order. It is written into Orbit, so it
 *  appears in the CRM straight away and nobody keys it in twice. */
const addCustomer = (token, customer) => ask(token, 'POST', '/customers', { body: customer });

// ---------- products and prices ----------

/** What this division may quote with: its price types, its products, and only
 *  those prices of each — B2C never sees a Distributor's Price. */
const products = (token, { division, team } = {}) =>
  ask(token, 'GET', '/products', { params: { division, team } });

/** What an order comes to, priced by Orbit's own engine.
 *
 *  This app does not work out a total. It used to, from its own copy of the
 *  price list and the division rules, which meant the same rule written twice
 *  and a quiet difference whenever one changed. Orbit prices it; this app shows
 *  what came back. */
const price = (token, { division, team }, order) =>
  ask(token, 'POST', '/pricing/price', { params: { division, team }, body: order });

// ---------- the order form ----------

/** The company's order lists, extra fields, form sections and rules — what
 *  configStore.js used to hold. Switched-off items come too, so an old order
 *  still reads back the choice it was made with. */
const config = (token) => ask(token, 'GET', '/config');

// ---------- quotes ----------

/** A quote to raise an order from: the customer, the division and team, and
 *  every line at the price the customer already agreed. Refused (409) while
 *  Finance hasn't finished with it. */
const quote = (token, id) => ask(token, 'GET', `/quotes/${encodeURIComponent(id)}`);

module.exports = {
  OrbitError,
  ask,
  me,
  customers,
  customer,
  addCustomer,
  products,
  price,
  config,
  quote,
  get baseUrl() {
    return ORBIT_URL;
  },
};
