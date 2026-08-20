import type { SupabaseClient } from "@supabase/supabase-js";
import type { Appointment, AppointmentServiceLine, AppointmentProductLine } from "@/types";

/**
 * Thin wrappers around the migration-041 RPCs, one function per
 * server-side operation — mirrors `src/lib/products/stock-api.ts`'s
 * shape (typed params in, typed row out, errors normalized to one
 * class). Every appointment-mutating call in the UI should go through
 * here rather than hand-rolling `.rpc(...)` at the call site, so the
 * RPC contract only has to be known in one place.
 */

export class AppointmentApiError extends Error {}

// `db.rpc(...)` returns a PostgrestFilterBuilder — thenable, but not
// structurally a `Promise` — so `wrap` takes a `PromiseLike` rather
// than `Promise` to accept it directly without an intermediate cast.
function wrap<T>(
  builder: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  return Promise.resolve(builder).then(({ data, error }) => {
    if (error) throw new AppointmentApiError(error.message);
    return data;
  });
}

export interface RescheduleParams {
  appointmentId: string;
  startAt: string;
  endAt: string;
  staffId: string;
  overrideReason?: string | null;
}

export function rescheduleAppointment(
  db: SupabaseClient,
  { appointmentId, startAt, endAt, staffId, overrideReason }: RescheduleParams,
): Promise<Appointment> {
  return wrap(
    db.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_start_at: startAt,
      p_end_at: endAt,
      p_staff_id: staffId,
      p_override_reason: overrideReason ?? null,
    }),
  );
}

export function updateAppointmentStatus(
  db: SupabaseClient,
  appointmentId: string,
  newStatus: string,
  reason?: string | null,
): Promise<Appointment> {
  return wrap(
    db.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: newStatus,
      p_reason: reason ?? null,
    }),
  );
}

/**
 * Completion itself (billing finalization + stock deduction) is a
 * plain RPC call — safe to call directly since it's fully atomic in
 * the DB. The WhatsApp send that follows a successful completion is
 * NOT here: that's an external HTTP call that must never be allowed
 * to roll back a completed appointment, so it's driven by
 * `/api/appointments/[id]/complete` (a thin route that calls this RPC
 * first, then best-effort sends the message) rather than from the
 * client directly. UI code should call that route, not this function,
 * for the "Complete" action — this export exists for anything that
 * only needs the DB-side completion (e.g. a future admin tool) without
 * the WhatsApp side effect.
 */
export function completeAppointmentRpc(db: SupabaseClient, appointmentId: string): Promise<Appointment> {
  return wrap(db.rpc("complete_appointment", { p_appointment_id: appointmentId }));
}

export function recordAppointmentPayment(
  db: SupabaseClient,
  appointmentId: string,
  amount: number,
  method: string,
  note?: string | null,
): Promise<Appointment> {
  return wrap(
    db.rpc("record_appointment_payment", {
      p_appointment_id: appointmentId,
      p_amount: amount,
      p_method: method,
      p_note: note ?? null,
    }),
  );
}

export function checkAppointmentConflicts(
  db: SupabaseClient,
  staffId: string,
  startAt: string,
  endAt: string,
  excludeAppointmentId?: string | null,
): Promise<Appointment[]> {
  return wrap(
    db.rpc("check_appointment_conflicts", {
      p_staff_id: staffId,
      p_start_at: startAt,
      p_end_at: endAt,
      p_exclude_appointment_id: excludeAppointmentId ?? null,
    }),
  );
}

export interface AvailableSlot {
  slot_start: string;
  slot_end: string;
}

export function suggestAvailableSlots(
  db: SupabaseClient,
  staffId: string,
  date: string,
  durationMinutes: number,
  limit = 5,
): Promise<AvailableSlot[]> {
  return wrap(
    db.rpc("suggest_available_slots", {
      p_staff_id: staffId,
      p_date: date,
      p_duration_minutes: durationMinutes,
      p_limit: limit,
    }),
  );
}

// ------------------------------------------------------------
// Line items — plain table writes (RLS + the billed-appointment
// guard trigger enforce the rules; no RPC needed for these).
// ------------------------------------------------------------

export interface AddServiceLineParams {
  appointmentId: string;
  serviceId: string | null;
  nameSnapshot: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  durationMinutes?: number;
}

export async function addAppointmentServiceLine(
  db: SupabaseClient,
  params: AddServiceLineParams,
): Promise<AppointmentServiceLine> {
  const { data, error } = await db
    .from("appointment_services")
    .insert({
      appointment_id: params.appointmentId,
      service_id: params.serviceId,
      name_snapshot: params.nameSnapshot,
      quantity: params.quantity,
      unit_price: params.unitPrice,
      discount_amount: params.discountAmount ?? 0,
      duration_minutes: params.durationMinutes ?? 0,
    })
    .select()
    .single();
  if (error) throw new AppointmentApiError(error.message);
  return data as AppointmentServiceLine;
}

export async function removeAppointmentServiceLine(db: SupabaseClient, lineId: string): Promise<void> {
  const { error } = await db.from("appointment_services").delete().eq("id", lineId);
  if (error) throw new AppointmentApiError(error.message);
}

export interface AddProductLineParams {
  appointmentId: string;
  productId: string;
  nameSnapshot: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
}

export async function addAppointmentProductLine(
  db: SupabaseClient,
  params: AddProductLineParams,
): Promise<AppointmentProductLine> {
  const { data, error } = await db
    .from("appointment_products")
    .insert({
      appointment_id: params.appointmentId,
      product_id: params.productId,
      name_snapshot: params.nameSnapshot,
      quantity: params.quantity,
      unit_price: params.unitPrice,
      discount_amount: params.discountAmount ?? 0,
    })
    .select()
    .single();
  if (error) throw new AppointmentApiError(error.message);
  return data as AppointmentProductLine;
}

export async function removeAppointmentProductLine(db: SupabaseClient, lineId: string): Promise<void> {
  const { error } = await db.from("appointment_products").delete().eq("id", lineId);
  if (error) throw new AppointmentApiError(error.message);
}
