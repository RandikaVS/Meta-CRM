import type { SupabaseClient } from "@supabase/supabase-js";
import { daysAgoStart, lastNDayKeys, localDayKey } from "@/lib/dashboard/date-utils";

/** Appointment volume + revenue by day, zero-filled for empty days —
 *  same bucketing approach as `loadConversationsSeries`
 *  (src/lib/dashboard/queries.ts). Feeds the "Appointments by day"
 *  chart (spec item 15). */
export interface AppointmentVolumePoint {
  day: string; // "Jan 5" style short label
  scheduled: number;
  completed: number;
}

export async function loadAppointmentVolumeSeries(
  db: SupabaseClient,
  rangeDays: 7 | 30 = 7,
): Promise<AppointmentVolumePoint[]> {
  const since = daysAgoStart(rangeDays - 1).toISOString();
  const { data, error } = await db
    .from("appointments")
    .select("start_at, status")
    .gte("start_at", since);
  if (error) throw error;

  const keys = lastNDayKeys(rangeDays);
  const buckets = new Map<string, AppointmentVolumePoint>(
    keys.map((k) => [
      k,
      { day: new Date(k).toLocaleDateString(undefined, { month: "short", day: "numeric" }), scheduled: 0, completed: 0 },
    ]),
  );

  ((data ?? []) as { start_at: string; status: string }[]).forEach((row) => {
    const key = localDayKey(row.start_at);
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.scheduled += 1;
    if (row.status === "completed") bucket.completed += 1;
  });

  return keys.map((k) => buckets.get(k)!);
}
