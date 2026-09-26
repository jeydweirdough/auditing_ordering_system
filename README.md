# Getmeds orders app

A sign-in with a dashboard per role (Salesperson, Team Leader, Management, Finance, Dispatch, Admin). Orders are kept in the shared Getmeds database (Supabase Postgres, the same tables getmeds-system uses) and reach Zoho through getmeds-system's own integration: approving an order creates its Sales Order, verifying payment confirms it.

> The sections below "Run it locally" still describe the Discord-storage version and are being rewritten.

---

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:4000 (or the `PORT` in `.env`) and sign in with one of the sample accounts below.

With no `DATABASE_URL` in `.env`, `npm run dev` starts its own Postgres on this machine (kept in `data/pgdata`), sets it up the first time, and adds the sample accounts, a few customers and the price list. It never touches the shared Supabase database; to use one, set `DATABASE_URL` yourself (never the live one for testing).

With a local database, Zoho is always in **mock** mode, even if `.env` says `ZOHO_MODE=live`, so a test approval can't create a real Sales Order. Uploaded files go to `data/storage` instead of Supabase.

The local database needs about 1 GB of free memory to start. If `npm run dev` stops with "out of memory", close some programs and run it again.

Needs Node 24 (`engines` in `package.json`).

### Sample accounts

For local testing only: they exist in the local database, never in the live one. Every one has the same password:

**Password: `orders-dev-1`**

| Role | Email | Name | Notes |
|---|---|---|---|
| Salesperson | `sales@dev.local` | Sam Sales | Division B2C. Leo Leader is their Team Leader, so their orders go to him first |
| Salesperson | `sales2@dev.local` | Sol Sales | Division HOS. No Team Leader, so any Team Leader may endorse their orders |
| Team Leader | `leader@dev.local` | Leo Leader | Endorses, sends back or rejects salespeople's orders before Management |
| Management | `manager@dev.local` | Mara Manager | Approves (creates the Zoho Sales Order), sends back, rejects |
| Finance | `finance@dev.local` | Fe Finance | Verifies payment (confirms the Sales Order), puts orders on hold |
| Dispatch | `dispatch@dev.local` | Dino Dispatch | Checks prescriptions, picks, packs, dispatches, delivers; stock notices and holds |
| Admin | `admin@dev.local` | Ada Admin | Edits, deletes and restores any order; the Zoho sync page |

Sample customers already in (mock) Zoho: **Juan Dela Cruz**, **St. Luke Pharmacy** and **Maria Santos**.

To try the whole journey: sign in as `sales@dev.local` and raise an order for Juan Dela Cruz, then as `leader@dev.local` (endorse), `manager@dev.local` (approve), `finance@dev.local` (verify payment) and `dispatch@dev.local` (start picking → packed → dispatch → delivered).

To start over with a fresh local database, stop the server and delete the `data/pgdata` folder. To use a different password for the sample accounts, set `DEV_PASSWORD` in `.env` before the first run.

---

## Roles

| Role | Steps |
|---|---|
| Salesperson | raise an order for themselves or another salesperson, resubmit one sent back, cancel |
| Management | raise an order for themselves or a salesperson, resubmit their own when sent back, approve, send back (reason), reject (reason), cancel |
| Finance | verify payment (method, reference, amount, date), hold (reason) |
| Dispatch | start picking, mark packed, dispatch (courier, tracking), deliver (received by) |
| Admin | create for any salesperson, edit anything, delete and restore any order, any step; People: add, change role, deactivate, reset password |

The steps are one table, `ACTIONS` in `src/orders.js`: who may take each, from which statuses, what it moves the order to, and which fields it asks for. The server checks every step against it, and the page draws its forms from it.

---

## How it works

- **Accounts** live in `data/users.json`, passwords hashed with scrypt (`src/passwords.js`). A sign-in is an HMAC-signed cookie (`SESSION_SECRET`) that lasts 8 hours. Deactivating someone or resetting their password signs them out at once.
- **Or in `ACCOUNTS`**, for hosts without a disk such as Vercel, until there's a database: one account per line, `id | email | password | role | name`, the password in plain text or as a `scrypt$...` hash (`.env.example` has the details). With it set, `data/users.json` isn't read and the People screen is read-only: add, change or remove someone by editing `ACCOUNTS` and restarting, or redeploying on Vercel. Changing someone's password there signs them out everywhere. Never change or reuse an id: orders point at their salesperson by id.
- **Orders** live in `#order-audit` (`src/orderAudit.js`), not on disk. Each order has an id in the Getmeds format, `GM-YYYYMMDD-NNNN` (numbered from 0001 each day like `getmeds-backend`'s, but dated in Manila; orders from before keep their `ORD-` ids), a starter message titled with it, and a thread on it. Every step is two posts in the thread: an embed for people (step, status change, `Name · Role`, time), and a reply from the bot holding the order's data as JSON (`src/orderCodec.js`): `{ "format": "order/1", "order", "step", "x" }`, the whole order after that step plus the step. On startup the server reads the channel and every thread and rebuilds each order from its newest reply. Customer name, contact number, address, receiver, doctor, customer remarks, notes, reasons, payment reference, received-by and the list of attached files are in `x`, encrypted with `RECORD_SECRET` (AES-256-GCM, bound to the order id and step). Data too long for one message goes as a `.json` file.
- **The order form** asks for what the Getmeds order form (`getmeds-frontend`, `OrderForm.jsx`) asks for: Division is a fixed list and Sub-division is typed with each Division's branches as suggestions (both from `getmeds-system`'s `divisions.js`), Head quarter is typed, Source and Invoicing from are fixed lists, Payment terms and Delivery method are typed with Zoho's usual answers offered as suggestions, plus the receiver, whether the customer is the doctor, the doctor's name and customer remarks. The lists are at the top of `src/orders.js`.
- **Attachments** go with a new order: photos, PDF, Word or Excel, up to 10 files and 3 MB in all, each tagged Proof of payment, Purchase order or Other. Vercel takes at most 4.5 MB per request and the files travel base64-encoded in the JSON, so the page redraws photos over 1 MB smaller before sending. They're posted with the order's first data message in its thread, encrypted with `RECORD_SECRET` under a neutral name (`GM-…-file-1.bin`), and the app decrypts them when someone who may see the order opens one (`GET /api/orders/:id/files/:n`). Without `RECORD_SECRET` they're posted as they are.
- **Posting** happens after the step is taken. The step post goes through the webhook's queue (`src/discordQueue.js`), which keeps within Discord's rate limits; the reply goes through the bot (`sendAsBot`, which needs Send Messages in Threads), or as the webhook's next message if the bot may not. A failed post is kept on its step and sent again, in order, and the API answers 202 until a step is stored. Without `DISCORD_BOT_TOKEN`, orders are in memory only.
- **Old orders** from `data/orders.json` are copied into their threads on the first start, then the file is renamed `orders.imported.json`.
- **Admin's changes** are steps too: `edit`, `delete_order` and `restore` in `ACTIONS`, also reachable as `PATCH` and `DELETE /api/orders/:id`, each with a required reason. An edit's step names the changed fields and keeps their old values in `x`. Deleting is soft (`status: "deleted"`): hidden from everyone but Admin, and restorable. Every Admin change, account changes included, also gets a line in the "Admin log" thread in `#order-audit`: what changed and who, never values, reasons or passwords.
- **Changes are JSON only**, so another site's form can't post one with someone's cookie.

---

## Dashboards

Salesperson, Management, Finance and Admin open on a **Dashboard**: one main panel for what the role is there to watch, then four cards of the same size. A switch above them picks the period (this month, last month, the last 90 days, all time), and each figure is compared with the same stretch before it. Cards tagged **Now** are as things stand, whatever the period. The server works the figures out (`GET /api/orders/dashboard?period=month|last_month|90d|all`), so a salesperson's dashboard only ever counts their own orders.

| Role | Main panel | Cards |
|---|---|---|
| Salesperson | Their sales, by day, week or month | Orders raised, approval rate, delivered, sent back to them |
| Management | Their team, the salespeople whose orders they decided on, and what they approved | Waiting for them, approval rate, time to decide, team delivered |
| Finance | Awaiting payment, banded by days since approval: 0–3, 4–7, 8–14 and 15+ | Large orders (from `FINANCE_LARGE_ORDER_PHP`, ₱100,000 by default), amount mismatches, on hold, payments verified |
| Admin | Overall sales, with every salesperson's and manager's figures | Orders raised, delivered, people by role, Discord storage |

Charts use one blue for the series; Finance's bands use the status colours, each named beside it, never colour alone. Every chart has a table view, and every bar a tooltip on hover or keyboard focus.

---

## Connecting Discord

1. In `#order-audit`, open **Edit Channel → Integrations → Webhooks → New Webhook**, and copy its URL into `DISCORD_AUDIT_WEBHOOK_URL`.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**. On its **Bot** page, click **Reset Token** and copy the token into `DISCORD_BOT_TOKEN`. On the same page, turn on **Message Content Intent** and save; without it Discord returns the messages blank.
3. On **OAuth2 → URL Generator**, tick the `bot` scope and **View Channels**, **Read Message History**, **Create Public Threads** and **Send Messages in Threads**. Open the generated URL and add the bot to the server. If `#order-audit` is private, give the bot access to it.
4. Add `RECORD_SECRET` to `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Keep a copy somewhere safe. Lose it and the customer details in the channel are unreadable for good.
5. Set `DISCORD_MODE=live` and `DISCORD_ENABLED=true`, and restart. The console prints `[orders] loaded N order(s) from #order-audit`.

What Discord as the database costs:

- **Anyone who can manage messages in the channel can delete orders.**
- **Every startup reads the whole channel and every thread**, 100 messages per request. Fine for hundreds of orders, slow for tens of thousands.
- **There are no queries.** Filtering happens in memory after everything is loaded.
- **One key protects every customer's details.** Treat `RECORD_SECRET` like a database password.

---

## Deploying to Vercel

`vercel.json` is ready: `/` goes to `/app`, the sign-in page comes from Vercel's CDN with a header that stops other sites framing it, and `/api/...` runs as one function in Singapore (`sin1`).

In **Settings → Environment Variables**, for Production, set `DISCORD_MODE`, `DISCORD_ENABLED`, `DISCORD_AUDIT_WEBHOOK_URL`, `DISCORD_BOT_TOKEN`, `RECORD_SECRET`, `SESSION_SECRET` and `ACCOUNTS`. `SESSION_SECRET` matters most: without it each instance signs cookies with its own key, and people are signed out at random. Redeploy after changing any of them.

- The first request after a cold start waits while orders are read back from Discord.
- Vercel can pause the function between requests, so a step's Discord posts may go out with the next request. The page shows the step as waiting until then.

---

## Measuring Discord's limits

To see the real limits on our Discord server:

```bash
npm run probe:discord
npm run probe:discord -- --uploads --threads --burst
```

This measures them live through `DISCORD_PROBE_WEBHOOK_URL`, a webhook in a channel made for testing; it refuses to use the `#order-audit` webhook. It sends one request at each limit and one just past it, prints what Discord accepted and refused next to the documented numbers, compares them with this project's settings, then deletes everything it posted.

- `--uploads` checks the upload size limit and sends about 21 MB.
- `--threads` checks thread names and leaves one thread, which archives itself after an hour.
- `--burst` posts until the first 429. That one 429 is the only request here that counts toward Discord's ban on invalid requests; refused requests (400, 413) don't.

---

## What maps onto the real backend

| Here | In `getmeds-backend/` |
|---|---|
| `src/discord.js`, `src/discordQueue.js` | `src/integrations/discord/`, with the same mock/live switch as `integrations/zoho/index.js` |
| The step posts in `src/orderAudit.js` | `discordAuditService` |
| `DISCORD_MODE`, `DISCORD_ENABLED` | Alongside `ZOHO_MODE`, `ZOHO_DRY_RUN` |
| Orders in `#order-audit`, accounts in `ACCOUNTS` | Supabase Postgres |

---

## Three rules worth carrying over

1. **Respond first, notify second.** The person taking a step should never wait on Discord, and Discord should never be able to fail the step.
2. **Encrypt what's private before it leaves.** Customer details reach Discord only inside `x`, encrypted with `RECORD_SECRET`.
3. **Two switches, not one.** `DISCORD_MODE` decides mock or real; `DISCORD_ENABLED` lets you stop sending without a deploy.
