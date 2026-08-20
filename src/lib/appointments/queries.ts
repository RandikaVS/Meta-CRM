import type { SupabaseClient } from "@supabase/supabase-js";
import type { Appointment, AppointmentStatus, Profile } from "@/types";
// Generic, dashboard-agnostic date helpers (startOfLocalDay/daysAgoStart/
// localDayKey/lastNDayKeys/mondayIndex/DOW_SHORT_MON_FIRST) — reused as-is
// rather than re-implementing local-timezone-safe day bucketing a second
// time. See src/lib/dashboard/queries.ts for the established pattern this
// module follows (parallel Promise.all of count/aggregate queries, RLS
// handles account scoping so nothing here filters by account_id).
import { daysAgoStart, startOfLocalDay } from "@/lib/dashboard/date-utils";

type DB = SupabaseClient;

const APPOINTMENT_SELECT = "*, contact:contacts(*), staff:profiles!appointments_staff_id_fkey(*)";

export interface AppointmentSummary {
  todayCount: number;
  confirmedCount: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  revenue: number;
  outstanding: number;
  totalCount: number;
  completionRate: number;
  noShowRate: number;
  averageValue: number;
}

export type SummaryRangeDays = 1 | 7 | 30;

/** Stats strip at the top of the Appointments page (spec item 14).
 *  `rangeDays` scopes every count/sum except `todayCount`, which is
 *  always literally today regardless of the selected range — it's a
 *  distinct, always-relevant signal ("what's on today"). */
export async function loadAppointmentSummary(
  db: DB,
  rangeDays: SummaryRangeDays = 7,
): Promise<AppointmentSummary> {
  const todayStart = startOfLocalDay().toISOString();
  const tomorrowStart = daysAgoStart(-1).toISOString();
  const rangeStart = daysAgoStart(rangeDays - 1).toISOString();

  const [today, confirmed, completed, cancelled, noShow, revenueRows] = await Promise.all([
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .gte("start_at", todayStart)
      .lt("start_at", tomorrowStart),
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "confirmed")
      .gte("start_at", rangeStart),
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("start_at", rangeStart),
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "cancelled")
      .gte("start_at", rangeStart),
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("status", "no_show")
      .gte("start_at", rangeStart),
    db
      .from("appointments")
      .select("total_amount, amount_paid, payment_status")
      .eq("status", "completed")
      .gte("start_at", rangeStart),
  ]);

  const rows = (revenueRows.data ?? []) as {
    total_amount: number;
    amount_paid: number;
    payment_status: string;
  }[];
  const revenue = rows.reduce((sum, r) => sum + (r.total_amount || 0), 0);
  const outstanding = rows.reduce(
    (sum, r) => sum + Math.max((r.total_amount || 0) - (r.amount_paid || 0), 0),
    0,
  );

  const completedCount = completed.count ?? 0;
  const cancelledCount = cancelled.count ?? 0;
  const noShowCount = noShow.count ?? 0;
  // Denominator: every appointment that reached a terminal-ish
  // outcome in range (completed + cancelled + no-show) — matches how
  // a front-desk would read "completion rate" (excludes still-pending
  // scheduled/confirmed appointments, which haven't happened yet).
  const decided = completedCount + cancelledCount + noShowCount;

  return {
    todayCount: today.count ?? 0,
    confirmedCount: confirmed.count ?? 0,
    completedCount,
    cancelledCount,
    noShowCount,
    revenue,
    outstanding,
    totalCount: decided,
    completionRate: decided > 0 ? completedCount / decided : 0,
    noShowRate: decided > 0 ? noShowCount / decided : 0,
    averageValue: completedCount > 0 ? revenue / completedCount : 0,
  };
}

export interface AppointmentListParams {
  search: string;
  staffId: string | null;
  status: AppointmentStatus | null;
  paymentStatus: string | null;
  serviceId: string | null;
  startDate: string | null; // inclusive, YYYY-MM-DD or ISO
  endDate: string | null; // exclusive
  page: number;
  pageSize: number;
}

export interface AppointmentListResult {
  items: Appointment[];
  totalCount: number;
}

/** Server-side paginated list backing the Appointments table (spec
 *  items 12/13). `search` matches the contact's name/phone via an
 *  inner-join filter (same shape as the Contacts page's tag filter —
 *  narrow first, then page) since PostgREST can't `.or()` across an
 *  embedded relation directly. */
export async function loadAppointments(
  db: DB,
  params: AppointmentListParams,
): Promise<AppointmentListResult> {
  const { search, staffId, status, paymentStatus, serviceId, startDate, endDate, page, pageSize } =
    params;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = db.from("appointments").select(APPOINTMENT_SELECT, { count: "exact" });

  if (staffId) query = query.eq("staff_id", staffId);
  if (status) query = query.eq("status", status);
  if (paymentStatus) query = query.eq("payment_status", paymentStatus);
  if (startDate) query = query.gte("start_at", startDate);
  if (endDate) query = query.lt("start_at", endDate);
  if (serviceId) {
    // Narrow to appointments carrying this service via an inner-join
    // filter, same technique the v1 contacts API uses for tag filters.
    query = db
      .from("appointments")
      .select(`${APPOINTMENT_SELECT}, service_filter:appointment_services!inner(service_id)`, {
        count: "exact",
      })
      .eq("service_filter.service_id", serviceId);
    if (staffId) query = query.eq("staff_id", staffId);
    if (status) query = query.eq("status", status);
    if (paymentStatus) query = query.eq("payment_status", paymentStatus);
    if (startDate) query = query.gte("start_at", startDate);
    if (endDate) query = query.lt("start_at", endDate);
  }
  if (search.trim()) {
    query = query.or(`name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`, {
      referencedTable: "contact",
    });
  }

  query = query.order("start_at", { ascending: false }).range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;
  return { items: (data ?? []) as unknown as Appointment[], totalCount: count ?? 0 };
}

/** Range-scoped fetch for the calendar (spec item 33: never pull the
 *  whole table — only the visible day/week/month window). */
export async function loadCalendarAppointments(
  db: DB,
  range: { start: string; end: string; staffId?: string | null },
): Promise<Appointment[]> {
  let query = db
    .from("appointments")
    .select(APPOINTMENT_SELECT)
    .gte("start_at", range.start)
    .lt("start_at", range.end)
    .neq("status", "cancelled")
    .order("start_at", { ascending: true });

  if (range.staffId) query = query.eq("staff_id", range.staffId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as Appointment[];
}

export async function loadAppointmentById(db: DB, id: string): Promise<Appointment | null> {
  const { data, error } = await db
    .from("appointments")
    .select(
      `${APPOINTMENT_SELECT}, services:appointment_services(*), products:appointment_products(*, product:products(name, image_url))`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Appointment) ?? null;
}

/** "Staff" = every account member (mirrors deal-form's own
 *  `profiles.select("*").order("full_name")` for the assignee picker —
 *  no separate staff table, no active/inactive flag to filter on). */
export async function loadStaffList(db: DB): Promise<Profile[]> {
  const { data, error } = await db.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return (data ?? []) as Profile[];
}
