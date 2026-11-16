import { test, expect } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

// Found on the live deployment: a tile with a date dimension and two metrics
// set to heatmap failed with "scale incompatible with channel: utc !== band".
// Cells need discrete axes, so temporal dimensions are bucketed into labels
// and a single dimension puts the measures on the other axis.
async function open(page: any, d: DashboardSpec) {
  const id = crypto.randomUUID();
  const saved = await page.request.post("/api/dashboards", { data: { id, spec: d, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 850 }, revision: 0 } }); expect(saved.ok()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click(); await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(d.title) }).click(); return id;
}

test("a heatmap draws when one axis is a date, and when there is one dimension and several metrics", async ({ page }) => {
  const d: DashboardSpec = { title: `Heatmap regression ${crypto.randomUUID()}`, tiles: [
    { id: "two-metrics", title: "Events, Active users", metrics: ["event_count", "active_users"], dimensions: ["day:fct_events.event_date"], chart: "heatmap", layout: { x: 24, y: 24, w: 460, h: 300 } },
    { id: "time-by-cat", title: "Events by platform over time", metrics: ["event_count"], dimensions: ["month:fct_events.event_date", "dim_users.device_platform"], chart: "heatmap", layout: { x: 500, y: 24, w: 460, h: 300 } },
  ] };
  const results = d.tiles.map(spec => page.waitForResponse(response => response.url().endsWith("/api/query")
    && response.request().method() === "POST"
    && JSON.stringify(response.request().postDataJSON().metrics) === JSON.stringify(spec.metrics)
    && JSON.stringify(response.request().postDataJSON().dimensions) === JSON.stringify(spec.dimensions)));
  await open(page, d);
  for (const [index, spec] of d.tiles.entries()) {
    const response = await results[index]; expect(response.ok()).toBe(true);
    const result = await response.json(); expect(result.rows.length).toBeGreaterThan(0);
    const tile = page.getByRole("group", { name: spec.title!, exact: true });
    await expect(tile).toBeVisible();
    await expect(tile.getByText(/Could not draw/)).toHaveCount(0);
    // Plot's cell marks, not legend/background/axis rectangles, must account
    // for every returned row and each independent metric row.
    const cells = tile.locator('figure g[aria-label="cell"] rect');
    await expect(cells).toHaveCount(result.rows.length * (spec.dimensions.length === 1 ? spec.metrics.length : 1));
    await expect(cells.first()).toBeVisible();
    await expect(cells.locator("title").first()).toContainText("Events:");
    if (spec.metrics.length > 1) {
      await expect(cells.locator("title").filter({ hasText: "Active users:" })).toHaveCount(result.rows.length);
      await expect(tile.locator("figcaption")).toContainText("not amounts between rows");
    } else {
      const platform = result.columns.indexOf("device_platform");
      expect(platform).toBeGreaterThanOrEqual(0);
      for (const name of new Set(result.rows.map((row: unknown[]) => String(row[platform]))))
        expect((await cells.locator("title").allTextContents()).some(text => text.includes(String(name)))).toBe(true);
    }
  }
  await page.screenshot({ path: "test-results/heatmap-regression.png" });
});
