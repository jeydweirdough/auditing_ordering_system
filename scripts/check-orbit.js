'use strict';

// Can this app reach Orbit, and does Orbit answer as the person asking?
//
// Run it after changing ORBIT_API_URL, after deploying either app, or whenever
// something here says "Couldn't reach Orbit". It signs in as a real person and
// asks for each thing this app used to keep its own copy of, so a pass means
// accounts.js, customers.js, products.js and configStore.js have nothing left
// to do.
//
//   node --env-file-if-exists=.env scripts/check-orbit.js ana@pharmacrm.test demo1234
//
// It only reads. Nothing here creates an order or changes anything.

const orbit = require('../src/orbit');

const [email, password] = process.argv.slice(2);

async function signIn() {
  const response = await fetch(`${orbit.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Orbit refused that sign-in (${response.status}).`);
  return (await response.json()).accessToken;
}

const peso = (centavos) => `PHP ${(centavos / 100).toFixed(2)}`;

async function main() {
  if (!email || !password) {
    console.error('Give an email and password: node scripts/check-orbit.js someone@example.com theirpassword');
    process.exit(2);
  }
  if (!orbit.baseUrl) {
    console.error('ORBIT_API_URL is not set. Add it to .env (see .env.example).');
    process.exit(2);
  }
  console.log(`Asking ${orbit.baseUrl} as ${email}\n`);

  const token = await signIn();

  const me = await orbit.me(token);
  console.log(`who        ${me.user.name ?? me.user.email} at ${me.org.name}`);
  console.log(`steps      ${Object.keys(me.grants).join(', ')}`);
  console.log(`raises for ${(me.grants.raise ?? []).map((s) => `${s.division}/${s.team}`).join(', ') || '(nowhere)'}`);

  const { items } = await orbit.customers(token, { limit: 50 });
  console.log(`customers  ${items.length} they may raise orders for`);

  const division = (me.grants.raise ?? [])[0]?.division;
  if (division) {
    const book = await orbit.products(token, { division });
    console.log(`prices     ${book.products.length} products, quoted with: ${book.priceTypes.map((t) => t.code).join(', ')}`);
    const first = book.products.find((p) => Object.keys(p.prices).length > 0);
    const listed = book.priceTypes.find((t) => t.entry === 'list' && first?.prices[t.code] !== undefined);
    if (first && listed) {
      const priced = await orbit.price(token, { division }, {
        priceType: listed.code,
        lines: [{ productId: first.id, quantity: 2 }],
      });
      console.log(`pricing    2 x ${first.name} at ${listed.name} = ${peso(priced.totalCentavos)} (worked out by Orbit)`);
    }
  }

  const config = await orbit.config(token);
  const lists = config.kinds.map((k) => `${k.kind} (${(config.lists[k.kind] ?? []).length})`);
  console.log(`settings   ${lists.join(', ')}`);
  console.log(`           ${config.fields.length} extra order field(s)`);

  console.log('\nAll of it came from Orbit. Nothing was read from this app.');
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.status ? `${error.status} ` : ''}${error.message}`);
  process.exit(1);
});
