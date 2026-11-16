import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

const own = { id: "own-window", field: "movement_date", source: "dimension", mode: "range", min: "2026-01-01", max: "2026-04-01", maxExclusive: true };
const selection = { id: "cross-country", field: "dim_users.country", source: "dimension", mode: "discrete", values: ["US"] };
async function openSample(page: Page, selected = true) {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  const title = `Review scope ${crypto.randomUUID().slice(0, 8)}`;
  const spec = { title, crossFilters: selected ? [selection] : [], tiles: [{ id: "revenue", title: "Revenue by country", chart: "bar",
    metrics: ["new_mrr"], dimensions: ["dim_users.country"], where: [own], layout: { x: 24, y: 24, w: 900, h: 400 } }] };
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, spec,
    canvas: { ...DEFAULT_CANVAS, width: 1000, height: 700 } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.locator(".node figure svg")).toBeVisible();
  return spec;
}
async function tileReview(page: Page) {
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Design review", exact: true }).click();
  const review = tile.locator(".beautify-pop");
  await expect(review).toBeVisible();
  await expect(review).not.toContainText("Checking the chart type");
  return review;
}

for (const failure of ["http", "missing", "timeout"]) test(`${failure} field evidence marks tile review incomplete and can be retried`, async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"], rows: [["US", 100], ["DE", 80]], ms: 1 } }));
  let attempts = 0;
  await page.route("**/api/profile?*", route => {
    if (++attempts === 1) return failure === "http"
      ? route.fulfill({ status: 503, json: { error: "Warehouse profiling is unavailable" } })
      : route.fulfill({ json: { fields: failure === "timeout" ? [{ field: "dim_users.country", type: "varchar", cardinality: null, sample: [], role: "categorical", warning: "Field profiling reached its time limit." }] : [] } });
    return route.fulfill({ json: { fields: [{ field: "dim_users.country", type: "varchar", cardinality: 2, sample: ["US", "DE"], role: "geo", isoLike: true }] } });
  });
  await openSample(page, false);
  const review = await tileReview(page);
  await expect(review.getByRole("alert")).toContainText("Chart-type review incomplete");
  await expect(review).not.toContainText("No chart changes suggested by these checks");
  await review.getByRole("button", { name: "Retry chart review", exact: true }).click();
  await expect(review.getByRole("button", { name: /Switch to Country map/ })).toBeVisible();
  await expect(review.getByRole("alert")).toHaveCount(0);
});

test("dashboard review reports timed-out evidence instead of an all-clear or a speculative chart switch", async ({ page }) => {
  await page.route("**/api/profile?*", route => route.fulfill({ json: { fields: [{ field: "dim_users.country", type: "varchar", cardinality: null, sample: [], role: "categorical", warning: "Field profiling reached its time limit." }] } }));
  await openSample(page, false);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Design review" });
  await expect(review.locator(".review-coverage")).toContainText("Review incomplete");
  await expect(review).toContainText("Field profiling reached its time limit");
  await expect(review.getByRole("button", { name: /Switch to Country map/ })).toHaveCount(0);
});

test("selection-only findings cannot remove a useful breakdown in either review surface", async ({ page }, info) => {
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(); queries.push(q);
    return route.fulfill({ json: { columns: ["country", "new_mrr"], rows: q.where?.some((f: any) => f.id === selection.id) ? [["US", 100]] : [["US", 100], ["DE", 80]], ms: 1 } });
  });
  await openSample(page);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const dashboard = page.getByRole("dialog", { name: "Design review" });
  await expect(dashboard.locator(".review-coverage")).toContainText("1 chart reviewed");
  await expect(dashboard).toContainText("specific to this selection");
  await expect(dashboard.getByRole("button", { name: /^(Remove breakdown|Show over time)$/ })).toHaveCount(0);
  expect(queries.some(q => JSON.stringify(q.where) === JSON.stringify([own]))).toBe(true);
  await dashboard.screenshot({ path: info.outputPath("scoped-design-review.png") });
  await dashboard.getByRole("button", { name: "Close", exact: true }).click();
  const perTile = await tileReview(page);
  await expect(perTile).toContainText("specific to this selection");
  await expect(perTile.getByRole("button", { name: /^(Remove breakdown|Show over time)$/ })).toHaveCount(0);
  expect(queries.every(q => q.where?.some((f: any) => f.id === own.id))).toBe(true);
});

test("confirmed chart-wide findings remain actionable, preserve filters and undo as one edit", async ({ page }) => {
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON();
    return route.fulfill({ json: { columns: q.dimensions.length ? ["country", "new_mrr"] : ["new_mrr"],
      rows: q.dimensions.length ? (q.where?.some((f: any) => f.id === selection.id) ? [["US", 100]] : [["US", 100], ["DE", 0]]) : [[100]], ms: 1 } });
  });
  const original = await openSample(page);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Design review" });
  await expect(review).toContainText("Applying this changes the chart for every selection.");
  await review.getByRole("button", { name: "Remove breakdown", exact: true }).click();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  const save = async () => {
    const sent = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
    const response = await sent; expect(response.ok()).toBe(true);
    return response.request().postDataJSON().spec;
  };
  const changed = await save();
  expect(changed.tiles[0]).toMatchObject({ dimensions: [], where: [own] });
  // Exploration stays visible but is deliberately excluded from saved content.
  await expect(page.locator(".xfilters")).toContainText("US");
  expect(changed.crossFilters).toBeUndefined();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  const restored = await save();
  expect(restored.tiles).toEqual(original.tiles);
  expect(restored.crossFilters).toBeUndefined();
});

for (const scenario of ["missing", "limited"]) test(`${scenario} category evidence cannot justify removing the breakdown`, async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"],
    rows: scenario === "missing" ? [["US", 100], ["DE", null]] : [["US", 100]], truncated: scenario === "limited", ms: 1 } }));
  await openSample(page, false);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Design review" });
  await expect(review.locator(".review-coverage")).toContainText("1 chart reviewed");
  await expect(review.getByRole("button", { name: /^(Remove breakdown|Show over time)$/ })).toHaveCount(0);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  const perTile = await tileReview(page);
  await expect(perTile.getByRole("button", { name: /^(Remove breakdown|Show over time)$/ })).toHaveCount(0);
});

test("changing selection cancels a tile review and ignores delayed suggestions", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"], rows: [["US", 100]], ms: 1 } }));
  await openSample(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route("**/api/profile?**", async route => {
    started = true; await gate;
    await route.fulfill({ json: { fields: [{ field: "dim_users.country", role: "geo", type: "string", cardinality: 2, sample: ["US", "DE"] }] } }).catch(() => {});
  });
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Design review", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  release();
  await expect(tile.locator(".beautify-pop")).toHaveCount(0);
  await expect(tile.getByRole("button", { name: "Remove breakdown", exact: true })).toHaveCount(0);
  await expect(tile.locator("figure svg")).toBeVisible();
});

test("a failed chart-wide confirmation marks the review incomplete and withholds axis edits", async ({ page }) => {
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON();
    return q.where?.some((f: any) => f.id === selection.id)
      ? route.fulfill({ json: { columns: ["country", "new_mrr"], rows: [["US", 100]], ms: 1 } })
      : route.fulfill({ status: 503, json: { error: "Synthetic query unavailable" } });
  });
  await openSample(page);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Design review" });
  await expect(review.locator(".review-coverage")).toContainText("Review incomplete");
  await expect(review).toContainText("Could not verify the chart's own category result");
  await expect(review.getByRole("button", { name: /^(Remove breakdown|Show over time)$/ })).toHaveCount(0);
});
