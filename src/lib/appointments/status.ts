import type { AppointmentStatus } from "@/types";

/**
 * Status-transition rules — mirrors
 * `validate_appointment_status_transition()` (migration 041) exactly,
 * so the UI only ever offers actions the server will actually accept.
 * The DB trigger remains the enforced source of truth (this is for
 * disabling/hiding buttons, not the security boundary).
 */

const FORWARD_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'],
  confirmed: ['scheduled', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  // A completed appointment may only be voided (admin+) — enforced below.
  completed: ['cancelled'],
  // A cancelled appointment may only be reopened to scheduled (admin+).
  cancelled: ['scheduled'],
  no_show: ['scheduled', 'cancelled'],
  rescheduled: ['scheduled', 'cancelled'],
};

/** Transitions the DB trigger requires admin+ for, regardless of what
 *  FORWARD_TRANSITIONS allows structurally — reopening or voiding a
 *  finalized record. */
function requiresAdmin(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === 'cancelled' && to !== 'cancelled') return true;
  if (from === 'completed' && to === 'cancelled') return true;
  return false;
}

/**
 * Whether `from -> to` is an offerable transition for this caller.
 * `to === 'completed'` is deliberately never allowed here — completion
 * always goes through the dedicated complete-appointment flow (needs
 * billing + stock deduction), never a plain status change.
 */
export function canTransitionStatus(
  from: AppointmentStatus,
  to: AppointmentStatus,
  isAdmin: boolean,
): boolean {
  if (to === 'completed') return false;
  if (from === to) return false;
  if (!FORWARD_TRANSITIONS[from]?.includes(to)) return false;
  if (requiresAdmin(from, to) && !isAdmin) return false;
  return true;
}

/** Statuses offerable as a next step from `current` (excludes
 *  'completed' — see canTransitionStatus). Used to build the status
 *  action menu. */
export function nextStatusOptions(current: AppointmentStatus, isAdmin: boolean): AppointmentStatus[] {
  return (FORWARD_TRANSITIONS[current] ?? []).filter((next) =>
    canTransitionStatus(current, next, isAdmin),
  );
}

/** True once nothing about the schedule/financials can change without
 *  an admin correction (mirrors `appointments.is_billed`). Purely a
 *  UI hint — the actual field lock is `guard_appointment_billed_edits`. */
export function isTerminalStatus(status: AppointmentStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export const STATUS_ORDER: AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'no_show',
  'cancelled',
  'rescheduled',
];
