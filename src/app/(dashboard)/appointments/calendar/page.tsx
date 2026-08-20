"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Appointment, Profile } from "@/types";
import { loadCalendarAppointments, loadStaffList } from "@/lib/appointments/queries";
import { formatCurrency } from "@/lib/currency";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { TimeGrid, type GridColumn } from "@/components/appointments/time-grid";
import { AppointmentForm } from "@/components/appointments/appointment-form";
import { AppointmentDetailSheet } from "@/components/appointments/appointment-detail-sheet";
import { RescheduleDialog } from "@/components/appointments/reschedule-dialog";
import { ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";

type ViewMode = "day" | "week" | "agenda" | "month";

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
/** Monday-start week, matching the app's other Mon-first conventions. */
function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  const jsDow = out.getDay(); // 0=Sun..6=Sat
  const diff = (jsDow + 6) % 7; // days since Monday
  return addDays(out, -diff);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export default function AppointmentsCalendarPage() {
  const t = useTranslations("Appointments.calendar");
  const supabase = createClient();
  const { defaultCurrency } = useAuth();
  const canManage = useCan("send-messages");

  const [view, setView] = useState<ViewMode>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [staffFilter, setStaffFilter] = useState("");
  const [staffList, setStaffList] = useState<Profile[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [quickCreate, setQuickCreate] = useState<{ staffId: string; startAt: string } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);

  useEffect(() => {
    loadStaffList(supabase).then(setStaffList).catch(() => {});
  }, [supabase]);

  const range = useMemo(() => {
    if (view === "day") return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1) };
    if (view === "month") {
      const start = startOfMonth(anchor);
      return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
    }
    // week + agenda share a 7-day window
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 7) };
  }, [view, anchor]);

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await loadCalendarAppointments(supabase, {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        staffId: staffFilter || null,
      });
      setAppointments(rows);
    } catch {
      toast.error(t("toastFailedLoad"));
    } finally {
      setLoading(false);
    }
  }, [supabase, range, staffFilter, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAppointments();
  }, [fetchAppointments]);

  function navigate(delta: number) {
    if (view === "day") setAnchor((d) => addDays(d, delta));
    else if (view === "month") setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
    else setAnchor((d) => addDays(d, delta * 7));
  }

  function openDetail(appointment: Appointment) {
    setDetailId(appointment.id);
    setDetailOpen(true);
  }

  function openQuickCreate(staffId: string, time: Date) {
    if (!canManage) return;
    setQuickCreate({ staffId, startAt: time.toISOString() });
    setFormOpen(true);
  }

  // Day view: one column per staff member (spec item 17's resource
  // layout) — or a single column when a specific staff is filtered.
  const dayColumns: GridColumn[] = useMemo(() => {
    const list = staffFilter ? staffList.filter((s) => s.id === staffFilter) : staffList;
    return list.map((s) => ({ key: s.id, label: s.full_name || t("unassigned") }));
  }, [staffList, staffFilter, t]);

  // Week view: one column per date, independent of staff filter (the
  // staff filter just narrows which appointments populate each day).
  const weekColumns: GridColumn[] = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(range.start, i);
      return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) };
    });
  }, [range.start]);

  const monthDays = useMemo(() => {
    if (view !== "month") return [];
    const gridStart = startOfWeek(range.start);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [view, range.start]);

  const headerLabel =
    view === "day"
      ? anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : view === "month"
        ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
        : `${range.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${addDays(range.end, -1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <GatedButton
          canAct={canManage}
          gateReason="create appointments"
          onClick={() => {
            setQuickCreate(null);
            setFormOpen(true);
          }}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="size-4" />
          {t("newAppointment")}
        </GatedButton>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => navigate(-1)} className="border-border text-muted-foreground hover:bg-muted">
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAnchor(new Date())}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("today")}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => navigate(1)} className="border-border text-muted-foreground hover:bg-muted">
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-1 text-sm font-medium text-foreground">{headerLabel}</span>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
          >
            <option value="">{t("allStaff")}</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
          <div className="flex items-center rounded-lg border border-border p-0.5">
            {(["day", "week", "month", "agenda"] as ViewMode[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  view === v ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {t(`view.${v}` as string)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : view === "day" ? (
        <TimeGrid
          columns={dayColumns.length > 0 ? dayColumns : [{ key: "none", label: t("noStaff") }]}
          appointments={appointments}
          columnKeyFor={(a) => a.staff_id ?? "none"}
          dateFor={() => anchor}
          onSlotClick={openQuickCreate}
          onAppointmentClick={openDetail}
        />
      ) : view === "week" ? (
        <TimeGrid
          columns={weekColumns}
          appointments={appointments}
          columnKeyFor={(a) => a.start_at.slice(0, 10)}
          dateFor={(key) => new Date(key)}
          onSlotClick={(key, time) => openQuickCreate(staffFilter, time)}
          onAppointmentClick={openDetail}
        />
      ) : view === "month" ? (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
          {monthDays.map((day) => {
            const dayKey = day.toISOString().slice(0, 10);
            const dayAppointments = appointments.filter((a) => a.start_at.slice(0, 10) === dayKey);
            const inMonth = day.getMonth() === anchor.getMonth();
            return (
              <button
                key={dayKey}
                onClick={() => {
                  setAnchor(day);
                  setView("day");
                }}
                className={`min-h-24 space-y-1 bg-card p-1.5 text-left hover:bg-muted/50 ${!inMonth ? "opacity-40" : ""}`}
              >
                <span className="text-xs text-muted-foreground">{day.getDate()}</span>
                {dayAppointments.slice(0, 3).map((a) => (
                  <span key={a.id} className="block truncate rounded bg-primary/10 px-1 text-[10px] text-primary">
                    {new Date(a.start_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} {a.contact?.name}
                  </span>
                ))}
                {dayAppointments.length > 3 && (
                  <span className="block text-[10px] text-muted-foreground">
                    {t("moreCount", { count: dayAppointments.length - 3 })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        // Agenda view
        <div className="space-y-4">
          {appointments.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t("noAppointments")}</p>
          ) : (
            Array.from(new Set(appointments.map((a) => a.start_at.slice(0, 10)))).map((dayKey) => (
              <div key={dayKey}>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {new Date(dayKey).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {appointments
                    .filter((a) => a.start_at.slice(0, 10) === dayKey)
                    .map((a) => (
                      <li key={a.id}>
                        <button
                          onClick={() => openDetail(a)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50"
                        >
                          <span className="w-14 shrink-0 text-xs text-muted-foreground">
                            {new Date(a.start_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{a.contact?.name || "—"}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{a.staff?.full_name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatCurrency(a.total_amount, defaultCurrency)}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          )}
        </div>
      )}

      <AppointmentForm
        open={formOpen}
        onOpenChange={setFormOpen}
        defaultStaffId={quickCreate?.staffId}
        defaultStartAt={quickCreate?.startAt}
        onSaved={() => fetchAppointments()}
      />
      <AppointmentDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        appointmentId={detailId}
        onEdit={() => setDetailOpen(false)}
        onReschedule={(a) => {
          setDetailOpen(false);
          setRescheduleTarget(a);
          setRescheduleOpen(true);
        }}
        onChanged={fetchAppointments}
      />
      <RescheduleDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        appointment={rescheduleTarget}
        onRescheduled={fetchAppointments}
      />
    </div>
  );
}
