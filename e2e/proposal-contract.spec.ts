import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";

const tile = (id: string, patch: Partial<TileSpec> = {}): TileSpec => ({ id, title: id, metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 850, h: 330 }, ...patch });
async function open(page: Page, spec: DashboardSpec) {
  const id = crypto.randomUUID();
  const response = await page.request.post("/api/dashboards", { data: { id, spec, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 900 }, revision: 0 } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
  return id;
}
async function save(page: Page) {
  const pending = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await pending; expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  return response.request().postDataJSON();
}

test("AI changes an existing table to a map, previews it, and preserves undo and saved versions", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: {
    title: "Show the geographic distribution", reason: "Map signup counts by country; this is volume, not population-adjusted penetration.",
    actions: [{ type: "chart", id: "countries", chart: "map" }],
  } } }));
  const spec: DashboardSpec = { title: `Map redesign ${crypto.randomUUID()}`, tiles: [tile("countries", {
    title: "Where new accounts come from", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "table",
    layout: { x: 24, y: 24, w: 850, h: 480 },
  })] };
  const id = await open(page, spec);
  await page.getByRole("button", { name: "Improve with AI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  expect(await dialog.locator("svg path").count()).toBeGreaterThan(50);
  // Preview alone must leave the saved document untouched.
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec.tiles[0].chart).toBe("table");
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node table")).toBeVisible();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect(page.locator(".node table")).toHaveCount(0);
  const saved = await save(page);
  expect(saved.spec.tiles[0]).toEqual({ ...spec.tiles[0], chart: "map" });
  const history = await (await page.request.get(`/api/dashboards/${id}/versions`)).json();
  expect(history.versions).toHaveLength(2);
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec.tiles[0].chart).toBe("map");
});

test("chat rejects an unsupported visualization atomically and can recover with a valid proposal", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  let chart = "scatter";
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: {
    title: "Compare country signups", reason: "Make the geographic breakdown easier to explore.",
    actions: [{ type: "title", id: "countries", title: "Geographic distribution" }, { type: "chart", id: "countries", chart }],
  } } }));
  const spec: DashboardSpec = { title: `Chart validation ${crypto.randomUUID()}`, tiles: [tile("countries", {
    title: "Country signups", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "table",
  })] };
  const id = await open(page, spec);
  await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
  const assistant = page.getByRole("region", { name: "Canvas assistant" });
  await assistant.getByPlaceholder("Message the agent…").fill("Improve this comparison");
  await assistant.getByRole("button", { name: "Send", exact: true }).click();
  await assistant.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("cannot show every selected breakdown and measure");
  await expect(page.locator(".node")).toContainText("Country signups");
  await expect(page.locator(".node table")).toBeVisible();
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec).toEqual(spec);
  chart = "map";
  await assistant.getByPlaceholder("Message the agent…").fill("Use a map for these country counts");
  await assistant.getByRole("button", { name: "Send", exact: true }).click();
  await assistant.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.locator(".node")).toContainText("Geographic distribution");
  await expect(page.locator(".node table")).toHaveCount(0);
  const saved = await save(page);
  expect(saved.spec.tiles[0]).toMatchObject({ id: "countries", chart: "map", title: "Geographic distribution" });
});

test("AI edits the second tab and survives save/reopen without losing either tab's filter scope", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  const original: DashboardSpec = { title: `Proposal scope ${crypto.randomUUID()}`, tabs: [{ id: "one", title: "Overview" }, { id: "two", title: "Detail" }],
    tiles: [tile("overview", { tabId: "one" }), tile("detail", { tabId: "two" })],
    filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", defaultValue: { values: ["US"] }, bindings: [{ tileId: "overview", field: "dim_users.country" }, { tileId: "detail", field: "dim_users.country" }] },
      { id: "period", label: "Review period", field: "fct_mrr_movements.movement_date", control: "date", scope: "tab", tabId: "two", defaultValue: { min: "2026-06-01", max: "2026-08-31" }, bindings: [{ tileId: "detail", field: "fct_mrr_movements.movement_date" }] }] };
  await page.route("**/api/agent/chat", route => {
    const input = route.request().postDataJSON();
    expect(input.document.activeTabId).toBe("two");
    expect(input.document.spec.tiles.map((t: any) => t.id)).toEqual(["detail"]);
    expect(input.document.spec.filters.flatMap((f: any) => f.bindings).every((b: any) => b.tileId === "detail")).toBe(true);
    return route.fulfill({ json: { proposal: { title: "A clearer detail view", reason: "Replace the detail chart with a useful comparison", actions: [
      { type: "remove", id: "detail" }, { type: "add", tile: tile("replacement", { title: "Comparison evidence", metrics: ["net_new_mrr"] }) },
    ] } } });
  });
  const id = await open(page, original);
  await page.getByRole("tab", { name: /Detail/ }).click();
  await page.getByRole("button", { name: "Improve with AI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const saved = await save(page), after = saved.spec as DashboardSpec;
  expect(after.tiles.find(t => t.id === "overview")).toEqual(original.tiles[0]);
  expect(after.tiles.find(t => t.id === "replacement")?.tabId).toBe("two");
  expect(after.filters![0].bindings.map(b => b.tileId).sort()).toEqual(["overview", "replacement"]);
  expect(after.filters![1].bindings.map(b => b.tileId)).toEqual(["replacement"]);
  await page.reload(); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.title) }).click();
  await page.getByRole("tab", { name: /Detail/ }).click();
  await expect(page.locator(".node")).toContainText("Comparison evidence");
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec).toEqual(after);
});

test("story adds a valid monthly headline, suppresses repeats and supports undo, redo and persistence", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/dashboard-story", route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { title: input.review.dashboardTitle, layout: null, order: input.tiles.map((t: any) => t.id), notes: [], summary: "Add retention context alongside recurring revenue.",
      additions: [{ title: "Monthly retention", reason: "Add an existing-customer perspective", metrics: ["nrr"], breakdown: "none" },
        { title: "Unsupported lifecycle trend", reason: "This request has no declared trend date", metrics: ["mrr"], breakdown: "time" }] } });
  });
  const spec: DashboardSpec = { title: `Story period ${crypto.randomUUID()}`, tiles: [tile("revenue", { metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"], chart: "kpi", layout: { x: 24, y: 24, w: 420, h: 156 } })] };
  const id = await open(page, spec);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Design review" });
  const valid = review.locator(".addition-item").filter({ hasText: "Monthly retention" });
  const invalid = review.locator(".addition-item").filter({ hasText: "Unsupported lifecycle trend" });
  await expect(invalid.getByRole("button", { name: "Add this tile" })).toBeDisabled();
  await expect(invalid).toContainText("no declared date");
  await valid.getByRole("button", { name: "Add this tile" }).click();
  await expect(page.locator(".node")).toHaveCount(2);
  await expect(valid).toHaveCount(0);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node")).toHaveCount(1);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect(page.locator(".node")).toHaveCount(2);
  const saved = await save(page);
  expect(saved.spec.tiles.find((t: TileSpec) => t.metrics.includes("nrr"))).toMatchObject({ chart: "kpi", dimensions: ["month:fct_saas_monthly.month"] });
  await page.reload(); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
  await expect(page.locator(".node")).toHaveCount(2);
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec).toEqual(saved.spec);
});
