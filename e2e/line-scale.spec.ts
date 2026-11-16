import { test, expect, type Page } from "@playwright/test";
import type { ChartKind } from "../src/compiler/spec.ts";

async function open(page: Page, kind: ChartKind = "line", fit = false, values: (number | null)[] = [1.04, 1.02, .98], secondaryValues?: number[]) {
  const id = crypto.randomUUID(), title = `Retention scale ${id}`;
  const metrics = secondaryValues ? ["ending_mrr", "nrr"] : kind === "combo" ? ["nrr", "grr"] : ["nrr"];
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", ...metrics], rows: values.map((v, i) => [`2026-0${i + 6}-01`, ...metrics.map((_, j) => j > 0 && secondaryValues ? secondaryValues[i] : v === null ? null : v - j * .03)]), ms: 1,
  } }));
  const created = await page.request.post("/api/dashboards", { data: { id, spec: { title, tiles: [{ id: "retention", title: "Retention trend", metrics,
    dimensions: ["month:fct_saas_monthly.month"], chart: kind, format: fit ? { lineScale: "fit" } : {}, layout: { x: 24, y: 24, w: 600, h: 400 } }] } } });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const tile = page.getByRole("group", { name: "Retention trend", exact: true });
  await expect(tile.locator("figure")).toBeVisible();
  return { tile, id };
}

async function yDomain(page: Page): Promise<number[]> {
  return page.locator(".chart-host figure").evaluate(figure => {
    const plot = typeof (figure as any).scale === "function" ? figure : figure.querySelector("svg");
    return (plot as any).scale("y").domain;
  });
}

test("an explicit fitted line reveals retention variation, labels the range and saves the choice", async ({ page, request }) => {
  const { tile, id } = await open(page);
  expect((await yDomain(page))[0]).toBe(0);
  await tile.click({ position: { x: 8, y: 8 } });
  await page.getByLabel("Line Y-axis", { exact: true }).selectOption("fit");
  await expect(tile.locator("figcaption")).toContainText("Y-axis fitted to data:");
  const domain = await yDomain(page);
  expect(domain[0]).toBeGreaterThan(.9); expect(domain[0]).toBeLessThanOrEqual(.98);
  expect(domain[1]).toBeGreaterThanOrEqual(1.04); expect(domain[1]).toBeLessThan(1.1);
  await expect(tile.locator("figcaption")).toContainText("%");
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const document = await (await request.get(`/api/dashboards/${id}`)).json();
  expect(document.spec.tiles[0].format.lineScale).toBe("fit");
  await tile.screenshot({ path: "../../outputs/semantic-canvas-local/retention-fitted-axis.png" });
  await page.getByLabel("Line Y-axis", { exact: true }).selectOption("zero");
  await expect(tile.locator("figcaption")).toHaveCount(0);
  expect((await yDomain(page))[0]).toBe(0);
});

test("a narrow fitted percentage range retains distinct, correctly scaled tick labels", async ({ page }) => {
  const { tile } = await open(page, "line", true, [.0351254, .0351258, .035126]);
  const ticks = await tile.locator('g[aria-label="y-axis tick label"] text').allTextContents();
  expect(ticks.length).toBeGreaterThan(2);
  expect(new Set(ticks).size).toBe(ticks.length);
  expect(ticks.every(t => t.startsWith("3.512") && t.endsWith("%"))).toBe(true);
  await expect(tile.locator("figcaption")).toContainText("3.512");
});

for (const kind of ["bar", "area", "combo"] as const) test(`${kind} retains a zero baseline when a fitted line setting is carried over`, async ({ page }) => {
  const { tile } = await open(page, kind, true);
  expect((await yDomain(page))[0]).toBe(0);
  await expect(tile.locator("figcaption").filter({ hasText: "fitted to data" })).toHaveCount(0);
});

test("missing observations never claim a fitted data range", async ({ page }) => {
  const { tile } = await open(page, "line", true, [null, null, null]);
  await expect(tile.locator("figcaption")).toContainText("No observed measure values; no fitted range available.");
});

test("fitted dual-axis lines retain distinct units and identify the primary fitted range", async ({ page }) => {
  const { tile } = await open(page, "line", true, [1000, 1020, 980], [1.04, 1.02, .98]);
  await expect(tile.locator("figcaption")).toContainText("Left y-axis fitted to data: $");
  await expect(tile.locator("figcaption")).toContainText("Independent scales");
  await expect(tile.locator("figure")).toContainText("%");
  const domain = await yDomain(page);
  expect(domain[0]).toBeGreaterThan(900);
  expect(domain[1]).toBeLessThan(1100);
  // With a visible legend, the first SVG is a swatch. Both axes must be
  // attached to the actual plot, where the line marks use those coordinates.
  await expect(tile.locator('svg:has(g[aria-label="line"]) > .secondary-axis')).toHaveCount(1);
  await expect(tile.locator('.secondary-axis').locator('..').locator('g[aria-label="y-axis tick label"]')).toHaveCount(1);
});
