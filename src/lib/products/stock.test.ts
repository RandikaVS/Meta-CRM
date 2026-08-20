import { describe, expect, it } from "vitest";
import {
  computeInventoryValue,
  getStockStatus,
  resolveStockAdjustment,
  StockAdjustError,
} from "./stock";

describe("getStockStatus", () => {
  it("is out_of_stock at zero, even with a zero reorder level", () => {
    expect(getStockStatus(0, 0)).toBe("out_of_stock");
  });

  it("is out_of_stock below zero (defensive — shouldn't happen given the DB CHECK)", () => {
    expect(getStockStatus(-1, 5)).toBe("out_of_stock");
  });

  it("is low_stock when at or under the reorder level but above zero", () => {
    expect(getStockStatus(5, 5)).toBe("low_stock");
    expect(getStockStatus(1, 5)).toBe("low_stock");
  });

  it("is in_stock once above the reorder level", () => {
    expect(getStockStatus(6, 5)).toBe("in_stock");
  });

  it("is in_stock whenever reorder level is 0 and stock is positive", () => {
    expect(getStockStatus(1, 0)).toBe("in_stock");
  });
});

describe("resolveStockAdjustment — add mode", () => {
  it("returns a positive delta and the summed resulting stock", () => {
    expect(resolveStockAdjustment({ mode: "add", quantity: 10, currentStock: 5 })).toEqual({
      delta: 10,
      resultingStock: 15,
    });
  });

  it("rejects a zero or negative quantity", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "add", quantity: 0, currentStock: 5 }),
    ).toThrow(StockAdjustError);
    expect(() =>
      resolveStockAdjustment({ mode: "add", quantity: -1, currentStock: 5 }),
    ).toThrow(StockAdjustError);
  });
});

describe("resolveStockAdjustment — remove mode", () => {
  it("returns a negative delta and the reduced resulting stock", () => {
    expect(resolveStockAdjustment({ mode: "remove", quantity: 4, currentStock: 10 })).toEqual({
      delta: -4,
      resultingStock: 6,
    });
  });

  it("allows removing exactly down to zero", () => {
    expect(resolveStockAdjustment({ mode: "remove", quantity: 10, currentStock: 10 })).toEqual({
      delta: -10,
      resultingStock: 0,
    });
  });

  it("rejects removing more than is in stock", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "remove", quantity: 11, currentStock: 10 }),
    ).toThrow(StockAdjustError);
  });

  it("rejects a zero or negative quantity", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "remove", quantity: 0, currentStock: 10 }),
    ).toThrow(StockAdjustError);
  });
});

describe("resolveStockAdjustment — set mode", () => {
  it("computes the delta needed to reach the target quantity (increase)", () => {
    expect(resolveStockAdjustment({ mode: "set", quantity: 25, currentStock: 10 })).toEqual({
      delta: 15,
      resultingStock: 25,
    });
  });

  it("computes the delta needed to reach the target quantity (decrease)", () => {
    expect(resolveStockAdjustment({ mode: "set", quantity: 3, currentStock: 10 })).toEqual({
      delta: -7,
      resultingStock: 3,
    });
  });

  it("rejects a negative target", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "set", quantity: -1, currentStock: 10 }),
    ).toThrow(StockAdjustError);
  });

  it("rejects a target equal to the current stock (no-op)", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "set", quantity: 10, currentStock: 10 }),
    ).toThrow(StockAdjustError);
  });

  it("allows targeting zero", () => {
    expect(resolveStockAdjustment({ mode: "set", quantity: 0, currentStock: 10 })).toEqual({
      delta: -10,
      resultingStock: 0,
    });
  });
});

describe("resolveStockAdjustment — invalid input", () => {
  it("rejects non-finite quantities", () => {
    expect(() =>
      resolveStockAdjustment({ mode: "add", quantity: NaN, currentStock: 5 }),
    ).toThrow(StockAdjustError);
  });
});

describe("computeInventoryValue", () => {
  it("sums cost price × current stock across products", () => {
    expect(
      computeInventoryValue([
        { cost_price: 100, current_stock: 3 },
        { cost_price: 50, current_stock: 4 },
      ]),
    ).toBe(500);
  });

  it("treats missing/falsy values as zero rather than NaN", () => {
    expect(
      computeInventoryValue([
        { cost_price: 0, current_stock: 5 },
        // @ts-expect-error — defensive against bad data (e.g. a null slipping through)
        { cost_price: null, current_stock: 5 },
      ]),
    ).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(computeInventoryValue([])).toBe(0);
  });
});
