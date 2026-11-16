import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { FormatSpec } from "../src/format/format.ts";

async function open(page: Page, width: number, values: number[], format: Partial<FormatSpec>) {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"], rows: values.map((v, i) => [i ? "DE" : "US", v]), ms: 1 } }));
  const title = `Axis labels ${crypto.randomUUID()}`;
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1100 }, spec: { title,
    tiles: [{ id: "bars", title: "Revenue by country", metrics: ["new_mrr"], dimensions: ["dim_users.country"], chart: "barH", format, layout: { x: 24, y: 24, w: width, h: 360 } }] } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/"); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title }).click();
  return page.locator(".node .tile");
}

const cases: { name: string; width: number; values: number[]; format: Partial<FormatSpec> }[] = [
  { name: "currency", width: 850, values: [100, 50], format: { number: "currency" } },
  { name: "narrow currency", width: 320, values: [100, 50], format: { number: "currency" } },
  { name: "negative currency", width: 320, values: [-100, -50], format: { number: "currency" } },
  { name: "percent", width: 320, values: [1, .5], format: { number: "percent" } },
  { name: "explicit precision", width: 850, values: [1234567.89, 1000000], format: { number: "currency", decimals: 6 } },
  { name: "mixed signs", width: 400, values: [-500, 250], format: { number: "currency" } },
  { name: "rounding boundary", width: 320, values: [9900, 5000], format: { number: "currency" } },
];
for (const scenario of cases) test(`horizontal ${scenario.name} ticks stay inside the chart without overlapping`, async ({ page }, testInfo) => {
  const tile = await open(page, scenario.width, scenario.values, scenario.format);
  await expect(tile.locator("figure")).toBeVisible();
  await expect(async () => {
    const bounds = await tile.locator('g[aria-label="x-axis tick label"] text').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), plot = node.closest("svg")!.getBoundingClientRect();
      return { text: node.textContent, left: box.left, right: box.right, plotLeft: plot.left, plotRight: plot.right };
    }));
    expect(bounds.length).toBeGreaterThanOrEqual(2);
    for (const label of bounds) {
      expect(label.left, `${label.text} crosses the left edge`).toBeGreaterThanOrEqual(label.plotLeft);
      expect(label.right, `${label.text} crosses the right edge`).toBeLessThanOrEqual(label.plotRight);
    }
    const sorted = bounds.sort((a, b) => a.left - b.left);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].left, `${sorted[i - 1].text} overlaps ${sorted[i].text}`).toBeGreaterThan(sorted[i - 1].right + 2);
  }).toPass({ timeout: 6000 });
  if (scenario.name === "currency") {
    await tile.screenshot({ path: testInfo.outputPath("horizontal-axis-canvas.png") });
    const download = page.waitForEvent("download");
    await page.evaluate(async () => {
      const { downloadPng } = await import("/src/app/export.ts");
      await downloadPng("horizontal-axis.png", document.querySelector(".node .tile") as HTMLElement);
    });
    await (await download).saveAs(testInfo.outputPath("horizontal-axis-export.png"));
  }
});

test("a chart too narrow for its numeric labels explains how to fix it", async ({ page }) => {
  const tile = await open(page, 230, [1234567.89, 1000000], { number: "currency", decimals: 8 });
  await expect(tile.locator(".chart-err")).toContainText("Enlarge this chart");
});

test("hidden horizontal axes do not reserve space for labels", async ({ page }) => {
  const tile = await open(page, 230, [1234567.89, 1000000], { number: "currency", decimals: 8, showX: false });
  await expect(tile.locator('g[aria-label="bar"] rect')).toHaveCount(2);
  await expect(tile.locator('g[aria-label="x-axis tick label"]')).toHaveCount(0);
});
