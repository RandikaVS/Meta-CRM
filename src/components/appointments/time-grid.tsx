"use client";

import type { Appointment, AppointmentStatus } from "@/types";

/**
 * Hour-scale positioned-block grid — the shared rendering engine
 * behind both the Calendar's Day view (columns = staff, spec item 17's
 * "each staff member has their own column" resource layout) and Week
 * view (columns = date). One component, two grouping strategies, so
 * conflicts are visually obvious in both ("two blocks in the same
 * column overlapping vertically" reads instantly as a double-booking)
 * without maintaining two separate layout implementations.
 */

export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 20;
const PX_PER_MINUTE = 1; // 60px per hour — tall enough to read a 15-30min block's title.

export interface GridColumn {
  key: string;
  label: string;
}

const STATUS_BLOCK_TONE: Record<AppointmentStatus, string> = {
  scheduled: "bg-muted border-border text-foreground",
  confirmed: "bg-primary/15 border-primary/40 text-primary",
  checked_in: "bg-primary/15 border-primary/40 text-primary",
  in_progress: "bg-amber-500/15 border-amber-500/40 text-amber-300",
  completed: "bg-primary/10 border-primary/30 text-primary/80",
  cancelled: "bg-red-500/10 border-red-500/30 text-red-300/70 line-through",
  no_show: "bg-red-500/10 border-red-500/30 text-red-300/70",
  rescheduled: "bg-muted border-border text-muted-foreground",
};

function minutesFromDayStart(iso: string, referenceDate: Date): number {
  const d = new Date(iso);
  const start = new Date(referenceDate);
  start.setHours(DAY_START_HOUR, 0, 0, 0);
  return (d.getTime() - start.getTime()) / 60_000;
}

export interface TimeGridProps {
  columns: GridColumn[];
  /** Appointments already filtered to the visible range. */
  appointments: Appointment[];
  /** Which column an appointment belongs to. */
  columnKeyFor: (appointment: Appointment) => string;
  /** The calendar day used to compute each column's midnight (Week
   *  view passes a different date per column via `dateFor`). */
  dateFor: (columnKey: string) => Date;
  onSlotClick: (columnKey: string, time: Date) => void;
  onAppointmentClick: (appointment: Appointment) => void;
}

export function TimeGrid({ columns, appointments, columnKeyFor, dateFor, onSlotClick, onAppointmentClick }: TimeGridProps) {
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  const totalHeight = (DAY_END_HOUR - DAY_START_HOUR) * 60 * PX_PER_MINUTE;

  const byColumn = new Map<string, Appointment[]>();
  for (const col of columns) byColumn.set(col.key, []);
  for (const appt of appointments) {
    const key = columnKeyFor(appt);
    if (byColumn.has(key)) byColumn.get(key)!.push(appt);
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="flex min-w-[560px]">
        {/* Hour rail */}
        <div className="w-14 shrink-0 border-r border-border">
          <div className="h-9 border-b border-border" />
          <div style={{ height: totalHeight }} className="relative">
            {hours.map((h) => (
              <div
                key={h}
                style={{ top: (h - DAY_START_HOUR) * 60 * PX_PER_MINUTE }}
                className="absolute -translate-y-1/2 pr-2 text-right text-[11px] text-muted-foreground"
              >
                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })}
              </div>
            ))}
          </div>
        </div>

        {/* Columns */}
        {columns.map((col) => (
          <div key={col.key} className="min-w-[140px] flex-1 border-r border-border last:border-r-0">
            <div className="flex h-9 items-center justify-center border-b border-border px-2 text-xs font-medium text-foreground">
              {col.label}
            </div>
            <div
              style={{ height: totalHeight }}
              className="relative cursor-pointer bg-[linear-gradient(to_bottom,transparent_59px,var(--border)_60px)] bg-[length:100%_60px]"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const minutes = Math.round(y / PX_PER_MINUTE / 15) * 15;
                const time = new Date(dateFor(col.key));
                time.setHours(DAY_START_HOUR, 0, 0, 0);
                time.setMinutes(time.getMinutes() + minutes);
                onSlotClick(col.key, time);
              }}
            >
              {(byColumn.get(col.key) ?? []).map((appt) => {
                const ref = dateFor(col.key);
                const top = Math.max(0, minutesFromDayStart(appt.start_at, ref)) * PX_PER_MINUTE;
                const height = Math.max(
                  18,
                  (minutesFromDayStart(appt.end_at, ref) - minutesFromDayStart(appt.start_at, ref)) * PX_PER_MINUTE,
                );
                return (
                  <button
                    key={appt.id}
                    type="button"
                    style={{ top, height }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAppointmentClick(appt);
                    }}
                    className={`absolute inset-x-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm ${STATUS_BLOCK_TONE[appt.status]}`}
                  >
                    <span className="block truncate font-medium">
                      {new Date(appt.start_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </span>
                    <span className="block truncate">{appt.contact?.name || "—"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
