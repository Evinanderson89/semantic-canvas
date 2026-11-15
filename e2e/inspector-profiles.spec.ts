import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

const geo = { field: "country", type: "varchar", cardinality: 2, sample: ["US", "DE"], role: "geo" };
const category = { field: "movement_type", type: "varchar", cardinality: 3, sample: ["new", "churn", "expansion"], role: "categorical" };
async function dashboard(page: Page) {
  const id = crypto.randomUUID(), title = `Profile regression ${id.slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000 }, spec: { title, tiles: [
    { id: "country", title: "Country chart", metrics: ["new_signups"], dimensions: ["country"], chart: "bar", layout: { x: 24, y: 24, w: 400, h: 320 } },
    { id: "movement", title: "Movement chart", metrics: ["new_mrr"], dimensions: ["movement_type"], chart: "bar", layout: { x: 460, y: 24, w: 400, h: 320 } },
  ] } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
}

test("a slow previous chart cannot overwrite the current inspector's suggestions", async ({ page }) => {
  let started = false, release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await page.route("**/api/profile?*", async route => {
    if (new URL(route.request().url()).searchParams.get("fields") === "country") {
      started = true; await held;
      await route.fulfill({ json: { fields: [geo] } }).catch(() => {});
    } else await route.fulfill({ json: { fields: [category] } });
  });
  await dashboard(page);
  await page.getByRole("group", { name: "Country chart", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.locator(".inspector").getByRole("status")).toHaveText("Profiling…");
  await page.getByRole("group", { name: "Movement chart", exact: true }).click();
  const inspector = page.locator(".inspector");
  await expect(inspector.locator(".viz-row").first()).toBeVisible();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toHaveCount(0);
  release();
  // A real subsequent user edit confirms the current tile remains the target after the late response.
  await inspector.getByPlaceholder("Tile title").fill("Movement remains selected");
  await expect(page.getByRole("group", { name: "Movement remains selected", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toHaveCount(0);
});

test("changing the acting principal invalidates existing profile suggestions before new data arrives", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await page.route("**/api/profile?*", async route => {
    if (route.request().headers()["x-sc-principal"] === "emea") {
      await held; await route.fulfill({ json: { fields: [{ ...geo, role: "categorical", sample: ["Unknown"] }] } });
    } else await route.fulfill({ json: { fields: [geo] } });
  });
  await dashboard(page);
  await page.getByRole("group", { name: "Country chart", exact: true }).click();
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("button", { name: /Country map/ })).toBeVisible();
  await page.getByLabel("Acting as", { exact: true }).selectOption("emea");
  await expect(inspector.getByRole("status")).toHaveText("Profiling…");
  await expect(inspector.locator(".viz-row")).toHaveCount(0);
  release();
  await expect(inspector.locator(".viz-row").first()).toBeVisible();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toHaveCount(0);
});

for (const failure of ["http", "missing"]) test(`${failure} profile response shows a recoverable error instead of scalar recommendations`, async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/profile?*", route => {
    attempts++;
    if (attempts === 1) return failure === "http" ? route.fulfill({ status: 503, json: { error: "Warehouse profiling is unavailable" } })
      : route.fulfill({ json: { fields: [] } });
    return route.fulfill({ json: { fields: [geo] } });
  });
  await dashboard(page);
  await page.getByRole("group", { name: "Country chart", exact: true }).click();
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("alert")).toContainText(failure === "http" ? "unavailable" : "missing");
  await expect(inspector.locator(".viz-row")).toHaveCount(0);
  await inspector.getByRole("button", { name: "Retry field profiles" }).click();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toBeVisible();
  await expect(inspector.getByRole("alert")).toHaveCount(0);
});

test("the same tile re-profiles when its metric base or semantic model changes", async ({ page }) => {
  const bases: string[] = [];
  await page.route("**/api/profile?*", route => {
    const base = new URL(route.request().url()).searchParams.get("base")!; bases.push(base);
    return route.fulfill({ json: { fields: [{ ...geo, role: base === "fct_sales" ? "geo" : "categorical" }] } });
  });
  await page.goto("/e2e/fixtures/inspector.html");
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("button", { name: /Country map/ })).toBeVisible();
  await page.getByRole("button", { name: "Change metric base" }).click();
  await expect.poll(() => bases).toEqual(["fct_sales", "dim_users"]);
  await expect(inspector.getByRole("button", { name: /Country map/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Reload semantic model" }).click();
  await expect.poll(() => bases).toEqual(["fct_sales", "dim_users", "dim_users"]);
});

test("timed-out evidence is visible without blocking manual chart selection and can be refreshed", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/profile?*", route => route.fulfill({ json: { fields: [++attempts === 1
    ? { ...geo, role: "categorical", cardinality: null, sample: [], warning: "Field profiling reached its time limit." }
    : geo] } }));
  await dashboard(page);
  await page.getByRole("group", { name: "Country chart", exact: true }).click();
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("status")).toContainText("Some field evidence is unavailable");
  await expect(inspector.locator(".viz-row").first()).toBeEnabled();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toHaveCount(0);
  await inspector.getByRole("button", { name: "Retry field profiles" }).click();
  await expect(inspector.getByRole("button", { name: /Country map/ })).toBeVisible();
  await expect(inspector.getByRole("status")).toHaveCount(0);
});
