import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/");
  await openStarter(page, "Dashboard cleanup demo");
});

test("keyboard opening enters design review and Escape returns to its trigger", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /Design review/, exact: false });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Design review", exact: true });
  await expect(panel).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await trigger.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Enter");
  await expect(panel).toBeFocused();
  await trigger.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("story preview keeps keyboard focus usable after keeping or applying a structure", async ({ page }) => {
  await page.getByRole("button", { name: /Design review/ }).click();
  const panel = page.getByRole("dialog", { name: "Design review", exact: true });
  const preview = panel.getByRole("button", { name: "Preview story structure", exact: true });
  await preview.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByLabel("Proposed story structure")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Keep current", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(preview).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Apply story structure", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("No additional automatic layout proposal");
  await expect(panel).toBeFocused();
  await expect(panel).toBeVisible();
});

test("continuous review lets the user return to canvas editing without taking focus back", async ({ page }) => {
  await page.getByRole("button", { name: /Design review/ }).click();
  const panel = page.getByRole("dialog", { name: "Design review", exact: true });
  await expect(panel.locator(".review-coverage")).toBeVisible();
  const chart = page.locator(".node").filter({ has: page.getByRole("heading", { name: "Web sessions", exact: true }) });
  await chart.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panel.locator(".review-intro")).toContainText("Review 2");
  await expect(chart).toBeFocused();
  await expect(panel).toBeVisible();
});
