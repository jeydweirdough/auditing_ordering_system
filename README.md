# record_database — Discord sync practice

A deliberately small API that does one thing end to end: accept a record, store it, and announce it in a Discord channel. Once this works you have proven every moving part you need for the real Getmeds integration.

The folder structure is the same shape as `getmeds-backend/`, so what you learn here transfers directly.

---

## Direction of travel — read this first

Your webhook URL is something **you call**. Discord will never call your API through it. So:

| You want | Webhook enough? | What you need |
|---|---|---|
| API posts a record into `#input-form` | Yes | What this project does |
| Discord posts into your API | **No** | Slash commands + interactions endpoint |
| Bot DMs a specific person | **No** | A bot token, not a webhook |

Phase 5 below covers the return direction. Do not start there.

---

## Setup

```bash
cd record_database
npm install
cp .env.example .env
npm run dev
```

The server listens on port 4000. Nothing is sent to Discord yet, because `.env` starts with `DISCORD_MODE=mock` and `DISCORD_ENABLED=false`.

Open http://localhost:4000 for a test page. It sends records, runs the exercises below, and shows each record next to the Discord message it produced — which fields were saved, which were withheld, and whether delivery succeeded. The `curl.exe` commands below still work too.

---

## Phase 1 — prove the URL works, no code

Before writing anything, confirm the webhook is alive. In PowerShell, `curl` is aliased to `Invoke-WebRequest`, so use `curl.exe` explicitly:

```bash
curl.exe -X POST "YOUR_WEBHOOK_URL" -H "Content-Type: application/json" -d "{\"content\":\"hello from the terminal\"}"
```

You should see the message appear in `#input-form` instantly, and get back an empty `204 No Content`.

**If it fails:** `401` means the token is wrong or the webhook was deleted. `404` means the id is wrong. Both usually mean you copied only part of the URL.

---

## Phase 2 — the API, still offline

```bash
curl.exe -X POST localhost:4000/api/records -H "Content-Type: application/json" ^
  -d "{\"division\":\"HOS | MARIKINA\",\"itemCount\":3,\"customerName\":\"Juan Dela Cruz\"}"
```

Expected response:

```json
{ "recordId": "RD-20260912-0001", "status": "received" }
```

The console prints `[discord] disabled, would have sent: RD-20260912-0001 — received`. Nothing left your machine.

**Why this phase exists.** Running with the sender switched off but the code path live is how you find bugs in production without spamming a channel. Deploy like this first, read the logs, then flip the switch.

Try a bad request too:

```bash
curl.exe -X POST localhost:4000/api/records -H "Content-Type: application/json" -d "{\"division\":\"HOS\"}"
```

You get `400` and `itemCount must be a positive integer`. Validate before you notify — a malformed record should never produce a Discord message.

---

## Phase 3 — mock mode

Set `DISCORD_ENABLED=true`, leave `DISCORD_MODE=mock`, restart, post again.

Now the console prints `[discord:mock] "RD-... — received"`. The adapter recorded the payload in `adapter.sent` but made no network call. This is the mode your future Jest tests run in.

---

## Phase 4 — go live

Put your webhook URL in `.env`, set `DISCORD_MODE=live`, restart, post again. The embed appears in `#input-form`.

Look closely at what arrived. You sent `customerName: "Juan Dela Cruz"`. It is stored in the record, and it is **not** in the Discord message — `src/redact.js` stripped it. That is the whole point of an allowlist: fields have to be named to get out.

### Exercise 4a — confirm the filter holds

Post a record with an invented field:

```bash
curl.exe -X POST localhost:4000/api/records -H "Content-Type: application/json" ^
  -d "{\"division\":\"HOS\",\"itemCount\":1,\"glNumber\":\"GL-00123\"}"
```

`glNumber` reaches the database and not Discord, even though nobody wrote a rule about `glNumber`. Compare this to a denylist, where you would have had to predict the field name in advance.

### Exercise 4b — watch the queue hold the line

Click **Send 40 at once** on the test page, or run:

```bash
for /L %i in (1,1,40) do curl.exe -s -X POST localhost:4000/api/records -H "Content-Type: application/json" -d "{\"division\":\"HOS\",\"itemCount\":1}"
```

All 40 records are saved at once. Their Discord messages go into the send queue in `src/discordQueue.js`, which posts them one at a time within Discord's limits:

- **About 5 requests per 2 seconds.** Discord reports this bucket in the `X-RateLimit-Remaining` and `X-RateLimit-Reset-After` headers of every response. The queue reads them and waits for the reset.
- **About 30 messages per minute per channel.** The headers don't warn about this one, so the queue counts its own sends (`DISCORD_MAX_PER_MINUTE` in `.env`).

Expect the first 30 within about 12 seconds, a pause until the minute is up, then the last 10. The page's **Send queue** panel shows the pause and the reason for it, and **429s from Discord** should stay at 0.

That last number matters more than it looks. Discord bans your IP at Cloudflare after 10,000 invalid requests (401, 403 or 429) in 10 minutes, so retrying through 429s is not a plan. Pace so you never get one.

### Exercise 4c — break it on purpose

Change one character in the webhook URL in `.env`, restart, post a record. The API still returns `201` and the record is still stored — only a warning appears in the console. **This is the behaviour you want.** A Discord outage must never fail an order. Check `src/server.js`: the response is sent *before* `notify()` is called, and the promise has its own `.catch`.

The queue also stops at the first `401` or `404`. Every later message would be refused the same way, and each refusal counts toward that ban.

---

## Phase 5 — the return direction (optional, much harder)

To make Discord reach your API you need a registered application, not a webhook:

1. Create an application in the Developer Portal, note the **public key**.
2. Add `POST /interactions` to this API.
3. Verify the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers against the public key using `tweetnacl`. Reject anything that fails — unverified endpoints get hammered.
4. Reply `{ "type": 1 }` to Discord's `PING` or it will refuse to save your URL.
5. Register a command with `PUT /applications/{app_id}/guilds/{guild_id}/commands`.
6. Answer within **3 seconds**, or reply `{ "type": 5 }` to defer and PATCH the real answer later.
7. Expose your local server with a tunnel (`cloudflared tunnel --url http://localhost:4000`) so Discord can reach it while you develop.

Do not attempt this until phases 1 to 4 are boring.

---

## Phase 6 — Discord as the database

Discord can hold the records themselves, so the list survives a restart without Postgres. Each record is stored in its own message:

- **The embed** is for people: record id, division, item count, status and time. Only allowlisted fields, as before.
- **The footer** is for the server: the whole record as one line starting `rd1`. Fields that aren't on the allowlist (`customerName`, `notes`) are encrypted with `RECORD_SECRET` first, so channel members see ciphertext. Without `RECORD_SECRET` those fields are left out rather than stored in the clear.

On startup the server reads the channel, picks out every message its webhook posted, and rebuilds the list from the footers. New record ids continue after the highest one found. Messages posted before this format are skipped.

### Setup

A webhook can post but can't read, so reading needs a bot:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On the **Bot** page, click **Reset Token** and copy the token into `.env` as `DISCORD_BOT_TOKEN`.
3. On the same page, turn on **Message Content Intent** and save. Without it, Discord returns the messages with their embeds blanked out.
4. On **OAuth2 → URL Generator**, tick the `bot` scope and the **View Channels**, **Read Message History** and **Create Public Threads** permissions. Open the generated URL and add the bot to your server. If `#input-form` is private, give the bot access to it.
5. Add `RECORD_SECRET` to `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Keep a copy somewhere safe. Lose it and every customer name in the channel is unreadable for good.
6. Restart. The console prints `[store] loaded N record(s) from Discord`.

### Threads and attachments

Every record gets a thread, started on its channel message and named after its record id. The thread holds a copy of the record, its files, and every update after that, so everything about one record stays together. Whatever people type or attach in the thread in Discord shows up too.

Send files with a new record as `multipart/form-data` instead of JSON, with each file in a `files` field:

```bash
curl.exe -X POST localhost:4000/api/records -F division=HOS -F itemCount=1 -F files=@receipt.pdf -F files=@photo.jpg
```

Add to a record's thread later, with a message, a new status, files, or any mix:

```bash
curl.exe -X POST localhost:4000/api/records/RD-20260913-0001/thread -F message="Picked up by the rider" -F status=dispatched -F files=@proof.jpg
```

A new status also updates the record and its channel message. `GET /api/records/:id/thread` lists the thread; `GET /api/records/:id/files/:n` opens file `n` (`0` is the first), counting across the whole thread.

- Threads and files are **not** encrypted: anyone who can read the channel can read and open them. Only `customerName` and `notes` on the record itself are encrypted.
- Up to 10 files and 10 MB per post (`DISCORD_MAX_UPLOAD_MB`; boosted servers allow more). File names are simplified to letters, digits, `-` and `_`, because Discord matches them exactly.
- The first PNG, JPG, GIF or WEBP image shows inside the copy's embed; everything else, SVG and HEIC included, appears as a normal attachment.
- Threads need the bot, with **Create Public Threads** on top of the read permissions. Without `DISCORD_BOT_TOKEN`, files ride on the record's channel message and there is no thread.
- Threads are read when a record is opened, not at startup, so startup stays one pass over the channel.

### What you give up

- **Writes aren't instant.** The API answers `202 Accepted`: the record is stored once Discord confirms, which can take a minute during a burst. If the server stops before that, the record is lost. `GET /api/records/:id` tells you when `inDiscord` is `true`.
- **Anyone who can manage messages can delete records.** A deleted message is a deleted record.
- **Every startup reads the whole channel**, 100 messages per request. Fine for hundreds of records, slow for tens of thousands.
- **There are no queries.** Filtering happens in memory after everything is loaded.
- **One key protects every customer name.** Treat `RECORD_SECRET` like a database password.

---

## Measuring Discord's limits

To see the real limits on our Discord server:

```bash
npm run probe:discord
npm run probe:discord -- --uploads --threads --burst
```

This measures them live through `DISCORD_PROBE_WEBHOOK_URL`, a webhook in a channel made for testing; it refuses to use the records webhook. It sends one request at each limit and one just past it, prints what Discord accepted and refused next to the documented numbers, compares them with this project's settings, then deletes everything it posted.

- `--uploads` checks the upload size limit and sends about 21 MB.
- `--threads` checks thread names and leaves one thread, which archives itself after an hour.
- `--burst` posts until the first 429. That one 429 is the only request here that counts toward Discord's ban on invalid requests; refused requests (400, 413) don't.

---

## The orders app

`http://localhost:4000/app`: a sign-in, a dashboard per role, and an audit trail per order in `#order-audit`.

```bash
npm run accounts      # once: admin, salesperson, management, finance, dispatch (.test@getmeds.ph) and SESSION_SECRET
```

| Role | Steps |
|---|---|
| Salesperson | raise an order, resubmit one sent back, cancel |
| Management | approve, send back (reason), reject (reason), cancel |
| Finance | verify payment (method, reference, amount, date), hold (reason) |
| Dispatch | start picking, mark packed, dispatch (courier, tracking), deliver (received by) |
| Admin | create for any salesperson, edit anything, delete and restore any order, any step; People: add, change role, deactivate, reset password |

The steps are one table, `ACTIONS` in `src/orders.js`: who may take each, from which statuses, what it moves the order to, and which fields it asks for. The server checks every step against it, and the page draws its forms from it.

- **Accounts** live in `data/users.json`, passwords hashed with scrypt (`src/passwords.js`). A sign-in is an HMAC-signed cookie (`SESSION_SECRET`) that lasts 8 hours. Deactivating someone or resetting their password signs them out at once.
- **Or in `ACCOUNTS`**, for hosts without a disk such as Vercel, until there's a database: one account per line, `id | email | password | role | name`, the password in plain text or as a `scrypt$...` hash (`.env.example` has the details). With it set, `data/users.json` isn't read and the People screen is read-only: add, change or remove someone by editing `ACCOUNTS` and restarting, or redeploying on Vercel. Changing someone's password there signs them out everywhere. Never change or reuse an id: orders point at their salesperson by id.
- **Orders** live in `#order-audit` (`src/orderAudit.js`), not on disk. Each order has a starter message titled with its id and a thread on it. Every step is two posts in the thread: an embed for people (step, status change, `Name · Role`, time), and a reply from the bot holding the order's data as JSON (`src/orderCodec.js`): `{ "format": "order/1", "order", "step", "x" }`, the whole order after that step plus the step. On startup the server reads the channel and every thread and rebuilds each order from its newest reply. Customer name, contact number, address, notes, reasons, payment reference and received-by are in `x`, encrypted with `RECORD_SECRET` (AES-256-GCM, bound to the order id and step). Data too long for one message goes as a `.json` file.
- **Posting** happens after the step is taken. The step post goes through the webhook's queue; the reply goes through the bot (`sendAsBot`, which needs Send Messages in Threads), or as the webhook's next message if the bot may not. A failed post is kept on its step and sent again, in order, and the API answers 202 until a step is stored. It follows `DISCORD_MODE` and `DISCORD_ENABLED` like the records; without `DISCORD_BOT_TOKEN`, orders are in memory only.
- **Old orders** from `data/orders.json` are copied into their threads on the first start, then the file is renamed `orders.imported.json`.
- **Admin's changes** are steps too: `edit`, `delete_order` and `restore` in `ACTIONS`, also reachable as `PATCH` and `DELETE /api/orders/:id`, each with a required reason. An edit's step names the changed fields and keeps their old values in `x`. Deleting is soft (`status: "deleted"`): hidden from everyone but Admin, and restorable. Every Admin change, account changes included, also gets a line in the "Admin log" thread in `#order-audit`: what changed and who, never values, reasons or passwords.
- **Changes are JSON only**, so another site's form can't post one with someone's cookie.

The step posts are the same shape as `getmeds-backend`'s `discordAuditService`. The data replies are what this practice project adds, so Discord is the database for orders the way it is for records.

---

## What maps onto the real backend

| Here | In `getmeds-backend/` |
|---|---|
| `src/discord.js` | `src/integrations/discord/` — same mock/live switch as `integrations/zoho/index.js` |
| `src/redact.js` | `src/integrations/discord/redact.js` |
| `src/discordQueue.js` | Next to them in `src/integrations/discord/` |
| `notify()` after the response | One line after the bell notification in `src/services/` |
| `DISCORD_MODE`, `DISCORD_ENABLED` | Alongside `ZOHO_MODE`, `ZOHO_DRY_RUN` |
| In-memory `records` array | Supabase Postgres |

---

## Three rules worth carrying over

1. **Respond first, notify second.** The caller should never wait on Discord, and Discord should never be able to fail the request.
2. **Allowlist what leaves.** Not a denylist. New fields default to staying in.
3. **Two switches, not one.** `DISCORD_MODE` decides mock or real; `DISCORD_ENABLED` lets you stop sending without a deploy. You will want the second one at some point.
