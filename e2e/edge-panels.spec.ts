import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function open(page: Page, withFilter = false) {
  const title = `Edge controls ${crypto.randomUUID()}`;
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_signups"], rows: [["US", 100], ["DE", 80]], ms: 1 } }));
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: { ...DEFAULT_CANVAS, width: 720, height: 360 }, spec: { title, tiles: [
    { id: "edge", title: "Signups at the edge", chart: "bar", metrics: ["new_signups"], dimensions: ["dim_users.country"], layout: { x: withFilter ? 24 : 420, y: withFilter ? 24 : 150, w: 280, h: 200 } },
    ...(withFilter ? [{ id: "filter", kind: "filter", metrics: [], dimensions: [], filterId: "country", layout: { x: 420, y: 230, w: 280, h: 120 } }] : []),
  ], ...(withFilter ? { filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", bindings: [{ tileId: "edge", field: "dim_users.country" }] }] } : {}) } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const tile = page.locator(".node .tile");
  await expect(tile.locator("figure svg")).toBeVisible();
  return tile;
}
async function reachable(control: Locator) {
  await expect.poll(() => control.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })).toBe(true);
}

test("chart actions and export stay clickable beyond the bottom and right canvas edges", async ({ page }, info) => {
  const tile = await open(page);
  const before = await page.locator(".node").getAttribute("style");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  const actions = tile.getByRole("group", { name: "More chart actions", exact: true });
  for (const button of await actions.getByRole("button").all()) await reachable(button);
  await page.screenshot({ path: info.outputPath("edge-actions.png") });
  await actions.getByRole("button", { name: "Export", exact: true }).click();
  const panel = tile.locator(".export-pop");
  await reachable(panel.getByRole("button", { name: "Download raw CSV", exact: true }));
  await reachable(panel.getByRole("button", { name: "Download PNG", exact: true }));
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download raw CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  expect(await page.locator(".node").getAttribute("style")).toBe(before);
});

test("keyboard menus and long explanations stay usable after zooming and resizing", async ({ page }, info) => {
  await page.route("**/api/agent/explain", route => route.fulfill({ json: { text: Array.from({ length: 35 }, (_, i) => `Observation ${i + 1}: compare the same reporting period and check the underlying definition.`).join("\n\n") } }));
  const tile = await open(page);
  await page.getByLabel("Canvas zoom", { exact: true }).selectOption("0.75");
  const trigger = tile.getByRole("button", { name: "More chart actions", exact: true });
  await trigger.focus(); await trigger.press("Enter");
  await page.keyboard.press("Tab");
  await expect(tile.getByRole("button", { name: "Metric definition and scope", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await tile.getByRole("button", { name: "Explain this", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Chart explanation" });
  await expect(panel).toContainText("Observation 35");
  await page.setViewportSize({ width: 520, height: 540 });
  await reachable(panel.getByRole("button", { name: "Close", exact: true }));
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await reachable(panel.getByRole("button", { name: "Close", exact: true }));
  await expect.poll(() => panel.evaluate(el => Math.abs(el.querySelector(".explain-head")!.getBoundingClientRect().top - el.getBoundingClientRect().top))).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath("edge-explanation.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("closing a pending explanation aborts it and a late response cannot reopen the panel", async ({ page }) => {
  let release!: () => void, started = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agent/explain", async route => {
    started = true; await pending;
    await route.fulfill({ json: { text: "Delayed explanation" } });
  });
  const tile = await open(page);
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Explain this", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Chart explanation" });
  await expect(panel).toContainText("Thinking");
  await expect.poll(() => started).toBe(true);
  const cancelled = page.waitForEvent("requestfailed", r => r.url().includes("/api/agent/explain"));
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await cancelled;
  release();
  await expect(panel).toHaveCount(0);
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Design review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Chart design review" });
  await reachable(review.getByRole("button", { name: "Close", exact: true }));
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

test("a filter picker at the bottom canvas edge remains reachable and updates the chart scope", async ({ page }) => {
  await open(page, true);
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose Country", exact: true });
  const us = picker.getByRole("checkbox", { name: "US", exact: true });
  await us.scrollIntoViewIfNeeded();
  await reachable(us);
  const request = page.waitForRequest(r => r.url().endsWith("/api/query") && r.postDataJSON().where?.some((f: any) => f.id === "control:country"));
  await us.check();
  expect((await request).postDataJSON().where).toContainEqual(expect.objectContaining({ field: "dim_users.country", values: ["US"] }));
  const done = picker.getByRole("button", { name: "Done", exact: true });
  await reachable(done); await done.click();
  await expect(picker).toHaveCount(0);
});

for (const close of ["button", "escape"]) test(`closing AI chart suggestions with ${close} aborts the request and cannot replace a newer answer`, async ({ page }) => {
  let release!: () => void, started = false, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agent/beautify", async route => {
    if (++calls === 1) { started = true; await pending; return route.fulfill({ json: { text: "Obsolete delayed suggestions" } }); }
    return route.fulfill({ json: { text: "Fresh suggestions for this chart" } });
  });
  const tile = await open(page);
  const openReview = async () => {
    await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
    await tile.getByRole("button", { name: "Design review", exact: true }).click();
    return page.getByRole("dialog", { name: "Chart design review" });
  };
  const panel = await openReview();
  await panel.getByRole("button", { name: "Ask the agent for more", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  const cancelled = page.waitForEvent("requestfailed", request => request.url().includes("/api/agent/beautify"));
  if (close === "escape") await page.keyboard.press("Escape");
  else await panel.getByRole("button", { name: "Close", exact: true }).click();
  await cancelled; await expect(panel).toHaveCount(0);
  const next = await openReview();
  await next.getByRole("button", { name: "Ask the agent for more", exact: true }).click();
  await expect(next).toContainText("Fresh suggestions for this chart");
  release();
  await expect(next).not.toContainText("Obsolete delayed suggestions");
  await expect(next.getByRole("button", { name: "Ask again", exact: true })).toBeEnabled();
});
