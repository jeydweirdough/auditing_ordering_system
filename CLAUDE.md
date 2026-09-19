# CLAUDE.md

Guidance for Claude Code when working in this repo. The [README](README.md) is the full source of truth (how Discord-as-database works, roles, dashboards, deploy); this file is a quick orientation on top of it.

## What this is

The Getmeds orders app: an Express server + static multi-page frontend (`public/*.html` + vanilla JS, no framework/build step) with a sign-in and one dashboard per role (Salesperson, Management, Finance, Dispatch, Admin). There's no database yet — orders, accounts, config and products are all read from and written to Discord (`#order-audit`), each order living in its own thread. See the README's "How it works" section before touching anything order- or Discord-related.

## Commands

```bash
npm install
cp .env.example .env
npm run accounts        # once: seeds admin/salesperson/management/finance/dispatch test accounts + SESSION_SECRET
npm run dev              # runs src/server.js with --watch
npm start                # same, without --watch
npm run test:constraints # node scripts/test-constraints.js
npm run probe:discord    # measures real Discord rate limits against a test webhook (never #order-audit)
npm run import:products  # python scripts/import-products.py
```

There is no build step and no bundler — `public/js/*.js` is served as-is.

Other test/migration scripts live directly in `scripts/` (not wired to `npm test`), e.g. `scripts/test-*.js` for feature-specific checks and `scripts/migrate-to-discord*.js` / `scripts/clean-discord.js` for one-off data migrations. Run them with `node --env-file-if-exists=.env scripts/<name>.js`.

## Layout

- `src/server.js` — Express app entrypoint; waits for orders/config/products/accounts to load from Discord before serving any request.
- `src/orders.js` — the order state machine. `ACTIONS` is the single table of who can take each step, from which statuses, what it moves to, and what fields it needs. Start here for any workflow/role change.
- `src/orderAudit.js` / `src/orderCodec.js` — how an order step becomes posts in a Discord thread and back.
- `src/discord.js`, `src/discordQueue.js`, `src/discordHub.js`, `src/discordStore.js`, `src/discordTable.js` — the Discord integration layer (mock/live switch, rate-limited send queue, generic "table in a channel" storage used by config/products/accounts).
- `src/accounts.js`, `src/products.js`, `src/customers.js`, `src/recycleBin.js`, `src/configStore.js` — the other record types, all backed by Discord the same way orders are.
- `src/passwords.js` — scrypt hashing for local (`data/users.json`) accounts.
- `public/*.html` + `public/js/*.js` — one page per route, no client-side framework.
- `data/` — only used when `ACCOUNTS` env var isn't set; gitignored.

## Conventions worth keeping

These are called out explicitly in the README as rules to carry over into the real backend — respect them here:

1. **Respond first, notify second.** API calls must not block on Discord; a failed Discord post is retried later, not surfaced as a failed step.
2. **Encrypt what's private before it leaves.** Customer details and attachments go into Discord only inside the encrypted `x` field (`RECORD_SECRET`, AES-256-GCM). Never log or post plaintext customer data.
3. **Two switches, not one.** `DISCORD_MODE` (mock/live) and `DISCORD_ENABLED` (on/off) are independent — don't collapse them.
4. **Order/account ids are never reused or changed** — orders and other records reference people by id.
5. Role/permission changes belong in `ACTIONS` (`src/orders.js`), not scattered `if (role === ...)` checks in routes or the frontend.

## Keeping docs current

- Add a dated entry to [CHANGELOG.md](CHANGELOG.md) for user-facing or behavioral changes (new features, workflow/role changes, breaking changes to env vars or data formats). Skip it for pure refactors with no observable effect.
- Update the relevant README section (roles table, `ACTIONS`-derived docs, env vars, deploy notes) in the same change that alters the behavior it describes.
