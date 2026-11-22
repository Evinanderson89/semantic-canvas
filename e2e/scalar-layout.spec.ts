import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { filterStylesStarter } from "../src/library/setup.ts";

async function open(page: Page, width: number, height: number) {
  const title = `Scalar layout ${crypto.randomUUID()}`;
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["new_mrr"], rows: [[1234567.89]], ms: 1 } }));
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 700 },
    spec: { title, tiles: [{ id: "scalar", title: "New revenue", metrics: ["new_mrr"], dimensions: [], chart: "kpi",
      format: { number: "currency", decimals: 2 }, layout: { x: 24, y: 24, w: width, h: height } }] },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  return page.locator(".node .tile-stat");
}

async function assertReadable(tile: Locator) {
  await expect(tile.locator(".stat .v")).toBeVisible();
  const geometry = await tile.evaluate(el => {
    const body = el.querySelector(".body")!, value = el.querySelector(".stat .v")!;
    const range = document.createRange(); range.selectNodeContents(value);
    const text = range.getBoundingClientRect(), area = body.getBoundingClientRect(), card = el.getBoundingClientRect();
    return { left: text.left, right: text.right, top: text.top, bottom: text.bottom, area: { left: area.left, right: area.right, top: area.top, bottom: area.bottom },
      cardBottom: card.bottom, font: parseFloat(getComputedStyle(value).fontSize) };
  });
  expect(geometry.font).toBeGreaterThanOrEqual(16);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.area.top - 1);
  expect(geometry.bottom).toBeLessThanOrEqual(Math.min(geometry.area.bottom, geometry.cardBottom) + 1);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.area.left - 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.area.right + 1);
  await expect(tile.locator(".stat .l")).toHaveCount(0);
}

for (const [width, height] of [[520, 80], [260, 108], [180, 156]]) test(`scalar at ${width} by ${height} shows its complete value and keeps actions`, async ({ page }) => {
  const tile = await open(page, width, height);
  await expect(tile.locator(".stat .v")).toHaveText("$1,234,567.89");
  await assertReadable(tile);
  await tile.getByRole("button", { name: "Open detail dashboard", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Detail dashboard", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Detail dashboard", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Metric definition and scope" })).toContainText("New MRR");
});

test("the filter starter's headline has enough space and scalar values remain readable in each presentation", async ({ page }, info) => {
  const starter = filterStylesStarter();
  const headline = starter.tiles.find(t => t.id === "actives")!;
  expect(headline.layout.h).toBe(108);
  expect(headline.layout.y + headline.layout.h).toBeLessThan(starter.tiles.find(t => t.id === "signups")!.layout.y);
  const tile = await open(page, headline.layout.w, headline.layout.h);
  await assertReadable(tile);
  await tile.screenshot({ path: info.outputPath("scalar-card.png") });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share", exact: true });
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await dialog.getByRole("button", { name: mode, exact: true }).click();
    const card = dialog.getByRole("article", { name: `${mode} presentation` }).locator(".tile-stat");
    await expect(card.locator(".stat .v")).toHaveText("$1,234,567.89");
    await assertReadable(card);
  }
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath("scalar-infographic.png"));
});
