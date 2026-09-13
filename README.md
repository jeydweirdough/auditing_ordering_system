# Getmeds orders app

A sign-in with a dashboard per role (Salesperson, Management, Finance, Dispatch, Admin), and an audit trail per order in the `#order-audit` Discord channel. Until there's a database, Discord is also where orders are stored: each order lives in its own thread, and the server rebuilds every order from Discord when it starts.

---

## Run it locally

```bash
npm install
cp .env.example .env
npm run accounts      # once: admin, salesperson, management, finance, dispatch (.test@getmeds.ph) and SESSION_SECRET
npm run dev
```

Open http://localhost:4000, which goes to the sign-in at `/app`. With `.env` as copied, `DISCORD_MODE=mock` and `DISCORD_ENABLED=false`: orders are kept in memory and nothing is sent to Discord.

Needs Node 24 (`engines` in `package.json`).

---

## Roles

| Role | Steps |
|---|---|
| Salesperson | raise an order, resubmit one sent back, cancel |
| Management | approve, send back (reason), reject (reason), cancel |
| Finance | verify payment (method, reference, amount, date), hold (reason) |
| Dispatch | start picking, mark packed, dispatch (courier, tracking), deliver (received by) |
| Admin | create for any salesperson, edit anything, delete and restore any order, any step; People: add, change role, deactivate, reset password |

The steps are one table, `ACTIONS` in `src/orders.js`: who may take each, from which statuses, what it moves the order to, and which fields it asks for. The server checks every step against it, and the page draws its forms from it.

---

## How it works

- **Accounts** live in `data/users.json`, passwords hashed with scrypt (`src/passwords.js`). A sign-in is an HMAC-signed cookie (`SESSION_SECRET`) that lasts 8 hours. Deactivating someone or resetting their password signs them out at once.
- **Or in `ACCOUNTS`**, for hosts without a disk such as Vercel, until there's a database: one account per line, `id | email | password | role | name`, the password in plain text or as a `scrypt$...` hash (`.env.example` has the details). With it set, `data/users.json` isn't read and the People screen is read-only: add, change or remove someone by editing `ACCOUNTS` and restarting, or redeploying on Vercel. Changing someone's password there signs them out everywhere. Never change or reuse an id: orders point at their salesperson by id.
- **Orders** live in `#order-audit` (`src/orderAudit.js`), not on disk. Each order has a starter message titled with its id and a thread on it. Every step is two posts in the thread: an embed for people (step, status change, `Name · Role`, time), and a reply from the bot holding the order's data as JSON (`src/orderCodec.js`): `{ "format": "order/1", "order", "step", "x" }`, the whole order after that step plus the step. On startup the server reads the channel and every thread and rebuilds each order from its newest reply. Customer name, contact number, address, notes, reasons, payment reference and received-by are in `x`, encrypted with `RECORD_SECRET` (AES-256-GCM, bound to the order id and step). Data too long for one message goes as a `.json` file.
- **Posting** happens after the step is taken. The step post goes through the webhook's queue (`src/discordQueue.js`), which keeps within Discord's rate limits; the reply goes through the bot (`sendAsBot`, which needs Send Messages in Threads), or as the webhook's next message if the bot may not. A failed post is kept on its step and sent again, in order, and the API answers 202 until a step is stored. Without `DISCORD_BOT_TOKEN`, orders are in memory only.
- **Old orders** from `data/orders.json` are copied into their threads on the first start, then the file is renamed `orders.imported.json`.
- **Admin's changes** are steps too: `edit`, `delete_order` and `restore` in `ACTIONS`, also reachable as `PATCH` and `DELETE /api/orders/:id`, each with a required reason. An edit's step names the changed fields and keeps their old values in `x`. Deleting is soft (`status: "deleted"`): hidden from everyone but Admin, and restorable. Every Admin change, account changes included, also gets a line in the "Admin log" thread in `#order-audit`: what changed and who, never values, reasons or passwords.
- **Changes are JSON only**, so another site's form can't post one with someone's cookie.

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
