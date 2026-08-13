-- ============================================================
-- 037_account_branding.sql
--
-- Lets the account owner (admin+) customise the sidebar branding:
--   - accounts.logo_url  — replaces the default sidebar icon
--   - accounts.brand_name — replaces the hardcoded "Sidebar.title"
--     string shown next to it
--
-- Both are nullable; null means "use the app default" (icon + the
-- Sidebar.title translation), so no backfill is needed and existing
-- accounts render unchanged until someone opts in from
-- Settings → Appearance.
--
-- Storage: a new public `logos` bucket, one object per account at
-- `logos/{account_id}/logo-<timestamp>.<ext>`, mirroring the
-- `avatars` bucket convention from 008 but keyed by account id
-- instead of user id. Read is public (sidebars render unauthenticated
-- <img> tags); write is restricted to admins+ of that account via the
-- is_account_member() helper from 017.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_name TEXT;

-- Keep it sane — same ballpark as other short display-name columns in
-- this codebase (contacts.name etc use no limit, but a logo caption
-- rendered next to a 32px icon has no use for more than this).
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_brand_name_length;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_brand_name_length
  CHECK (brand_name IS NULL OR char_length(brand_name) <= 80);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'logos',
  'logos',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Logos are publicly readable" ON storage.objects;
CREATE POLICY "Logos are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'logos');

-- Path convention: the first segment is the target account's id, so
-- (storage.foldername(name))[1]::uuid must be an account the caller
-- is an admin+ member of.
DROP POLICY IF EXISTS "Admins can upload their account logo" ON storage.objects;
CREATE POLICY "Admins can upload their account logo"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Admins can update their account logo" ON storage.objects;
CREATE POLICY "Admins can update their account logo"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Admins can delete their account logo" ON storage.objects;
CREATE POLICY "Admins can delete their account logo"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

-- accounts.logo_url / brand_name themselves are covered by the
-- existing `accounts_update` policy (017, admin+) — no new policy
-- needed on the accounts table.
