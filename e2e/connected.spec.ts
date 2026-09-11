import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * A table Ingest connected (docs/connected-canvas.md), reviewed and published
 * from Connections. Local mode acts as the administrator, so registration is
 * one API call and the whole review happens in the browser.
 */
const source = "duckglue-local", dataset = "e2e_shop_orders";
const registration = { dataset, importId: "imp-e2e",
  table: { description: "Orders", grain: "one row per order", primary_key: "id", default_date_column: "created_at", columns: [{ name: "id", type: "string" }, { name: "amount", type: "double" }, { name: "created_at", type: "timestamp" }] },
  metrics: { e2e_shop_orders_rows: { label: "Orders", expression: "count(*)" }, e2e_shop_orders_amount_total: { label: "Order amount", expression: "sum(amount)" } },
  provenance: { source: "Shop orders", loadedAt: "2026-09-10T15:00:00Z", loadedBy: "casey", rows: 12 } };
const disconnect = (request: APIRequestContext) => request.delete(`/api/sources/${source}/connected/${dataset}`);
test.afterEach(async ({ request }) => { await disconnect(request); });

test("an administrator reviews a connected table's draft metrics and publishes the ones it ticks", async ({ page, request }) => {
  await disconnect(request);
  expect((await request.post(`/api/sources/${source}/connected`, { data: registration })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const row = page.locator(".connected-table", { hasText: dataset });
  await expect(row.getByText("Ingested, unreviewed")).toBeVisible();
  await expect(row.getByText("Orders · draft", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Count of rows")).toBeVisible();
  await expect(dialog.getByText("Total of amount")).toBeVisible();
  await expect(dialog.getByLabel("Default date column")).toHaveValue("created_at");
  const rows = dialog.locator(".publish-metric", { hasText: "e2e_shop_orders_rows" });
  await rows.getByLabel("Publish e2e_shop_orders_rows").check();
  await rows.getByLabel("Direction").selectOption("higher");
  await rows.getByLabel("month", { exact: true }).check();
  // The server's own validation comes back inline: grains need a date time dimension.
  await rows.getByLabel("Time dimension").selectOption("");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("time_grains requires a date time_dimension");
  await rows.getByLabel("Time dimension").selectOption(`${dataset}.created_at`);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText("Published", { exact: true })).toBeVisible();
  await expect(row.getByText("Orders · published", { exact: true })).toBeVisible();
  await expect(row.getByText("Order amount · draft", { exact: true })).toBeVisible();
  await expect(row.getByText("2 metrics (1 reviewed)")).toBeVisible();
});

test("an Open in Semantic Canvas link selects the source, opens the registry on the table and leaves a clean URL", async ({ page }) => {
  await page.goto("/?source=duckglue-local&table=fct_saas_monthly&keep=1");
  await expect(page.getByRole("heading", { name: "Metric Registry", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter by topic", { exact: true })).toHaveValue("fct_saas_monthly");
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?keep=1");
  expect(await page.evaluate(() => localStorage.getItem("sc:source"))).toBe("duckglue-local");
  await page.goto("/?source=nope&table=nope");
  await expect(page.getByText("Suggest a dashboard")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.search)).toBe("");
});
