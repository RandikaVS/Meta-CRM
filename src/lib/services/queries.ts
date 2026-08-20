import type { SupabaseClient } from "@supabase/supabase-js";
import type { Service } from "@/types";

/** Bookable-service catalog reads. Writes (create/rename/deactivate)
 *  are plain `supabase.from('services')` calls made directly from the
 *  Services manager dialog — same directness as
 *  CustomFieldsManager/PipelineSettings for small settings-class
 *  catalogs, no extra indirection needed. */
export async function loadServices(
  db: SupabaseClient,
  opts: { activeOnly?: boolean } = {},
): Promise<Service[]> {
  let query = db.from("services").select("*").order("name");
  if (opts.activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Service[];
}
