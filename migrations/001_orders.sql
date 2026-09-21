-- The orders schema: everything this app owns.
--
-- This app owns orders. Orbit owns people, customers, products, prices and the
-- order settings, and is asked for them (src/orbit.js) rather than copied here.
-- Nothing in this schema refers to an Orbit table: an id from Orbit is kept as
-- plain text, because the two move on their own migrations and a foreign key
-- across them would tie those together for no gain.
--
-- It is written as it will live in Supabase, beside Orbit's `core`. Until then
-- it runs in a database of its own; moving it is a connection string, not a
-- rewrite.
--
-- Two things hold throughout:
--   * every row carries `org_id`, from the first day, so one company's orders
--     can never be read as another's even if this app has a bug;
--   * money is whole centavos as an integer, never a float. Orbit prices in
--     centavos, and 0.1 + 0.2 is not 0.3 in any language anyone bills in.

CREATE SCHEMA IF NOT EXISTS orders;

SET search_path TO orders, public;


-- An order's status. The eighteen steps that move between them live in
-- src/orders.js, which is the part of this app worth keeping.
CREATE TYPE order_status AS ENUM (
  'pending_tl_approval',   -- waiting for the Team Leader
  'pending_approval',      -- waiting for Management
  'returned',              -- sent back to the salesperson for changes
  'rejected',
  'awaiting_payment',      -- with Finance
  'on_hold',               -- Finance stopped it
  'ready_for_dispatch',
  'picking',
  'packed',
  'dispatched',
  'completed',             -- delivered
  'cancelled'
);


CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  -- GM-20260921-0007. Unique per company, from order_counters below.
  number          text NOT NULL,
  status          order_status NOT NULL DEFAULT 'pending_tl_approval',

  -- Whose order it is, in Orbit's words. Checked against Orbit's grants on
  -- every action; kept here so a list can be drawn without asking.
  division        text NOT NULL,
  subdivision     text NOT NULL,
  headquarters    text,

  -- The customer, by Orbit's id AND as a snapshot of the day it was raised.
  -- Both on purpose: the id is how you find them now, the snapshot is what was
  -- agreed then. An order is a record of a transaction, so editing a customer
  -- in the CRM must never rewrite an order already placed — the address it was
  -- sent to is the address it was sent to.
  customer_id     text,
  customer_name   text NOT NULL,
  contact_number  text,
  address         text,
  receiver_name   text,
  receiver_contact text,

  -- What the company chose, from Orbit's own lists (Settings -> Orders). Text,
  -- not an enum: these are a company's to change, and a code it has since
  -- retired must still read back on an old order.
  invoicing_from  text,
  source          text,
  payment_method  text,
  payment_terms   text,
  delivery_method text,

  customer_is_doctor boolean NOT NULL DEFAULT false,
  doctor_name     text,
  remarks         text,
  notes           text,

  -- This company's own extra order fields, by their key in Orbit's settings.
  -- Which keys exist and what each means is Orbit's to say; this only holds
  -- what was answered.
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,

  total_centavos  bigint NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'PHP',

  -- Who raised it and who it is for: they differ when a Team Leader raises one
  -- on behalf of a rep. Orbit profile ids.
  owner_id        text,
  owner_name      text,
  created_by_id   text,
  created_by_name text,

  -- Bumped on every change; an action pinned to a stale one is refused, so two
  -- approvers at once cannot both win.
  version         integer NOT NULL DEFAULT 1,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- The recycle bin. Set, not removed: an order is never really deleted until
  -- the retention window in Orbit's settings has passed.
  deleted_at      timestamptz,

  CONSTRAINT order_number_in_company UNIQUE (org_id, number),
  CONSTRAINT order_total_not_negative CHECK (total_centavos >= 0)
);

CREATE INDEX orders_by_company_status ON orders (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX orders_by_team ON orders (org_id, division, subdivision) WHERE deleted_at IS NULL;
CREATE INDEX orders_by_customer ON orders (org_id, customer_id) WHERE deleted_at IS NULL;
CREATE INDEX orders_in_the_bin ON orders (org_id, deleted_at) WHERE deleted_at IS NOT NULL;


CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position        integer NOT NULL,

  -- Orbit's product id where there is one, and its name and code as they were.
  -- Same reason as the customer: what was sold is what was sold.
  product_id      text,
  product_code    text,
  product_name    text NOT NULL,
  unit_type       text,

  quantity        integer NOT NULL,
  unit_price_centavos bigint NOT NULL,
  -- Which of Orbit's price types this line was quoted at (srp, patient...).
  price_type      text,
  -- A promo or a bundle it came from, by Orbit's id, for reading back only.
  promo_id        text,
  bundle_id       text,
  total_centavos  bigint NOT NULL,

  CONSTRAINT order_item_position UNIQUE (order_id, position),
  CONSTRAINT order_item_quantity CHECK (quantity > 0 AND quantity <= 100000),
  CONSTRAINT order_item_price CHECK (unit_price_centavos >= 0),
  CONSTRAINT order_item_total CHECK (total_centavos >= 0)
);

CREATE INDEX order_items_by_order ON order_items (org_id, order_id, position);


-- The order's history: every step, in order, for good.
-- This is what the Discord thread used to be. Append-only by habit and by
-- intent — nothing in the app updates or deletes a row here, because "what
-- happened to this order" must not be something anyone can quietly change.
CREATE TABLE order_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seq             integer NOT NULL,

  -- The action's name from src/orders.js: tl_approve, verify_payment, deliver...
  type            text NOT NULL,
  label           text NOT NULL,
  status_from     order_status,
  status_to       order_status,

  actor_id        text,
  actor_name      text,
  -- What role they acted as at the time. Roles are Orbit's and can be edited,
  -- so the history keeps what was true then.
  actor_role      text,

  note            text,
  -- Whatever that step carried: a reason, a courier and tracking number, who
  -- received it. Shaped by the action, so it is kept as it came.
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,

  at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_event_seq UNIQUE (order_id, seq)
);

CREATE INDEX order_events_by_order ON order_events (org_id, order_id, seq);


-- What Finance verified. An order may be paid in parts, so this is a list.
CREATE TABLE order_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  method          text,
  reference       text,
  amount_centavos bigint NOT NULL,
  paid_on         date NOT NULL,

  verified_by_id  text,
  verified_by_name text,
  at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_payment_amount CHECK (amount_centavos > 0)
);

CREATE INDEX order_payments_by_order ON order_payments (org_id, order_id);


-- Dispatch's side: one row per time it goes out. Usually one.
CREATE TABLE order_shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  courier         text,
  tracking_number text,
  packing_notes   text,

  packed_at       timestamptz,
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  received_by     text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_shipments_by_order ON order_shipments (org_id, order_id);


-- Files attached to an order: the proof of payment, a signed form, a photo.
-- The bytes live in object storage; this is where they are and what they are.
CREATE TABLE order_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  -- orgs/{org}/orders/{order}/{id}. A path, never a public URL: these are
  -- somebody's medical order, and the bucket is private.
  ref             text NOT NULL,
  name            text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL,

  uploaded_by_id  text,
  at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_file_size CHECK (size_bytes > 0)
);

CREATE INDEX order_files_by_order ON order_files (org_id, order_id);


-- Order numbers: GM-20260921-0007, counted per company per day.
-- A row per day, taken with UPDATE ... RETURNING inside the order's own
-- transaction, so two orders raised at the same moment cannot take the same
-- number and a failed order doesn't burn one.
CREATE TABLE order_counters (
  org_id          uuid NOT NULL,
  day             date NOT NULL,
  n               integer NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, day)
);


-- Row-level security: one company's rows are invisible to another, enforced by
-- the database rather than by this app remembering to filter. Every connection
-- sets app.org_id for the transaction (src/db.js); without it, nothing matches.
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters  ENABLE ROW LEVEL SECURITY;

CREATE POLICY one_company ON orders
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_items
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_events
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_payments
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_shipments
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_files
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY one_company ON order_counters
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
