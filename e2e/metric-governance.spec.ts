import { expect, test } from "@playwright/test";

test("editors see which computed metrics depend on unpublished components, and the warning clears after publication", async ({ page }) => {
  let published = false;
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.route("**/api/model**", async route => {
    const response = await route.fetch(), model = await response.json();
    const base = model.metrics.ending_mrr;
    model.metrics.test_draft_component = { ...base, name: "test_draft_component", label: "Draft adjustment", reviewed: published };
    model.metrics.test_derived = { ...base, name: "test_derived", label: "Dependency review metric", type: "derived", expression: "ending_mrr - test_draft_component" };
    await route.fulfill({ response, json: model });
  });
  const openRegistry = () => page.goto("/?source=duckglue-local&table=fct_saas_monthly");
  await openRegistry();
  const row = page.locator(".mrow").filter({ has: page.getByText("Dependency review metric", { exact: true }) });
  const warning = row.getByText("Dependencies need review", { exact: true });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("title", /Draft adjustment.*administrator review/);
  await expect(row.getByText("Ingested, unreviewed", { exact: true })).toHaveCount(0);
  published = true;
  await openRegistry();
  await expect(row).toBeVisible();
  await expect(warning).toHaveCount(0);
});
