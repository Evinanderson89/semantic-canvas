import { expect, it } from "vitest";
import { filterMetadata, filterValueLabels } from "../src/app/useFilterMetadata.ts";

it("preserves typed values, missing values and the explicit result limit", () => {
  expect(filterMetadata({ values: [{ value: 1, n: "12" }, { value: "1", n: 3 }, { value: null, n: 2 }, { value: false, n: 1 }], truncated: true }, "discrete"))
    .toEqual({ kind: "values", values: [{ value: 1, n: 12 }, { value: "1", n: 3 }, { value: null, n: 2 }, { value: false, n: 1 }], truncated: true });
});

it("distinguishes typed filter values and blank or missing labels without changing their keys", () => {
  const values = [1, "1", false, "false", null, "Missing (null)", "", " ", "Blank text", "US", "US"];
  const labels = filterValueLabels(values);
  expect(labels.size).toBe(10);
  expect(new Set(labels.values()).size).toBe(10);
  expect(labels.get(1)).toBe("1 (number)");
  expect(labels.get("1")).toBe('"1" (text)');
  expect(labels.get(false)).toBe("false (boolean)");
  expect(labels.get(null)).toBe("Missing (null)");
  expect(labels.get("Missing (null)")).toBe('"Missing (null)" (text)');
  expect(labels.get("")).toBe('"" (text)');
  expect(labels.get(" ")).toBe('" " (text)');
  expect(labels.get("US")).toBe("US");
});

it("does not confuse literal text with generated type labels", () => {
  const labels = filterValueLabels([1, "1", "1 (number)", '"1" (text)', null, "Missing (null)"]);
  expect(new Set(labels.values()).size).toBe(labels.size);
  expect(labels.get("1 (number)")).toBe('"1 (number)" (text)');
});
it("distinguishes empty results and unknown range bounds from observed zero", () => {
  expect(filterMetadata({ values: [] }, "discrete")).toEqual({ kind: "values", values: [], truncated: false });
  expect(filterMetadata({ min: null, max: null }, "range")).toEqual({ kind: "extent", min: null, max: null });
  expect(filterMetadata({ min: 0, max: 0 }, "range")).toEqual({ kind: "extent", min: 0, max: 0 });
});
it("retains fractional and temporal bounds without rounding or numeric coercion", () => {
  expect(filterMetadata({ min: 1.25, max: 9.75 }, "range")).toMatchObject({ min: 1.25, max: 9.75 });
  expect(filterMetadata({ min: "2026-01-01", max: "2026-08-31" }, "range")).toMatchObject({ min: "2026-01-01", max: "2026-08-31" });
});
it("rejects error bodies and malformed counts rather than presenting an empty list", () => {
  for (const body of [{ error: "Denied" }, { values: [{ value: "US", n: -1 }] }, { values: [{ value: "US", n: "" }] }, { values: [{ value: {}, n: 1 }] }]) {
    expect(() => filterMetadata(body, "discrete")).toThrow("invalid filter values");
  }
  expect(() => filterMetadata({ error: "Denied" }, "range")).toThrow("invalid data range");
});
