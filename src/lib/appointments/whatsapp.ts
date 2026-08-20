import type { SupabaseClient } from "@supabase/supabase-js";
import type { Appointment } from "@/types";
import {
  sendMessageToConversation,
  SendMessageError,
} from "@/lib/whatsapp/send-message";
import { formatCurrency } from "@/lib/currency";

/**
 * Appointment-completion WhatsApp send (spec items 25/26). Server-only
 * — reuses `sendMessageToConversation` (the same core `/api/whatsapp/send`
 * and the public `/api/v1/messages` route already call) rather than
 * duplicating Meta-sending logic. Called exclusively from
 * `/api/appointments/[id]/complete/route.ts`, AFTER `complete_appointment()`
 * has already committed — a WhatsApp failure here must never be able to
 * undo a completed appointment, so this function only ever reports
 * success/failure back to the caller; it never throws for an expected
 * failure mode (no template configured, Meta rejected the send, etc).
 *
 * Message content: sent via an APPROVED `message_templates` row named
 * `appointment_completed` — never a hard-coded free-text string. WhatsApp's
 * own policy requires an approved template for a business-initiated
 * message outside the 24h customer-service window anyway, so this is the
 * only correct mechanism, not just the "nicer" one. If the account hasn't
 * created + gotten that template approved yet (the common case for a new
 * install — template approval is an external Meta review step this code
 * can't automate), this cleanly reports "not configured" instead of
 * crashing or sending an unapproved message.
 */

export interface AppointmentWhatsAppResult {
  sent: boolean;
  /** Set when sent=false — surfaced to the UI and logged as the
   *  whatsapp_failed event's payload.detail. */
  reason?: string;
}

const COMPLETION_TEMPLATE_NAME = "appointment_completed";

/** Mirrors `/api/whatsapp/send/route.ts`'s own `findOrCreateConversation` —
 *  duplicated rather than imported because that one is a private,
 *  unexported route-local helper; the logic is ~10 lines and stable. */
async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await db
    .from("conversations")
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
    .select("id")
    .single();
  if (error) {
    console.error("[appointments/whatsapp] failed to create conversation:", error.message);
    return null;
  }
  return created.id;
}

export async function sendAppointmentCompletionMessage(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  appointment: Appointment,
  currency: string,
): Promise<AppointmentWhatsAppResult> {
  if (!appointment.contact_id) {
    return { sent: false, reason: "Appointment has no linked contact" };
  }

  const { data: template } = await db
    .from("message_templates")
    .select("*")
    .eq("name", COMPLETION_TEMPLATE_NAME)
    .eq("status", "APPROVED")
    .maybeSingle();

  if (!template) {
    return {
      sent: false,
      reason: `No approved "${COMPLETION_TEMPLATE_NAME}" WhatsApp template configured — create and submit one in Settings → Templates to enable this message.`,
    };
  }

  const conversationId = await findOrCreateConversation(
    db,
    accountId,
    userId,
    appointment.contact_id,
  );
  if (!conversationId) {
    return { sent: false, reason: "Could not open a conversation for this contact" };
  }

  const serviceNames = (appointment.services ?? []).map((s) => s.name_snapshot).join(", ");

  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: "template",
      templateName: template.name,
      templateLanguage: template.language ?? "en_US",
      // Positional {{1}}..{{n}} body variables — matches the spec's
      // worked example (name, appointment #, service, total). A
      // template configured with a different variable count will
      // reject this with a clear "N variables but M supplied" message
      // (template-send-builder.ts) rather than a confusing Meta 400.
      templateParams: [
        appointment.appointment_number,
        serviceNames || "your service",
        formatCurrency(appointment.total_amount, currency),
      ],
    });
    return { sent: true };
  } catch (err) {
    const reason = err instanceof SendMessageError ? err.message : "Unknown WhatsApp send error";
    return { sent: false, reason };
  }
}
