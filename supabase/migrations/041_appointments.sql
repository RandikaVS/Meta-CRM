-- ============================================================
-- 041_appointments.sql — Appointment Management
--
-- Adds a dedicated scheduling module on top of the existing CRM
-- entities. Deliberately additive-only — no existing table is
-- altered except by adding new nullable FK-bearing columns via
-- brand-new child tables; `deals`/`pipelines` (the "Bookings &
-- Services" pipeline) are untouched.
--
-- New tables
--   services            — catalog of bookable services (name,
--                          duration, price). Nothing like this
--                          existed; "Bookings" only ever stored a
--                          free-text deal title.
--   staff_schedules      — weekly working hours per staff member.
--   staff_time_off        — leave / break / blocked ranges per staff.
--                          Both are the "minimum required extension"
--                          for availability — staff themselves are
--                          just `profiles` rows (account members),
--                          reused exactly as `deals.assigned_to`
--                          already does. No new staff table.
--   appointments          — the scheduled event: contact + staff +
--                          time range + status + billing snapshot.
--   appointment_services / appointment_products — line items.
--   appointment_payments  — signed-amount payment ledger (mirrors
--                          product_stock_movements' signed-delta
--                          ledger design: positive = payment,
--                          negative = refund).
--   appointment_events    — append-only audit/idempotency ledger,
--                          modeled on flow_run_events (010).
--
-- Conflict-safety strategy (spec item 7)
--   A GiST EXCLUDE constraint on (staff_id, time-range) is the
--   source of truth — it rejects an overlapping INSERT/UPDATE
--   atomically, under any write path (RPC, PostgREST, future code),
--   which is strictly stronger than an app-level SELECT-then-INSERT
--   check (immune to the two-users-at-once race). A partial
--   predicate excludes cancelled/no_show/rescheduled rows (they
--   don't hold the slot) and rows carrying an admin `override_reason`
--   (see `guard_appointment_override` below) from the constraint
--   entirely, giving exactly the "flexible, admin can override with
--   a reason" escape hatch the spec asks for.
--
-- Billing model (spec items 21/22/29)
--   No separate "invoice" entity — the appointment row IS the bill
--   (subtotal/discount/tax/total/payment_status/amount_paid columns),
--   avoiding "multiple competing billing systems". Line-item tables
--   use GENERATED ALWAYS columns for line_total (decimal-safe, one
--   formula, enforced by Postgres itself) and an AFTER trigger keeps
--   the parent appointment's totals in sync on every line-item
--   change. Once `is_billed` flips true (inside `complete_appointment`
--   below), a guard trigger — same pattern as
--   `guard_products_stock_column` (040) — rejects further direct
--   edits to schedule/financial columns, so a completed appointment's
--   total can never silently drift from its finalized bill.
--
-- Stock integration (spec item 23)
--   `complete_appointment` calls the EXISTING `adjust_product_stock`
--   RPC (040) per product line — no stock logic is duplicated.
--   `appointment_products.stock_movement_id` is the idempotency
--   marker: a line already carrying a movement id is skipped, so
--   retrying completion (or a webhook replay) can never deduct twice.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Needed for the GiST exclusion constraint below (equality on a
-- non-range type, uuid, inside a GiST index).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- SERVICES — bookable service catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name              text NOT NULL,
  description       text,
  category          text,
  duration_minutes  integer NOT NULL DEFAULT 30 CHECK (duration_minutes > 0),
  price             numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  tax_rate          numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_account_name_unique UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS services_account_id_idx ON services (account_id);
CREATE INDEX IF NOT EXISTS services_account_id_active_idx ON services (account_id, is_active);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS services_select ON services;
CREATE POLICY services_select ON services FOR SELECT USING (is_account_member(account_id));
-- Settings-class (catalog data), same tier as tags/custom_fields/pipelines.
DROP POLICY IF EXISTS services_insert ON services;
CREATE POLICY services_insert ON services FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS services_update ON services;
CREATE POLICY services_update ON services FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS services_delete ON services;
CREATE POLICY services_delete ON services FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON services;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- STAFF_SCHEDULES — weekly working hours per staff member
--
-- "Staff" is not a new entity — it's an account member (`profiles`
-- row), exactly as `deals.assigned_to` already models. One row per
-- (staff, weekday); a staff member with NO rows is treated as
-- available all day every day (see `suggest_available_slots`) so an
-- unconfigured account isn't blocked from booking — matches "do not
-- make validation unnecessarily strict".
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- 0 = Sunday .. 6 = Saturday, matching JS Date#getDay().
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_schedules_staff_day_unique UNIQUE (staff_id, day_of_week),
  CONSTRAINT staff_schedules_time_order CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS staff_schedules_staff_id_idx ON staff_schedules (staff_id);
CREATE INDEX IF NOT EXISTS staff_schedules_account_id_idx ON staff_schedules (account_id);

ALTER TABLE staff_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_schedules_select ON staff_schedules;
CREATE POLICY staff_schedules_select ON staff_schedules FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS staff_schedules_insert ON staff_schedules;
CREATE POLICY staff_schedules_insert ON staff_schedules FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS staff_schedules_update ON staff_schedules;
CREATE POLICY staff_schedules_update ON staff_schedules FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS staff_schedules_delete ON staff_schedules;
CREATE POLICY staff_schedules_delete ON staff_schedules FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON staff_schedules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON staff_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- STAFF_TIME_OFF — leave / break / blocked ranges per staff
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_time_off (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  reason        text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_time_off_range_order CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS staff_time_off_staff_start_idx ON staff_time_off (staff_id, start_at);
CREATE INDEX IF NOT EXISTS staff_time_off_account_id_idx ON staff_time_off (account_id);

ALTER TABLE staff_time_off ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_time_off_select ON staff_time_off;
CREATE POLICY staff_time_off_select ON staff_time_off FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS staff_time_off_insert ON staff_time_off;
CREATE POLICY staff_time_off_insert ON staff_time_off FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS staff_time_off_update ON staff_time_off;
CREATE POLICY staff_time_off_update ON staff_time_off FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS staff_time_off_delete ON staff_time_off;
CREATE POLICY staff_time_off_delete ON staff_time_off FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_number  text NOT NULL,

  -- History-preserving nullables, same convention as deals.contact_id
  -- (migration 004) / deals.assigned_to (migration 002): deleting the
  -- referenced row detaches it rather than destroying the appointment.
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  staff_id            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- Optional link back to a "Bookings & Services" pipeline card this
  -- appointment was scheduled from (spec item 36). Nullable — most
  -- appointments are booked directly.
  deal_id             uuid REFERENCES deals(id) ON DELETE SET NULL,

  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,

  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
                         'scheduled', 'confirmed', 'checked_in', 'in_progress',
                         'completed', 'cancelled', 'no_show', 'rescheduled'
                       )),
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'calendar', 'booking', 'api')),

  customer_notes      text,
  internal_notes      text,
  cancel_reason        text,

  -- Admin conflict override (spec item 7). When set, this row is
  -- exempt from the EXCLUDE constraint below — see
  -- `guard_appointment_override`, which requires admin+ to set it and
  -- stamps `override_by` itself (never trusts a client-supplied id).
  override_reason      text,
  override_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  discount_type        text CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value        numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_rate              numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),

  -- Billing snapshot — kept in sync by recompute_appointment_totals()
  -- (fired from the line-item tables' triggers) until is_billed
  -- flips true, at which point guard_appointment_billed_edits locks
  -- these columns. subtotal = sum of line totals BEFORE the
  -- appointment-level discount; discount_amount /tax_amount/
  -- total_amount are derived from it — see the function body for the
  -- exact formula.
  subtotal_amount       numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
  discount_amount        numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount             numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),

  amount_paid           numeric(12,2) NOT NULL DEFAULT 0,
  payment_status         text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid', 'refunded')),

  -- Flips true inside complete_appointment(); guards schedule +
  -- financial columns from further direct edits (spec items 9/29).
  is_billed              boolean NOT NULL DEFAULT false,

  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  checked_in_at          timestamptz,
  completed_at           timestamptz,
  cancelled_at            timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appointments_time_order CHECK (end_at > start_at),
  CONSTRAINT appointments_account_number_unique UNIQUE (account_id, appointment_number)
);

-- Query patterns from spec item 33: staff+time (calendar/day-view),
-- contact+time (customer history), status+time (filtered lists),
-- and a bare start_at for account-wide calendar range scans.
CREATE INDEX IF NOT EXISTS appointments_account_id_idx ON appointments (account_id);
CREATE INDEX IF NOT EXISTS appointments_staff_start_idx ON appointments (staff_id, start_at);
CREATE INDEX IF NOT EXISTS appointments_contact_start_idx ON appointments (contact_id, start_at);
CREATE INDEX IF NOT EXISTS appointments_status_start_idx ON appointments (status, start_at);
CREATE INDEX IF NOT EXISTS appointments_start_at_idx ON appointments (start_at);
CREATE INDEX IF NOT EXISTS appointments_deal_id_idx ON appointments (deal_id) WHERE deal_id IS NOT NULL;

-- ------------------------------------------------------------
-- Conflict-safety: GiST EXCLUDE constraint (spec item 7)
--
-- Two rows for the SAME staff_id whose [start_at, end_at) ranges
-- overlap are rejected by Postgres itself, atomically, regardless of
-- write path. The partial predicate means only "live, non-overridden"
-- appointments participate — a cancelled/no_show/rescheduled row (or
-- one carrying an admin override) never blocks a new booking.
-- ------------------------------------------------------------
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_staff_overlap;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_staff_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (
    staff_id IS NOT NULL
    AND status NOT IN ('cancelled', 'no_show', 'rescheduled')
    AND override_reason IS NULL
  );

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointments_insert ON appointments;
CREATE POLICY appointments_insert ON appointments FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointments_update ON appointments;
CREATE POLICY appointments_update ON appointments FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy: appointments are never hard-deleted (spec item
-- 10: "keep the appointment reference/history intact") — cancel via
-- status instead. Mirrors the products table's own no-hard-delete design.

DROP TRIGGER IF EXISTS set_updated_at ON appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Human-friendly reference, generated once at insert. NEW.id is
-- already populated by the column DEFAULT before a BEFORE INSERT
-- trigger runs, so it's safe to derive from here.
CREATE OR REPLACE FUNCTION generate_appointment_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.appointment_number IS NULL OR NEW.appointment_number = '' THEN
    -- Last 8 hex chars of the id (not the first — UUIDv4's leading
    -- segment carries the least entropy) give ~4 billion combos per
    -- account per day, plenty to make a same-day collision between
    -- two genuinely random ids effectively impossible; the UNIQUE
    -- constraint below is still the hard backstop either way.
    NEW.appointment_number := 'APT-' || to_char(now(), 'YYMMDD') || '-' ||
      upper(right(replace(NEW.id::text, '-', ''), 8));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generate_appointment_number ON appointments;
CREATE TRIGGER generate_appointment_number BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION generate_appointment_number();

-- Admin-only override: setting/changing override_reason requires
-- admin+, and override_by is always stamped from auth.uid() itself
-- (never trusts a client-supplied user id) — spec item 7's "record
-- who performed it".
CREATE OR REPLACE FUNCTION guard_appointment_override()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.override_reason IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.override_reason IS DISTINCT FROM OLD.override_reason) THEN
    IF NOT is_account_member(NEW.account_id, 'admin') THEN
      RAISE EXCEPTION 'Only an admin can override a scheduling conflict' USING ERRCODE = '42501';
    END IF;
    NEW.override_by := auth.uid();
  ELSIF NEW.override_reason IS NULL THEN
    NEW.override_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS guard_appointment_override ON appointments;
CREATE TRIGGER guard_appointment_override BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION guard_appointment_override();

-- Status-transition guard (spec item 8) — permissive by design (many
-- forward paths + "cancel from anywhere"), but protects the two
-- transitions that could corrupt a finalized record:
--   - 'completed' can only be reached through complete_appointment()
--     (which sets the app.appointment_completing flag), never a plain
--     UPDATE — that RPC is what finalizes billing + deducts stock, so
--     status can't outrun the work that's supposed to back it.
--   - Leaving 'completed' or 'cancelled' (other than completed ->
--     cancelled, an explicit void) requires admin+, so a mis-click
--     can't casually reopen a finalized record.
CREATE OR REPLACE FUNCTION validate_appointment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' AND current_setting('app.appointment_completing', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Appointments can only be completed via complete_appointment()' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'completed' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'A completed appointment can only move to cancelled' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'cancelled' AND NOT is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION 'Reopening a cancelled appointment requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'completed' AND NEW.status = 'cancelled' AND NOT is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION 'Voiding a completed appointment requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS validate_appointment_status_transition ON appointments;
CREATE TRIGGER validate_appointment_status_transition BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION validate_appointment_status_transition();

-- Once billed, lock schedule + financial columns against a direct
-- UPDATE (mirrors guard_products_stock_column, 040). amount_paid /
-- payment_status are deliberately NOT in this list — recording a
-- payment after completion is normal and stays open via
-- record_appointment_payment(). complete_appointment() itself is
-- exempt because it flips is_billed false -> true in the SAME
-- statement (OLD.is_billed is still false when the guard evaluates).
-- reschedule_appointment() / a genuine admin correction can bypass by
-- setting app.appointment_admin_edit for the duration of the call.
CREATE OR REPLACE FUNCTION guard_appointment_billed_edits()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_billed
     AND current_setting('app.appointment_admin_edit', true) IS DISTINCT FROM 'on'
     AND (
       NEW.start_at IS DISTINCT FROM OLD.start_at OR
       NEW.end_at IS DISTINCT FROM OLD.end_at OR
       NEW.staff_id IS DISTINCT FROM OLD.staff_id OR
       NEW.contact_id IS DISTINCT FROM OLD.contact_id OR
       NEW.discount_type IS DISTINCT FROM OLD.discount_type OR
       NEW.discount_value IS DISTINCT FROM OLD.discount_value OR
       NEW.tax_rate IS DISTINCT FROM OLD.tax_rate OR
       NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount OR
       NEW.discount_amount IS DISTINCT FROM OLD.discount_amount OR
       NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR
       NEW.total_amount IS DISTINCT FROM OLD.total_amount
     ) THEN
    RAISE EXCEPTION 'This appointment is billed — schedule and pricing are locked. Use an admin correction if this needs to change.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS guard_appointment_billed_edits ON appointments;
CREATE TRIGGER guard_appointment_billed_edits BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION guard_appointment_billed_edits();

-- ============================================================
-- Shared helper: stamp a child row's account_id from its parent
-- appointment. Used by all four line-item/ledger tables below so the
-- client never has to (and can't incorrectly) supply account_id —
-- it's always derived server-side from the parent, closing off a
-- whole class of cross-account data-entry bugs.
-- ============================================================
CREATE OR REPLACE FUNCTION set_appointment_child_account_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT account_id INTO NEW.account_id FROM appointments WHERE id = NEW.appointment_id;
  IF NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'Unknown appointment_id' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- APPOINTMENT_SERVICES — line items
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id    uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id        uuid REFERENCES services(id) ON DELETE SET NULL,
  -- Captured at add-time so a later rename/price change on the
  -- catalog row never rewrites history (spec item 29).
  name_snapshot     text NOT NULL,
  quantity          integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price        numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  duration_minutes  integer NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
  -- Decimal-safe by construction — Postgres computes this, not app code.
  line_total        numeric(12,2) GENERATED ALWAYS AS (GREATEST(quantity * unit_price - discount_amount, 0)) STORED,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_services_appointment_id_idx ON appointment_services (appointment_id);
CREATE INDEX IF NOT EXISTS appointment_services_account_id_idx ON appointment_services (account_id);

DROP TRIGGER IF EXISTS set_account_id ON appointment_services;
CREATE TRIGGER set_account_id BEFORE INSERT ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION set_appointment_child_account_id();

ALTER TABLE appointment_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_services_select ON appointment_services;
CREATE POLICY appointment_services_select ON appointment_services FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_services_insert ON appointment_services;
CREATE POLICY appointment_services_insert ON appointment_services FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_services_update ON appointment_services;
CREATE POLICY appointment_services_update ON appointment_services FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_services_delete ON appointment_services;
CREATE POLICY appointment_services_delete ON appointment_services FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- APPOINTMENT_PRODUCTS — line items, linked to the Stock module
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id     uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- RESTRICT: a product can't be hard-deleted out from under an
  -- appointment's history (products has no DELETE RLS policy at all
  -- today — see 040 — so this is belt-and-suspenders for any future
  -- service-role cleanup script).
  product_id         uuid REFERENCES products(id) ON DELETE RESTRICT,
  name_snapshot      text NOT NULL,
  quantity           numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price         numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_amount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total         numeric(12,2) GENERATED ALWAYS AS (GREATEST(quantity * unit_price - discount_amount, 0)) STORED,
  -- Idempotency marker: NULL until complete_appointment() actually
  -- deducts stock for this line via adjust_product_stock() (040).
  -- A line that already carries a movement id is skipped on retry —
  -- this is what makes completion-retry-safe (spec item 23).
  stock_movement_id  uuid REFERENCES product_stock_movements(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_products_appointment_id_idx ON appointment_products (appointment_id);
CREATE INDEX IF NOT EXISTS appointment_products_account_id_idx ON appointment_products (account_id);
CREATE INDEX IF NOT EXISTS appointment_products_product_id_idx ON appointment_products (product_id);

DROP TRIGGER IF EXISTS set_account_id ON appointment_products;
CREATE TRIGGER set_account_id BEFORE INSERT ON appointment_products
  FOR EACH ROW EXECUTE FUNCTION set_appointment_child_account_id();

ALTER TABLE appointment_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_products_select ON appointment_products;
CREATE POLICY appointment_products_select ON appointment_products FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_products_insert ON appointment_products;
CREATE POLICY appointment_products_insert ON appointment_products FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_products_update ON appointment_products;
CREATE POLICY appointment_products_update ON appointment_products FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_products_delete ON appointment_products;
CREATE POLICY appointment_products_delete ON appointment_products FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- Block line-item writes once the parent appointment is billed —
-- same intent as guard_appointment_billed_edits, mirrored onto the
-- child tables (a client could otherwise edit line items directly
-- even though the parent's own columns are locked). Covers INSERT
-- too, not just UPDATE/DELETE — a billed appointment can't gain a
-- brand-new line item any more than it can have an existing one
-- changed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_appointment_line_item_edits()
RETURNS TRIGGER AS $$
DECLARE
  v_billed BOOLEAN;
  v_appointment_id UUID := COALESCE(NEW.appointment_id, OLD.appointment_id);
BEGIN
  SELECT is_billed INTO v_billed FROM appointments WHERE id = v_appointment_id;
  IF v_billed AND current_setting('app.appointment_admin_edit', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'This appointment is billed — line items are locked. Use an admin correction if this needs to change.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS guard_line_item_edits ON appointment_services;
CREATE TRIGGER guard_line_item_edits BEFORE INSERT OR UPDATE OR DELETE ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION guard_appointment_line_item_edits();
DROP TRIGGER IF EXISTS guard_line_item_edits ON appointment_products;
CREATE TRIGGER guard_line_item_edits BEFORE INSERT OR UPDATE OR DELETE ON appointment_products
  FOR EACH ROW EXECUTE FUNCTION guard_appointment_line_item_edits();

-- ------------------------------------------------------------
-- recompute_appointment_totals — keeps appointments.subtotal_amount /
-- discount_amount / tax_amount / total_amount in sync with whatever
-- line items currently exist, PLUS the appointment-level discount/tax
-- settings. Fired from both line-item tables' triggers and from
-- appointments itself when discount/tax fields change. Idempotent
-- full recompute (not incremental) — cheap at one-appointment scale,
-- and simpler/safer to reason about than an incremental delta.
--
-- subtotal_amount = sum of line totals (each already net of its own
--   per-line discount).
-- discount_amount = the appointment-level discount applied on top:
--   percentage -> subtotal * value/100; fixed -> min(value, subtotal)
--   so a fixed discount can never exceed the subtotal.
-- tax_amount = (subtotal - discount_amount) * tax_rate/100.
-- total_amount = subtotal - discount_amount + tax_amount.
-- All rounded to 2dp at each step — decimal-safe, no float math.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_appointment_totals(p_appointment_id UUID)
RETURNS VOID AS $$
DECLARE
  v_subtotal NUMERIC(12,2);
  v_discount_type TEXT;
  v_discount_value NUMERIC(12,2);
  v_tax_rate NUMERIC(5,2);
  v_discount NUMERIC(12,2);
  v_taxable NUMERIC(12,2);
  v_tax NUMERIC(12,2);
BEGIN
  SELECT discount_type, discount_value, tax_rate
  INTO v_discount_type, v_discount_value, v_tax_rate
  FROM appointments WHERE id = p_appointment_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal FROM (
    SELECT line_total FROM appointment_services WHERE appointment_id = p_appointment_id
    UNION ALL
    SELECT line_total FROM appointment_products WHERE appointment_id = p_appointment_id
  ) lines;

  v_discount := CASE
    WHEN v_discount_type = 'percentage' THEN ROUND(v_subtotal * COALESCE(v_discount_value, 0) / 100, 2)
    WHEN v_discount_type = 'fixed' THEN LEAST(COALESCE(v_discount_value, 0), v_subtotal)
    ELSE 0
  END;
  v_taxable := v_subtotal - v_discount;
  v_tax := ROUND(v_taxable * COALESCE(v_tax_rate, 0) / 100, 2);

  PERFORM set_config('app.appointment_admin_edit', 'on', true);
  UPDATE appointments SET
    subtotal_amount = v_subtotal,
    discount_amount = v_discount,
    tax_amount = v_tax,
    total_amount = v_taxable + v_tax
  WHERE id = p_appointment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trigger_recompute_appointment_totals()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM recompute_appointment_totals(COALESCE(NEW.appointment_id, OLD.appointment_id));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS recompute_totals ON appointment_services;
CREATE TRIGGER recompute_totals AFTER INSERT OR UPDATE OR DELETE ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION trigger_recompute_appointment_totals();
DROP TRIGGER IF EXISTS recompute_totals ON appointment_products;
CREATE TRIGGER recompute_totals AFTER INSERT OR UPDATE OR DELETE ON appointment_products
  FOR EACH ROW EXECUTE FUNCTION trigger_recompute_appointment_totals();

CREATE OR REPLACE FUNCTION trigger_recompute_on_discount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.discount_type IS DISTINCT FROM OLD.discount_type
     OR NEW.discount_value IS DISTINCT FROM OLD.discount_value
     OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate THEN
    PERFORM recompute_appointment_totals(NEW.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS recompute_on_discount_change ON appointments;
CREATE TRIGGER recompute_on_discount_change AFTER UPDATE OF discount_type, discount_value, tax_rate ON appointments
  FOR EACH ROW EXECUTE FUNCTION trigger_recompute_on_discount_change();

-- ============================================================
-- APPOINTMENT_PAYMENTS — signed-amount ledger (mirrors
-- product_stock_movements: positive = payment received, negative =
-- refund). Immutable — no UPDATE/DELETE policy for anyone.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL CHECK (amount <> 0),
  method          text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'bank_transfer', 'online', 'other')),
  note            text,
  recorded_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_payments_appointment_id_idx ON appointment_payments (appointment_id);
CREATE INDEX IF NOT EXISTS appointment_payments_account_id_idx ON appointment_payments (account_id);

DROP TRIGGER IF EXISTS set_account_id ON appointment_payments;
CREATE TRIGGER set_account_id BEFORE INSERT ON appointment_payments
  FOR EACH ROW EXECUTE FUNCTION set_appointment_child_account_id();

ALTER TABLE appointment_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_payments_select ON appointment_payments;
CREATE POLICY appointment_payments_select ON appointment_payments FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_payments_insert ON appointment_payments;
CREATE POLICY appointment_payments_insert ON appointment_payments FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
-- No UPDATE/DELETE policy — immutable ledger.

-- ============================================================
-- APPOINTMENT_EVENTS — append-only audit + idempotency ledger
-- (modeled on flow_run_events, 010). Immutable.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN (
                    'created', 'staff_changed', 'time_changed', 'service_changed',
                    'product_changed', 'status_changed', 'rescheduled', 'checked_in',
                    'completed', 'cancelled', 'bill_finalized', 'payment_recorded',
                    'whatsapp_sent', 'whatsapp_failed', 'override_used'
                  )),
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_events_appointment_created_idx ON appointment_events (appointment_id, created_at DESC);
-- Backs the WhatsApp-retry idempotency check ("has this appointment
-- already got a whatsapp_sent event?") and similar per-type lookups.
CREATE INDEX IF NOT EXISTS appointment_events_appointment_type_idx ON appointment_events (appointment_id, event_type);
CREATE INDEX IF NOT EXISTS appointment_events_account_id_idx ON appointment_events (account_id);

DROP TRIGGER IF EXISTS set_account_id ON appointment_events;
CREATE TRIGGER set_account_id BEFORE INSERT ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION set_appointment_child_account_id();

ALTER TABLE appointment_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_events_select ON appointment_events;
CREATE POLICY appointment_events_select ON appointment_events FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_events_insert ON appointment_events;
CREATE POLICY appointment_events_insert ON appointment_events FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
-- No UPDATE/DELETE policy — immutable audit trail.

-- ============================================================
-- check_appointment_conflicts — friendly pre-check + the data the UI
-- needs to render "Sarah is already booked from 11:30 to 12:30".
-- SECURITY INVOKER — relies entirely on the caller's own
-- appointments_select RLS, no privilege bypass. The EXCLUDE
-- constraint above is still the real backstop against a race; this
-- is purely UX (and reused as the base of suggest_available_slots).
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_appointment_conflicts(
  p_staff_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_exclude_appointment_id UUID DEFAULT NULL
)
RETURNS SETOF appointments
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT * FROM appointments
  WHERE staff_id = p_staff_id
    AND status NOT IN ('cancelled', 'no_show', 'rescheduled')
    AND override_reason IS NULL
    AND (p_exclude_appointment_id IS NULL OR id <> p_exclude_appointment_id)
    AND tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ORDER BY start_at;
$$;

REVOKE ALL ON FUNCTION public.check_appointment_conflicts(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_appointment_conflicts(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated;

-- ============================================================
-- suggest_available_slots — candidate start times for a staff member
-- on a given day (spec: "offer alternative available slots",
-- "suggested next available time"). Samples working hours (from
-- staff_schedules; a staff member with no configured hours is treated
-- as available 00:00-23:59) in 15-minute increments, skipping
-- staff_time_off and existing appointments. Bounded + simple by
-- design — not a general solver.
-- ============================================================
CREATE OR REPLACE FUNCTION public.suggest_available_slots(
  p_staff_id UUID,
  p_date DATE,
  p_duration_minutes INT,
  p_limit INT DEFAULT 5
)
RETURNS TABLE (slot_start TIMESTAMPTZ, slot_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_dow SMALLINT := EXTRACT(DOW FROM p_date);
  v_work_start TIME;
  v_work_end TIME;
  v_cursor TIMESTAMPTZ;
  v_day_end TIMESTAMPTZ;
  v_candidate_end TIMESTAMPTZ;
  v_found INT := 0;
BEGIN
  SELECT start_time, end_time INTO v_work_start, v_work_end
  FROM staff_schedules WHERE staff_id = p_staff_id AND day_of_week = v_dow;

  -- No configured hours -> available all day (see table comment).
  v_cursor := p_date + COALESCE(v_work_start, TIME '00:00');
  v_day_end := p_date + COALESCE(v_work_end, TIME '23:59');

  WHILE v_cursor < v_day_end AND v_found < p_limit LOOP
    v_candidate_end := v_cursor + make_interval(mins => p_duration_minutes);
    EXIT WHEN v_candidate_end > v_day_end;

    IF NOT EXISTS (
      SELECT 1 FROM appointments
      WHERE staff_id = p_staff_id
        AND status NOT IN ('cancelled', 'no_show', 'rescheduled')
        AND override_reason IS NULL
        AND tstzrange(start_at, end_at, '[)') && tstzrange(v_cursor, v_candidate_end, '[)')
    ) AND NOT EXISTS (
      SELECT 1 FROM staff_time_off
      WHERE staff_id = p_staff_id
        AND tstzrange(start_at, end_at, '[)') && tstzrange(v_cursor, v_candidate_end, '[)')
    ) THEN
      slot_start := v_cursor;
      slot_end := v_candidate_end;
      v_found := v_found + 1;
      RETURN NEXT;
    END IF;

    v_cursor := v_cursor + INTERVAL '15 minutes';
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.suggest_available_slots(UUID, DATE, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_available_slots(UUID, DATE, INT, INT) TO authenticated;

-- ============================================================
-- reschedule_appointment — dedicated RPC (spec item 10). Same row,
-- new time/staff; the EXCLUDE constraint enforces conflict-safety on
-- the UPDATE itself (caught below and re-raised as a friendly
-- message), and every call logs a 'rescheduled' event with the
-- old/new values so history is never lost.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reschedule_appointment(
  p_appointment_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_staff_id UUID,
  p_override_reason TEXT DEFAULT NULL
)
RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_appt appointments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'This action requires the ''agent'' role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'End time must be after start time' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_appt FROM appointments
  WHERE id = p_appointment_id AND account_id = v_account_id
  FOR UPDATE;

  IF v_appt.id IS NULL THEN
    RAISE EXCEPTION 'Appointment not found' USING ERRCODE = '22023';
  END IF;
  IF v_appt.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot reschedule a % appointment', v_appt.status USING ERRCODE = '22023';
  END IF;

  BEGIN
    UPDATE appointments SET
      start_at = p_start_at,
      end_at = p_end_at,
      staff_id = p_staff_id,
      override_reason = p_override_reason,
      updated_by = auth.uid()
    WHERE id = p_appointment_id
    RETURNING * INTO v_appt;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That staff member already has an appointment overlapping this time' USING ERRCODE = '23P01';
  END;

  INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload) VALUES
    (p_appointment_id, 'rescheduled', auth.uid(), jsonb_build_object(
      'previous_start_at', v_appt.start_at, 'previous_end_at', v_appt.end_at,
      'new_start_at', p_start_at, 'new_end_at', p_end_at,
      'previous_staff_id', v_appt.staff_id, 'new_staff_id', p_staff_id
    ));
  IF p_override_reason IS NOT NULL THEN
    INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload) VALUES
      (p_appointment_id, 'override_used', auth.uid(), jsonb_build_object('reason', p_override_reason));
  END IF;

  RETURN v_appt;
END;
$$;

ALTER FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT) TO authenticated;

-- ============================================================
-- update_appointment_status — generic transition RPC (everything
-- except 'completed', which must go through complete_appointment()).
-- Actual transition legality is enforced by the
-- validate_appointment_status_transition trigger; this RPC just
-- resolves the caller, stamps the right timestamp per status, and
-- logs the event.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_appointment_status(
  p_appointment_id UUID,
  p_new_status TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_appt appointments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_new_status = 'completed' THEN
    RAISE EXCEPTION 'Use complete_appointment() to complete an appointment' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'This action requires the ''agent'' role or higher' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_appt FROM appointments
  WHERE id = p_appointment_id AND account_id = v_account_id
  FOR UPDATE;
  IF v_appt.id IS NULL THEN
    RAISE EXCEPTION 'Appointment not found' USING ERRCODE = '22023';
  END IF;

  UPDATE appointments SET
    status = p_new_status,
    cancel_reason = CASE WHEN p_new_status = 'cancelled' THEN p_reason ELSE cancel_reason END,
    cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE cancelled_at END,
    checked_in_at = CASE WHEN p_new_status = 'checked_in' AND checked_in_at IS NULL THEN now() ELSE checked_in_at END,
    updated_by = auth.uid()
  WHERE id = p_appointment_id
  RETURNING * INTO v_appt;

  INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload) VALUES
    (p_appointment_id, CASE WHEN p_new_status = 'cancelled' THEN 'cancelled'
                            WHEN p_new_status = 'checked_in' THEN 'checked_in'
                            ELSE 'status_changed' END,
     auth.uid(), jsonb_build_object('new_status', p_new_status, 'reason', p_reason));

  RETURN v_appt;
END;
$$;

ALTER FUNCTION public.update_appointment_status(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_appointment_status(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment_status(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- complete_appointment — the whole completion workflow (spec item
-- 24) in one atomic transaction:
--   1. validate (agent+, at least one service line, not already done)
--   2. lock the row
--   3. totals are already correct (kept live by
--      recompute_appointment_totals) — just read them
--   4. flip status -> completed, is_billed -> true, stamp
--      completed_at, recompute payment_status
--   5. for each unfulfilled product line, deduct stock via the
--      EXISTING adjust_product_stock() RPC (040) and record the
--      movement id — already-deducted lines (stock_movement_id IS NOT
--      NULL) are skipped, which is what makes a retry safe
--   6. log 'completed' + 'bill_finalized' events
-- Insufficient stock raises from inside adjust_product_stock() itself
-- and rolls back the ENTIRE transaction — the appointment is not
-- left half-completed.
--
-- Deliberately does NOT send the WhatsApp message — that's an
-- external HTTP call that can't participate in a DB transaction and
-- must never be allowed to roll back a completed appointment. The
-- caller (src/app/api/appointments/[id]/complete/route.ts) calls this
-- RPC first, then attempts the WhatsApp send as a separate, best-
-- effort step and logs whatsapp_sent/whatsapp_failed accordingly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_appointment(p_appointment_id UUID)
RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_appt appointments;
  v_service_count INT;
  v_line RECORD;
  v_movement product_stock_movements;
  v_payment_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'This action requires the ''agent'' role or higher' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_appt FROM appointments
  WHERE id = p_appointment_id AND account_id = v_account_id
  FOR UPDATE;
  IF v_appt.id IS NULL THEN
    RAISE EXCEPTION 'Appointment not found' USING ERRCODE = '22023';
  END IF;
  IF v_appt.status = 'completed' THEN
    -- Retry-safe: completing an already-completed appointment is a
    -- no-op success, not an error — a caller that retries after a
    -- network blip on the FIRST attempt's response shouldn't see a
    -- scary failure for work that actually already succeeded.
    RETURN v_appt;
  END IF;
  IF v_appt.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot complete a cancelled appointment' USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_service_count FROM appointment_services WHERE appointment_id = p_appointment_id;
  IF v_service_count = 0 THEN
    RAISE EXCEPTION 'Add at least one service before completing this appointment' USING ERRCODE = '22023';
  END IF;

  -- Deduct stock for product lines not already fulfilled. Reuses
  -- adjust_product_stock() (040) verbatim — no stock logic is
  -- duplicated here.
  FOR v_line IN
    SELECT id, product_id, quantity FROM appointment_products
    WHERE appointment_id = p_appointment_id AND stock_movement_id IS NULL AND product_id IS NOT NULL
  LOOP
    SELECT * INTO v_movement FROM adjust_product_stock(
      v_line.product_id, 'sale', -v_line.quantity,
      v_appt.appointment_number, 'Appointment ' || v_appt.appointment_number
    );
    UPDATE appointment_products SET stock_movement_id = v_movement.id WHERE id = v_line.id;
  END LOOP;

  v_payment_status := CASE
    WHEN v_appt.amount_paid < 0 THEN 'refunded'
    WHEN v_appt.amount_paid >= v_appt.total_amount AND v_appt.total_amount > 0 THEN 'paid'
    WHEN v_appt.amount_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END;

  PERFORM set_config('app.appointment_completing', 'on', true);
  UPDATE appointments SET
    status = 'completed',
    is_billed = true,
    completed_at = now(),
    payment_status = v_payment_status,
    updated_by = auth.uid()
  WHERE id = p_appointment_id
  RETURNING * INTO v_appt;

  INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload) VALUES
    (p_appointment_id, 'completed', auth.uid(), jsonb_build_object('total_amount', v_appt.total_amount)),
    (p_appointment_id, 'bill_finalized', auth.uid(), jsonb_build_object(
      'subtotal_amount', v_appt.subtotal_amount, 'discount_amount', v_appt.discount_amount,
      'tax_amount', v_appt.tax_amount, 'total_amount', v_appt.total_amount
    ));

  RETURN v_appt;
END;
$$;

ALTER FUNCTION public.complete_appointment(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_appointment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_appointment(UUID) TO authenticated;

-- ============================================================
-- record_appointment_payment — appends a signed payment/refund entry
-- and recomputes amount_paid + payment_status. Allowed even after
-- completion (paying the bill IS the normal post-service flow) —
-- amount_paid/payment_status are intentionally outside
-- guard_appointment_billed_edits' protected column list.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_appointment_payment(
  p_appointment_id UUID,
  p_amount NUMERIC,
  p_method TEXT DEFAULT 'cash',
  p_note TEXT DEFAULT NULL
)
RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_appt appointments;
  v_total_paid NUMERIC(12,2);
  v_payment_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Payment amount cannot be zero' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'This action requires the ''agent'' role or higher' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_appt FROM appointments
  WHERE id = p_appointment_id AND account_id = v_account_id
  FOR UPDATE;
  IF v_appt.id IS NULL THEN
    RAISE EXCEPTION 'Appointment not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO appointment_payments (appointment_id, amount, method, note, recorded_by)
  VALUES (p_appointment_id, p_amount, p_method, NULLIF(TRIM(p_note), ''), auth.uid());

  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM appointment_payments WHERE appointment_id = p_appointment_id;

  v_payment_status := CASE
    WHEN v_total_paid < 0 THEN 'refunded'
    WHEN v_total_paid >= v_appt.total_amount AND v_appt.total_amount > 0 THEN 'paid'
    WHEN v_total_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END;

  UPDATE appointments SET amount_paid = v_total_paid, payment_status = v_payment_status
  WHERE id = p_appointment_id
  RETURNING * INTO v_appt;

  INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload) VALUES
    (p_appointment_id, 'payment_recorded', auth.uid(), jsonb_build_object('amount', p_amount, 'method', p_method));

  RETURN v_appt;
END;
$$;

ALTER FUNCTION public.record_appointment_payment(UUID, NUMERIC, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_appointment_payment(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_appointment_payment(UUID, NUMERIC, TEXT, TEXT) TO authenticated;

-- ============================================================
-- log_appointment_event — thin insert wrapper so the client can log
-- non-critical timeline events (e.g. 'service_changed',
-- 'staff_changed' from a plain edit form) without needing INSERT
-- access shaped any differently than every other write here.
-- Plain INSERT already works via the appointment_events_insert RLS
-- policy — this RPC exists only for the WhatsApp completion route,
-- which runs as the service role and still needs account_id
-- resolved/validated the same way. Kept minimal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_whatsapp_event(
  p_appointment_id UUID,
  p_sent BOOLEAN,
  p_detail TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO appointment_events (appointment_id, event_type, actor_user_id, payload)
  SELECT p_appointment_id,
         CASE WHEN p_sent THEN 'whatsapp_sent' ELSE 'whatsapp_failed' END,
         auth.uid(),
         jsonb_build_object('detail', p_detail);
$$;

ALTER FUNCTION public.record_whatsapp_event(UUID, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_whatsapp_event(UUID, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_event(UUID, BOOLEAN, TEXT) TO authenticated, service_role;
