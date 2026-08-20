"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Appointment, AppointmentStatus } from "@/types";
import {
  loadAppointments,
  loadAppointmentSummary,
  loadStaffList,
  type SummaryRangeDays,
} from "@/lib/appointments/queries";
import { loadAppointmentVolumeSeries, type AppointmentVolumePoint } from "@/lib/appointments/chart-data";
import { formatCurrency } from "@/lib/currency";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GatedButton } from "@/components/ui/gated-button";
import { MetricCard } from "@/components/dashboard/metric-card";
import { BarChart } from "@/components/tremor/bar-chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { AppointmentForm } from "@/components/appointments/appointment-form";
import { AppointmentDetailSheet } from "@/components/appointments/appointment-detail-sheet";
import { RescheduleDialog } from "@/components/appointments/reschedule-dialog";
import { ServicesManager } from "@/components/appointments/services-manager";
import {
  Search,
  Plus,
  MoreHorizontal,
  Loader2,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Settings2,
  Users,
  CheckCircle2,
  XCircle,
  UserX,
  Wallet,
  CircleDollarSign,
} from "lucide-react";

const PAGE_SIZE = 25;
type DatePreset = "all" | "today" | "tomorrow" | "week" | "month";

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function rangeForPreset(preset: DatePreset): { start: string | null; end: string | null } {
  const now = new Date();
  const today = startOfDay(now);
  switch (preset) {
    case "today": {
      const end = new Date(today);
      end.setDate(end.getDate() + 1);
      return { start: today.toISOString(), end: end.toISOString() };
    }
    case "tomorrow": {
      const start = new Date(today);
      start.setDate(start.getDate() + 1);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    case "week": {
      const end = new Date(today);
      end.setDate(end.getDate() + 7);
      return { start: today.toISOString(), end: end.toISOString() };
    }
    case "month": {
      const end = new Date(today);
      end.setMonth(end.getMonth() + 1);
      return { start: today.toISOString(), end: end.toISOString() };
    }
    default:
      return { start: null, end: null };
  }
}

const STATUS_TONE: Record<AppointmentStatus, string> = {
  scheduled: "bg-muted text-foreground",
  confirmed: "bg-primary/10 text-primary",
  checked_in: "bg-primary/10 text-primary",
  in_progress: "bg-amber-500/10 text-amber-400",
  completed: "bg-primary/10 text-primary",
  cancelled: "bg-red-500/15 text-red-400",
  no_show: "bg-red-500/15 text-red-400",
  rescheduled: "bg-muted text-muted-foreground",
};

export default function AppointmentsPage() {
  const t = useTranslations("Appointments.page");
  const tStatus = useTranslations("Appointments.status");
  const supabase = createClient();
  const { defaultCurrency } = useAuth();
  const canManage = useCan("send-messages");
  const canManageSettings = useCan("edit-settings");

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);

  const [search, setSearch] = useState("");
  const [staffId, setStaffId] = useState("");
  const [status, setStatus] = useState<AppointmentStatus | "">("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");

  const [staffList, setStaffList] = useState<{ id: string; full_name: string | null }[]>([]);

  const [summaryRange, setSummaryRange] = useState<SummaryRangeDays>(7);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof loadAppointmentSummary>> | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [volume, setVolume] = useState<AppointmentVolumePoint[]>([]);
  const [volumeLoading, setVolumeLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editAppointment, setEditAppointment] = useState<Appointment | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  const [servicesManagerOpen, setServicesManagerOpen] = useState(false);

  const fetchSeq = useRef(0);

  const fetchAppointments = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const { start, end } = rangeForPreset(datePreset);
      const result = await loadAppointments(supabase, {
        search,
        staffId: staffId || null,
        status: status || null,
        paymentStatus: paymentStatus || null,
        serviceId: null,
        startDate: start,
        endDate: end,
        page,
        pageSize: PAGE_SIZE,
      });
      if (seq !== fetchSeq.current) return;
      setAppointments(result.items);
      setTotalCount(result.totalCount);
    } catch {
      if (seq === fetchSeq.current) toast.error(t("toastFailedLoad"));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [supabase, search, staffId, status, paymentStatus, datePreset, page, t]);

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      setSummary(await loadAppointmentSummary(supabase, summaryRange));
    } catch {
      // stats strip is a nice-to-have; fail quietly
    } finally {
      setSummaryLoading(false);
    }
  }, [supabase, summaryRange]);

  const fetchVolume = useCallback(async () => {
    setVolumeLoading(true);
    try {
      setVolume(await loadAppointmentVolumeSeries(supabase, summaryRange === 1 ? 7 : summaryRange));
    } catch {
      // chart is decorative-secondary; fail quietly
    } finally {
      setVolumeLoading(false);
    }
  }, [supabase, summaryRange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAppointments();
  }, [fetchAppointments]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSummary();
    fetchVolume();
  }, [fetchSummary, fetchVolume]);

  useEffect(() => {
    loadStaffList(supabase).then(setStaffList).catch(() => {});
  }, [supabase]);

  function resetPage() {
    setPage(0);
  }

  function openDetail(id: string) {
    setDetailId(id);
    setDetailOpen(true);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasActiveFilters = !!search.trim() || !!staffId || !!status || !!paymentStatus || datePreset !== "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalCount > 0 ? t("subtitle", { count: totalCount }) : t("subtitleZero")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            render={<Link href="/appointments/calendar" />}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <CalendarDays className="size-4" />
            {t("calendarLink")}
          </Button>
          {canManageSettings && (
            <Button
              variant="outline"
              onClick={() => setServicesManagerOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Settings2 className="size-4" />
              {t("manageServices")}
            </Button>
          )}
          <GatedButton
            canAct={canManage}
            gateReason="create appointments"
            onClick={() => {
              setEditAppointment(null);
              setFormOpen(true);
            }}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t("newAppointment")}
          </GatedButton>
        </div>
      </div>

      {/* Range selector */}
      <div className="flex items-center gap-1">
        {([1, 7, 30] as SummaryRangeDays[]).map((r) => (
          <button
            key={r}
            onClick={() => setSummaryRange(r)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              summaryRange === r ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {r === 1 ? t("rangeToday") : t("rangeDays", { days: r })}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
        {summaryLoading || !summary ? (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-xl border border-border bg-card" />
          ))
        ) : (
          <>
            <MetricCard title={t("statToday")} value={summary.todayCount.toLocaleString()} icon={CalendarClock} />
            <MetricCard title={t("statConfirmed")} value={summary.confirmedCount.toLocaleString()} icon={Users} />
            <MetricCard title={t("statCompleted")} value={summary.completedCount.toLocaleString()} icon={CheckCircle2} />
            <MetricCard title={t("statCancelled")} value={summary.cancelledCount.toLocaleString()} icon={XCircle} />
            <MetricCard title={t("statNoShow")} value={summary.noShowCount.toLocaleString()} icon={UserX} />
            <MetricCard title={t("statRevenue")} value={formatCurrency(summary.revenue, defaultCurrency)} icon={Wallet} />
            <MetricCard
              title={t("statOutstanding")}
              value={formatCurrency(summary.outstanding, defaultCurrency)}
              icon={CircleDollarSign}
            />
          </>
        )}
      </div>

      {/* Volume chart */}
      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-foreground">{t("volumeChartTitle")}</h2>
        {volumeLoading ? (
          <div className="mt-3 h-[220px] animate-pulse rounded-lg bg-muted/40" />
        ) : (
          <BarChart
            data={volume as unknown as Record<string, unknown>[]}
            index="day"
            categories={["scheduled", "completed"]}
            colors={["violet", "emerald"]}
            showLegend
            yAxisWidth={32}
            className="mt-3 h-[220px]"
          />
        )}
      </section>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPage();
            }}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <select
          value={staffId}
          onChange={(e) => {
            setStaffId(e.target.value);
            resetPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">{t("allStaff")}</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as AppointmentStatus | "");
            resetPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">{t("allStatuses")}</option>
          {(["scheduled", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"] as AppointmentStatus[]).map(
            (s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ),
          )}
        </select>
        <select
          value={paymentStatus}
          onChange={(e) => {
            setPaymentStatus(e.target.value);
            resetPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">{t("allPaymentStatuses")}</option>
          <option value="unpaid">{t("paymentUnpaid")}</option>
          <option value="partially_paid">{t("paymentPartial")}</option>
          <option value="paid">{t("paymentPaid")}</option>
          <option value="refunded">{t("paymentRefunded")}</option>
        </select>
        <div className="flex items-center gap-1">
          {(["all", "today", "tomorrow", "week", "month"] as DatePreset[]).map((p) => (
            <button
              key={p}
              onClick={() => {
                setDatePreset(p);
                resetPage();
              }}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                datePreset === p ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(`preset.${p}` as string)}
            </button>
          ))}
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => {
              setSearch("");
              setStaffId("");
              setStatus("");
              setPaymentStatus("");
              setDatePreset("all");
              resetPage();
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t("clearFilters")}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t("tableColumns.number")}</TableHead>
              <TableHead className="text-muted-foreground">{t("tableColumns.customer")}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t("tableColumns.staff")}</TableHead>
              <TableHead className="text-muted-foreground">{t("tableColumns.when")}</TableHead>
              <TableHead className="text-muted-foreground">{t("tableColumns.status")}</TableHead>
              <TableHead className="text-muted-foreground text-right">{t("tableColumns.total")}</TableHead>
              <TableHead className="text-muted-foreground hidden sm:table-cell">{t("tableColumns.payment")}</TableHead>
              <TableHead className="w-12 text-muted-foreground" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : appointments.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <CalendarClock className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters ? t("noAppointmentsMatch") : t("noAppointmentsYet")}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              appointments.map((a) => (
                <TableRow
                  key={a.id}
                  className="cursor-pointer border-border hover:bg-muted/50"
                  onClick={() => openDetail(a.id)}
                >
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.appointment_number}</TableCell>
                  <TableCell className="text-foreground">
                    {a.contact?.name || <span className="italic text-muted-foreground">{t("unnamedCustomer")}</span>}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {a.staff?.full_name || "-"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(a.start_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[a.status]}`}>
                      {tStatus(a.status)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-foreground">
                    {formatCurrency(a.total_amount, defaultCurrency)}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {t(`paymentStatusLabel.${a.payment_status}` as string)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" />}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-popover border-border">
                        <DropdownMenuItem onClick={() => openDetail(a.id)} className="text-popover-foreground focus:bg-muted focus:text-foreground">
                          {t("viewAction")}
                        </DropdownMenuItem>
                        {!a.is_billed && canManage && (
                          <>
                            <DropdownMenuItem
                              onClick={() => {
                                setEditAppointment(a);
                                setFormOpen(true);
                              }}
                              className="text-popover-foreground focus:bg-muted focus:text-foreground"
                            >
                              {t("editAction")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setRescheduleTarget(a);
                                setRescheduleOpen(true);
                              }}
                              className="text-popover-foreground focus:bg-muted focus:text-foreground"
                            >
                              {t("rescheduleAction")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t("showingPagination", {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">{t("pageCount", { page: page + 1, total: totalPages })}</span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <AppointmentForm
        open={formOpen}
        onOpenChange={setFormOpen}
        appointment={editAppointment}
        onSaved={() => {
          fetchAppointments();
          fetchSummary();
        }}
      />

      <AppointmentDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        appointmentId={detailId}
        onEdit={(a) => {
          setDetailOpen(false);
          setEditAppointment(a);
          setFormOpen(true);
        }}
        onReschedule={(a) => {
          setDetailOpen(false);
          setRescheduleTarget(a);
          setRescheduleOpen(true);
        }}
        onChanged={() => {
          fetchAppointments();
          fetchSummary();
        }}
      />

      <RescheduleDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        appointment={rescheduleTarget}
        onRescheduled={() => {
          fetchAppointments();
          fetchSummary();
        }}
      />

      {canManageSettings && (
        <ServicesManager open={servicesManagerOpen} onOpenChange={setServicesManagerOpen} />
      )}
    </div>
  );
}
