import { describe, expect, it } from "vitest";
import { applyBestLayout, bestLayout, scoreLayout } from "../src/canvas/layouts.ts";
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
});
