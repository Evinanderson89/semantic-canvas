import { openStarter } from "./library-helpers.ts";
import { expect, test } from "@playwright/test";

test("long timelines disclose limits and show the latest sample date", async ({ page, request }) => {
  const response = await request.post("/api/query", { headers: { "x-sc-principal": "admin" }, data: { metrics: ["event_count"], dimensions: ["day:fct_events.event_date"], compare: "prior" } });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.truncated).toBe(true); expect(result.rows).toHaveLength(500);
  expect(result.window.end).toMatch(/^2026-08-31/);
  expect(result.rows.at(-1)[result.columns.indexOf("event_count")]).toBe(2769);
  await page.goto("/");
  await openStarter(page, "Events & engagement");
  await page.getByLabel("Period", { exact: true }).selectOption("day");
  await expect(page.locator(".result-warning").first()).toContainText("500 rows");
  await expect(page.locator(".kpi-asof").first()).toContainText("2026-08-31");
});

test("unsupported snapshot periods fail clearly while the canvas remains monthly", async ({ page, request }) => {
  const response = await request.post("/api/query", { data: { metrics: ["ending_mrr"], dimensions: ["quarter:fct_saas_monthly.month"] } });
  expect(response.status()).toBe(400); expect(JSON.stringify(await response.json())).toContain("requires month");
  await page.goto("/"); await openStarter(page, "SaaS overview");
  await page.getByLabel("Period", { exact: true }).selectOption("quarter");
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("month");
  await expect(page.getByRole("alert")).toContainText("requires month");
  await expect(page.locator(".kpi-value").first()).toHaveText("$203k");
});

test("a failed recovery write cannot abandon the current document", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "sc:drafts") throw new DOMException("Full", "QuotaExceededError"); return original.call(this, key, value); };
  });
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click(); await page.getByText("Text note", { exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator(".note-text")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Recovery backup failed");
  await expect(page.getByRole("button", { name: "Download backup" })).toBeVisible();
});

test("text cursor keys do not move notes and canvas keyboard resizing works", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click(); await page.getByText("Text note", { exact: true }).click();
  const node = page.locator(".node.selected");
  const before = await node.evaluate(el => ({ x: el.style.left, w: parseFloat(el.style.width) }));
  await page.locator(".note-text").click(); await page.keyboard.press("ArrowRight");
  expect(await node.evaluate(el => el.style.left)).toBe(before.x);
  await node.focus(); await page.keyboard.press("Alt+ArrowRight");
  expect(await node.evaluate(el => parseFloat(el.style.width))).toBeGreaterThan(before.w);
});

test("layout changes have a preview and one undo restores tiles and canvas", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const boxes = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).getAttribute("style")));
  await expect(page.locator(".node").first()).toBeVisible();
  const before = await boxes();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.getByRole("img", { name: "Proposed dashboard layout" })).toBeVisible();
  expect(await boxes()).toEqual(before);
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  expect(await boxes()).not.toEqual(before);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect(await boxes()).toEqual(before);
});

test("review reports inaccessible charts instead of declaring success", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "SaaS overview");
  await page.getByLabel("Acting as", { exact: true }).selectOption("emea");
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  await expect(page.locator(".review-coverage")).toContainText("Review incomplete");
  await expect(page.locator(".review-coverage")).toContainText("unavailable");
});

test("AI proposals receive unsaved content and apply through undo", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  let received: any;
  await page.route("**/api/agent/chat", async route => {
    received = route.request().postDataJSON();
    await route.fulfill({ json: { text: "A clearer title.", proposal: { title: "Focus the story", reason: "Name the question", actions: [{ type: "rename", title: "Revenue story" }] } } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Open agent chat" }).click();
  await page.getByPlaceholder("Message the agent…").fill("Improve this canvas"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toBeVisible();
  expect(received.document.spec.title).toBe("Untitled dashboard"); expect(received.document.canvas.width).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revenue story", exact: true })).toBeVisible();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.getByRole("heading", { name: "Untitled dashboard", exact: true })).toBeVisible();
});

test("a proposal becomes unavailable after the document changes", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { text: "Proposed title", proposal: { title: "Rename", reason: "Clearer", actions: [{ type: "rename", title: "Old proposal" }] } } }));
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Open agent chat" }).click();
  await page.getByPlaceholder("Message the agent…").fill("Improve it"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Text", exact: true }).click(); await page.getByText("Text note", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  await expect(page.getByText("Your document changed.", { exact: false })).toBeVisible();
});

test("a downloaded document shape can be restored as a new dashboard", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"][aria-label="Import dashboard backup"]').setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, spec: { title: "Recovered story", tiles: [{ id: "note", kind: "text", text: "Keep this decision", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 400, h: 120 } }] }, canvas: { preset: "custom", width: 1000, height: 800, snap: true, grid: 8, locked: false } })) });
  await expect(page.getByRole("heading", { name: "Recovered story", exact: true })).toBeVisible();
  await expect(page.locator(".note-text")).toHaveText("Keep this decision");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
});

test("starter dashboards open with their own supported reporting periods", async ({ page }) => {
  await page.goto("/"); await openStarter(page, "Events & engagement");
  await page.getByLabel("Period", { exact: true }).selectOption("day");
  await openStarter(page, "SaaS overview");
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("month");
  await openStarter(page, "Events & engagement");
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("month");
  await expect(page.locator(".kpi-value").first()).not.toHaveText("—");
  await expect(page.locator(".tile .err")).toHaveCount(0);
});
