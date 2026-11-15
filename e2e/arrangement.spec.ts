import { expect, test, type Page } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { applyLayout } from "../src/canvas/layouts.ts";

const kpi = (id: string, x: number, y: number, pinned = false): TileSpec => ({ id, title: id, chart: "kpi", metrics: ["new_mrr"], dimensions: [], pinned, layout: { x, y, w: 280, h: 156 } });

test("arranged multi-series charts fit interactive controls and real result-limit warnings", async ({ page }, info) => {
  const tiles: TileSpec[] = [
    { id: "additions", title: "Gross MRR additions by month: new, expansion, reactivation", metrics: ["new_mrr", "expansion_mrr", "reactivation_mrr"], dimensions: ["month:movement_date"], chart: "barStacked", limit: 12, layout: { x: 0, y: 0, w: 468, h: 280 } },
    { id: "losses", title: "MRR losses by month: churn and contraction (positive magnitudes)", metrics: ["churned_mrr", "contraction_mrr"], dimensions: ["month:movement_date"], chart: "barStacked", limit: 12, layout: { x: 500, y: 0, w: 468, h: 280 } },
  ];
  const arranged = applyLayout("exec-summary", tiles, 1000);
  await openDraft(page, arranged);
  // Include exploration controls and warning chrome. The read-only AI preview
  // and report layouts do not exercise this smaller interactive plot budget.
  for (const tile of arranged) {
    const node = page.locator(".node").filter({ has: page.getByText(tile.title!, { exact: true }) });
    await expect(node.getByText(/Latest window · 12 rows/)).toBeVisible();
    await expect(node.getByRole("button", { name: "1 data check to review", exact: true })).toBeVisible();
    await expect(node.locator('g[aria-label="bar"] rect').first()).toBeVisible();
    await expect(node.locator(".err, .chart-err")).toHaveCount(0);
    const plot = await node.locator(".chart-host > figure > svg").boundingBox();
    expect(plot?.height).toBeGreaterThan(180);
  }
  await page.locator(".canvas-surface").screenshot({ path: info.outputPath("arranged-movement-charts.png") });
});
async function openDraft(page: Page, tiles: TileSpec[]) {
  const spec = { title: `Pinned arrangement ${crypto.randomUUID()}`, tiles };
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec, canvas: { ...DEFAULT_CANVAS, width: 1200, height: 3000 }, revision: 0 } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
  await expect(page.locator(".node")).toHaveCount(tiles.length);
  return spec;
}

test("story and executive arrangements preview before applying and support undo", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/"); await openStarter(page, "Dashboard cleanup demo");
  const geometry = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style")));
  const initial = await geometry();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tell a story", exact: true })).toHaveAttribute("aria-pressed", "true");
  const story = await page.getByRole("img", { name: "Proposed dashboard layout" }).innerHTML();
  expect(await geometry()).toEqual(initial);
  await page.getByRole("button", { name: "Build an executive dashboard", exact: true }).click();
  expect(await page.getByRole("img", { name: "Proposed dashboard layout" }).innerHTML()).not.toEqual(story);
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  expect(await geometry()).not.toEqual(initial);
  await expect(page.locator(".heading-text")).toHaveText(["At a glance", "How it's changing", "A closer look"]);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
});

test("a cancelled drag leaves the prior edit undoable and never leaks into a saved dashboard", async ({ page }) => {
  const original = await openDraft(page, [kpi("Revenue to move", 24, 24), kpi("Pinned context", 400, 24, true)]);
  const geometry = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => {
    const style = (n as HTMLElement).style;
    return { x: parseFloat(style.left), y: parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
  }));
  const move = async (dx: number, dy: number) => {
    const box = (await page.locator(".node-inner").first().boundingBox())!;
    await page.mouse.move(box.x + 24, box.y + 24);
    await page.mouse.down();
    await page.mouse.move(box.x + 24 + dx, box.y + 24 + dy, { steps: 3 });
  };
  const initial = await geometry();
  await move(80, 80);
  await page.mouse.up();
  const committed = await geometry();
  expect(committed[0]).not.toEqual(initial[0]);
  expect(committed[1]).toEqual(initial[1]);
  await move(40, 40);
  await expect.poll(geometry).not.toEqual(committed);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(geometry).toEqual(committed);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect.poll(geometry).toEqual(committed);
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saving;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().spec.tiles.map((t: TileSpec) => t.layout)).toEqual(committed);
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.title) }).click();
  await expect.poll(geometry).toEqual(committed);
});

test("a loose dashboard previews around a pin, applies once and survives undo, save and reopen", async ({ page }, testInfo) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  const original = await openDraft(page, [kpi("Pinned revenue", 24, 24, true), kpi("Supporting KPI", 600, 1800),
    { ...kpi("Revenue trend", 150, 2400), chart: "line", dimensions: ["month:movement_date"], layout: { x: 150, y: 2400, w: 400, h: 300 } }]);
  const geometry = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style")));
  const initial = await geometry();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.locator(".arrange-preview [role=status]")).toHaveText("2 tiles will move or resize. 1 tile stays in place because of pins.");
  expect(await geometry()).toEqual(initial);
  await page.locator(".arrange-preview").screenshot({ path: testInfo.outputPath("pinned-arrangement-preview.png") });
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  const arranged = await geometry();
  expect(arranged[0]).toEqual(initial[0]);
  expect(arranged[1]).not.toEqual(initial[1]);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect.poll(geometry).toEqual(arranged);
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saving;
  expect(response.ok()).toBe(true);
  const saved = response.request().postDataJSON();
  expect(saved.spec.tiles[0]).toEqual(original.tiles[0]);
  for (const [i, t] of saved.spec.tiles.entries()) expect({ ...t, layout: original.tiles[i].layout }).toEqual(original.tiles[i]);
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.title) }).click();
  await expect.poll(geometry).toEqual(arranged);
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.locator(".arrange-preview [role=status]")).toContainText("This layout already fits");
  await expect(page.getByRole("button", { name: "Apply layout", exact: true })).toBeDisabled();
});

test("an all-pinned dashboard explains why there is no arrangement to apply", async ({ page }) => {
  await openDraft(page, [kpi("Pinned one", 24, 24, true), kpi("Pinned two", 400, 24, true)]);
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.locator(".arrange-preview [role=status]")).toContainText("All content is held in place by pins");
  await expect(page.getByRole("button", { name: "Apply layout", exact: true })).toBeDisabled();
});

test("a loose chart moved below a pinned section keeps its independent membership after saving", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  const original = await openDraft(page, [
    { ...kpi("Loose trend", 24, 24), chart: "line", dimensions: ["month:movement_date"], layout: { x: 24, y: 24, w: 900, h: 350 } },
    { id: "heading", title: "Authored section", text: "Authored section", kind: "heading", metrics: [], dimensions: [], layout: { x: 24, y: 260, w: 900, h: 48 } },
    { ...kpi("Pinned detail", 24, 340, true), section: "heading" },
  ]);
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saving;
  expect(response.ok()).toBe(true);
  const saved = response.request().postDataJSON();
  expect(saved.spec.tiles[0].section).toBeNull();
  expect(saved.spec.tiles.slice(1)).toEqual(original.tiles.slice(1));
  const stored = await page.request.get(`/api/dashboards/${saved.id}`);
  expect((await stored.json()).spec.tiles).toEqual(saved.spec.tiles);
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.title) }).click();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await expect(page.locator(".arrange-preview [role=status]")).toContainText("This layout already fits");
  await expect(page.getByRole("button", { name: "Apply layout", exact: true })).toBeDisabled();
});
