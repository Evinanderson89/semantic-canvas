import { expect, test } from "@playwright/test";
import { model as fixture } from "../test/fixtures.ts";

function snowflake(ambiguous = false) {
  const model = structuredClone(fixture);
  model.metrics = { revenue: model.metrics.revenue };
  model.tables.dim_users.columns = [{ name: "user_id", type: "string" }, { name: "region_id", type: "string" }];
  model.tables.dim_plans.columns = [{ name: "plan_id", type: "string" }, { name: "region_id", type: "string" }];
  model.tables.dim_regions = { name: "dim_regions", synonyms: [], partitionKeys: [], columns: [{ name: "region_id", type: "string" }, { name: "region", type: "string" }] };
  model.tables.fct_refunds = { name: "fct_refunds", synonyms: [], partitionKeys: [], columns: [{ name: "sale_id", type: "string" }, { name: "reason", type: "string" }] };
  model.joins.push({ left: "dim_users", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" },
    { left: "fct_sales", leftOn: "sale_id", right: "fct_refunds", rightOn: "sale_id", type: "left", cardinality: "one_to_many" });
  if (ambiguous) model.joins.push({ left: "dim_plans", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" });
  return model;
}

test("a multi-hop breakdown can be selected, filtered and rendered without offering a fan-out", async ({ page }, info) => {
  await page.route("**/api/model", route => route.fulfill({ json: snowflake() }));
  await page.route("**/api/profile?*", route => route.fulfill({ json: { fields: [{ field: "dim_regions.region", type: "string", role: "categorical", cardinality: 2, sample: ["East", "West"] }] } }));
  await page.route("**/api/values?*", route => route.fulfill({ json: { values: [{ value: "East", n: 2 }, { value: "West", n: 1 }], truncated: false } }));
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ json: { columns: ["region", "revenue"], rows: [["East", 300]], sql: "", ms: 1 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  const sheet = page.locator(".picker .sheet");
  await sheet.getByRole("button", { name: /^Revenue \(USD\)/ }).click();
  const region = sheet.getByRole("button", { name: /^dim_regions.region / });
  await expect(region).toBeVisible();
  await expect(region).toContainText("fct_sales → dim_users → dim_regions");
  await expect(sheet.getByRole("button", { name: /^fct_refunds.reason/ })).toHaveCount(0);
  await sheet.getByText("Unavailable joined tables", { exact: true }).click();
  await expect(sheet).toContainText("double count");
  await region.click();
  await expect(region).toHaveAttribute("aria-pressed", "true");
  await region.dragTo(sheet.locator(".drawer"));
  await sheet.locator(".pill-f").getByRole("checkbox", { name: "East" }).check();
  await sheet.locator(".joined-unavailable").scrollIntoViewIfNeeded();
  await expect(sheet.locator(".joined-unavailable p").last()).toBeInViewport();
  await page.screenshot({ path: info.outputPath("joined-fields.png") });
  await sheet.getByRole("button", { name: /Choose visualization/ }).click();
  await sheet.getByRole("button", { name: /Horizontal bar/ }).click();
  await sheet.getByRole("button", { name: "Add tile", exact: true }).click();
  await expect(page.locator(".node .tile figure svg")).toBeVisible();
  expect(queries.at(-1)).toMatchObject({ metrics: ["revenue"], dimensions: ["dim_regions.region"], where: [expect.objectContaining({ field: "dim_regions.region", values: ["East"] })] });
});

test("ambiguous paths explain the model correction instead of offering an invalid breakdown", async ({ page }) => {
  await page.route("**/api/model", route => route.fulfill({ json: snowflake(true) }));
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  const sheet = page.locator(".picker .sheet");
  await sheet.getByRole("button", { name: /^Revenue \(USD\)/ }).click();
  await expect(sheet.getByRole("button", { name: /^dim_regions.region / })).toHaveCount(0);
  await sheet.getByText("Unavailable joined tables", { exact: true }).click();
  await expect(sheet).toContainText("two ways");
  await expect(sheet).toContainText("the model must say which");
});

test("selecting a qualified dimension does not select a same-named local field", async ({ page }) => {
  const model = snowflake();
  model.tables.fct_sales.columns.push({ name: "region", type: "string" }, { name: "subregion", type: "string" });
  await page.route("**/api/model", route => route.fulfill({ json: model }));
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  const sheet = page.locator(".picker .sheet");
  await sheet.getByRole("button", { name: /^Revenue \(USD\)/ }).click();
  const joined = sheet.getByRole("button", { name: /^dim_regions.region / });
  const own = sheet.getByRole("button", { name: /^region string$/ });
  const suffix = sheet.getByRole("button", { name: /^subregion string$/ });
  await joined.click();
  await expect(joined).toHaveAttribute("aria-pressed", "true");
  await expect(own).toHaveAttribute("aria-pressed", "false");
  await expect(own).not.toHaveClass(/\bon\b/);
  await joined.click();
  await suffix.click();
  await expect(suffix).toHaveAttribute("aria-pressed", "true");
  await expect(own).toHaveAttribute("aria-pressed", "false");
  await expect(joined).toHaveAttribute("aria-pressed", "false");
});
