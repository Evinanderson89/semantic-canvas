import { expect, it } from "vitest";
import { sparklineHover, sparklineTimeline } from "../src/app/sparkline.ts";

const day = (date: string) => Date.parse(date);
const point = (x: string, y = 100) => ({ x, y });

it("keeps omitted months at their elapsed dates without bridging their values", () => {
  const t = sparklineTimeline([point("2024-01-01"), point("2024-02-01"), point("2024-04-01"), point("2024-05-01")], "month");
  expect(t.segments.map(s => s.map(p => p.x))).toEqual([["2024-01-01", "2024-02-01"], ["2024-04-01", "2024-05-01"]]);
  expect(t.gaps).toEqual([{ from: day("2024-03-01"), to: day("2024-04-01") }]);
  expect(t.missingPeriods).toBe(true);
  expect(t.missingValues).toBe(0);
  expect(t.points[2].position - t.points[1].position).toBe(60 * 86400000);
  expect(sparklineHover(t, day("2024-03-15")).point).toBeUndefined();
  expect(sparklineHover(t, day("2024-04-01")).point?.y).toBe(100);
});

it("merges explicit nulls and omitted periods, while preserving a genuine zero", () => {
  const t = sparklineTimeline([point("2024-01-01", 0), point("2024-02-01", NaN), point("2024-04-01", NaN), point("2024-05-01", 20)], "month");
  expect(t.valid.map(p => p.y)).toEqual([0, 20]);
  expect(t.segments.map(s => s.length)).toEqual([1, 1]);
  expect(t.gaps).toEqual([{ from: day("2024-02-01"), to: day("2024-05-01") }]);
  expect(t.missingPeriods).toBe(true);
  expect(t.missingValues).toBe(2);
  expect(sparklineHover(t, day("2024-02-01")).gap).toBeDefined();
});

it.each([
  ["day", "2024-02-28", "2024-02-29", "2024-03-01"],
  ["week", "2024-02-25", "2024-03-03", "2024-03-10"],
  ["month", "2024-02-01", "2024-03-01", "2024-04-01"],
  ["quarter", "2024-11-01", "2025-02-01", "2025-05-01"],
  ["year", "2024-04-01", "2025-04-01", "2026-04-01"],
])("respects %s bucket boundaries including leap days and fiscal starts", (grain, first, next, later) => {
  expect(sparklineTimeline([point(first), point(next)], grain).gaps).toEqual([]);
  expect(sparklineTimeline([point(first), point(later)], grain).gaps).toEqual([{ from: day(next), to: day(later) }]);
});

it("retains missing latest and entirely unknown histories", () => {
  const t = sparklineTimeline([point("2024-01-01"), point("2024-02-01", NaN)], "month");
  expect(t.domain[1]).toBe(day("2024-02-01"));
  expect(sparklineHover(t, t.domain[1]).gap).toBeDefined();
  expect(t.valid).toHaveLength(1);
  expect(t.missingPeriods).toBe(false);
  expect(t.missingValues).toBe(1);
  const empty = sparklineTimeline([point("2024-01-01", NaN), point("2024-02-01", NaN)], "month");
  expect(empty.valid).toEqual([]);
  expect(empty.gaps).toHaveLength(1);
  expect(sparklineTimeline([], "month").segments).toEqual([]);
});

it("does not expand long gaps or stretch a bar across absent years", () => {
  const t = sparklineTimeline([point("2000-01-01"), point("2050-01-01")], "month");
  expect(t.points).toHaveLength(2);
  expect(t.gaps).toHaveLength(1);
  expect(t.step).toBe(31 * 86400000);
});

it("supports Date objects without mutating inputs and falls back for non-date categories", () => {
  const input = [{ x: new Date("2024-02-01"), y: 20 }, { x: new Date("2024-01-01"), y: 10 }];
  const t = sparklineTimeline(input, "month");
  expect(t.points.map(p => p.y)).toEqual([10, 20]);
  expect(input.map(p => p.y)).toEqual([20, 10]);
  const categories = sparklineTimeline([point("a"), point("b", NaN), point("c")]);
  expect(categories.temporal).toBe(false);
  expect(categories.missingPeriods).toBe(false);
  expect(categories.missingValues).toBe(1);
  expect(categories.segments).toHaveLength(2);
  expect(sparklineHover(categories, 1).gap).toBeDefined();
});
