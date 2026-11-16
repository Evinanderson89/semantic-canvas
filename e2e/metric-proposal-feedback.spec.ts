import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Metric Registry", exact: true }).click();
  await page.getByRole("button", { name: "Propose a metric", exact: true }).click();
  const form = page.getByRole("form", { name: "Propose a metric" });
  await form.getByLabel("Label", { exact: true }).fill("Synthetic reviewed count");
  await form.getByLabel("Expression", { exact: true }).fill("COUNT(*)");
  return form;
}

test("a checked proposal freezes its fields, confirms unreviewed status and appears in the registry", async ({ page }) => {
  let metric: any, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/model", async route => {
    const response = await route.fetch(), body = await response.json();
    if (metric) body.metrics[metric.name] = metric;
    await route.fulfill({ json: body });
  });
  await page.route("**/api/sources/*/metrics", async route => {
    metric = { ...route.request().postDataJSON(), filter: null, synonyms: [], reviewed: false,
      origin: { kind: "proposal", by: "Synthetic reviewer", at: "2026-11-15T10:00:00.000Z" } };
    await pending; await route.fulfill({ json: { metric } });
  });
  const form = await open(page);
  await form.getByRole("button", { name: "Check and propose" }).click();
  await expect(form.getByLabel("Label", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("Expression", { exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "Cancel" })).toBeDisabled();
  release();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Synthetic reviewed count" })).toContainText("marked unreviewed");
  await expect(page.getByRole("button", { name: "Propose a metric", exact: true })).toBeFocused();
  await expect(page.locator(".mrow").filter({ hasText: "Synthetic reviewed count" })).toContainText("Proposed by Synthetic reviewer, unreviewed");
});

test("a rejected proposal retains its definition and can be corrected and resubmitted", async ({ page }) => {
  let accept = false;
  await page.route("**/api/sources/*/metrics", route => accept
    ? route.fulfill({ json: { metric: { ...route.request().postDataJSON(), reviewed: false } } })
    : route.fulfill({ status: 422, json: { problems: ["Synthetic warehouse rejected this expression"] } }));
  const form = await open(page);
  await form.getByRole("button", { name: "Check and propose" }).click();
  await expect(form.getByRole("alert")).toContainText("warehouse rejected");
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Synthetic reviewed count");
  await expect(form.getByLabel("Expression", { exact: true })).toHaveValue("COUNT(*)");
  await expect(form.getByLabel("Expression", { exact: true })).toBeEnabled();
  accept = true;
  await form.getByLabel("Expression", { exact: true }).fill("COUNT(1)");
  await form.getByRole("button", { name: "Check and propose" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Synthetic reviewed count" })).toContainText("live for editors");
});

for (const response of ["missing", "wrong-metric"] as const) test(`an unconfirmed ${response} response cannot claim a metric is ready`, async ({ page }) => {
  await page.route("**/api/sources/*/metrics", route => route.fulfill({ json: {
    metric: response === "missing" ? null : { ...route.request().postDataJSON(), name: "other_metric", reviewed: false },
  } }));
  const form = await open(page);
  await form.getByRole("button", { name: "Check and propose" }).click();
  await expect(form.getByRole("alert")).toContainText("could not confirm the new metric");
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Synthetic reviewed count");
  await expect(page.getByRole("status").filter({ hasText: "live for editors" })).toHaveCount(0);
});
