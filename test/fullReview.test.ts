import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { chartResult, chartUnits } from "../src/app/chartResult.ts";
import { chartRoles, magnitudeSplit } from "../src/charts/Chart.tsx";
import { metricUnit } from "../src/format/format.ts";
import { investigationContext } from "../src/suggest/investigate.ts";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { computedMetricIssue, type Metric } from "../src/semantic/model.ts";

const result = { columns: ["sold_on_month", "revenue", "revenue__prev", "revenue__delta", "revenue__pct"], rows: [["2026-01-01", 120, 100, 20, 0.2], ["2026-02-01", 150, null, null, null]] };
for (const [show, values] of [["value", [120, 150]], ["delta", [20, null]], ["percent", [0.2, null]]] as const) it(`plots only ${show} series and preserves unavailable comparisons`, () => {
  const projected = chartResult(tile({ dimensions: ["month:fct_sales.sold_on"], compare: "prior", compareShow: show }), result);
  expect(projected.columns).toEqual(["sold_on_month", "revenue"]);
  expect(projected.measureColumns).toEqual(["revenue"]);
  expect(projected.rows.map(row => row[1])).toEqual(values);
});
it("does not guess numeric dimensions or all-null metrics, and uses the active drill grain", () => {
  expect(chartRoles(["cohort", "revenue"], [{ cohort: 2026, revenue: null }], ["revenue"])).toEqual({ measures: ["revenue"], dims: ["cohort"] });
  expect(chartResult(tile({ dimensions: ["month:sold_on"] }), { columns: ["sold_on_day", "revenue"], rows: [["2026-01-02", 50]] }, ["day:sold_on"]).columns).toEqual(["sold_on_day", "revenue"]);
  expect(() => chartResult(tile({ compare: "prior", compareShow: "percent" }), { columns: ["revenue"], rows: [[50]] })).toThrow(/missing/);
});
it("does not use unknown secondary-axis values to invent a zero minimum", () => {
  const split = magnitudeSplit([{ volume: 10000, rate: 0.8 }, { volume: 12000, rate: null }, { volume: 11000, rate: 0.9 }], ["volume", "rate"]);
  expect(split?.secondaryDomain).toEqual({ min: 0.8, max: 0.9 });
});
it("separates different units even when their numeric magnitudes are similar", () => {
  const spec = tile({ chart: "line", metrics: ["revenue", "retention"] });
  expect(chartUnits(spec, model)).toEqual({ separateAxes: true, issue: undefined });
  const split = magnitudeSplit([{ revenue: 0.8, retention: 0.9 }, { revenue: 1.2, retention: 1.1 }], spec.metrics, true);
  expect(split?.primary).toEqual(["revenue"]); expect(split?.secondary).toEqual(["retention"]);
  expect(chartUnits({ ...spec, compare: "prior", compareShow: "percent" }, model).separateAxes).toBe(false);
});
it("rejects unlike units on a shared bar scale, including months and counts formatted as plain numbers", () => {
  const typed = structuredClone(model); typed.metrics.revenue.unit = "months";
  expect(metricUnit(typed, "revenue")).toBe("months"); expect(metricUnit(typed, "new_signups")).toBe("number");
  const mixed = tile({ chart: "bar", metrics: ["revenue", "new_signups"], dimensions: ["month:sold_on"] });
  expect(chartUnits(mixed, typed).issue).toMatch(/different units/);
  expect(() => validateRedesign({ title: "Empty", tiles: [] }, DEFAULT_CANVAS, { title: "Mixed", reason: "Compare", actions: [{ type: "add", tile: mixed }] }, typed)).toThrow(/different units/);
});
for (const [label, patch] of [
  ["declared cumulative metric", { type: "cumulative", metric: "live_revenue" }],
  ["SQL window expression", { expression: "SUM(SUM(fct_sales.amount)) OVER (ORDER BY sold_on)" }],
] satisfies [string, Partial<Metric>][]) it(`does not reset a ${label} inside an investigation window`, () => {
  const typed = structuredClone(model); Object.assign(typed.metrics.revenue, patch);
  expect(computedMetricIssue(typed, typed.metrics.revenue)).toBeNull();
  expect(() => investigationContext(typed, tile({ dimensions: ["month:sold_on"] }), [], [], result)).toThrow(/earlier periods/);
});
