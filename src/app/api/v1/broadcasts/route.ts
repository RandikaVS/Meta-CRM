// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The broadcast + its recipient rows are persisted synchronously, then
// the Meta fan-out runs in `after()` so the request returns fast. Poll
// `GET /api/v1/broadcasts/{id}` for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';

// The `after()` fan-out below runs the first delivery chunk within this
// route's max duration. deliverBroadcastChunk is time-boxed well under
// that (see its own budgetMs default) and leaves anything it doesn't
// finish as 'pending' — the cron drain (src/app/api/broadcasts/cron)
// picks up from there, so a near-cap (MAX_RECIPIENTS) audience finishes
// over several drain ticks instead of needing this request to survive
// the whole send.
export const maxDuration = 60;
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  deliverBroadcastChunk,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    // Fan out the first chunk after the response is sent. Uses the same
    // service-role client — no request-scoped auth needed for the Meta
    // calls or the account-scoped row updates. Whatever this chunk
    // doesn't finish inside its own time budget stays 'pending' and is
    // picked up by the cron drain (src/app/api/broadcasts/cron).
    after(() => deliverBroadcastChunk(ctx.supabase, plan.broadcastId));

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.totalPlanned,
        accepted: plan.totalPlanned,
        rejected: plan.rejected,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
