// ============================================================
// Broadcast core — durable, resumable delivery.
//
// Two phases, deliberately decoupled by nothing but the DB:
//
//   createBroadcast()      — validate, resolve contacts, persist the
//                            `broadcasts` row + `broadcast_recipients`
//                            rows (status 'pending', each carrying its
//                            own send-time `params`/`message_params`).
//   deliverBroadcastChunk() — claim + send a bounded, time-boxed batch
//                            of still-pending recipients, then report
//                            back how much work is left.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for every broadcast exactly the same way regardless of which caller
// created it.
//
// Why "chunk" and not "deliver everything": a broadcast can have up to
// MAX_RECIPIENTS recipients, and neither an HTTP request's timeout nor
// a browser tab staying open is a safe unit of work for that. Every
// recipient's `params` is persisted at creation time specifically so
// deliverBroadcastChunk can be called by a completely different process
// invocation than the one that created the broadcast — see
// src/app/api/broadcasts/cron/route.ts, which calls it on a schedule
// to drain whatever a previous chunk (or a crashed one) didn't finish.
// Two overlapping chunk calls for the same broadcast can't double-send
// a recipient: each row is atomically claimed (status 'pending' ->
// 'sending') immediately before it's dispatched, and a claim that never
// completes (the process was killed mid-send) is swept back to
// 'pending' by the next chunk call after STALE_CLAIM_MS.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
  /** Structured per-send values (header text/media, button values). */
  messageParams?: SendTimeParams;
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

export interface CreatedBroadcast {
  broadcastId: string;
  /** Recipients actually persisted (post-validation, post-dedup). */
  totalPlanned: number;
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact and persisting its send-time params on the recipient row.
 * Throws {@link BroadcastError} on bad input / missing config / a
 * malformed template / a DB failure. Nothing is sent in this phase —
 * call {@link deliverBroadcastChunk} (typically via `after()`) to
 * start sending.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<CreatedBroadcast> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Fail fast if WhatsApp isn't configured — deliverBroadcastChunk will
  // need this too, but there's no point persisting rows we already know
  // can't be sent.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // Template row is optional at creation time (Meta will reject the
  // send later if the name/language don't resolve to an approved
  // template) but validate the *shape* now if a local row exists, so a
  // malformed row fails loudly here instead of as N identical opaque
  // failures once sending starts.
  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: {
    contactId: string;
    phone: string;
    params: string[];
    messageParams?: SendTimeParams;
  }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
      messageParams: r.messageParams,
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name || `API broadcast (${templateName})`,
      template_name: templateName,
      template_language: templateLanguage,
      status: 'sending',
      total_recipients: deduped.length,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] create broadcast error:', bErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // params/message_params are persisted per row (not kept in memory)
  // so deliverBroadcastChunk can resolve exactly what to send from the
  // DB alone, whether it's called from this request's after() or from
  // a later, unrelated cron invocation.
  const { error: rErr } = await db.from('broadcast_recipients').insert(
    deduped.map((r) => ({
      broadcast_id: broadcast.id,
      contact_id: r.contactId,
      status: 'pending' as const,
      params: r.params,
      message_params: r.messageParams ?? null,
    }))
  );
  if (rErr) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  return { broadcastId: broadcast.id as string, totalPlanned: deduped.length, rejected };
}

export interface DeliverChunkOptions {
  /** Wall-clock budget for this call; stop starting new sends past it. */
  budgetMs?: number;
  /** Max recipients to claim + send in this call, budget allowing. */
  maxRecipients?: number;
  /** How many sends run concurrently. */
  concurrency?: number;
}

export interface DeliverChunkResult {
  broadcastId: string;
  sent: number;
  failed: number;
  /** Recipients still pending or mid-send after this call returns. */
  remaining: number;
  /** True once the broadcast reached a terminal status (sent/failed). */
  finished: boolean;
}

const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_MAX_RECIPIENTS = 500;
const DEFAULT_CONCURRENCY = 8;
const FETCH_PAGE_SIZE = 50;
/** A 'sending' claim older than this with no result is assumed dead
 *  (the process that claimed it was killed/evicted mid-send). */
const STALE_CLAIM_MS = 5 * 60_000;

interface RecipientCandidate {
  id: string;
  params: unknown;
  message_params: unknown;
  contact: { phone: string | null } | null;
}

/**
 * Claim and send up to `maxRecipients` still-pending recipients of
 * `broadcastId`, time-boxed to `budgetMs`. Safe to call repeatedly
 * (from `after()`, and again from the cron drain) until it reports
 * `finished: true` — every recipient not finished by this call is left
 * exactly as it was (`pending`), ready for the next call to pick up.
 */
export async function deliverBroadcastChunk(
  db: SupabaseClient,
  broadcastId: string,
  options: DeliverChunkOptions = {}
): Promise<DeliverChunkResult> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxRecipients = options.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const deadline = Date.now() + budgetMs;

  // Self-heal claims abandoned by a crashed/evicted previous attempt
  // before doing anything else, so this call can pick them back up.
  await db
    .from('broadcast_recipients')
    .update({ status: 'pending', claimed_at: null })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'sending')
    .lt('claimed_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());

  // Resolve everything needed to send fresh from the DB — this call
  // may be a completely separate process invocation from the one that
  // created the broadcast, so nothing about *how* to send can ride
  // along in memory.
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .select('id, account_id, template_name, template_language, status')
    .eq('id', broadcastId)
    .maybeSingle();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] deliverBroadcastChunk: broadcast not found', broadcastId, bErr);
    return { broadcastId, sent: 0, failed: 0, remaining: 0, finished: true };
  }
  // Already terminal — a previous chunk finished it, or a human
  // canceled it. Nothing to do.
  if (broadcast.status !== 'sending') {
    return { broadcastId, sent: 0, failed: 0, remaining: 0, finished: true };
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', broadcast.account_id)
    .single();
  if (!config) {
    await db
      .from('broadcasts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', broadcastId);
    return { broadcastId, sent: 0, failed: 0, remaining: 0, finished: true };
  }
  const accessToken = decrypt(config.access_token);
  const phoneNumberId = config.phone_number_id as string;

  // Pulled into locals (not read off `broadcast` inside the `sendOne`
  // closure below) so TS's null-narrowing above actually applies —
  // narrowing on a captured outer `const` doesn't survive into a
  // nested function declaration.
  const templateName = broadcast.template_name as string;
  const templateLanguage = broadcast.template_language as string;

  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();
  const templateRow =
    rawTemplateRow && isMessageTemplate(rawTemplateRow)
      ? (rawTemplateRow as MessageTemplate)
      : null;

  let sent = 0;
  let failed = 0;

  async function sendOne(row: RecipientCandidate) {
    const phone = row.contact?.phone;
    if (!phone) {
      failed++;
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'Contact has no phone number', claimed_at: null })
        .eq('id', row.id);
      return;
    }

    const variants = phoneVariants(sanitizePhoneForMeta(phone));
    const bodyParams = Array.isArray(row.params)
      ? row.params.filter((p): p is string => typeof p === 'string')
      : [];
    const messageParams = (row.message_params ?? undefined) as SendTimeParams | undefined;

    let sentMessageId: string | null = null;
    let lastError: string | null = null;
    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to: variant,
          templateName,
          language: templateLanguage,
          template: templateRow ?? undefined,
          messageParams,
          params: bodyParams,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      sent++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
          claimed_at: null,
        })
        .eq('id', row.id);
    } else {
      failed++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
          claimed_at: null,
        })
        .eq('id', row.id);
    }
  }

  let claimedThisCall = 0;
  while (claimedThisCall < maxRecipients && Date.now() < deadline) {
    const pageSize = Math.min(FETCH_PAGE_SIZE, maxRecipients - claimedThisCall);
    const { data: candidates } = await db
      .from('broadcast_recipients')
      .select('id, params, message_params, contact:contacts(phone)')
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(pageSize);

    if (!candidates || candidates.length === 0) break; // no more pending work

    // Bounded-concurrency worker pool over this page. Each row is
    // atomically claimed (pending -> sending) immediately before
    // dispatch, right here — never claimed ahead of when it's actually
    // about to be sent — so a concurrent drainer racing on the same
    // page just loses the claim and moves on instead of double-sending.
    let cursor = 0;
    const rows = candidates as unknown as RecipientCandidate[];
    async function worker() {
      while (cursor < rows.length && Date.now() < deadline) {
        const row = rows[cursor++];
        const { data: claim } = await db
          .from('broadcast_recipients')
          .update({ status: 'sending', claimed_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle();
        if (!claim) continue; // lost the race to another drainer
        claimedThisCall++;
        await sendOne(row);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  const { count: remaining } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', ['pending', 'sending']);

  let finished = false;
  if ((remaining ?? 0) === 0) {
    finished = true;
    // Terminal status only — the per-status count columns are
    // trigger-owned (see the note on the insert above). A partial send
    // is still 'sent' (per-recipient failures show in failed_count);
    // only a total wipeout is 'failed'.
    const { count: notFailed } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .neq('status', 'failed');
    await db
      .from('broadcasts')
      .update({
        status: (notFailed ?? 0) > 0 ? 'sent' : 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', broadcastId);
  }

  return { broadcastId, sent, failed, remaining: remaining ?? 0, finished };
}
