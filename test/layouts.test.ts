import { describe, expect, it } from "vitest";
import { applyBestLayout, applyLayout, bestLayout, scoreLayout } from "../src/canvas/layouts.ts";
import type { TileSpec } from "../src/compiler/spec.ts";

const kpi = (id: string): TileSpec => ({
  id, kind: "metric", chart: "kpi", metrics: ["revenue"], dimensions: ["month:d"],
  layout: { x: 0, y: 0, w: 300, h: 156 },
});
const chart = (id: string): TileSpec => ({
  id, kind: "metric", chart: "line", metrics: ["revenue", "cost"], dimensions: ["month:d"],
  layout: { x: 0, y: 0, w: 500, h: 300 },
});
const heading = (id: string): TileSpec => ({
  id, kind: "heading", text: "Section", metrics: [], dimensions: [],
  layout: { x: 0, y: 0, w: 400, h: 56 },
});
/** A single-metric tile with a dimension and no explicit chart -- inferChart
 *  renders this as area/bar, not a stat card, even though it has one metric. */
const singleMetricChart = (id: string): TileSpec => ({
  id, kind: "metric", metrics: ["mrr"], dimensions: ["month:d"],
  layout: { x: 0, y: 0, w: 500, h: 300 },
});
/** True dimensionless stat -- one metric, no dimensions, no explicit chart. */
const stat = (id: string): TileSpec => ({
  id, kind: "metric", metrics: ["mrr"], dimensions: [],
  layout: { x: 0, y: 0, w: 300, h: 156 },
});

describe("scoreLayout / bestLayout", () => {
  it("prefers exec-summary for a real headline + support mix", () => {
    const tiles = [kpi("a"), kpi("b"), kpi("c"), chart("d")];
    expect(bestLayout(tiles)).toBe("exec-summary");
    expect(scoreLayout("exec-summary", tiles)).toBeGreaterThan(scoreLayout("grid", tiles));
  });

  it("falls back to grid for KPIs alone", () => {
    const tiles = [kpi("a"), kpi("b"), kpi("c")];
    expect(bestLayout(tiles)).toBe("grid");
  });

  it("falls back to grid for charts alone", () => {
    const tiles = [chart("a"), chart("b")];
    expect(bestLayout(tiles)).toBe("grid");
  });

  it("falls back to grid for a single KPI plus a chart (not enough headline numbers)", () => {
    const tiles = [kpi("a"), chart("b")];
    expect(bestLayout(tiles)).toBe("grid");
  });

  it("grid never refuses a tile set", () => {
    expect(scoreLayout("grid", [])).toBeGreaterThan(0);
    expect(scoreLayout("grid", [heading("a")])).toBeGreaterThan(0);
  });
});

describe("applyBestLayout", () => {
  it("places KPI tiles in one row, sized to share the canvas width evenly", () => {
    const tiles = [kpi("a"), kpi("b"), kpi("c"), chart("d")];
    const { name, tiles: out } = applyBestLayout(tiles, 900);
    expect(name).toBe("exec-summary");
    const kpis = out.filter((t) => t.id !== "d");
    expect(new Set(kpis.map((t) => t.layout.y)).size).toBe(1); // same row
    expect(kpis.every((t) => t.layout.w > 0)).toBe(true);
  });

  it("places the chart below the KPI row, not overlapping it", () => {
    const tiles = [kpi("a"), kpi("b"), kpi("c"), chart("d")];
    const { tiles: out } = applyBestLayout(tiles, 900);
    const kpiBottom = Math.max(...out.filter((t) => t.id !== "d").map((t) => t.layout.y + t.layout.h));
    const chartTile = out.find((t) => t.id === "d")!;
    expect(chartTile.layout.y).toBeGreaterThanOrEqual(kpiBottom);
  });

  it("is a no-op-shaped result on an empty dashboard", () => {
    expect(applyBestLayout([], 900)).toEqual({ name: "grid", tiles: [] });
  });

  it("grid layout still packs without overlap for a mixed, non-headline set", () => {
    const tiles = [chart("a"), chart("b"), heading("c")];
    const { name, tiles: out } = applyBestLayout(tiles, 900);
    expect(name).toBe("grid");
    expect(out).toHaveLength(3);
  });

  it("does not squeeze single-metric charts with dimensions into the KPI row", () => {
    // Real shape that shipped broken: two real KPIs plus four single-metric
    // charts with no explicit `chart` -- every one of the four got
    // misclassified as a KPI and packed at 156px-row height instead of full
    // chart size.
    const tiles = [
      stat("k1"), stat("k2"),
      singleMetricChart("c1"), singleMetricChart("c2"),
      singleMetricChart("c3"), singleMetricChart("c4"),
      chart("c5"), // a real multi-metric chart, so exec-summary is still the pick
    ];
    const { name, tiles: out } = applyBestLayout(tiles, 1200);
    expect(name).toBe("exec-summary");
    const headlineRowY = out.find((t) => t.id === "k1")!.layout.y;
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
      const t = out.find((x) => x.id === id)!;
      expect(t.layout.y).toBeGreaterThan(headlineRowY); // not packed into the KPI row
      expect(t.layout.h).toBeGreaterThan(156); // full chart height, not a KPI card's
    }
  });
});

describe("applyLayout stretch option", () => {
  it("exec-summary honors stretch:false too, not just grid", () => {
    // Regression: layoutExecSummary() used to hardcode stretch on for its
    // own internal arrange() calls, ignoring whatever applyLayout()'s own
    // caller asked for -- harmless today only because no incremental-repack
    // call site happens to pick "exec-summary" yet, not because the
    // parameter actually did anything for it.
    const tiles = [kpi("a"), kpi("b"), kpi("c"), chart("d")];
    const stretched = applyLayout("exec-summary", tiles, 1400, true);
    const unstretched = applyLayout("exec-summary", tiles, 1400, false);
    const chartOut = (out: TileSpec[]) => out.find((t) => t.id === "d")!.layout.w;
    expect(chartOut(stretched)).toBeGreaterThan(chartOut(unstretched));
  });
});
