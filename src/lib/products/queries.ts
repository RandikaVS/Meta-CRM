import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product, StockStatus } from "@/types";
import { computeInventoryValue, getStockStatus } from "./stock";

/**
 * Products list + dashboard-summary data access. Mirrors
 * `src/lib/dashboard/queries.ts`'s trade-off: RLS scopes every query
 * to the caller's account automatically, so nothing here passes
 * account_id explicitly, and light aggregation happens in JS rather
 * than a dedicated SQL view at this data scale.
 */

type DB = SupabaseClient;

export interface ProductSummary {
  totalProducts: number;
  activeProducts: number;
  lowStockCount: number;
  outOfStockCount: number;
  /** cost_price × current_stock, summed across every product (not just active). */
  inventoryValue: number;
}

export async function loadProductSummary(db: DB): Promise<ProductSummary> {
  const [{ count: totalProducts }, { count: activeProducts }, { data: rows, error }] =
    await Promise.all([
      db.from("products").select("id", { count: "exact", head: true }),
      db
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
      db.from("products").select("current_stock, reorder_level, cost_price"),
    ]);

  if (error) throw error;

  const rowsTyped = (rows ?? []) as {
    current_stock: number;
    reorder_level: number;
    cost_price: number;
  }[];

  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const p of rowsTyped) {
    const status = getStockStatus(p.current_stock, p.reorder_level);
    if (status === "low_stock") lowStockCount++;
    else if (status === "out_of_stock") outOfStockCount++;
  }

  return {
    totalProducts: totalProducts ?? 0,
    activeProducts: activeProducts ?? 0,
    lowStockCount,
    outOfStockCount,
    inventoryValue: computeInventoryValue(rowsTyped),
  };
}

/** Distinct, non-empty categories in use — backs the category filter
 *  dropdown and the create-form's category suggestions datalist. No
 *  dedicated categories table exists, so this derives the list from
 *  the products actually on file. */
export async function loadProductCategories(db: DB): Promise<string[]> {
  const { data, error } = await db
    .from("products")
    .select("category")
    .not("category", "is", null);
  if (error) throw error;

  const set = new Set<string>();
  (data ?? []).forEach((r: { category: string | null }) => {
    const trimmed = r.category?.trim();
    if (trimmed) set.add(trimmed);
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

export type ProductSortField =
  | "name"
  | "sku"
  | "selling_price"
  | "cost_price"
  | "current_stock"
  | "created_at";

export interface ProductListParams {
  search: string;
  category: string | null;
  stockStatus: StockStatus | null;
  isActive: boolean | null;
  sortField: ProductSortField;
  sortAscending: boolean;
  page: number;
  pageSize: number;
}

export interface ProductListResult {
  items: Product[];
  totalCount: number;
}

/**
 * Two paths, same shape as the Contacts page's tag-filter split
 * (src/app/(dashboard)/contacts/page.tsx):
 *
 *   - No stock-status filter: a plain PostgREST query. Supports full
 *     column sorting via `.order()`.
 *   - Stock-status filter active: `filter_products_by_stock_status`
 *     (migration 040) — stock status is derived, not a column, so it
 *     can't be filtered with `.eq()`. Fixed sort (created_at desc),
 *     same accepted trade-off the tag filter already makes.
 */
export async function loadProducts(
  db: DB,
  params: ProductListParams,
): Promise<ProductListResult> {
  const { search, category, stockStatus, isActive, sortField, sortAscending, page, pageSize } =
    params;
  const from = page * pageSize;
  const to = from + pageSize - 1;
  const term = search.trim();

  if (stockStatus) {
    const { data, error } = await db.rpc("filter_products_by_stock_status", {
      p_stock_status: stockStatus,
      p_search: term || null,
      p_category: category || null,
      p_is_active: isActive,
      p_limit: pageSize,
      p_offset: from,
    });
    if (error) throw error;
    const rows = (data ?? []) as { product: Product; total_count: number }[];
    return {
      items: rows.map((r) => r.product),
      totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
    };
  }

  let query = db.from("products").select("*", { count: "exact" });

  if (term) {
    const like = `%${term}%`;
    query = query.or(`name.ilike.${like},sku.ilike.${like},barcode.ilike.${like}`);
  }
  if (category) query = query.eq("category", category);
  if (isActive !== null) query = query.eq("is_active", isActive);

  query = query.order(sortField, { ascending: sortAscending }).range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;
  return { items: (data ?? []) as Product[], totalCount: count ?? 0 };
}
