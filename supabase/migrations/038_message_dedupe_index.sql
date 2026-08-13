-- ============================================================
-- 038: composite index backing the inbound webhook dedupe check
-- ============================================================
--
-- src/app/api/whatsapp/webhook/route.ts now guards every inbound insert
-- with:
--
--   SELECT id FROM messages
--   WHERE conversation_id = ? AND message_id = ? AND sender_type = 'customer'
--
-- run on EVERY inbound webhook delivery (including retries, which is the
-- point of the check). The existing idx_messages_message_id index only
-- covers message_id, so this query still has to fan out across every
-- conversation sharing that Meta id. A composite index makes it a single
-- index lookup instead, which matters once an account has real volume —
-- this check is now on the hot path for every inbound message from every
-- customer chatting concurrently.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_message_dedupe
  ON messages (conversation_id, message_id, sender_type);
