// ============================================================
// POST /api/appointments/[id]/complete
//
// The only entry point for finishing an appointment (spec item 24).
// Two independent steps, deliberately NOT wrapped in one all-or-
// nothing operation:
//
//   1. `complete_appointment()` RPC — atomic in the DB: finalizes
//      billing, deducts stock per product line, flips status. Either
//      fully succeeds or fully rolls back (see migration 041).
//   2. Best-effort WhatsApp completion message — an external HTTP
//      call that must never be allowed to roll back a completed
//      appointment. Its outcome (sent / failed + reason) is reported
//      back to the caller and logged as a `whatsapp_sent` /
//      `whatsapp_failed` appointment_events row either way, but a
//      failure here does NOT fail this request — the appointment is
//      already completed by the time step 2 runs.
//
// Retry-safe end to end: step 1 is idempotent (`complete_appointment`
// no-ops on an already-completed appointment, and stock is deducted
// at most once per product line via `stock_movement_id`); step 2
// checks `appointment_events` for an existing `whatsapp_sent` row
// before sending again, so retrying this whole route after a network
// blip never double-completes or double-messages.
// ============================================================

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { loadAppointmentById } from "@/lib/appointments/queries";
import { sendAppointmentCompletionMessage } from "@/lib/appointments/whatsapp";
import { DEFAULT_CURRENCY } from "@/lib/currency";

/** Postgres ERRCODEs the migration 041 RPCs raise, mapped to HTTP
 *  status the same way `toErrorResponse` maps the typed auth errors. */
function statusForPgErrorCode(code: string | undefined): number {
  if (code === "42501") return 403; // insufficient_privilege
  if (code === "22023") return 400; // invalid_parameter_value
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id: appointmentId } = await params;

    const { error: rpcError } = await ctx.supabase.rpc("complete_appointment", {
      p_appointment_id: appointmentId,
    });
    if (rpcError) {
      return NextResponse.json(
        { error: rpcError.message },
        { status: statusForPgErrorCode((rpcError as { code?: string }).code) },
      );
    }

    const appointment = await loadAppointmentById(ctx.supabase, appointmentId);
    if (!appointment) {
      return NextResponse.json({ error: "Appointment not found after completion" }, { status: 500 });
    }

    // Idempotency check — a retry of this route (client timeout,
    // browser refresh mid-request) must not send a second WhatsApp
    // message for a completion that already notified the customer.
    const { data: alreadySent } = await ctx.supabase
      .from("appointment_events")
      .select("id")
      .eq("appointment_id", appointmentId)
      .eq("event_type", "whatsapp_sent")
      .limit(1)
      .maybeSingle();

    let whatsapp: { sent: boolean; reason?: string; skipped?: boolean };
    if (alreadySent) {
      whatsapp = { sent: true, skipped: true };
    } else {
      const { data: account } = await ctx.supabase
        .from("accounts")
        .select("default_currency")
        .eq("id", ctx.accountId)
        .maybeSingle();

      whatsapp = await sendAppointmentCompletionMessage(
        ctx.supabase,
        ctx.accountId,
        ctx.userId,
        appointment,
        account?.default_currency ?? DEFAULT_CURRENCY,
      );

      // Log the outcome either way — this IS the audit trail item
      // 25/26 ask for ("WhatsApp message sent" / "WhatsApp message
      // failed"). Best-effort: a logging failure shouldn't fail the
      // response for a completion that already succeeded.
      await ctx.supabase
        .rpc("record_whatsapp_event", {
          p_appointment_id: appointmentId,
          p_sent: whatsapp.sent,
          p_detail: whatsapp.reason ?? null,
        })
        .then(({ error }) => {
          if (error) console.error("[appointments/complete] failed to log whatsapp event:", error.message);
        });
    }

    return NextResponse.json({ appointment, whatsapp });
  } catch (err) {
    return toErrorResponse(err);
  }
}
