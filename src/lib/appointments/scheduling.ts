/**
 * Pure scheduling helpers — conflict math, slot formatting, duration
 * arithmetic. No I/O. The DB is still the source of truth for
 * conflict-safety (the `appointments_no_staff_overlap` GiST EXCLUDE
 * constraint, migration 041) — these helpers exist purely for fast,
 * synchronous UI feedback (disabling a slot, showing "Sarah is
 * already booked from…") before the round trip confirms it.
 */

export interface TimeRange {
  start: Date | string;
  end: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** True if two half-open ranges [start, end) overlap. Mirrors the
 *  Postgres `tstzrange(...) && tstzrange(...)` check used by the
 *  EXCLUDE constraint and `check_appointment_conflicts`. */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  const aStart = toDate(a.start).getTime();
  const aEnd = toDate(a.end).getTime();
  const bStart = toDate(b.start).getTime();
  const bEnd = toDate(b.end).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/** `start + durationMinutes` as a Date — used to default `end_at`
 *  when a service's duration is picked in the create form. */
export function addMinutes(start: Date | string, minutes: number): Date {
  return new Date(toDate(start).getTime() + minutes * 60_000);
}

/** Whole-minute duration between two times, never negative. */
export function durationMinutes(start: Date | string, end: Date | string): number {
  const ms = toDate(end).getTime() - toDate(start).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

export class SchedulingError extends Error {}

/** Client-side pre-check before attempting to save — throws with a
 *  user-facing message when `start`/`end` are structurally invalid.
 *  Does NOT check for staff conflicts (that needs the DB); this is
 *  purely "did the user pick a sane range". */
export function validateTimeRange(start: Date | string, end: Date | string): void {
  const s = toDate(start);
  const e = toDate(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    throw new SchedulingError('Enter a valid date and time');
  }
  if (e.getTime() <= s.getTime()) {
    throw new SchedulingError('End time must be after start time');
  }
}

/** Format a single conflicting appointment as the spec's example:
 *  "Sarah is already booked from 11:30 AM to 12:30 PM." */
export function formatConflictMessage(
  staffName: string,
  conflict: TimeRange,
): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${staffName} is already booked from ${fmt(toDate(conflict.start))} to ${fmt(toDate(conflict.end))}.`;
}
