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
  await open(page, d);
  for (const title of ["Events, Active users", "Events by platform over time"]) {
    const tile = page.locator("article, .tile, [data-tile]").filter({ hasText: title }).first();
    await expect(tile).toBeVisible();
    await expect(tile.getByText(/Could not draw/)).toHaveCount(0);
    await expect(tile.locator("svg rect").first()).toBeVisible({ timeout: 15000 });
  }
  await page.screenshot({ path: "test-results/heatmap-regression.png" });
});
