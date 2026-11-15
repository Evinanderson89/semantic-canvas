import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test("investigates retention without AI, keeps the view, and restores with one undo", async ({ page }) => {
  let aiCalls = 0;
  await page.route("**/api/agent/status", r => r.fulfill({ json: { configured: false } }));
  await page.route("**/api/agent/chat", r => { aiCalls++; return r.abort(); });
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const originalCount = await page.locator(".node").count();
  const card = page.locator(".node").filter({ has: page.locator(".kpi-label", { hasText: /^Net revenue retention$/i }) });
  await card.getByRole("button", { name: "Investigate this", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Investigate this", exact: true });
  await expect(dialog).toContainText("no additional supported categorical breakdowns");
  await expect(dialog).toContainText("2026-08-01");
  await expect(dialog.getByRole("button", { name: "Keep this view", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: /Compare with the previous period/ }).click();
  await expect(dialog.locator("table")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep this view", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Keep this view", exact: true }).click();
  await expect(page.locator(".node")).toHaveCount(originalCount + 1);
  await expect(page.locator(".evidence-origin")).toContainText("Net revenue retention");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node")).toHaveCount(originalCount);
  expect(aiCalls).toBe(0);
});

test("investigation preserves current scope and saved evidence survives reopening", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "MRR movements");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("dim_users.country");
  await page.getByLabel("Label", { exact: true }).fill("Country");
  await page.getByRole("button", { name: "Save filter", exact: true }).click();
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  await page.getByRole("checkbox", { name: "US", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Wait for this time-series chart, not whichever chart finishes querying first.
  await page.getByRole("group", { name: "Monthly movement mix", exact: true }).getByRole("button", { name: "Investigate this", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Investigate this", exact: true });
  await expect(dialog).toContainText("dim_users.country US");
  await dialog.getByRole("button", { name: /Break down by country/ }).click();
  await expect(dialog.getByRole("button", { name: "Keep this view", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Keep this view", exact: true }).click();
  const save = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const savedRequest = (await save).request().postDataJSON();
  const evidence = savedRequest.spec.tiles.find((t: any) => t.evidence);
  expect(evidence.where).toContainEqual(expect.objectContaining({ field: "dim_users.country", values: ["US"] }));
  expect(evidence.dimensions).toEqual(["month:fct_mrr_movements.movement_date", "fct_mrr_movements.movement_type", "dim_users.country"]);
  expect(evidence.where).toContainEqual(expect.objectContaining({ field: "fct_mrr_movements.movement_date", min: "2026-03-01", max: "2026-09-01", maxExclusive: true }));
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.getByRole("button", { name: /Workspace$/ }).click();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  // Saved dashboards are ordered newest first; previous runs may have the same starter title.
  const reopened = page.waitForResponse(r => r.url().endsWith(`/api/dashboards/${savedRequest.id}`) && r.request().method() === "GET");
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: savedRequest.spec.title, exact: false }).first().click();
  expect((await reopened).ok()).toBe(true);
  await expect(page.locator(".evidence-origin")).toBeVisible();
});

test("a failed investigation is retryable and cannot be kept", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "SaaS overview");
  await page.route("**/api/query", route => route.request().postDataJSON()?.id?.startsWith("investigation:")
    ? route.fulfill({ status: 503, json: { error: "Warehouse unavailable" } }) : route.continue());
  await page.getByRole("button", { name: "Investigate this", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Investigate this", exact: true });
  await expect(dialog.getByRole("button", { name: "Retry investigation", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep this view", exact: true })).toBeDisabled();
  await page.unroute("**/api/query");
  await dialog.getByRole("button", { name: "Retry investigation", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Keep this view", exact: true })).toBeEnabled();
});
