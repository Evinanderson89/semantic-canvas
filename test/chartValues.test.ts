import { expect, it } from "vitest";
import { coerceDate, componentValue, donutSegments } from "../src/charts/values.ts";

it("computes numeric-string donut shares and closes a whole circle", () => {
  const shares = donutSegments(["10", "20", "30"]);
  expect(shares.map(s => s.value)).toEqual([10, 20, 30]);
  expect(shares[0].end).toBeCloseTo(1 / 6);
  expect(shares[1].end).toBeCloseTo(.5);
  expect(shares[2].end).toBe(1);
  expect(donutSegments([0, "9", 0])).toEqual([{ start: 0, end: 0, value: 0 }, { start: 0, end: 1, value: 9 }, { start: 1, end: 1, value: 0 }]);
  expect(donutSegments([1e308, 1e308]).map(s => s.end)).toEqual([.5, 1]);
});

it("does not turn missing or invalid components into zero", () => {
  for (const value of [null, undefined, "", " ", false, true, "unknown", Infinity, NaN]) expect(() => componentValue(value)).toThrow(/finite value/);
  for (const values of [[], [0, 0], [10, -2], [10, null], [10, "invalid"]]) expect(() => donutSegments(values)).toThrow();
});

it("keeps calendar timestamps stable and respects explicit offsets", () => {
  for (const value of ["2026-07-01", "2026-07-01 00:00:00", "2026-07-01T00:00:00", "2026-07-01T00:00:00Z"]) expect((coerceDate(value) as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect((coerceDate("2026-07-01T02:00:00+02:00") as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect(coerceDate("2026-07-not-a-date")).toBe("2026-07-not-a-date");
});
