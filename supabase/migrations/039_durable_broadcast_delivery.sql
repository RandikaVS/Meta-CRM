-- ============================================================
-- 039: durable, resumable broadcast delivery
-- ============================================================
--
-- Both broadcast send paths (dashboard wizard and the public
-- /api/v1/broadcasts API) previously fanned out to every recipient in
-- one long-running loop tied to a single request/browser-tab lifetime:
-- the dashboard path ran the whole send loop in the browser (dead the
-- moment the tab closes, the laptop sleeps, or the network blips), and
-- the API path ran it inside one `after()` callback bounded by the
-- route's maxDuration — both leave `broadcast_recipients` rows stuck
-- 'pending' forever with no way to resume if interrupted mid-campaign.
--
-- This migration adds what src/lib/whatsapp/broadcast-core.ts needs to
-- process a broadcast in resumable chunks, driven by either the
-- request that created it OR a scheduled cron drain
-- (src/app/api/broadcasts/cron/route.ts):
--
--   * params/message_params — per-recipient send-time values, persisted
--     at creation time so a *later, separate* process invocation (the
--     cron drain) can reconstruct exactly what to send without needing
--     the in-memory plan that created the broadcast.
--   * 'sending' status + claimed_at — an atomic claim so two overlapping
--     drainers (e.g. the initial after() call and a cron tick that fires
--     before it finishes) can't send the same recipient twice. A claim
--     older than 5 minutes with nothing to show for it is assumed to be
--     dead (function crashed / evicted mid-send) and is swept back to
--     'pending' by the next drain.

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS message_params JSONB,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'replied', 'failed'));

-- Backs both the drain's "give me the next page of pending work" query
-- and the reclaim sweep's "find stale claims" query, per broadcast.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_inflight
  ON broadcast_recipients (broadcast_id, status)
  WHERE status IN ('pending', 'sending');

-- Backs the cron drain's "which broadcasts still need work" scan.
CREATE INDEX IF NOT EXISTS idx_broadcasts_sending
  ON broadcasts (id)
  WHERE status = 'sending';
