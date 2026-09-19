# Changelog

All notable changes to this project are documented here, grouped by date. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

Nothing yet.

## 2026-09-19

### Removed
- Stopped tracking `data.bak` backup files (`.gitignore`).

## 2026-09-16

### Changed
- Enhanced dashboards for team leaders and dispatch, with new data handling and role-based filtering.

## 2026-09-15

### Added
- Discord table engine for managing structured data in threads (`src/discordTable.js`).
- User account migration and cleanup tooling for the Discord integration (`scripts/migrate-to-discord.js`, `scripts/clean-discord.js`).
- Product management and recycle bin functionality (`src/products.js`, `src/recycleBin.js`).

## 2026-09-13

### Added
- File attachments on orders (photos, PDF, Word, Excel) and improved order detail views.
- Support for the `ACCOUNTS` environment variable, for hosts without a disk (e.g. Vercel), with related documentation.

### Changed
- Refactored the Discord integration and removed unused code.
- Updated the README and removed obsolete test scripts from `package.json`.

### Removed
- GitHub Actions deployment workflow.

## 2026-09-13 — First commit

### Added
- Initial version of the Getmeds orders app: sign-in and per-role dashboards (Salesperson, Management, Finance, Dispatch, Admin), with orders stored and audited as threads in `#order-audit` on Discord.
