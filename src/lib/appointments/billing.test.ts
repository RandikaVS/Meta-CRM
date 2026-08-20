import { describe, expect, it } from 'vitest';
import {
  computeAppointmentTotals,
  computeLineTotal,
  derivePaymentStatus,
  roundCurrency,
} from './billing';

describe('roundCurrency', () => {
  it('rounds to 2dp', () => {
    expect(roundCurrency(12.345)).toBe(12.35);
    expect(roundCurrency(12.344)).toBe(12.34);
  });

  it('avoids the classic 1.005 float trap', () => {
    // Math.round(1.005 * 100) naively gives 100 (99.999...) without
    // the epsilon nudge — this is exactly why roundCurrency adds one.
    expect(roundCurrency(1.005)).toBe(1.01);
  });
});

describe('computeLineTotal', () => {
  it('multiplies quantity by unit price', () => {
    expect(computeLineTotal({ quantity: 2, unitPrice: 650 })).toBe(1300);
  });

  it('nets out a per-line discount', () => {
    expect(computeLineTotal({ quantity: 1, unitPrice: 3000, discountAmount: 500 })).toBe(2500);
  });

  it('never goes negative even if the discount exceeds the line value', () => {
    expect(computeLineTotal({ quantity: 1, unitPrice: 100, discountAmount: 500 })).toBe(0);
  });
});

describe('computeAppointmentTotals', () => {
  it('matches the spec worked example (Haircut + Treatment + Shampoo x2)', () => {
    const totals = computeAppointmentTotals({
      lineTotals: [3000, 5000, 4000], // subtotal 12,000
      discountType: 'fixed',
      discountValue: 1000,
      taxRate: 0,
    });
    expect(totals).toEqual({
      subtotalAmount: 12000,
      discountAmount: 1000,
      taxAmount: 0,
      totalAmount: 11000,
    });
  });

  it('applies a percentage discount before tax', () => {
    const totals = computeAppointmentTotals({
      lineTotals: [1000],
      discountType: 'percentage',
      discountValue: 10, // 10% of 1000 = 100
      taxRate: 15, // 15% of (1000-100) = 135
    });
    expect(totals.discountAmount).toBe(100);
    expect(totals.taxAmount).toBe(135);
    expect(totals.totalAmount).toBe(1035);
  });

  it('caps a fixed discount at the subtotal (never a negative taxable amount)', () => {
    const totals = computeAppointmentTotals({
      lineTotals: [500],
      discountType: 'fixed',
      discountValue: 10_000,
    });
    expect(totals.discountAmount).toBe(500);
    expect(totals.totalAmount).toBe(0);
  });

  it('defaults to zero discount/tax when none is set', () => {
    expect(computeAppointmentTotals({ lineTotals: [100, 200] })).toEqual({
      subtotalAmount: 300,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 300,
    });
  });

  it('handles an empty line list', () => {
    expect(computeAppointmentTotals({ lineTotals: [] }).totalAmount).toBe(0);
  });
});

describe('derivePaymentStatus', () => {
  it('is unpaid at zero', () => {
    expect(derivePaymentStatus(0, 1000)).toBe('unpaid');
  });
  it('is partially_paid below the total', () => {
    expect(derivePaymentStatus(400, 1000)).toBe('partially_paid');
  });
  it('is paid at or above the total (when total > 0)', () => {
    expect(derivePaymentStatus(1000, 1000)).toBe('paid');
    expect(derivePaymentStatus(1200, 1000)).toBe('paid');
  });
  it('is refunded for a negative net amount', () => {
    expect(derivePaymentStatus(-50, 1000)).toBe('refunded');
  });
  it('is unpaid for a zero-total appointment with no payment', () => {
    expect(derivePaymentStatus(0, 0)).toBe('unpaid');
  });
});
