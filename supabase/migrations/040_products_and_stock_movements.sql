-- ============================================================
-- 040_products_and_stock_movements.sql — Stock & Product Management
--
-- Adds product catalog + auditable inventory tracking:
--
--   products                 — catalog rows (SKU, pricing, current
--                               stock snapshot, reorder thresholds).
--   product_stock_movements  — append-only ledger of every stock
--                               change. `products.current_stock` is a
--                               cached snapshot, never the source of
--                               truth; the ledger is.
--
-- Design mirrors the account-sharing era conventions (017+):
--   - account_id NOT NULL from day one (this table postdates 017, so
--     there's no legacy user_id-only phase to migrate through, unlike
--     `contacts`/`deals`).
--   - created_by is audit-only (ON DELETE SET NULL) — never used for
--     tenancy scoping. Same shape as api_keys.created_by (026).
--   - RLS via is_account_member(account_id, min_role) — SELECT open
--     to any member (viewer+), mutations gated at agent+ (same tier
--     as contacts/deals: operational data, not account settings).
--
-- Stock integrity — the actual point of this migration
--
--   current_stock must never drift from the ledger. Two backstops:
--
--   1. `guard_products_stock_column` trigger — rejects any UPDATE
--      that changes `current_stock` unless it runs inside
--      `adjust_product_stock()` (which flags the transaction via a
--      local `set_config`). A direct `UPDATE products SET
--      current_stock = ...` from the client, a bulk script, or a
--      future feature that forgets the ledger is rejected at the DB
--      layer, not just discouraged by convention.
--
--   2. `adjust_product_stock(...)` RPC — the ONLY path that changes
--      current_stock. SECURITY DEFINER, resolves the caller's
--      account/role itself (mirrors 018's set_member_role shape),
--      locks the product row (`FOR UPDATE`) so two concurrent
--      adjustments serialize instead of racing on a stale read,
--      inserts the ledger row and updates the snapshot in one
--      transaction, and rejects any change that would take stock
--      negative. Quantity is a signed delta (positive = increase,
--      negative = decrease) — one column expresses "add" and
--      "remove" instead of an ambiguous magnitude + separate sign
--      flag, and `new_stock = previous_stock + quantity` is enforced
--      by a CHECK constraint on the ledger table itself.
--
-- List filtering — `filter_products_by_stock_status` mirrors
-- `filter_contacts_by_tags` (025): stock status (in/low/out) is
-- derived, not stored, so it can't be filtered with a plain column
-- `.eq()` from the client. SECURITY INVOKER — relies entirely on the
-- caller's own RLS, no privilege bypass.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  sku               text NOT NULL,
  barcode           text,
  name              text NOT NULL,
  description       text,
  category          text,
  brand             text,
  image_url         text,
  unit              text NOT NULL DEFAULT 'pcs',

  cost_price        numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  selling_price     numeric(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  tax_rate          numeric(5,2)  NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),

  -- Cached snapshot of the ledger below — see the guard trigger. Kept
  -- as a column (not a view) so list/search queries stay a single
  -- cheap index scan instead of an aggregate over every movement row.
  current_stock     numeric(12,2) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  reorder_level     numeric(12,2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  max_stock_level   numeric(12,2) CHECK (max_stock_level IS NULL OR max_stock_level >= 0),

  -- No dedicated suppliers table exists in this schema (see project
  -- notes) — kept as plain reference fields rather than introducing a
  -- new master-data entity the rest of the app doesn't have yet.
  supplier_name     text,
  supplier_contact  text,

  is_active         boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT products_account_sku_unique UNIQUE (account_id, sku),
  CONSTRAINT products_max_stock_gte_reorder
    CHECK (max_stock_level IS NULL OR max_stock_level >= reorder_level)
);

-- account_id: every list/search query filters on it first (same role
-- as idx_contacts_user_id). Name/SKU/barcode search uses plain ILIKE
-- (no pg_trgm extension in this schema, matching contacts' own
-- name/phone/email search) — not worth a dedicated index at CRM
-- scale, consistent with the rest of the app.
CREATE INDEX IF NOT EXISTS products_account_id_idx ON products (account_id);
CREATE INDEX IF NOT EXISTS products_account_id_active_idx ON products (account_id, is_active);
CREATE INDEX IF NOT EXISTS products_account_id_category_idx ON products (account_id, category);

-- Barcode is optional but must be unique per account when present.
-- A plain UNIQUE constraint would treat every NULL as distinct anyway
-- (standard SQL), but the partial index spells out the intent and
-- keeps the index small (only rows that actually have a barcode).
DROP INDEX IF EXISTS products_account_barcode_unique;
CREATE UNIQUE INDEX products_account_barcode_unique
  ON products (account_id, barcode) WHERE barcode IS NOT NULL;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS products_insert ON products;
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_update ON products;
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

-- No DELETE policy: hard-deleting a product with stock history would
-- orphan/destroy the audit trail. `product_stock_movements.product_id`
-- also uses ON DELETE RESTRICT (below) as a second, DB-level backstop.
-- The app exposes deactivation (is_active = false) instead — see the
-- Products page "Deactivate" action.

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Guard: current_stock may only change via adjust_product_stock().
--
-- `adjust_product_stock` sets a transaction-local flag right before
-- its own UPDATE; any other UPDATE path (a stray client call, a
-- future bulk-import script, hand-editing in the SQL console) hits
-- this trigger instead. `current_setting(..., true)` returns NULL
-- instead of erroring when the flag was never set, which is the
-- common case.
-- ============================================================
CREATE OR REPLACE FUNCTION guard_products_stock_column()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_stock IS DISTINCT FROM OLD.current_stock
     AND current_setting('app.stock_adjustment_in_progress', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'current_stock can only be changed via adjust_product_stock()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS guard_products_stock_column ON products;
CREATE TRIGGER guard_products_stock_column BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION guard_products_stock_column();

-- ============================================================
-- PRODUCT_STOCK_MOVEMENTS — append-only audit ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS product_stock_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  movement_type     text NOT NULL CHECK (movement_type IN (
    'opening_stock',   -- initial quantity set when the product was created
    'purchase',        -- stock received from a supplier
    'manual_increase', -- ad-hoc correction upward
    'sale',            -- stock sold to a customer
    'manual_decrease', -- ad-hoc correction downward
    'damaged',         -- written off (breakage, spoilage, expiry)
    'returned',        -- customer return added back to sellable stock
    'adjustment'       -- "set to exact quantity" reconciliation
  )),

  -- Signed delta applied to current_stock. Positive = increase,
  -- negative = decrease — one column expresses both direction and
  -- magnitude, so previous + quantity = new is always true (enforced
  -- below) rather than relying on movement_type to imply sign.
  quantity          numeric(12,2) NOT NULL CHECK (quantity <> 0),
  previous_stock    numeric(12,2) NOT NULL CHECK (previous_stock >= 0),
  new_stock         numeric(12,2) NOT NULL CHECK (new_stock >= 0),
  CONSTRAINT product_stock_movements_math_check
    CHECK (new_stock = previous_stock + quantity),

  reference_number  text,
  reason            text,

  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_stock_movements_account_id_idx
  ON product_stock_movements (account_id);
-- Backs "stock history for this product, newest first" (the primary
-- read pattern — the History drawer and the audit trail).
CREATE INDEX IF NOT EXISTS product_stock_movements_product_created_idx
  ON product_stock_movements (product_id, created_at DESC);

ALTER TABLE product_stock_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_stock_movements_select ON product_stock_movements;
CREATE POLICY product_stock_movements_select ON product_stock_movements FOR SELECT
  USING (is_account_member(account_id));

-- INSERT is allowed at agent+ so the ledger's RLS shape matches every
-- other operational table (defense in depth / seed scripts run as a
-- normal member). In practice the app only ever writes movement rows
-- through `adjust_product_stock()` below (SECURITY DEFINER, bypasses
-- RLS) — this policy is a backstop, not the primary write path.
DROP POLICY IF EXISTS product_stock_movements_insert ON product_stock_movements;
CREATE POLICY product_stock_movements_insert ON product_stock_movements FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- No UPDATE / DELETE policy anywhere, for anyone (RLS default-denies
-- when a table has RLS enabled and no matching policy). The ledger is
-- immutable by construction — correcting a mistake means recording a
-- new offsetting movement (e.g. an 'adjustment'), never editing
-- history. This is the "no fragile design" requirement enforced at
-- the database layer, not just by app-code discipline.

-- ============================================================
-- adjust_product_stock(...) — the sole path that changes
-- products.current_stock.
--
-- Atomic: locks the product row, computes new_stock, inserts the
-- ledger row, and updates the snapshot — all in one function
-- invocation/transaction, so a caller never observes (or can race
-- with) a half-applied adjustment. Two concurrent calls against the
-- same product serialize on the row lock instead of both reading the
-- same stale current_stock and one silently clobbering the other.
--
-- Mirrors 018_account_member_rpcs.sql's shape: resolve caller's
-- account/role from `profiles` itself, raise typed Postgres
-- exceptions (42501 = forbidden, 22023 = bad input) that
-- `toErrorResponse`/the RPC caller map to the right UX.
-- ============================================================
CREATE OR REPLACE FUNCTION public.adjust_product_stock(
  p_product_id UUID,
  p_movement_type TEXT,
  p_quantity_delta NUMERIC,
  p_reference_number TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS product_stock_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_product products;
  v_new_stock NUMERIC(12,2);
  v_movement product_stock_movements;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_account_id, v_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Profile is not linked to an account' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'This action requires the ''agent'' role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_quantity_delta IS NULL OR p_quantity_delta = 0 THEN
    RAISE EXCEPTION 'Quantity delta cannot be zero' USING ERRCODE = '22023';
  END IF;

  IF p_movement_type NOT IN (
    'opening_stock', 'purchase', 'manual_increase', 'sale',
    'manual_decrease', 'damaged', 'returned', 'adjustment'
  ) THEN
    RAISE EXCEPTION 'Invalid movement type: %', p_movement_type USING ERRCODE = '22023';
  END IF;

  -- Row lock: a second concurrent call against the same product
  -- blocks here until this transaction commits, then reads the
  -- post-adjustment stock rather than a stale value.
  SELECT * INTO v_product FROM products
  WHERE id = p_product_id AND account_id = v_account_id
  FOR UPDATE;

  IF v_product.id IS NULL THEN
    RAISE EXCEPTION 'Product not found' USING ERRCODE = '22023';
  END IF;

  v_new_stock := v_product.current_stock + p_quantity_delta;

  IF v_new_stock < 0 THEN
    RAISE EXCEPTION 'Stock cannot go below zero (current: %, change: %)',
      v_product.current_stock, p_quantity_delta USING ERRCODE = '22023';
  END IF;

  INSERT INTO product_stock_movements (
    account_id, product_id, movement_type, quantity,
    previous_stock, new_stock, reference_number, reason, created_by
  ) VALUES (
    v_account_id, p_product_id, p_movement_type, p_quantity_delta,
    v_product.current_stock, v_new_stock,
    NULLIF(TRIM(p_reference_number), ''), NULLIF(TRIM(p_reason), ''), auth.uid()
  ) RETURNING * INTO v_movement;

  -- Flip the guard flag for the rest of THIS transaction only
  -- (is_local = true), so the UPDATE below is let through by
  -- guard_products_stock_column and the flag can't leak into any
  -- other concurrent session.
  PERFORM set_config('app.stock_adjustment_in_progress', 'on', true);
  UPDATE products SET current_stock = v_new_stock WHERE id = p_product_id;

  RETURN v_movement;
END;
$$;

ALTER FUNCTION public.adjust_product_stock(UUID, TEXT, NUMERIC, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.adjust_product_stock(UUID, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_product_stock(UUID, TEXT, NUMERIC, TEXT, TEXT) TO authenticated;

-- ============================================================
-- filter_products_by_stock_status(...) — server-side computed-column
-- filter, same shape/reasoning as filter_contacts_by_tags (025).
--
-- stock_status (in_stock / low_stock / out_of_stock) is derived from
-- current_stock vs reorder_level, not a stored column, so it can't be
-- filtered with a plain PostgREST `.eq()`. This does the derivation +
-- filter + windowed total count + pagination server-side.
--
-- SECURITY INVOKER (default) — runs as the caller, so the existing
-- `products_select` RLS policy scopes results to their account. No
-- privilege bypass.
--
-- Sort order is fixed (created_at desc) — same limitation the tag
-- filter already accepts for contacts. The Products page falls back
-- to a plain sortable PostgREST query when no stock-status filter is
-- active.
-- ============================================================
CREATE OR REPLACE FUNCTION public.filter_products_by_stock_status(
  p_stock_status TEXT,
  p_search TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (product products, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT p.*,
      CASE
        WHEN p.current_stock <= 0 THEN 'out_of_stock'
        WHEN p.current_stock <= p.reorder_level THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM products p
    WHERE (
        p_search IS NULL
        OR p.name ILIKE '%' || p_search || '%'
        OR p.sku ILIKE '%' || p_search || '%'
        OR p.barcode ILIKE '%' || p_search || '%'
      )
      AND (p_category IS NULL OR p.category = p_category)
      AND (p_is_active IS NULL OR p.is_active = p_is_active)
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    WHERE stock_status = p_stock_status
    ORDER BY created_at DESC, id DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT p AS product, page.total_count
  FROM page
  JOIN products p ON p.id = page.id
  ORDER BY p.created_at DESC, p.id DESC;
$$;

ALTER FUNCTION public.filter_products_by_stock_status(TEXT, TEXT, TEXT, BOOLEAN, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_products_by_stock_status(TEXT, TEXT, TEXT, BOOLEAN, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_products_by_stock_status(TEXT, TEXT, TEXT, BOOLEAN, INT, INT) TO authenticated;

-- ============================================================
-- product-images storage bucket
--
-- Mirrors chat-media (023) / flow-media (016+020): public read
-- (product photos render straight from the URL in the catalog table,
-- no signed-URL dance needed), account-scoped writes keyed off the
-- object path's first segment (`account-<account_id>/...`), enforced
-- by `uploadAccountMedia()` (src/lib/storage/upload-media.ts) — every
-- caller goes through that helper rather than hand-building a path.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  TRUE,
  5242880, -- 5 MB — matches MEDIA_MAX_BYTES_BY_KIND.image
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Product images are publicly readable" ON storage.objects;
CREATE POLICY "Product images are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Members can upload product images" ON storage.objects;
CREATE POLICY "Members can upload product images"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'product-images'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update product images" ON storage.objects;
CREATE POLICY "Members can update product images"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'product-images'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete product images" ON storage.objects;
CREATE POLICY "Members can delete product images"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'product-images'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
