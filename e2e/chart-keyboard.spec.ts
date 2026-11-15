import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { TileSpec } from "../src/compiler/spec.ts";

async function open(page: Page, patch: Partial<TileSpec>, columns: string[], rows: unknown[][]) {
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    const query = route.request().postDataJSON(); queries.push(query);
    const resultColumns = columns.map(column => column === "movement_date_month" && query.dimensions.includes("day:movement_date") ? "movement_date_day" : column);
    return route.fulfill({ json: { columns: resultColumns, rows, ms: 1 } });
  });
  const id = crypto.randomUUID(), title = `Keyboard exploration ${id}`;
  const saved = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1100 }, spec: { title,
    tiles: [{ id: "chart", title: "Explore evidence", metrics: ["new_mrr"], dimensions: ["dim_users.country"], chart: "barH", layout: { x: 24, y: 24, w: 850, h: 420 }, ...patch }] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const tile = page.locator(".node .tile"), explorer = tile.locator(".chart-explore");
  await expect(tile.locator("figure")).toBeVisible();
  return { tile, explorer, queries };
}

test("keyboard chooses a category and filters without moving the tile", async ({ page }, testInfo) => {
  const { explorer, queries } = await open(page, {}, ["country", "new_mrr"], [["US", 100], ["DE", 50]]);
  const node = page.locator(".node"), before = await node.getAttribute("style");
  const summary = explorer.locator("summary");
  await expect(summary).toBeAttached();
  await summary.focus(); await summary.press("Enter");
  await page.keyboard.press("Tab");
  const select = explorer.getByLabel("Category", { exact: true });
  await expect(select).toBeFocused();
  await page.keyboard.type("DE");
  await expect(select.locator("option:checked")).toHaveText("DE");
  await page.keyboard.press("Tab");
  const action = explorer.getByRole("button", { name: "Filter to category", exact: true });
  await expect(action).toBeFocused(); await action.press("Space");
  await expect.poll(() => queries.some(q => q.where?.some((f: any) => f.field === "dim_users.country" && f.values?.includes("DE")))).toBe(true);
  expect(await node.getAttribute("style")).toBe(before);
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await page.screenshot({ path: testInfo.outputPath("keyboard-category-exploration.png") });
  const download = page.waitForEvent("download");
  await page.evaluate(async () => {
    const { downloadPng } = await import("/src/app/export.ts");
    await downloadPng("keyboard-chart.png", document.querySelector(".node .tile") as HTMLElement);
  });
  await (await download).saveAs(testInfo.outputPath("keyboard-chart-export.png"));
});

test("exploration has its own row above a multi-series legend without clipping the chart", async ({ page }, testInfo) => {
  const { tile, explorer } = await open(page, { chart: "line", metrics: ["new_mrr", "lost_mrr"], dimensions: ["month:movement_date"], layout: { x: 24, y: 24, w: 430, h: 360 } },
    ["movement_date_month", "new_mrr", "lost_mrr"], [["2026-06-01", 100, 30], ["2026-07-01", 150, 20]]);
  const summary = explorer.locator("summary"), figure = tile.locator("figure"), host = tile.locator(".chart-host");
  await expect(summary).toBeVisible();
  await expect.poll(async () => {
    const action = (await summary.boundingBox())!, chart = (await figure.boundingBox())!;
    return action.y + action.height <= chart.y;
  }).toBe(true);
  const chart = (await figure.boundingBox())!, bounds = (await host.boundingBox())!;
  expect(chart.y + chart.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  await summary.click();
  await expect(explorer.getByLabel("Reporting period", { exact: true })).toBeVisible();
  await summary.press("Escape");
  await expect(summary).toBeFocused();
  await tile.screenshot({ path: testInfo.outputPath("chart-exploration-row.png") });
});

test("typed heatmap categories keep numeric, text, null and boolean filter values", async ({ page }) => {
  const { explorer } = await open(page, { chart: "heatmap", dimensions: ["dim_users.country", "dim_users.signup_source"] }, ["country", "signup_source", "new_mrr"], [[1, "direct", 10], ["1", "direct", 20], [null, "direct", 30], [false, "direct", 40]]);
  for (const [label, expected] of [["1 (number)", 1], ['"1" (text)', "1"], ["Missing category", null], ["false", false]] as const) {
    await explorer.locator("summary").click();
    await explorer.getByLabel("Category", { exact: true }).selectOption({ label });
    const query = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST" && r.postDataJSON().where?.some((f: any) => f.field === "dim_users.country"));
    await explorer.getByRole("button", { name: "Filter to category", exact: true }).click();
    expect((await query).postDataJSON().where.find((f: any) => f.field === "dim_users.country").values).toEqual([expected]);
    await expect(explorer.locator("summary")).toBeFocused();
  }
});

test("a completed chart query does not take focus back after the user moves elsewhere", async ({ page }) => {
  const { explorer, tile } = await open(page, {}, ["country", "new_mrr"], [["US", 100], ["DE", 50]]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/query", async route => { await held; return route.fallback(); });
  await explorer.locator("summary").click();
  const queried = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST");
  await explorer.getByRole("button", { name: "Filter to category", exact: true }).click();
  await queried;
  const save = page.getByRole("button", { name: "Save dashboard", exact: true });
  try { await save.focus(); } finally { release(); }
  await expect(tile.locator(".chart-explore")).toBeVisible();
  await expect(save).toBeFocused();
});

test("keyboard drills the selected reporting period and Escape closes exploration", async ({ page }) => {
  const { explorer, queries } = await open(page, { chart: "line", dimensions: ["month:movement_date"] }, ["movement_date_month", "new_mrr"], [["2026-06-01", 100], ["2026-07-01", 150]]);
  const summary = explorer.locator("summary");
  await expect(summary).toBeAttached();
  await summary.focus(); await summary.press("Enter"); await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(explorer).not.toHaveAttribute("open"); await expect(summary).toBeFocused();
  await summary.press("Enter"); await page.keyboard.press("Tab");
  const select = explorer.getByLabel("Reporting period", { exact: true });
  await expect(select).toBeFocused(); await page.keyboard.type("Jul");
  await page.keyboard.press("Tab"); await explorer.getByRole("button", { name: "Drill into period", exact: true }).press("Enter");
  await expect.poll(() => queries.some(q => q.where?.some((f: any) => f.min === "2026-07-01" && f.max === "2026-08-01") && q.dimensions.some((d: string) => d.startsWith("week:") || d.startsWith("day:")))).toBe(true);
  await expect(explorer).toHaveCount(0);
  await expect(page.locator(".chart-host")).toBeFocused();
});

test("waterfall exploration exposes source categories without a synthetic total", async ({ page }) => {
  const { explorer, queries } = await open(page, { chart: "waterfall" }, ["country", "new_mrr"], [["Total", 100], ["DE", -20]]);
  await explorer.locator("summary").click();
  const select = explorer.getByLabel("Category", { exact: true });
  await expect(select.locator("option")).toHaveText(["Total", "DE"]);
  await explorer.getByRole("button", { name: "Filter to category", exact: true }).click();
  await expect.poll(() => queries.some(q => q.where?.some((f: any) => f.values?.includes("Total")))).toBe(true);
});

test("daily small-multiple panel labels remain filterable when time cannot drill further", async ({ page }) => {
  const { tile, queries } = await open(page, { chart: "smallMultiples", dimensions: ["day:movement_date", "dim_users.country"] },
    ["movement_date_day", "country", "new_mrr"], [["2026-06-01", "US", 10], ["2026-06-02", "US", 20], ["2026-06-01", "DE", 5], ["2026-06-02", "DE", 7]]);
  const panel = tile.getByRole("button", { name: "Filter country to DE", exact: true });
  await expect(panel).toBeVisible(); await panel.focus(); await panel.press("Enter");
  await expect.poll(() => queries.some(q => q.where?.some((f: any) => f.field === "dim_users.country" && f.values?.includes("DE")))).toBe(true);
});
