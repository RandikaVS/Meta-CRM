import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductStockMovement, StockMovementType } from "@/types";

/**
 * Wraps the `adjust_product_stock` / stock-history reads so callers
 * never build the RPC payload or the movements query by hand — one
 * place to keep in sync with migration 040's function signature.
 */

export class StockApiError extends Error {}

/** Detects Postgres 23505 (unique_violation) — same convention as
 *  `isUniqueViolation` in contacts/dedupe.ts, kept local here since
 *  products has no reason to import from the contacts feature. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export interface AdjustStockParams {
  productId: string;
  movementType: StockMovementType;
  /** Signed delta — positive increases stock, negative decreases it. */
  quantityDelta: number;
  referenceNumber?: string | null;
  reason?: string | null;
}

/**
 * Calls the `adjust_product_stock` RPC (migration 040) — the sole
 * path that changes `products.current_stock`. Atomic: the ledger row
 * and the stock snapshot update happen together server-side, so the
 * caller only ever sees the fully-applied result or an error, never a
 * half-applied state.
 */
export async function adjustProductStock(
  db: SupabaseClient,
  { productId, movementType, quantityDelta, referenceNumber, reason }: AdjustStockParams,
): Promise<ProductStockMovement> {
  const { data, error } = await db.rpc("adjust_product_stock", {
    p_product_id: productId,
    p_movement_type: movementType,
    p_quantity_delta: quantityDelta,
    p_reference_number: referenceNumber?.trim() || null,
    p_reason: reason?.trim() || null,
  });
  if (error) throw new StockApiError(error.message);
  return data as ProductStockMovement;
}

export interface StockHistoryEntry extends ProductStockMovement {
  /** Resolved display name for `created_by`; null for a removed member. */
  created_by_name: string | null;
}

/**
 * Newest-first movement history for one product, with `created_by`
 * resolved to a display name via `profiles` (any account member can
 * read teammate profiles — migration 017's `profiles_select`).
 */
export async function loadStockHistory(
  db: SupabaseClient,
  productId: string,
  limit = 100,
): Promise<StockHistoryEntry[]> {
  const { data, error } = await db
    .from("product_stock_movements")
    .select("*")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new StockApiError(error.message);

  const movements = (data ?? []) as ProductStockMovement[];
  if (movements.length === 0) return [];

  const userIds = [
    ...new Set(movements.map((m) => m.created_by).filter((id): id is string => !!id)),
  ];

  let namesByUser: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profileRows } = await db
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", userIds);
    namesByUser = Object.fromEntries(
      ((profileRows ?? []) as { user_id: string; full_name: string }[]).map((p) => [
        p.user_id,
        p.full_name,
      ]),
    );
  }

  return movements.map((m) => ({
    ...m,
    created_by_name: m.created_by ? (namesByUser[m.created_by] ?? null) : null,
  }));
}
