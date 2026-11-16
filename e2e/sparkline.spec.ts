import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function openKpi(page: Page, shape: "line" | "area" | "bar", rows: unknown[][], compare: "prior" | "first" = "prior") {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date_month", "new_mrr"], rows, ms: 1 } }));
  const title = `Sparkline review ${crypto.randomUUID()}`;
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0,
    canvas: { ...DEFAULT_CANVAS, width: 1000, height: 900 },
    spec: { title, tiles: [{ id: "spark-test", title: "New MRR", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "kpi", spark: { shape, showRange: true, compare }, layout: { x: 24, y: 24, w: 500, h: 250 } }] } } });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  return page.locator(".node .kpi");
}

test("a single-period first comparison stays unavailable in the dashboard and exported infographic", async ({ page }, testInfo) => {
  const card = await openKpi(page, "line", [["2026-08-01", 100]], "first");
  await expect(card.locator(".kpi-value")).toHaveText("$100.00");
  await expect(card.locator(".kpi-delta")).toHaveText("no comparison");
  await expect(card.locator(".kpi-delta span")).toHaveAttribute("title", /At least two shown periods/);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator(".kpi-delta")).toHaveText("no comparison");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(testInfo.outputPath("single-period-kpi.png"));
});

test("equal values in two distinct shown periods still report a real zero change", async ({ page }) => {
  const card = await openKpi(page, "line", [["2026-07-01", 100], ["2026-08-01", 100]], "first");
  await expect(card.locator(".kpi-delta")).toContainText("+0.0%");
  await expect(card.locator(".kpi-delta")).toContainText("vs first shown period");
});

for (const shape of ["line", "area"] as const) test(`${shape} sparkline breaks at null and omitted months and explains the gap on hover`, async ({ page }) => {
  const card = await openKpi(page, shape, [["2024-01-01", 10], ["2024-02-01", 20], ["2024-03-01", null], ["2024-05-01", 40], ["2024-06-01", 50]]);
  await expect(card.locator(".spark-line")).toHaveCount(2);
  if (shape === "area") await expect(card.locator(".spark-area")).toHaveCount(2);
  await expect(card.locator(".spark-missing")).toHaveText("Data gaps");
  const svg = card.locator("svg.spark");
  await expect(svg).toHaveAccessibleName(/Some reporting periods were not returned.*1 returned value is unavailable/);
  const box = (await svg.boundingBox())!;
  const ratio = (Date.parse("2024-04-15") - Date.parse("2024-01-01")) / (Date.parse("2024-06-01") - Date.parse("2024-01-01"));
  await svg.hover({ position: { x: 3 + ratio * (box.width - 6), y: 20 } });
  await expect(card.locator(".spark-tip")).toContainText("No data");
  await expect(card.locator(".spark-tip")).toContainText("2024-03-01 – 2024-04-30");
  await svg.hover({ position: { x: box.width - 3, y: 20 } });
  await expect(card.locator(".spark-tip b")).toContainText("50");
});

test("missing latest value remains unknown without a fabricated final sparkline dot", async ({ page }) => {
  const card = await openKpi(page, "line", [["2024-01-01", 10], ["2024-02-01", 20], ["2024-03-01", null]]);
  await expect(card.locator(".kpi-value")).toHaveText("—");
  await expect(card.locator(".spark-missing")).toHaveText("Missing values");
  await expect(card.locator("svg.spark")).toHaveAccessibleName(/1 returned value is unavailable/);
  await expect(card.locator("svg.spark")).not.toHaveAccessibleName(/periods were not returned/);
  await expect(card.locator(".kpi-delta")).toHaveText("no comparison");
  await expect(card.locator(".spark-observation")).toHaveCount(0);
  await expect(card.locator(".spark-range")).toContainText("2024-03-01");
  const svg = card.locator("svg.spark"), box = (await svg.boundingBox())!;
  await svg.hover({ position: { x: box.width - 2, y: 20 } });
  await expect(card.locator(".spark-tip b")).toHaveText("No data");
});

test("sparse bars retain period widths, stay inside the plot, and update on resize", async ({ page }) => {
  const card = await openKpi(page, "bar", [["2024-01-01", -100], ["2024-07-01", -50]]);
  await expect(card.locator(".spark-missing")).toHaveText("Missing periods");
  await expect(card.locator(".spark-missing")).toHaveAttribute("title", "Some reporting periods were not returned.");
  const svg = card.locator("svg.spark"), bars = svg.locator("rect");
  await expect(bars).toHaveCount(2);
  const check = async () => {
    const bounds = await svg.boundingBox();
    const dimensions = await bars.evaluateAll(nodes => nodes.map(n => ({ x: +n.getAttribute("x")!, y: +n.getAttribute("y")!, w: +n.getAttribute("width")!, h: +n.getAttribute("height")! })));
    for (const b of dimensions) {
      expect(b.w).toBeLessThan(bounds!.width / 5);
      expect(b.x + b.w).toBeLessThanOrEqual(bounds!.width);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(bounds!.height);
    }
  };
  await check();
  const previous = +(await bars.first().getAttribute("width"))!;
  // Exercise the SVG ResizeObserver independently of the canvas' zoom transform.
  await svg.evaluate(el => { el.style.width = "280px"; });
  await expect.poll(async () => +(await bars.first().getAttribute("width"))!).not.toBe(previous);
  await check();
});
