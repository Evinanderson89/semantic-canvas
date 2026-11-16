import { expect, it } from "vitest";
import { prepareHeatmap } from "../src/charts/heatmap.ts";

it("normalizes multiple metrics independently and explains constant rows and missing values", () => {
  const result = prepareHeatmap([
    { month: "June", revenue: "100000", rate: .98, fixed: 1 },
    { month: "July", revenue: 110000, rate: null, fixed: 1 },
    { month: "August", revenue: 120000, rate: .94, fixed: 1 },
  ], ["month"], ["revenue", "rate", "fixed"]);
  expect(result.normalized).toBe(true);
  result.cells.filter(c => c.metric === "revenue").forEach((cell, i) => expect(cell.value).toBeCloseTo(i / 2));
  expect(result.cells.filter(c => c.metric === "rate").map(c => c.value)).toEqual([1, null, 0]);
  expect(result.cells.filter(c => c.metric === "fixed").map(c => c.value)).toEqual([.5, .5, .5]);
  expect(result.caption).toContain("not amounts between rows");
  expect(result.caption).toContain("Constant rows");
  expect(result.caption).toContain("1 gray cell has no numeric value, not zero");
});

it("retains a single metric's values and never converts unknown cells to zero", () => {
  const values = [0, "-10", "", " ", false, true, Infinity, NaN, undefined, null];
  const result = prepareHeatmap(values.map((value, i) => ({ category: i, value })), ["category"], ["value"]);
  expect(result.normalized).toBe(false);
  expect(result.cells.map(c => c.value)).toEqual([0, -10, ...Array(8).fill(null)]);
  expect(result.cells.filter(c => c.invalid)).toHaveLength(6);
  expect(result.caption).toContain("one shared scale");
  expect(result.caption).toContain("8 gray cells");
});

it("preserves dimension identity, rejects duplicate cells and discloses absent combinations", () => {
  const rows = [{ a: null, b: "US", value: 1 }, { a: "null", b: "GB", value: 2 }];
  const result = prepareHeatmap(rows, ["a", "b"], ["value"]);
  expect(result.xValues.size).toBe(2);
  expect(result.caption).toContain("2 blank positions have no returned row");
  expect(() => prepareHeatmap([...rows, rows[0]], ["a", "b"], ["value"])).toThrow(/same heatmap cell/);
  expect(() => prepareHeatmap([{ a: new Date(0), value: 1 }, { a: new Date(0), value: 2 }], ["a"], ["value"])).toThrow(/cannot be safely summed/);
});

it("does not overflow when normalizing extreme signed finite values", () => {
  const result = prepareHeatmap([{ a: "low", x: -1e308, y: 0 }, { a: "middle", x: 0, y: 0 }, { a: "high", x: 1e308, y: 0 }], ["a"], ["x", "y"]);
  expect(result.cells.filter(c => c.metric === "x").map(c => c.value)).toEqual([0, .5, 1]);
  expect(result.cells.filter(c => c.metric === "y").map(c => c.value)).toEqual([.5, .5, .5]);
});

it("centers mixed-sign values on zero without changing values or implying business performance", () => {
  const result = prepareHeatmap([{ a:"loss",v:-20 },{ a:"unchanged",v:0 },{ a:"gain",v:100 },{ a:"missing",v:null }],["a"],["v"]);
  expect(result.divergingDomain).toEqual([-100,100]);
  expect(result.cells.map(c => c.value)).toEqual([-20,0,100,null]);
  expect(result.caption).toContain("neutral color marks zero");
  expect(result.caption).toContain("not business performance");
  for (const values of [[0,1],[-1,0],[],[null,null]])
    expect(prepareHeatmap(values.map((v,a) => ({a,v})),["a"],["v"]).divergingDomain).toBeUndefined();
  expect(prepareHeatmap([{a:"one",x:-1,y:3},{a:"two",x:2,y:4}],["a"],["x","y"]).divergingDomain).toBeUndefined();
});
