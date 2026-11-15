import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { ChartKind } from "../src/compiler/spec.ts";

async function open(page: Page, chart?: ChartKind, temporal = false) {
  const id = crypto.randomUUID(), title = `Inspector kind ${id.slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: DEFAULT_CANVAS, spec: { title, tiles: [
    { id: "metric", title: "Revenue card", chart, metrics: ["new_mrr"], dimensions: temporal ? ["month:movement_date"] : [],
      layout: { x: 24, y: 24, w: 560, h: 340 } },
  ] } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("group", { name: "Revenue card", exact: true }).click();
  return { id, title, inspector: page.locator(".inspector"), tile: page.locator(".node .tile") };
}

for (const chart of ["kpi", "stat", undefined] as const) test(`aggregate ${chart ?? "automatic"} card has accurate selection without inactive plot controls`, async ({ page }) => {
  const { inspector, tile } = await open(page, chart);
  await expect(tile.locator(".stat .v")).toBeVisible();
  const selected = inspector.getByRole("button", { name: /KPI card/ });
  await expect(selected).toHaveClass(/\bon\b/);
  await expect(inspector.getByRole("heading", { name: "Sparkline", exact: true })).toHaveCount(0);
  await expect(inspector.getByRole("heading", { name: "Axes", exact: true })).toHaveCount(0);
  await expect(inspector.getByRole("checkbox", { name: "Legend", exact: true })).toHaveCount(0);
  await expect(selected).toHaveAttribute("title", /no time breakdown/);
  const numbers = inspector.locator("section").filter({ has: page.getByRole("heading", { name: "Numbers", exact: true }) });
  await numbers.getByRole("button", { name: "plain", exact: true }).click();
  await expect(tile.locator(".stat .v")).not.toContainText("$");
  await inspector.getByRole("button", { name: /^Table/ }).click();
  await expect(tile.locator("table")).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Axes", exact: true })).toHaveCount(0);
  await selected.click();
  await expect(tile.locator(".stat .v")).toBeVisible();
});

test("a stat with reporting dates exposes working sparkline controls and keeps them after save/reopen", async ({ page }, info) => {
  const { title, inspector, tile } = await open(page, "stat", true);
  await expect(tile.locator(".kpi-value")).toBeVisible();
  await expect(inspector.getByRole("button", { name: /KPI card/ })).toHaveClass(/\bon\b/);
  const spark = inspector.locator("section").filter({ has: page.getByRole("heading", { name: "Sparkline", exact: true }) });
  await expect(spark).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Axes", exact: true })).toHaveCount(0);
  await spark.getByRole("button", { name: "bar", exact: true }).click();
  await expect(spark.getByRole("button", { name: "bar", exact: true })).toHaveClass(/\bon\b/);
  await expect(spark.getByRole("button", { name: "line", exact: true })).not.toHaveClass(/\bon\b/);
  await expect(tile.locator("svg.spark rect")).not.toHaveCount(0);
  await expect(tile.locator(".spark-line")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("inspector-reporting-kpi.png") });
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const saved = await saving;
  expect(saved.ok()).toBe(true);
  expect(saved.request().postDataJSON().spec.tiles[0]).toMatchObject({ chart: "stat", spark: { shape: "bar" }, dimensions: ["month:movement_date"] });
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.locator(".node svg.spark rect")).not.toHaveCount(0);
  await page.getByRole("group", { name: "Revenue card", exact: true }).click();
  await expect(spark.getByRole("button", { name: "bar", exact: true })).toHaveClass(/\bon\b/);
});
