import type { StockMovementType, StockStatus } from "@/types";

/**
 * Pure stock-calculation helpers, shared by the Products list (status
 * badges + summary cards) and the Adjust Stock dialog (delta math +
 * validation) so both agree on exactly one definition of "low" /
 * "out" / "how much am I actually changing".
 *
 * `filter_products_by_stock_status` (migration 040) computes
 * `stock_status` with the identical thresholds in SQL — keep the two
 * in lockstep if this ever changes.
 */

/**
 * in_stock / low_stock / out_of_stock from current vs reorder level.
 * `stock <= 0` wins over `stock <= reorder_level` even when
 * `reorder_level` is also 0 — "nothing on the shelf" always reads as
 * out of stock, never merely low.
 */
export function getStockStatus(
  currentStock: number,
  reorderLevel: number,
): StockStatus {
  if (currentStock <= 0) return "out_of_stock";
  if (currentStock <= reorderLevel) return "low_stock";
  return "in_stock";
}

/** Quick-adjust dialog modes. "set" targets an exact quantity; the
 *  other two are relative to the current stock. */
export type StockAdjustMode = "add" | "remove" | "set";

/** Movement types offered per mode — keeps the dialog's dropdown from
 *  showing nonsensical combinations (e.g. "Sale" while adding stock). */
export const MOVEMENT_TYPES_BY_MODE: Record<StockAdjustMode, StockMovementType[]> = {
  add: ["purchase", "manual_increase", "opening_stock", "returned"],
  remove: ["sale", "manual_decrease", "damaged"],
  set: ["adjustment"],
};

/** Every movement type, in the order the stock-history view lists them. */
export const ALL_MOVEMENT_TYPES: StockMovementType[] = [
  "opening_stock",
  "purchase",
  "manual_increase",
  "sale",
  "manual_decrease",
  "damaged",
  "returned",
  "adjustment",
];

export interface StockAdjustInput {
  mode: StockAdjustMode;
  /** For "add"/"remove": a positive magnitude. For "set": the target quantity. */
  quantity: number;
  currentStock: number;
}

export interface StockAdjustResult {
  /** Signed delta to send to `adjust_product_stock` — never zero. */
  delta: number;
  /** current_stock after applying `delta`, for optimistic UI / preview. */
  resultingStock: number;
}

export class StockAdjustError extends Error {}

/**
 * Turn a mode + quantity into the signed delta the RPC expects,
 * validating along the way. Throws `StockAdjustError` with a
 * user-facing message rather than returning a sentinel, so callers
 * can catch once and toast — mirrors how the rest of the app surfaces
 * form validation (see ContactForm).
 */
export function resolveStockAdjustment({
  mode,
  quantity,
  currentStock,
}: StockAdjustInput): StockAdjustResult {
  if (!Number.isFinite(quantity)) {
    throw new StockAdjustError("Enter a valid quantity");
  }

  if (mode === "set") {
    if (quantity < 0) {
      throw new StockAdjustError("Quantity cannot be negative");
    }
    const delta = quantity - currentStock;
    if (delta === 0) {
      throw new StockAdjustError("New quantity matches the current stock — nothing to save");
    }
    return { delta, resultingStock: quantity };
  }

  if (quantity <= 0) {
    throw new StockAdjustError("Enter a quantity greater than zero");
  }

  const delta = mode === "add" ? quantity : -quantity;
  const resultingStock = currentStock + delta;
  if (resultingStock < 0) {
    throw new StockAdjustError(
      `Cannot remove ${quantity} — only ${currentStock} in stock`,
    );
  }
  return { delta, resultingStock };
}

/** Inventory value for the summary cards: cost price × current stock,
 *  summed across the given products. */
export function computeInventoryValue(
  products: { cost_price: number; current_stock: number }[],
): number {
  return products.reduce(
    (sum, p) => sum + (p.cost_price || 0) * (p.current_stock || 0),
    0,
  );
}
