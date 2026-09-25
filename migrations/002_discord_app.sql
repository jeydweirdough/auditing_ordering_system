-- The orders app's additions to the shared Getmeds database.
--
-- Sep 25, 2026. This app now keeps its orders in the same Supabase Postgres as
-- getmeds-system (src/core/db/schema.pg.sql is that schema, copied verbatim), and
-- is replacing it. Everything here is ADDITIVE: a new column, a new table, or
-- an extra allowed value. Nothing is renamed, dropped or narrowed, so
-- getmeds-system keeps working against the same database until it is retired.
--
-- The allowed-value additions (orders.status, payment_proofs.file_type) are
-- made by src/db/migrate.js rather than here, because Postgres cannot add a
-- value to a CHECK constraint in place and the constraint's name is found at
-- run time. getmeds-system's own migration only ever widens those constraints
-- and keeps values it doesn't know, so it will not undo them.
--
-- Safe to run more than once.

-- Fields this app's order form has that the shared orders table has no column
-- for: customer remarks, internal notes, the customer's special-price flag, the
-- packing/receiving details Dispatch records, and the recycle-bin dates. One
-- JSONB column rather than eight, because nothing queries them by value and
-- none of them goes to Zoho.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS app_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A customer's usual receiver (name and number, filled into the next order
-- for them) and whether Management has cleared them for Special Price.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS app_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Which price tier a line was sold at (patient, doctor, srp, distributor,
-- hospital, special, government, bid), whether it was by unit or by pack, and
-- the product's name as the form showed it. The division price rules are
-- checked against price_type.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_type TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_type TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_label TEXT;

-- Raised to sign someone out everywhere (a password change). getmeds-system
-- ignores it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

-- The app's settings: the order form's lists (divisions, payment terms…), the
-- roles and their permissions, the product catalogue with its five price tiers,
-- and the recycle bin. Kept as (table, row) → JSON, the shape they had as
-- Discord threads, so the code that reads them did not have to change.
CREATE TABLE IF NOT EXISTS app_config (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT iso_now(),
  PRIMARY KEY (table_name, row_id)
);

-- Finds the recycle bin and the purge job's candidates without scanning.
CREATE INDEX IF NOT EXISTS idx_orders_status_updated ON orders(status, updated_at);
