import { expect, test, type Page } from "@playwright/test";
const profile = { field: "country", type: "varchar", cardinality: 2, sample: ["US", "DE"], role: "geo" };
async function picker(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  const sheet = page.locator(".picker .sheet");
  await sheet.getByRole("button", { name: /New signups/ }).click();
  return sheet;
}

test("a profiling deadline warns while still allowing an explicitly chosen chart", async ({ page }) => {
  await page.route("**/api/profile?*", route => route.fulfill({ json: { fields: [{ ...profile, role: "categorical", cardinality: null, sample: [], warning: "Field profiling reached its time limit." }] } }));
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^country/ }).click();
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await expect(sheet.getByRole("status")).toContainText("You can still choose a chart");
  await sheet.getByRole("button", { name: /^Table/ }).click();
  await expect(sheet.getByRole("button", { name: "Add tile", exact: true })).toBeEnabled();
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  await expect(page.locator(".node table")).toBeVisible();
  await expect(page.locator(".node table tbody tr").first()).toBeVisible();
});

for (const failure of ["http", "missing"]) test(`Add a tile cannot turn ${failure} profiling into scalar recommendations`, async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/profile?*", route => {
    attempts++;
    return attempts > 1 ? route.fulfill({ json: { fields: [profile] } }) : failure === "http"
      ? route.fulfill({ status: 503, json: { error: "Profiling unavailable" } }) : route.fulfill({ json: { fields: [] } });
  });
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^country/ }).click();
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await expect(sheet.getByRole("alert")).toContainText(failure === "http" ? "unavailable" : "missing");
  await expect(sheet.getByRole("button", { name: "Add tile", exact: true })).toBeDisabled();
  await expect(sheet.locator(".vizcard")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Retry field profiles" }).click();
  await expect(sheet.getByRole("button", { name: /Country map/ })).toBeVisible();
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  await expect(page.locator(".tile figure")).toBeVisible();
  await expect.poll(() => page.locator(".tile figure svg path").count()).toBeGreaterThan(0);
});

test("backtracking to a different breakdown cancels the previous profile and keeps the chosen chart honest", async ({ page }) => {
  let started = false, release!: () => void, finished = false;
  const held = new Promise<void>(r => { release = r; });
  await page.route("**/api/profile?*", async route => {
    const field = new URL(route.request().url()).searchParams.get("fields");
    if (field === "country") {
      started = true; await held; await route.fulfill({ json: { fields: [profile] } }).catch(() => {}); finished = true;
    } else await route.fulfill({ json: { fields: [{ ...profile, field: "signup_source", role: "categorical", sample: ["organic", "paid"] }] } });
  });
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^country/ }).click();
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await expect.poll(() => started).toBe(true);
  await expect(sheet.getByRole("button", { name: "Add tile", exact: true })).toBeDisabled();
  await sheet.getByRole("button", { name: "Back", exact: true }).click();
  await sheet.getByRole("button", { name: /^country/ }).click();
  await sheet.getByRole("button", { name: /^signup_source/ }).click();
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await expect(sheet.getByRole("button", { name: "Add tile", exact: true })).toBeEnabled();
  release(); await expect.poll(() => finished).toBe(true);
  await expect(sheet.getByRole("button", { name: /Country map/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  const saved = page.waitForRequest(r => r.url().includes("/api/dashboards") && r.method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saved).postDataJSON().spec.tiles[0]).toMatchObject({ dimensions: ["signup_source"] });
});

test("filter value failures are retryable and the hidden tail can be selected", async ({ page }) => {
  let attempts = 0;
  const values = Array.from({ length: 65 }, (_, i) => ({ value: i === 64 ? "US" : `value-${i}`, n: 100 - i }));
  await page.route("**/api/values?*", route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: "Values unavailable" } }) : route.fulfill({ json: { values, truncated: true } }));
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^country/ }).dragTo(sheet.locator(".drawer"));
  const pill = sheet.locator(".pill-f");
  await expect(pill.getByRole("alert")).toContainText("Values unavailable");
  await expect(pill).not.toContainText("No values returned");
  await pill.getByRole("button", { name: "Retry filter values" }).click();
  await expect(pill.locator(".val")).toHaveCount(60);
  await pill.getByRole("button", { name: "Show all 65 returned values" }).click();
  await expect(pill.locator(".val")).toHaveCount(65);
  await pill.getByRole("checkbox", { name: "US" }).check();
  await expect(pill.locator(".sum")).toContainText("US");
  await expect(pill).toContainText("Other values may exist");
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  await expect(page.locator(".node")).toBeVisible();
});

test("date bounds stay dates, empty extents stay unknown, and the selected final day is included", async ({ page }) => {
  await page.route("**/api/extent?*", route => route.fulfill({ json: { min: null, max: null } }));
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^signup_date/ }).dragTo(sheet.locator(".drawer"));
  const pill = sheet.locator(".pill-f");
  await pill.getByRole("button", { name: "Range", exact: true }).click();
  await expect(pill).toContainText("No data range is available");
  await expect(pill).not.toContainText("data range 0");
  await pill.getByLabel("from", { exact: true }).fill("2026-01-01");
  await pill.getByLabel("through", { exact: true }).fill("2026-01-31");
  await expect(pill.getByLabel("through", { exact: true })).toHaveValue("2026-01-31");
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  const queried = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST");
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  expect((await queried).postDataJSON().where[0]).toMatchObject({ field: "signup_date", min: "2026-01-01", max: "2026-02-01", maxExclusive: true });
});

test("tile-picker filter labels distinguish values and keep a selected null visible in the summary", async ({ page }) => {
  await page.route("**/api/values?*", route => route.fulfill({ json: { values: [1, "1", null, ""].map(value => ({ value, n: 1 })) } }));
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^country/ }).dragTo(sheet.locator(".drawer"));
  const pill = sheet.locator(".pill-f");
  await expect(pill.getByRole("checkbox", { name: /^1 \(number\)/ })).toBeVisible();
  await expect(pill.getByRole("checkbox", { name: /^"1" \(text\)/ })).toBeVisible();
  await expect(pill.getByRole("checkbox", { name: /^Blank text/ })).toBeVisible();
  await pill.getByRole("checkbox", { name: /^Missing \(null\)/ }).check();
  await expect(pill.locator(".sum")).toHaveText("Missing (null)");
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  const queried = page.waitForRequest(r => r.url().includes("/api/query") && r.method() === "POST");
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  expect((await queried).postDataJSON().where[0].values).toEqual([null]);
});

test("switching filter modes ignores late metadata and preserves fractional range hints", async ({ page }) => {
  let release!: () => void, started = false, finished = false, ranges = 0;
  const held = new Promise<void>(r => { release = r; });
  await page.route("**/api/extent?*", async route => {
    if (++ranges === 1) { started = true; await held; }
    await route.fulfill({ json: { min: 1.25, max: 9.75 } }).catch(() => {}); finished = true;
  });
  await page.route("**/api/values?*", route => route.fulfill({ json: { values: [{ value: 1.25, n: 4 }, { value: 9.75, n: 2 }] } }));
  const sheet = await picker(page);
  await sheet.getByRole("button", { name: /^dim_plans.monthly_price_usd/ }).dragTo(sheet.locator(".drawer"));
  const pill = sheet.locator(".pill-f");
  await expect.poll(() => started).toBe(true);
  await pill.getByRole("button", { name: "Discrete", exact: true }).click();
  await expect(pill.locator(".val")).toHaveCount(2);
  release(); await expect.poll(() => finished).toBe(true);
  await expect(pill.locator(".val")).toHaveCount(2);
  await expect(pill.getByText("Loading values…")).toHaveCount(0);
  await pill.getByRole("button", { name: "Range", exact: true }).click();
  await expect(pill).toContainText("data range 1.25 … 9.75");
  await expect(pill.getByLabel("min", { exact: true })).toHaveAttribute("placeholder", "1.25");
  await expect(pill.getByLabel("max", { exact: true })).toHaveAttribute("placeholder", "9.75");
  await page.screenshot({ path: "../../outputs/semantic-canvas-local/picker-filter-range.png", fullPage: true });
});
