import { expect, test } from "@playwright/test";

test("studio disclosures work with the keyboard and keep save actions reachable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await expect(page.getByRole("button", { name: "Add a chart", exact: true })).toBeVisible();
  const settings = page.getByRole("button", { name: "Canvas settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Canvas size", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await expect(page.getByLabel("Canvas size", { exact: true })).toHaveCount(0);
  const menu = page.getByRole("button", { name: "Dashboard actions", exact: true });
  await menu.click();
  const response = page.waitForResponse((r) => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save a copy", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".save-status")).toHaveText("Saved");
});

test("the metric library reveals definitions on demand and combines search with topics", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Metric Registry", exact: true }).click();
  await expect(page.locator(".expr").first()).toBeHidden();
  await page.locator(".metric-definition summary").first().click();
  await expect(page.locator(".expr").first()).toBeVisible();
  await page.getByLabel("Filter metrics", { exact: true }).fill("Ending MRR");
  await page.getByLabel("Filter by topic", { exact: true }).selectOption("fct_saas_monthly");
  await expect(page.locator(".mrow")).toHaveCount(1);
  await page.getByRole("button", { name: "Chart it →", exact: true }).click();
  await expect(page.locator(".kpi-value").first()).not.toHaveText("—");
});

test("new canvases remain readable in a compact window and appearance persists", async ({ page }) => {
  await page.setViewportSize({ width: 851, height: 760 });
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark appearance" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light appearance" }).click();
  await page.locator(".nav.cat").first().click();
  await expect(page.locator(".tile figure").first()).toBeVisible();
  const canvasWidth = await page.locator(".canvas-surface").evaluate((el) => el.clientWidth);
  expect(canvasWidth).toBeLessThanOrEqual(640);
  const zoom = Number(await page.getByLabel("Canvas zoom", { exact: true }).inputValue());
  expect(zoom).toBeGreaterThanOrEqual(.85);
  const canvasTop = (await page.locator(".canvas-scroll").boundingBox())!.y;
  expect(canvasTop).toBeLessThan(230);
  await page.locator(".node").first().click();
  const inspector = (await page.locator(".inspector").boundingBox())!;
  const save = (await page.getByRole("button", { name: "Save dashboard", exact: true }).boundingBox())!;
  const dock = (await page.locator(".insert-bar").boundingBox())!;
  expect(save.y + save.height).toBeLessThanOrEqual(inspector.y);
  expect(dock.x + dock.width).toBeLessThanOrEqual(inspector.x);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit dashboard", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Canvas settings" })).toBeVisible();
});
