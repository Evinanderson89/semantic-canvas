import { describe, expect, it } from "vitest";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { model } from "./fixtures.ts";

describe("suggestDashboard", () => {
  it("gives the main trend a focal point and keeps supporting metrics in separate charts", () => {
    const dash = suggestDashboard(model, { width: 1440 });
    const trends = dash.tiles.filter(t => t.title?.endsWith("over time") && t.chart !== "kpi");
    expect(trends).toHaveLength(3);
    expect(trends[0].layout.w).toBeGreaterThan(1300);
    expect(trends[1].layout.w).toBeLessThan(800);
    expect(trends[2].layout.y).toBe(trends[1].layout.y);
    expect(trends.every(t => t.metrics.length === 1)).toBe(true);
    for (const trend of trends) expect(dash.tiles.find(t => t.id === trend.section)?.kind).toBe("heading");
  });
});

it("wraps narrow dashboard charts into readable rows without changing their queries", () => {
  const wide = suggestDashboard(model, { width: 1440, audience: "analyst" });
  const narrow = suggestDashboard(model, { width: 640, audience: "analyst" });
  expect(narrow.tiles.map(({ layout, ...tile }) => tile)).toEqual(wide.tiles.map(({ layout, ...tile }) => tile));
  for (const tile of narrow.tiles) {
    expect(tile.layout.x).toBeGreaterThanOrEqual(24);
    expect(tile.layout.x + tile.layout.w).toBeLessThanOrEqual(616);
    expect(tile.layout.w).toBeGreaterThanOrEqual(tile.chart === "kpi" ? 180 : 500);
    for (const other of narrow.tiles) {
      if (tile.id === other.id) continue;
      const a = tile.layout, b = other.layout;
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
    }
  }
});
