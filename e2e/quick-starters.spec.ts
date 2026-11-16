import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function open(page: Page, width = 1440) {
  const id = crypto.randomUUID(), title = `Quick starter ${id.slice(0, 8)}`;
  const obstacle = { id: "context", kind: "text", text: "Keep this authored context", title: "Authored context", metrics: [], dimensions: [], pinned: true,
    layout: { x: width > 600 ? 600 : 24, y: 24, w: 280, h: 156 } };
  const response = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width, height: 500 }, spec: { title, tiles: [obstacle] } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  return { id, title, obstacle };
}
const boxes = (page: Page) => page.locator(".node").evaluateAll(nodes => nodes.map(node => {
  const style = (node as HTMLElement).style;
  return { x: parseFloat(style.left), y: parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
}));
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
async function insert(page: Page, label: string) {
  await page.getByRole("button", { name: "Views", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(label + " KPI row") }).click();
  await expect(page.locator(".node")).toHaveCount(5);
}

for (const width of [1440, 390]) test(`quick KPI starters stay readable and avoid authored content on a ${width}px canvas`, async ({ page }, info) => {
  const original = await open(page, width);
  await insert(page, "MRR Movements");
  await expect(page.locator(".node .stat .v")).toHaveCount(4);
  await expect(page.locator(".node .err, .node .chart-err")).toHaveCount(0);
  const geometry = await boxes(page);
  expect(geometry[0]).toEqual(original.obstacle.layout);
  for (let i = 0; i < geometry.length; i++) {
    expect(geometry[i].x).toBeGreaterThanOrEqual(0);
    expect(geometry[i].x + geometry[i].w).toBeLessThanOrEqual(width);
    if (i) expect(geometry[i].w).toBeGreaterThanOrEqual(260);
    for (let j = i + 1; j < geometry.length; j++) expect(overlap(geometry[i], geometry[j])).toBe(false);
  }
  const surfaceHeight = await page.locator(".canvas-surface").evaluate(el => parseFloat((el as HTMLElement).style.height));
  expect(surfaceHeight).toBeGreaterThanOrEqual(Math.max(...geometry.map(b => b.y + b.h)));
  await page.locator(".canvas-surface").screenshot({ path: info.outputPath(`quick-starter-${width}.png`) });
  for (const value of await page.locator(".node .stat .v").all()) {
    await value.scrollIntoViewIfNeeded();
    await expect(value).toBeInViewport();
  }
  if (width === 390) await page.locator(".node").last().screenshot({ path: info.outputPath("quick-starter-last-card.png") });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".node")).toHaveCount(1);
  expect((await boxes(page))[0]).toEqual(original.obstacle.layout);
});

test("monthly snapshot starters use declared periods and remain valid after save and reopen", async ({ page }, info) => {
  const original = await open(page);
  await insert(page, "SaaS Monthly");
  await expect(page.locator(".node .kpi-value")).toHaveCount(4);
  await expect(page.locator(".node .kpi-asof > span")).toHaveText(["Period Aug 2026", "Period Aug 2026", "Period Aug 2026", "Period Aug 2026"]);
  await expect(page.locator(".node .kpi-asof").getByRole("button", { name: "1 data check to review", exact: true })).toHaveCount(2);
  await expect(page.locator(".node .err, .node .chart-err")).toHaveCount(0);
  await page.locator(".canvas-surface").screenshot({ path: info.outputPath("monthly-quick-starter.png") });
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saving).ok()).toBe(true);
  const stored = await (await page.request.get(`/api/dashboards/${original.id}`)).json();
  expect(stored.spec.tiles.slice(1).every((t: { dimensions: string[] }) => t.dimensions.includes("month:fct_saas_monthly.month"))).toBe(true);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.title) }).click();
  await expect(page.locator(".node .kpi-value")).toHaveCount(4);
  await expect(page.locator(".node .err, .node .chart-err")).toHaveCount(0);
});
