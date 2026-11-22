import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

const popup = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Detail dashboard", exact: true });

test("MRR opens a centered sub-dashboard with multiple charts and optional AI", async ({ page }, info) => {
  let aiCalls = 0;
  await page.route("**/api/agent/status", r => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/explain", r => {
    aiCalls++;
    const body = r.request().postDataJSON();
    expect(body.metrics).toEqual(["net_new_mrr"]);
    expect(body.scopeNotes.join(" ")).toContain("not a reconciliation to ending MRR");
    return r.fulfill({ json: { text: "Test explanation: the movement ledger is separate from the closing balance." } });
  });
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const count = await page.locator(".node").count();
  await page.getByRole("button", { name: "Open Ending MRR detail dashboard", exact: true }).click();
  const dialog = popup(page);
  await expect(dialog.locator(".detail-dashboard-card")).toHaveCount(3);
  const waterfall = dialog.getByRole("region", { name: "What added and lost MRR?", exact: true });
  await expect(waterfall.locator("svg").first()).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Follow the trend", exact: true }).locator("svg").first()).toBeVisible();
  await expect(dialog.locator(".kpi-value")).not.toHaveText("—");
  const rect = await dialog.boundingBox();
  expect(Math.abs(rect!.x + rect!.width / 2 - 720)).toBeLessThan(3);
  expect(Math.abs(rect!.y + rect!.height / 2 - 450)).toBeLessThan(3);
  await waterfall.getByRole("button", { name: "More chart actions", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(aiCalls).toBe(0);
  await page.screenshot({ path: info.outputPath("mrr-detail-dashboard.png") });
  await waterfall.getByRole("button", { name: "Explain this view with AI", exact: true }).click();
  await expect(page.getByText(/Test explanation: the movement ledger/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(aiCalls).toBe(1);
  await waterfall.getByRole("button", { name: "Add to main dashboard", exact: true }).click();
  await expect(page.locator(".evidence-note")).toContainText("not a reconciliation to ending MRR");
  await expect(page.locator(".node")).toHaveCount(count + 1);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node")).toHaveCount(count);
});

test("Smart-add story details surfaces live movers, 1-click story arcs, and instant governed subdetails", async ({ page }, info) => {
  await page.goto("/"); await openStarter(page, "MRR movements");
  await page.getByRole("button", { name: "Open Net new MRR detail dashboard", exact: true }).click();
  const dialog = popup(page);
  await expect(dialog.locator(".detail-dashboard-card")).toHaveCount(3);

  // Open Smart Story Builder and verify humanized dates, CFO-honest swing math (no >100% of shift), and compact shelf
  await dialog.getByRole("button", { name: /Smart-add story details/ }).click();
  const smartPanel = dialog.getByRole("region", { name: "Smart story subdetails", exact: true });
  await expect(smartPanel).toBeVisible();
  await expect(smartPanel).toContainText("1-Click Story Arcs");
  await expect(smartPanel).toContainText("WHAT MOVED MOST");
  await expect(smartPanel).toContainText("Jul 2026 → Aug 2026");
  const panelText = await smartPanel.innerText();
  expect(panelText).not.toMatch(/[1-9]\d{2}%\s+of\s+(period\s+|net\s+)?shift/i);

  // Add a visual latest-period breakdown in one click while keeping live charts visible below
  await smartPanel.getByRole("button", { name: "Add Latest period by plan tier to detail dashboard", exact: true }).click();
  await expect(dialog.locator(".detail-dashboard-card")).toHaveCount(4);
  await expect(dialog.getByRole("region", { name: "Latest period by plan tier", exact: true }).locator("svg").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("smart-story-builder-open.png") });

  // Pressing Escape collapses Smart Story Builder first without closing the Detail Dashboard
  await page.keyboard.press("Escape");
  await expect(smartPanel).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Re-open and apply a 1-click Story Arc — auto-collapses to show the composed story + live factual takeaway
  await dialog.getByRole("button", { name: /Smart-add story details/ }).click();
  await dialog.getByRole("region", { name: "Smart story subdetails", exact: true }).getByRole("button", { name: /Why Did It Move\?/ }).click();
  await expect(smartPanel).toHaveCount(0);
  await expect(dialog.locator(".detail-story-subtitle")).toContainText("Aug 2026 stood at");
  await expect(dialog.locator(".detail-story-subtitle")).toContainText("Decomposes the latest displayed period");
  await page.screenshot({ path: info.outputPath("smart-story-subdetails.png") });
});

test("authors can choose, reorder, preview and save a detail dashboard", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "MRR movements");
  await expect(page.getByRole("button", { name: "Open Net new MRR detail dashboard", exact: true })).toBeVisible();
  await page.getByText("Net new MRR", { exact: true }).first().click();
  await page.locator(".inspector").getByRole("button", { name: "Set up detail dashboard", exact: true }).click();
  const dialog = popup(page);
  await dialog.getByLabel("Dashboard title", { exact: true }).fill("Revenue growth detail");
  await dialog.getByLabel("Detail dashboard layout", { exact: true }).selectOption("focus");
  await dialog.getByRole("checkbox", { name: "Latest value", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: "Compare with the previous period", exact: true }).check();
  await dialog.getByRole("button", { name: "Move chart 2 up", exact: true }).click();
  await expect(dialog.locator(".detail-dashboard-card").first()).toHaveAccessibleName(/Follow the trend/);
  await dialog.getByRole("button", { name: "Apply setup", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Revenue growth detail", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Customize this dashboard", exact: true })).toBeVisible();
  await expect(dialog).toContainText("Setup applied to your draft");
  await dialog.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saving;
  expect(response.ok()).toBe(true);
  const saved = response.request().postDataJSON();
  const config = saved.spec.tiles.find((t: any) => t.detailDashboard)?.detailDashboard;
  expect(config).toEqual({ title: "Revenue growth detail", layout: "focus", views: ["trend", "waterfall:net_new_mrr:fct_mrr_movements.movement_type", "compare"] });
  await page.getByRole("button", { name: /Workspace$/ }).click();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: saved.spec.title, exact: false }).first().click();
  await page.getByRole("button", { name: "Open Net new MRR detail dashboard", exact: true }).click();
  await expect(popup(page).getByRole("heading", { name: "Revenue growth detail", exact: true })).toBeVisible();
  await expect(popup(page).locator(".detail-dashboard-grid")).toHaveClass(/focus/);
});

test("detail charts preserve filters, can be added to the main dashboard, and undo independently", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "MRR movements");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("dim_users.country");
  await page.getByLabel("Label", { exact: true }).fill("Country");
  await page.getByRole("button", { name: "Save filter", exact: true }).click();
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  await page.getByRole("checkbox", { name: "US", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const count = await page.locator(".node").count();
  await page.getByRole("button", { name: "Open Net new MRR detail dashboard", exact: true }).click();
  const dialog = popup(page);
  await dialog.getByText("Reporting period and filters", { exact: true }).click();
  await expect(dialog).toContainText("dim_users.country US");
  await dialog.getByRole("region", { name: "What added and lost MRR?", exact: true }).getByRole("button", { name: "Add to main dashboard", exact: true }).click();
  await expect(page.locator(".node")).toHaveCount(count + 1);
  await expect(page.locator(".evidence-origin")).toHaveAttribute("title", /2026-08-01 to 2026-09-01/);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node")).toHaveCount(count);
});

test("a failed detail chart retries without blocking the other charts", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "SaaS overview");
  await page.route("**/api/query", route => route.request().postDataJSON()?.id?.startsWith("investigation:waterfall:")
    ? route.fulfill({ status: 503, json: { error: "Warehouse unavailable" } }) : route.continue());
  await page.getByRole("button", { name: "Open Ending MRR detail dashboard", exact: true }).click();
  const dialog = popup(page);
  const waterfall = dialog.getByRole("region", { name: "What added and lost MRR?", exact: true });
  await expect(waterfall.getByRole("button", { name: "Retry this chart", exact: true })).toBeVisible();
  await expect(waterfall.getByRole("button", { name: "Add to main dashboard", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("region", { name: "Follow the trend", exact: true }).getByRole("button", { name: "Add to main dashboard", exact: true })).toBeEnabled();
  await page.unroute("**/api/query");
  await waterfall.getByRole("button", { name: "Retry this chart", exact: true }).click();
  await expect(waterfall.getByRole("button", { name: "Add to main dashboard", exact: true })).toBeEnabled();
});

for (const width of [390, 768, 1280]) test(`detail dashboard fits ${width}px and setup can be cancelled`, async ({ page }, info) => {
  await page.goto("/"); await openStarter(page, "SaaS overview");
  await page.setViewportSize({ width, height: 900 });
  await page.getByRole("button", { name: "Open Ending MRR detail dashboard", exact: true }).click();
  const dialog = popup(page);
  await expect(dialog.locator(".detail-dashboard-card")).toHaveCount(3);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  for (const card of await dialog.locator(".detail-dashboard-card").all()) expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`detail-${width}.png`) });
  await dialog.getByRole("button", { name: "Customize this dashboard", exact: true }).click();
  await dialog.getByLabel("Dashboard title", { exact: true }).fill("Discard this title");
  await dialog.getByRole("button", { name: "Cancel setup", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Ending MRR details", exact: true })).toBeVisible();
});
