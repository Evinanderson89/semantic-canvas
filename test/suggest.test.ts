import { describe, expect, it } from "vitest";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { model } from "./fixtures.ts";

describe("suggestDashboard", () => {
  it("gives a trend group that ends up alone in its row the FULL row width, not half", () => {
    // Regression: the fixture model's top table (fct_sales) has three unit
    // -class groups (currency, ratio, count), so the third trend tile has
    // no partner to share a row with -- it used to stay at half-width
    // (`span(1, 2)`) regardless, leaving the right half of the canvas dead
    // for that entire row. Every OTHER row-packer in this app (arrange()'s
    // stretch cap) already treats a lone tile this way; this hand-rolled
    // layout hadn't caught up.
    const dash = suggestDashboard(model, { width: 1440 });
    // Excludes the KPI row (chart: "kpi") and the "one tile from the next
    // table" tile (step 4) -- dim_users has no date column, so that one's
    // title also ends in "over time" but it carries no time dimension.
    const trendTiles = dash.tiles.filter((t) =>
      t.title.endsWith("over time") && t.chart !== "kpi" && t.dimensions.length > 0);
    expect(trendTiles.length).toBe(3);
    const last = trendTiles[trendTiles.length - 1];
    const paired = trendTiles.slice(0, 2);
    // The first two share one row at half-width each.
    expect(paired[0].layout.w).toBeLessThan(800);
    expect(paired[1].layout.w).toBeLessThan(800);
    // The third, alone in the next row, gets the FULL row instead.
    expect(last.layout.x).toBe(24);
    expect(last.layout.w).toBeGreaterThan(1300);
  });
});
