import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import { openStarter } from "./library-helpers.ts";
const spec = (): DashboardSpec => ({ title: `Filter styles ${crypto.randomUUID()}`, tiles: [
  { id: "a", title: "Signups by platform", metrics: ["new_signups"], dimensions: ["dim_users.device_platform"], chart: "bar", layout: { x: 24, y: 190, w: 750, h: 350 } },
  { id: "k", title: "Active users", metrics: ["active_users"], dimensions: [], chart: "kpi", layout: { x: 800, y: 190, w: 180, h: 150 } },
] });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The sample model pins its calendar's today (docs/calendar.md), so presets end there, not on the wall clock.
let today = new Date();
test.beforeEach(async ({ request }) => { const m = await (await request.get("/api/model")).json(); today = m.calendar?.today ? new Date(`${m.calendar.today}T12:00:00`) : new Date(); });
const daysFromToday = (n: number) => { const d = today; return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
async function open(page: Page, d: DashboardSpec) {
  const id = crypto.randomUUID();
  const saved = await page.request.post("/api/dashboards", { data: { id, spec: d, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 850 }, revision: 0 } }); expect(saved.ok()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click(); await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(d.title) }).click(); return id;
}
const query = (page: Page, tile: string, match: (f: any) => boolean) => page.waitForResponse(r => r.url().endsWith("/api/query") && r.request().postDataJSON()?.id === tile && !!r.request().postDataJSON()?.where?.some(match));

test("NUMBER metadata offers a numeric range and sends numeric bounds to the chart", async ({ page }) => {
  await page.route("**/api/model*", async route => {
    const response = await route.fetch(), model = await response.json();
    model.tables.fct_mrr_movements.columns.find((c: { name: string }) => c.name === "mrr_delta_usd").type = "NUMBER(18,2)";
    await route.fulfill({ response, json: model });
  });
  const d: DashboardSpec = { title: `Decimal amount filter ${crypto.randomUUID()}`, tiles: [{
    id: "amount", title: "New revenue", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line",
    layout: { x: 24, y: 190, w: 750, h: 350 },
  }] };
  const id = await open(page, d);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("fct_mrr_movements.mrr_delta_usd");
  await page.getByLabel("Label", { exact: true }).fill("Movement amount");
  await expect(page.getByRole("radiogroup", { name: "Show as" }).getByRole("radio")).toHaveText(["Range"]);
  await page.getByRole("button", { name: "Save filter", exact: true }).click();
  const input = page.getByLabel("Movement amount from", { exact: true });
  await expect(input).toHaveAttribute("type", "number");
  const ran = query(page, "amount", f => f.field === "fct_mrr_movements.mrr_delta_usd" && f.mode === "range" && f.min === 10.25);
  await input.fill("10.25");
  expect((await ran).ok()).toBe(true);
  const exact = query(page, "amount", f => f.field === "fct_mrr_movements.mrr_delta_usd" && f.min === "9007199254740993");
  await input.fill("9007199254740993");
  expect((await exact).ok()).toBe(true);
  await expect(input).toHaveValue("9007199254740993");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  const persisted = await (await page.request.get(`/api/dashboards/${id}`)).json();
  expect(persisted.spec.filters[0]).toMatchObject({ control: "number" });
  // Range is the default presentation and need not be stored explicitly.
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(d.title) }).click();
  await expect(input).toHaveAttribute("type", "number");
});

test("authors a chips filter, toggles two chips and sends both values to the connected chart", async ({ page }) => {
  const d = spec(), id = await open(page, d);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("dim_users.device_platform"); await page.getByLabel("Label", { exact: true }).fill("Platform");
  const showAs = page.getByRole("radiogroup", { name: "Show as" });
  await expect(showAs.getByRole("radio")).toHaveText(["Dropdown", "Chips", "Segmented"]); await expect(showAs.getByRole("radio", { name: "Dropdown" })).toHaveAttribute("aria-checked", "true");
  await showAs.getByRole("radio", { name: "Chips" }).click(); await page.getByRole("button", { name: "Save filter", exact: true }).click();
  const group = page.getByRole("group", { name: "Platform" });
  await expect(group.getByRole("button", { name: /^ios/ })).toBeVisible();
  const first = query(page, "a", f => f.values?.length === 1 && f.values.includes("ios"));
  await group.getByRole("button", { name: /^ios/ }).click(); expect((await first).ok()).toBe(true);
  await expect(group.getByRole("button", { name: /^ios/ })).toHaveAttribute("aria-pressed", "true");
  const both = query(page, "a", f => f.values?.includes("ios") && f.values?.includes("android") && f.values.length === 2);
  await group.getByRole("button", { name: /^android/ }).click(); expect((await both).ok()).toBe(true);
  await expect(group.getByRole("button", { name: "Clear", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await expect(page.locator(".save-status")).toHaveText("Saved");
  const persisted = await (await page.request.get(`/api/dashboards/${id}`)).json();
  expect(persisted.spec.filters[0]).toMatchObject({ field: "dim_users.device_platform", control: "select", presentation: "chips" });
  expect(persisted.spec.tiles.find((t: any) => t.kind === "filter").layout).toMatchObject({ w: 520, h: 120 });
});

test("switches a date filter to presets and Last 30 days runs a 30-day window ending today", async ({ page }) => {
  const d = spec(); d.filters = [{ id: "period", label: "Period", field: "fct_events.event_date", control: "date", scope: "report", bindings: [{ tileId: "k", field: "fct_events.event_date" }] }];
  d.tiles.push({ id: "f", kind: "filter", filterId: "period", title: "Period", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 360, h: 150 } });
  const id = await open(page, d);
  await expect(page.getByLabel("Period from", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Period filter", exact: true }).click();
  const showAs = page.getByRole("radiogroup", { name: "Show as" }); await expect(showAs.getByRole("radio")).toHaveText(["Range", "Presets"]);
  await showAs.getByRole("radio", { name: "Presets" }).click(); await page.getByRole("button", { name: "Save filter", exact: true }).click();
  const period = page.getByRole("radiogroup", { name: "Period period" });
  const ran = query(page, "k", f => f.field === "fct_events.event_date" && f.min === daysFromToday(-29) && f.max === daysFromToday(1) && f.maxExclusive === true);
  await period.getByRole("radio", { name: "Last 30 days" }).click(); expect((await ran).ok()).toBe(true);
  await expect(period.getByRole("radio", { name: "Last 30 days" })).toHaveAttribute("aria-checked", "true");
  await expect(period.locator(".filter-resolved")).toHaveText(/^\w{3} \d{1,2} to \w{3} \d{1,2}$/);
  await period.getByRole("radio", { name: "Custom" }).click(); await expect(page.getByLabel("Period from", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await expect(page.locator(".save-status")).toHaveText("Saved");
  const persisted = await (await page.request.get(`/api/dashboards/${id}`)).json();
  expect(persisted.spec.filters[0]).toMatchObject({ control: "date", presentation: "presets" }); expect(persisted.spec.filters[0].defaultValue).toBeUndefined();
});

test("a document round-trips presentation and a preset default, and the API rejects mismatched pairings", async ({ page, request }) => {
  const d = spec(); d.filters = [
    { id: "period", label: "Period", field: "fct_events.event_date", control: "date", presentation: "presets", scope: "report", defaultValue: { preset: "last-30-days" }, bindings: [{ tileId: "k", field: "fct_events.event_date" }] },
    { id: "platform", label: "Platform", field: "dim_users.device_platform", control: "select", presentation: "segmented", scope: "report", bindings: [{ tileId: "a", field: "dim_users.device_platform" }] },
  ];
  d.tiles.push({ id: "f", kind: "filter", filterId: "period", title: "Period", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 520, h: 120 } });
  const ran = query(page, "k", f => f.min === daysFromToday(-29) && f.max === daysFromToday(1));
  const id = await open(page, d); expect((await ran).ok()).toBe(true);
  const persisted = await (await request.get(`/api/dashboards/${id}`)).json();
  expect(persisted.spec.filters.map((f: any) => [f.presentation, f.defaultValue])).toEqual([["presets", { preset: "last-30-days" }], ["segmented", undefined]]);
  await expect(page.getByRole("radiogroup", { name: "Period period" }).getByRole("radio", { name: "Last 30 days" })).toHaveAttribute("aria-checked", "true");
  const shelf = page.getByRole("radiogroup", { name: "Platform" }); await expect(shelf.getByRole("radio", { name: /^web/ })).toBeVisible();
  const one = query(page, "a", f => f.values?.length === 1 && f.values.includes("web"));
  await shelf.getByRole("radio", { name: /^web/ }).click(); expect((await one).ok()).toBe(true);
  const other = query(page, "a", f => f.values?.length === 1 && f.values.includes("ios"));
  await shelf.getByRole("radio", { name: /^ios/ }).click(); expect((await other).ok()).toBe(true);
  await expect(shelf.getByRole("radio", { name: /^web/ })).toHaveAttribute("aria-checked", "false");
  for (const bad of [{ ...d.filters[1], presentation: "presets" }, { ...d.filters[0], defaultValue: { preset: "last-7-days", min: "2026-01-01" } }]) {
    const result = await request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec: { ...d, filters: [bad] }, canvas: DEFAULT_CANVAS, revision: 0 } });
    expect(result.status()).toBe(400); expect(await result.text()).toMatch(/presentation|preset/);
  }
});

test("the Filter styles starter shows chips, a segmented row and date presets", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "Filter styles");
  await expect(page.locator(".node")).toHaveCount(6);
  await expect(page.getByRole("group", { name: "Platform" }).getByRole("button", { name: /^web/ })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Plan" }).getByRole("radio").first()).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Period period" }).getByRole("radio", { name: "Last 30 days" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Active users" })).toContainText(/\d/);
  await expect(page.getByRole("radiogroup", { name: "Period period" }).locator(".filter-resolved")).toHaveText(/^\w{3} \d{1,2} to \w{3} \d{1,2}$/);
  await page.screenshot({ path: "test-results/filter-styles-starter.png" });
});

for (const timezoneId of ["UTC", "Pacific/Kiritimati"]) test.describe(`reporting presets in a ${timezoneId} browser`, () => {
  test.use({ timezoneId });
  for (const pinned of [false, true]) test(`${pinned ? "pinned" : "live"} reporting date drives the visible range and actual query`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-02-01T00:30:00Z"));
    await page.route("**/api/model", async route => {
      const response = await route.fetch(), model = await response.json();
      model.calendar = { weekStart: "monday", fiscalYearStartMonth: 2,
        timezone: pinned ? "Pacific/Kiritimati" : "America/Los_Angeles", ...(pinned ? { today: "2026-08-31" } : {}) };
      await route.fulfill({ json: model });
    });
    const d = spec();
    d.filters = [{ id: "period", label: "Period", field: "fct_events.event_date", control: "date", presentation: "presets", scope: "report", defaultValue: { preset: "last-7-days" }, bindings: [{ tileId: "k", field: "fct_events.event_date" }] }];
    d.tiles.push({ id: "f", kind: "filter", filterId: "period", title: "Period", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 700, h: 150 } });
    const max = pinned ? "2026-09-01" : "2026-02-01";
    const ran = query(page, "k", f => f.min === (pinned ? "2026-08-25" : "2026-01-25") && f.max === max && f.maxExclusive === true);
    await open(page, d);
    expect((await ran).ok()).toBe(true);
    const control = page.getByRole("radiogroup", { name: "Period period" });
    await expect(control.locator(".filter-resolved")).toHaveText(pinned ? "Aug 25 to Aug 31" : "Jan 25 to Jan 31");
    const fiscal = query(page, "k", f => f.min === (pinned ? "2026-02-01" : "2025-02-01") && f.max === max && f.maxExclusive === true);
    await control.getByRole("radio", { name: "Year to date", exact: true }).click();
    expect((await fiscal).ok()).toBe(true);
    await expect(control.locator(".filter-resolved")).toHaveText(pinned ? "Feb 1 to Aug 31" : "Feb 1, 2025 to Jan 31, 2026");
  });
});
