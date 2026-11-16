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

test("publication review can retry a failed load without closing the dialog", async ({ page, request }) => {
  await disconnect(request);
  expect((await request.post(`/api/sources/${source}/connected`, { data: registration })).ok()).toBe(true);
  let attempts = 0;
  await page.route(`**/api/sources/${source}/connected/${dataset}`, route => {
    if (route.request().method() === "GET" && ++attempts === 1) return route.fulfill({ status: 503, json: { error: "Catalogue temporarily unavailable" } });
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.locator(".connected-table", { hasText: dataset }).getByRole("button", { name: "Review and publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Review and publish ${dataset}` });
  await expect(dialog.getByRole("alert")).toContainText("Catalogue temporarily unavailable");
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry loading review", exact: true }).click();
  await expect(dialog.getByLabel("Grain", { exact: true })).toHaveValue("one row per order");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  expect(attempts).toBe(2);
});

test("publication freezes submitted fields and preserves them after a failed save", async ({ page, request }) => {
  await disconnect(request);
  expect((await request.post(`/api/sources/${source}/connected`, { data: registration })).ok()).toBe(true);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route(`**/api/sources/${source}/connected/${dataset}/publish`, async route => {
    if (++attempts === 1) { await held; return route.fulfill({ status: 503, json: { error: "Publication temporarily unavailable" } }); }
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const row = page.locator(".connected-table", { hasText: dataset });
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Review and publish ${dataset}` });
  const grain = dialog.getByLabel("Grain", { exact: true });
  const metric = dialog.locator(".publish-metric", { hasText: "e2e_shop_orders_rows" });
  await grain.fill("One row per completed order");
  await metric.getByLabel("Publish e2e_shop_orders_rows").check();
  await metric.getByLabel("Label", { exact: true }).fill("Completed orders");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  try {
    await expect(grain).toBeDisabled();
    await expect(dialog.getByLabel("Default date column")).toBeDisabled();
    await expect(metric.getByLabel("Label", { exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(dialog.getByRole("alert")).toContainText("Publication temporarily unavailable");
  await expect(grain).toBeEnabled();
  await expect(grain).toHaveValue("One row per completed order");
  await expect(metric.getByLabel("Label", { exact: true })).toHaveValue("Completed orders");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await (await request.get(`/api/sources/${source}/connected/${dataset}`)).json();
  expect(saved.table.grain).toBe("One row per completed order");
  expect(saved.metrics.e2e_shop_orders_rows).toMatchObject({ label: "Completed orders", reviewed: true });
});

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
  await rows.getByLabel("Importance (0–100)").fill("80");
  await rows.getByLabel("month", { exact: true }).check();
  // The server's own validation comes back inline: grains need a date time dimension.
  await rows.getByLabel("Time dimension").selectOption("");
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("time_grains requires a date time_dimension");
  await rows.getByLabel("Time dimension").selectOption(`${dataset}.created_at`);
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText("Published", { exact: true })).toBeVisible();
  await expect(row.getByText("Orders · published", { exact: true })).toBeVisible();
  await expect(row.getByText("Order amount · draft", { exact: true })).toBeVisible();
  await expect(row.getByText("2 metrics (1 reviewed)")).toBeVisible();
  // Clear previously saved metadata, then reopen to verify what the server actually kept.
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  await rows.getByLabel("Direction").selectOption("");
  await rows.getByLabel("Importance (0–100)").fill("");
  await rows.getByLabel("month", { exact: true }).uncheck();
  await dialog.getByLabel("Default date column").selectOption("");
  await dialog.getByLabel("Grain", { exact: true }).fill("");
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog).toHaveCount(0);
  const cleared = await (await request.get(`/api/sources/${source}/connected/${dataset}`)).json();
  expect(cleared.table.default_date_column).toBeUndefined(); expect(cleared.table.grain).toBeUndefined();
  expect(cleared.metrics.e2e_shop_orders_rows.direction).toBeUndefined();
  expect(cleared.metrics.e2e_shop_orders_rows.importance).toBeUndefined();
  expect(cleared.metrics.e2e_shop_orders_rows.time_grains).toBeUndefined();
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  await rows.getByLabel("Publish e2e_shop_orders_rows").uncheck();
  await expect(dialog.getByText("Withdrawing published metrics", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("Viewer charts using these metrics will stop returning results");
  await page.screenshot({ path: "test-results/publication-withdrawal.png" });
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText("2 metrics (0 reviewed)")).toBeVisible();
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  await expect(rows.getByLabel("Publish e2e_shop_orders_rows")).not.toBeChecked();
  await rows.getByLabel("Publish e2e_shop_orders_rows").check();
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText("2 metrics (1 reviewed)")).toBeVisible();
  // Another administrator's change must not be silently undone by this open review.
  await row.getByRole("button", { name: "Review and publish", exact: true }).click();
  await rows.getByLabel("Label", { exact: true }).fill("My unfinished label");
  expect((await request.post(`/api/sources/${source}/connected/${dataset}/publish`, { data: { metrics: { e2e_shop_orders_rows: { reviewed: true, label: "Other administrator's label" } } } })).ok()).toBe(true);
  await dialog.getByRole("button", { name: /^(Publish|Save publication changes)$/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("This dataset changed while you were reviewing it");
  await expect(rows.getByLabel("Label", { exact: true })).toHaveValue("My unfinished label");
  const latest = await (await request.get(`/api/sources/${source}/connected/${dataset}`)).json();
  expect(latest.metrics.e2e_shop_orders_rows.label).toBe("Other administrator's label");
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
