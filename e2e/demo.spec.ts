import { expect, test } from "@playwright/test";

test("the messy topic has real review fixes and can be arranged into a clean dashboard", async ({ page }) => {
  await page.setViewportSize({ width: 851, height: 760 });
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/");
  const example = page.getByRole("button", { name: "Messy dashboard", exact: true });
  await expect(example).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Try the design playground/ })).toHaveCount(0);
  await example.click();
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await expect(example).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".node")).toHaveCount(6);
  const hasOverlap = () => page.locator(".node").evaluateAll(nodes => {
    const boxes = nodes.map(n => n.getBoundingClientRect());
    return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
  });
  expect(await hasOverlap()).toBe(true);

  await page.getByRole("button", { name: "Design review", exact: true }).click();
  await expect(page.locator(".review-coverage")).toContainText("6 charts reviewed");
  await expect(page.getByRole("button", { name: "Switch to week", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show over time", exact: true })).toBeVisible();
  const weekly = page.waitForResponse(r => r.url().endsWith("/api/query") && r.request().postDataJSON()?.dimensions?.includes("week:fct_web_sessions.session_date"));
  await page.getByRole("button", { name: "Switch to week", exact: true }).click();
  expect((await weekly).ok()).toBe(true);
  const trend = page.waitForResponse(r => r.url().endsWith("/api/query") && r.request().postDataJSON()?.metrics?.includes("new_mrr") && r.request().postDataJSON()?.dimensions?.some((d: string) => d.startsWith("month:")));
  await page.getByRole("button", { name: "Show over time", exact: true }).click();
  expect((await trend).ok()).toBe(true);
  await page.locator(".dash-beautify-pop").getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.getByRole("img", { name: "Proposed dashboard layout" })).toBeVisible();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await expect.poll(hasOverlap).toBe(false);
  await expect(page.locator(".tile .err")).toHaveCount(0);
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");

  // Editorial structure is previewed, undoable and saved with the document.
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  await page.getByRole("button", { name: "Preview story structure", exact: true }).click();
  await expect(page.getByLabel("Proposed story structure")).toContainText("At a glance");
  await expect(page.locator(".heading-text")).toHaveCount(0);
  await page.getByRole("button", { name: "Apply story structure", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Design review", exact: true })).toHaveCount(0);
  await expect(page.locator(".heading-text")).toHaveText(["At a glance", "How it's changing", "Supporting context", "A closer look"]);
  await expect(page.locator(".note-text")).toContainText("Check each chart's reporting period and filters");
  await expect(page.locator(".dash-title")).toHaveText("SaaS Overview");
  await expect.poll(hasOverlap).toBe(false);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".heading-text")).toHaveCount(0);
  await expect(page.locator(".dash-title")).toHaveText("SaaS Overview (rough draft)");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect(page.locator(".heading-text")).toHaveCount(4);
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const persisted = await page.request.get(`/api/dashboards/${response.request().postDataJSON().id}`);
  expect((await persisted.json()).spec.tiles.filter((t: any) => t.kind === "heading")).toHaveLength(4);

  // The topic always opens a fresh example; edits remain recoverable as a draft.
  await page.locator(".heading-text").last().scrollIntoViewIfNeeded();
  await example.click();
  await expect.poll(hasOverlap).toBe(true);
  await expect.poll(() => page.locator(".canvas-scroll").evaluate(el => el.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover draft: SaaS Overview (rough draft)", exact: true }).first()).toBeVisible();
  await expect(example).not.toHaveAttribute("aria-current", "page");
});
