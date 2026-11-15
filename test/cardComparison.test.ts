import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { visibleQuery } from "../src/app/query.ts";
import { kpiSummary } from "../src/app/kpiSummary.ts";
import { queryObservations } from "../src/suggest/queryObservations.ts";

const card = (patch: Record<string, unknown> = {}) => tile({ chart: "kpi", dimensions: ["month:fct_sales.sold_on"], ...patch });
const result = { columns: ["sold_on_month", "revenue", "revenue__prev"], rows: [["2026-06-01", 50, 40], ["2026-07-01", 80, 50], ["2026-08-01", 100, 80]] };

it("defaults temporal stat and KPI aliases to the same server comparison", () => {
  expect(visibleQuery(model, card()).compare).toBe("prior");
  expect(visibleQuery(model, card({ chart: "stat" })).compare).toBe("prior");
});

it("first shown does not request a different warehouse comparison or narrate the preceding month", () => {
  const spec = card({ spark: { compare: "first" }, compare: "yoy" });
  const query = visibleQuery(model, spec);
  expect(query.compare).toBe("none");
  const summary = queryObservations(model, { ...spec, ...query }, result).observations[0];
  expect(summary.previous).toBe(50);
  expect(summary.statement).toContain("Up 100%");
  expect(summary.statement).toContain("first shown period");
  expect(summary.statement).toContain("2026-06-01");
  expect(summary.statement).not.toContain("last year");
});

it("turning a comparison off prevents a local fallback even when a prior value is present", () => {
  expect(kpiSummary([{ x: "2026-07-01", y: 80 }, { x: "2026-08-01", y: 100 }], "none", "month", 50)).toEqual({ latest: 100, delta: null });
  const spec = card({ compare: "none" });
  expect(queryObservations(model, spec, result).observations[0].previous).toBeUndefined();
});

it("first shown never skips a missing baseline or compares a lone period to itself", () => {
  const spec = card({ spark: { compare: "first" } });
  for (const rows of [[["2026-06-01", null], ["2026-08-01", 100]], [["2026-08-01", 100]]]) {
    const observation = queryObservations(model, spec, { columns: ["sold_on_month", "revenue"], rows }).observations[0];
    expect(observation.previous).toBeUndefined();
    expect(observation.statement).toContain("comparison value is unavailable");
  }
});
