import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function openPanels(page: Page, categories: unknown[] = ["US", "DE", "CA", "GB"], reverse = false, missing = false, interactive = true) {
  const title = `Panel exploration ${crypto.randomUUID()}`;
  const dimensions = reverse ? ["dim_users.country", "month:movement_date"] : ["month:movement_date", "dim_users.country"];
  const rows = categories.flatMap((category, c) => ["2026-06-01", "2026-07-01", "2026-08-01"].map((date, i) =>
    reverse ? [category, date, missing ? null : (c + 1) * 100 + i * 50] : [date, category, missing ? null : (c + 1) * 100 + i * 50]));
  await page.route("**/api/query", route => {
    const body = route.request().postDataJSON();
    const filters = body.where?.filter((f: any) => f.field === "dim_users.country") ?? [];
    const filtered = rows.filter(row => filters.every((f: any) => f.values.some((v: unknown) => v === row[reverse ? 0 : 1])));
    return route.fulfill({ json: { columns: reverse ? ["country", "movement_date_month", "new_mrr"] : ["movement_date_month", "country", "new_mrr"], rows: filtered, ms: 1 } });
  });
  const result = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 750 },
    spec: { title, tiles: [{ id: "panels", title: "New MRR by country", metrics: ["new_mrr"], dimensions, chart: "smallMultiples",
      layout: { x: 24, y: 24, w: 900, h: 500 } }] } } });
  expect(result.ok(), await result.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const tile = page.locator(".node .tile");
  if (interactive) await expect(tile.locator(".chart-panel-filter")).toHaveCount(categories.length);
  return tile;
}

for (const reverse of [false, true]) test(`panel labels filter by the real category with ${reverse ? "category" : "time"} first`, async ({ page }) => {
  const tile = await openPanels(page, undefined, reverse);
  await expect(tile.locator("figcaption")).toContainText("Shared scales");
  await expect(tile.locator("figcaption")).toContainText("New MRR (USD)");
  await page.getByLabel("Canvas zoom", { exact: true }).selectOption("0.75");
  const filterRequest = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST" &&
    r.postDataJSON().where?.some((f: any) => f.field === "dim_users.country"));
  // GB and DE occupy the same facet column, but belong to different rows.
  await tile.getByRole("button", { name: "Filter country to GB", exact: true }).click();
  expect((await filterRequest).postDataJSON().where).toContainEqual(expect.objectContaining({ field: "dim_users.country", values: ["GB"] }));
  await expect(page.locator(".xfilters")).toContainText("GB");
  await expect(tile.locator(".chart-panel-filter")).toHaveCount(1);
  await expect(tile.getByRole("button", { name: "Filter country to GB", exact: true })).toBeVisible();
  await page.locator(".xfilters").getByRole("button", { name: /Clear all/ }).click();
  await expect(tile.locator(".chart-panel-filter")).toHaveCount(4);
});

for (const key of ["Enter", "Space"]) test(`${key} activates a panel label without moving its dashboard tile`, async ({ page }) => {
  const tile = await openPanels(page);
  const node = page.locator(".node"), before = await node.getAttribute("style");
  const label = tile.getByRole("button", { name: "Filter country to CA", exact: true });
  await label.focus();
  await label.press("ArrowRight");
  expect(await node.getAttribute("style")).toBe(before);
  await label.press(key);
  await expect(page.locator(".xfilters")).toContainText("CA");
  expect(await node.getAttribute("style")).toBe(before);
});

test("numeric, text, null and boolean categories retain their identity", async ({ page }) => {
  const categories = [1, "1", null, false];
  const tile = await openPanels(page, categories);
  for (const [label, expected] of [["1 (number)", 1], ['"1" (text)', "1"], ["Missing category", null], ["false", false]] as const) {
    const request = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST" && r.postDataJSON().where?.length);
    await tile.getByRole("button", { name: `Filter country to ${label}`, exact: true }).click();
    expect((await request).postDataJSON().where[0].values).toEqual([expected]);
    await expect(tile.locator(".chart-panel-filter")).toHaveCount(1);
    if (expected === null) await expect(page.locator(".xfilters")).toContainText("Missing (null)");
    await page.locator(".xfilters").getByRole("button", { name: /Clear all/ }).click();
    await expect(tile.locator(".chart-panel-filter")).toHaveCount(categories.length);
  }
});

test("clicking a plotted date does not turn a panel index into a drill or filter", async ({ page }) => {
  const tile = await openPanels(page);
  await tile.locator('g[aria-label="dot"] circle').first().click();
  await expect(page.locator(".xfilters")).toHaveCount(0);
  await expect(tile.locator(".chart-panel-filter")).toHaveCount(4);
  await page.screenshot({ path: "../../outputs/semantic-canvas-local/small-multiple-exploration.png", fullPage: true });
});

test("empty measure evidence is not presented as a measured zero-to-one scale", async ({ page }) => {
  const tile = await openPanels(page, ["US", "DE"], false, true);
  await expect(tile.locator("figcaption")).toContainText("No observed measure values");
});

test("too many panels produce an actionable size message instead of unreadable labels", async ({ page }) => {
  const tile = await openPanels(page, Array.from({ length: 100 }, (_, i) => `Category ${i}`), false, false, false);
  await expect(tile.locator(".chart-err")).toContainText("Enlarge this chart or filter to fewer categories");
  await expect(tile.locator(".chart-panel-filter")).toHaveCount(0);
});
