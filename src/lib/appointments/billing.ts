/**
 * Pure billing math — mirrors the SQL formula in
 * `recompute_appointment_totals` (migration 041) exactly, so the
 * live preview shown while editing an appointment never disagrees
 * with what the server will actually persist. The DB trigger is
 * still the authoritative source of truth (it recomputes on every
 * line-item change and is what `complete_appointment()` reads) —
 * these functions exist so the UI doesn't have to round-trip to the
 * server just to show "Subtotal / Discount / Tax / Total" while the
 * user is typing.
 *
 * Rounding: `roundCurrency` rounds to 2dp the same way Postgres's
 * `ROUND(numeric, 2)` does for values in normal currency ranges.
 * Plain JS floats (not an arbitrary-precision decimal type) — this
 * matches every other money value in the app (see
 * `src/lib/currency.ts`), which never introduced one either.
 */

export type DiscountType = 'percentage' | 'fixed' | null | undefined;

export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface BillingLine {
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
}

/** `max(quantity * unitPrice - discountAmount, 0)`, rounded — matches
 *  the `line_total` GENERATED column on appointment_services /
 *  appointment_products. */
export function computeLineTotal({ quantity, unitPrice, discountAmount = 0 }: BillingLine): number {
  return roundCurrency(Math.max(quantity * unitPrice - discountAmount, 0));
}

export interface AppointmentTotalsInput {
  lineTotals: number[];
  discountType?: DiscountType;
  discountValue?: number;
  taxRate?: number;
}

export interface AppointmentTotals {
  subtotalAmount: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** Subtotal → appointment-level discount → tax → grand total, in
 *  exactly that order — same as the SQL function and the same as the
 *  itemized-receipt example in the spec. */
export function computeAppointmentTotals({
  lineTotals,
  discountType,
  discountValue = 0,
  taxRate = 0,
}: AppointmentTotalsInput): AppointmentTotals {
  const subtotalAmount = roundCurrency(lineTotals.reduce((sum, v) => sum + v, 0));

  const discountAmount =
    discountType === 'percentage'
      ? roundCurrency((subtotalAmount * discountValue) / 100)
      : discountType === 'fixed'
        ? Math.min(discountValue, subtotalAmount)
        : 0;

  const taxable = subtotalAmount - discountAmount;
  const taxAmount = roundCurrency((taxable * taxRate) / 100);
  const totalAmount = roundCurrency(taxable + taxAmount);

  return { subtotalAmount, discountAmount, taxAmount, totalAmount };
}

/** unpaid / partially_paid / paid / refunded from amount paid vs
 *  total — mirrors both `complete_appointment` and
 *  `record_appointment_payment`'s SQL CASE. */
export function derivePaymentStatus(
  amountPaid: number,
  totalAmount: number,
): 'unpaid' | 'partially_paid' | 'paid' | 'refunded' {
  if (amountPaid < 0) return 'refunded';
  if (amountPaid >= totalAmount && totalAmount > 0) return 'paid';
  if (amountPaid > 0) return 'partially_paid';
  return 'unpaid';
}
