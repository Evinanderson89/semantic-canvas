import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { redesignImpact } from "../src/app/redesignImpact.ts";
import { applyProposal } from "../src/canvas/proposals.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { FilterSpec } from "../src/compiler/spec.ts";

it("distinguishes presentation from a change in the analysis", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "bar", dimensions: ["month:sold_on"] })] };
  const next = applyProposal(before, DEFAULT_CANVAS, { title: "A better trend", reason: "Read change over time", actions: [
    { type: "chart", id: "t1", chart: "line" }, { type: "place", id: "t1", layout: { x: 20, y: 30, w: 600, h: 300 } },
  ] }, model);
  const impact = redesignImpact(before, next.spec, model);
  expect(impact.analysisChanged).toBe(0); expect(impact.presentationChanged).toBe(1);
  expect(impact.tiles[0].changes.map(c => c.label)).toEqual(["Chart", "Size", "Position"]);
  expect(impact.metrics).toEqual(["revenue"]);
});
it("compares the resulting dashboard rather than counting intermediate actions", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "bar" })] };
  expect(redesignImpact(before, structuredClone(before), model).tiles).toEqual([]);
});
it("shows the full before/after description, including explicit removal, without inventing an analysis change", () => {
  const before = { title: "Revenue", description: "Country-level revenue", tiles: [tile()] };
  const impact = redesignImpact(before, { ...before, description: "Revenue over time" }, model);
  expect(impact.dashboardDescription).toEqual({ before: "Country-level revenue", after: "Revenue over time" });
  expect(impact.analysisChanged).toBe(0);
  expect(redesignImpact(before, { ...before, description: "" }, model).dashboardDescription).toEqual({ before: before.description, after: "" });
  expect(redesignImpact({ ...before, description: undefined }, { ...before, description: "" }, model).dashboardDescription).toBeNull();
});
it("shows the exact metric and reporting-grain replacement", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "line", dimensions: ["day:sold_on"] })] };
  const after = { ...before, tiles: [tile({ chart: "line", metrics: ["arpu"], dimensions: ["month:sold_on"] })] };
  const impact = redesignImpact(before, after, model);
  expect(impact.analysisChanged).toBe(1);
  expect(impact.removedMetrics).toEqual([{ name: "revenue", label: "Revenue (USD)" }]);
  expect(impact.tiles[0].changes).toEqual([
    { label: "Metrics", before: "Revenue (USD) [revenue]", after: "ARPU (USD) [arpu]", analytical: true },
    { label: "Breakdown / reporting grain", before: "day:sold_on", after: "month:sold_on", analytical: true },
  ]);
});
it("does not call a metric removed when another proposed chart still shows it", () => {
  const before = { title: "Revenue", tiles: [tile({ id: "a" }), tile({ id: "b" })] };
  const after = { ...before, tiles: [tile({ id: "a", metrics: ["users"] }), tile({ id: "new", metrics: ["revenue"] })] };
  expect(redesignImpact(before, after, model).removedMetrics).toEqual([]);
  expect(redesignImpact(before, { ...after, tiles: after.tiles.slice(0, 1) }, model).removedMetrics).toEqual([{ name: "revenue", label: "Revenue (USD)" }]);
});
it("surfaces the implicit prior-period comparison introduced by a KPI", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "line", dimensions: ["month:sold_on"] })] };
  const impact = redesignImpact(before, { ...before, tiles: [{ ...before.tiles[0], chart: "kpi" as const }] }, model);
  expect(impact.tiles[0].changes).toContainEqual({ label: "Comparison", before: "None", after: "Previous period", analytical: true });
});
it("shows lost interactive scope when a replacement metric cannot reach a filter", () => {
  const filter: FilterSpec = { id: "f", field: "dim_plans.tier", source: "dimension", mode: "discrete", values: ["enterprise"] };
  const before = { title: "Revenue", tiles: [tile()] }, after = { ...before, tiles: [tile({ metrics: ["users"] })] };
  const impact = redesignImpact(before, after, model, { filters: { t1: [filter] } }, { filters: { t1: [filter] }, warnings: { t1: ["Plan tier"] } });
  expect(impact.tiles[0].changes).toContainEqual({ label: "Query filters", before: 'dim_plans.tier includes "enterprise"', after: "None", analytical: true });
  expect(impact.tiles[0].changes).toContainEqual({ label: "Filters not applied", before: "None reported", after: "Plan tier", analytical: true });
});
it("compares the active drill grain and half-open date window", () => {
  const before = { title: "Revenue", tiles: [tile({ dimensions: ["month:sold_on"] })] };
  const drill = { grain: "day" as const, column: "sold_on", min: "2026-01-01", max: "2026-02-01", label: "January" };
  const impact = redesignImpact(before, before, model, {}, { drills: { t1: [drill] } });
  expect(impact.tiles[0].changes.find(c => c.label === "Breakdown / reporting grain")?.after).toBe("day:sold_on");
  expect(impact.tiles[0].changes.find(c => c.label === "Query filters")?.after).toContain("< 2026-02-01");
});
it("identifies removed evidence and added narrative without claiming a metric change", () => {
  const before = { title: "Old", tiles: [tile()] }, after = { title: "New", tiles: [tile({ id: "note", kind: "text", text: "Investigate retention", metrics: [] })] };
  const impact = redesignImpact(before, after, model);
  expect(impact.added).toBe(1); expect(impact.removed).toBe(1); expect(impact.analysisChanged).toBe(0);
  expect(impact.dashboardTitle).toEqual({ before: "Old", after: "New" });
  expect(impact.tiles.find(t => t.id === "t1")?.changes.find(c => c.label === "Metrics")?.after).toBe("Not present");
});
