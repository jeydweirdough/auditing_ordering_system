// Measures Discord's real limits with a webhook in a test channel, so you can see them for
// yourself and check this project's settings against them. Everything it posts is deleted again.
//
//   npm run probe:discord                   text, embed, file-count and reading limits
//   npm run probe:discord -- --uploads      also the upload size limit (sends about 21 MB)
//   npm run probe:discord -- --threads      also the thread name limit (needs the bot)
//   npm run probe:discord -- --burst        also posts until Discord's first 429
//
// Needs DISCORD_PROBE_WEBHOOK_URL in .env: a webhook in a channel made for testing, not the
// records channel. DISCORD_BOT_TOKEN, if set, adds the checks that need reading.
// Refused requests (400, 413) don't count toward Discord's ban on invalid requests; --burst
// causes exactly one 429, which does.
const { describeDiscordError } = require('../src/discordQueue');

const args = new Set(process.argv.slice(2));
const want = { uploads: args.has('--uploads'), threads: args.has('--threads'), burst: args.has('--burst') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (status) => status >= 200 && status < 300;
const x = (n) => 'x'.repeat(n);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const hookUrl = process.env.DISCORD_PROBE_WEBHOOK_URL;
const botToken = process.env.DISCORD_BOT_TOKEN || null;

if (!hookUrl) {
  console.log(`DISCORD_PROBE_WEBHOOK_URL isn't set.

The probe posts test messages and deletes them again, so it needs its own webhook:
  1. In Discord, create a channel for testing, for example #limits-test.
  2. Channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL.
  3. Add it to .env as DISCORD_PROBE_WEBHOOK_URL=<the URL>
  4. Run npm run probe:discord again.`);
  process.exit(1);
}
if (hookUrl === process.env.DISCORD_WEBHOOK_URL && !args.has('--records-channel')) {
  console.log('DISCORD_PROBE_WEBHOOK_URL is the records webhook. Use a webhook in a test channel, or add --records-channel to probe it anyway (the messages are deleted afterwards).');
  process.exit(1);
}
const parsed = new URL(hookUrl);
const match = parsed.pathname.match(/\/webhooks\/(\d+)\/([^/]+)/);
if (!match) {
  console.log("DISCORD_PROBE_WEBHOOK_URL doesn't look like a Discord webhook URL.");
  process.exit(1);
}
const hook = `${parsed.origin}/api/webhooks/${match[1]}/${match[2]}`;
const api = `${parsed.origin}/api/v10`;

let resumeAt = 0;   // Discord said: nothing before this
let limited = 0;    // 429s received
const posted = [];  // message ids to delete at the end
const threadsLeft = [];
const results = [];

// One request, paced by Discord's rate-limit headers. The burst turns pacing off.
async function call(method, url, { json, files = [], bot = false, pace = true, attempt = 1 } = {}) {
  if (pace && resumeAt > Date.now()) await sleep(resumeAt - Date.now());
  const headers = {};
  let body;
  if (files.length) {
    body = new FormData();
    body.append('payload_json', JSON.stringify(json ?? {}));
    files.forEach((f, i) => body.append(`files[${i}]`, new Blob([f.data]), f.name));
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (bot) headers.Authorization = `Bot ${botToken}`;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  const header = (name) => res.headers.get(name);
  if (header('x-ratelimit-remaining') === '0') resumeAt = Date.now() + (Number(header('x-ratelimit-reset-after')) || 1) * 1000;
  if (res.status === 429) {
    limited += 1;
    resumeAt = Date.now() + (Number(header('retry-after')) || data?.retry_after || 1) * 1000;
    if (pace && attempt < 3) return call(method, url, { json, files, bot, pace, attempt: attempt + 1 });
  }
  return { status: res.status, data, header };
}

async function execute(json, files = [], options = {}) {
  const res = await call('POST', `${hook}?wait=true`, { json, files, ...options });
  if (ok(res.status) && res.data?.id) posted.push(res.data.id);
  return res;
}

const why = (res) => `${res.status}${res.data ? `: ${describeDiscordError(res.data) ?? 'no details'}` : ''}`;
const note = (name, documented, observed, pass) => results.push({ name, documented, observed, pass });

// Sends one request at a documented limit and one just past it.
async function edge(name, documented, atLimit, overLimit) {
  const at = await atLimit();
  const over = await overLimit();
  const refused = over.status === 400 || over.status === 413;
  const observed = `at the limit ${ok(at.status) ? 'accepted' : `refused (${why(at)})`}; one over ${refused ? `refused (${why(over)})` : `accepted (${over.status})`}`;
  note(name, documented, observed, ok(at.status) && refused);
  return { at, over };
}

async function probe() {
  const webhook = await call('GET', hook);
  if (!ok(webhook.status)) throw new Error(`Discord refused the probe webhook (${why(webhook)}). Check DISCORD_PROBE_WEBHOOK_URL`);
  const channelId = webhook.data.channel_id;
  console.log(`Probing with webhook "${webhook.data.name}" in channel ${channelId}. Everything posted is deleted at the end.\n`);

  const first = await execute({ content: 'record_database limits probe. Everything posted here is deleted at the end.' });
  if (!ok(first.status)) throw new Error(`Discord refused the first message (${why(first)})`);
  const bucket = first.header('x-ratelimit-limit');
  note('Webhook bucket', 'not documented; about 5 per 2 s',
    bucket ? `${bucket} requests per window; this one resets in ${Number(first.header('x-ratelimit-reset-after')).toFixed(1)} s` : 'no rate-limit headers', null);

  await edge('Message text', '2000 characters', () => execute({ content: x(2000) }), () => execute({ content: x(2001) }));
  await edge('Embed title', '256 characters', () => execute({ embeds: [{ title: x(256) }] }), () => execute({ embeds: [{ title: x(257) }] }));
  await edge('Embed field value', '1024 characters',
    () => execute({ embeds: [{ fields: [{ name: 'v', value: x(1024) }] }] }),
    () => execute({ embeds: [{ fields: [{ name: 'v', value: x(1025) }] }] }));
  await edge('Embed footer', '2048 characters',
    () => execute({ embeds: [{ title: 'footer', footer: { text: x(2048) } }] }),
    () => execute({ embeds: [{ title: 'footer', footer: { text: x(2049) } }] }));
  await edge('Embed total', '6000 characters per embed',
    () => execute({ embeds: [{ title: x(256), description: x(4096), footer: { text: x(1648) } }] }),
    () => execute({ embeds: [{ title: x(256), description: x(4096), footer: { text: x(1649) } }] }));
  const tiny = (n) => Array.from({ length: n }, (_, i) => ({ name: `probe-${i + 1}.txt`, data: Buffer.from(`probe file ${i + 1}`) }));
  await edge('Files per message', '10 files', () => execute({ content: '10 files' }, tiny(10)), () => execute({ content: '11 files' }, tiny(11)));

  if (botToken) {
    const read = (n) => call('GET', `${api}/channels/${channelId}/messages?limit=${n}`, { bot: true });
    await edge('Messages per read', '100 per request', () => read(100), () => read(101));
  } else {
    note('Messages per read', '100 per request', 'skipped: needs DISCORD_BOT_TOKEN', undefined);
  }

  if (want.uploads) {
    const ours = (Number(process.env.DISCORD_MAX_UPLOAD_MB) || 10) * 1_000_000;
    const at = await execute({ content: `upload of ${mb(ours)}` }, [{ name: 'probe-upload.bin', data: Buffer.alloc(ours) }]);
    const over = await execute({ content: 'upload of 10 MiB + 1 byte' }, [{ name: 'probe-upload.bin', data: Buffer.alloc(10 * 1024 * 1024 + 1) }]);
    const overText = over.status === 413 ? 'refused (413)'
      : ok(over.status) ? 'accepted: this server takes bigger uploads (boosts?)'
      : `refused (${why(over)})`;
    note('Upload size', '10 MB per message without server boosts',
      `${mb(ours)}, our DISCORD_MAX_UPLOAD_MB, ${ok(at.status) ? 'accepted' : `refused (${why(at)})`}; 10 MiB + 1 byte ${overText}`,
      ok(at.status) && over.status === 413);
  } else {
    note('Upload size', '10 MB per message without server boosts', 'skipped: add --uploads (sends about 21 MB)', undefined);
  }

  if (want.threads && botToken) {
    const a = await execute({ content: 'thread name at the limit' });
    const b = await execute({ content: 'thread name one over' });
    const startThread = (message, n) => call('POST', `${api}/channels/${channelId}/messages/${message.data.id}/threads`, {
      bot: true, json: { name: x(n), auto_archive_duration: 60 },
    });
    const { at } = await edge('Thread name', '100 characters', () => startThread(a, 100), () => startThread(b, 101));
    if (ok(at.status)) threadsLeft.push(at.data.id);
  } else {
    note('Thread name', '100 characters', want.threads ? 'skipped: needs DISCORD_BOT_TOKEN' : 'skipped: add --threads (leaves one thread behind)', undefined);
  }

  if (want.burst) {
    await sleep(Math.max(2500, resumeAt - Date.now()));   // start from a full bucket
    let accepted = 0;
    let hit = null;
    for (let i = 1; i <= 60 && !hit; i++) {
      const r = await execute({ content: `burst ${i}` }, [], { pace: false });
      if (r.status === 429) hit = r;
      else if (ok(r.status)) accepted += 1;
    }
    const wait = hit && Number(hit.data?.retry_after ?? hit.header('retry-after'));
    note('Burst before a 429', 'not documented',
      hit ? `${accepted} accepted before the first 429; Discord asked to wait ${wait.toFixed(1)} s (scope: ${hit.header('x-ratelimit-scope') ?? 'not given'})` : `no 429 after ${accepted} messages`, null);
  } else {
    note('Burst before a 429', 'not documented', 'skipped: add --burst (causes one 429)', undefined);
  }
}

async function cleanup() {
  let deleted = 0;
  for (const id of posted) {
    const r = await call('DELETE', `${hook}/messages/${id}`);
    if (r.status === 204 || r.status === 200) deleted += 1;
  }
  return deleted;
}

function report(deleted) {
  const width = Math.max(...results.map((r) => r.name.length));
  const mark = (pass) => (pass === true ? '[ok]     ' : pass === false ? '[differs]' : pass === null ? '[info]   ' : '[skipped]');
  console.log('What Discord allowed:\n');
  for (const r of results) {
    console.log(`  ${mark(r.pass)} ${r.name.padEnd(width)}  documented: ${r.documented}`);
    console.log(`  ${' '.repeat(9)} ${' '.repeat(width)}  observed:   ${r.observed}`);
  }
  const passed = (name) => results.find((r) => r.name === name)?.pass;
  const perMinute = Number(process.env.DISCORD_MAX_PER_MINUTE) || 30;
  const upload = results.find((r) => r.name === 'Upload size');
  console.log(`
How this project's settings compare:
  Thread updates     at most 1800 characters plus a status line, inside the 2000-character message limit${passed('Message text') ? '' : ' (not confirmed above)'}
  Stored record      checked against the 2048-character footer before sending${passed('Embed footer') ? '' : ' (not confirmed above)'}
  Files              at most 10 per post${passed('Files per message') ? '' : ' (not confirmed above)'}
  Uploads            DISCORD_MAX_UPLOAD_MB=${Number(process.env.DISCORD_MAX_UPLOAD_MB) || 10}${upload.pass === true ? ', accepted by this server' : upload.pass === false ? ', check the upload line above' : ', run with --uploads to check'}
  Pacing             follows the bucket headers; DISCORD_MAX_PER_MINUTE=${perMinute} for the per-channel cap Discord doesn't report

${deleted} of ${posted.length} probe messages deleted.${threadsLeft.length ? ` ${threadsLeft.length} thread left in the test channel; it archives itself after an hour.` : ''}
429s received: ${limited}.`);
}

(async () => {
  let failure = null;
  try {
    await probe();
  } catch (err) {
    failure = err;
  }
  const deleted = await cleanup().catch(() => 0);
  if (results.length) report(deleted);
  if (failure) {
    console.error(`\nProbe stopped: ${failure.message}`);
    process.exit(1);
  }
})();
