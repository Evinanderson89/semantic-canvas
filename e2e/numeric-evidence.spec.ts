import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { readFile } from "node:fs/promises";

async function open(page: Page, columns: string[], rows: unknown[][], patch: Partial<TileSpec> = {}) {
  await page.route("**/api/query", route => route.fulfill({ json: { columns, rows, ms: 1 } }));
  const title = `Numeric evidence ${crypto.randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0,
    canvas: { ...DEFAULT_CANVAS, width: 1000, height: 700 }, spec: { title, tiles: [{ id: "numeric", title: "New revenue", metrics: ["new_mrr"], dimensions: [], chart: "kpi",
      layout: { x: 24, y: 24, w: 800, h: 360 }, ...patch }] },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  return page.locator(".node .tile");
}

test("precision limits qualify the KPI, withhold rounded conclusions, preserve CSV and follow every report format", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const rows: unknown[][] = [["2026-07-01", "9007199254740992", null], ["2026-08-01", "9007199254740993", "9007199254740992"]];
  const tile = await open(page, ["movement_date_month", "new_mrr", "new_mrr__prev"], rows, { dimensions: ["month:movement_date"], compare: "prior" });
  await expect(tile.locator(".kpi-delta")).toHaveText("precision limited");
  await tile.getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("Numeric precision needs review: New MRR (USD)");
  await expect(evidence).toContainText("9007199254740993");
  await expect(evidence).toContainText("not proof of a source-data defect");
  const csvDownload = page.waitForEvent("download");
  await evidence.getByRole("button", { name: "Download raw CSV", exact: true }).click();
  const csv = await csvDownload, csvPath = info.outputPath("exact-precision-values.csv");
  await csv.saveAs(csvPath);
  const contents = await readFile(csvPath, "utf8");
  expect(contents).toContain("2026-07-01,9007199254740992");
  expect(contents).toContain("2026-08-01,9007199254740993");
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    const presentation = review.getByRole("article", { name: `${mode} presentation` });
    await expect(presentation).toContainText("Numeric precision needs review: New MRR (USD)");
    await expect(presentation.locator(".kpi-delta")).toHaveText("precision limited");
    await expect(review.locator(".report-evidence-drafts")).toContainText("No automatic observation was drafted");
    await expect(review.getByRole("button", { name: "Add observation to takeaway", exact: true })).toHaveCount(0);
    await expect(review.locator(".report-evidence-drafts")).not.toContainText("Unchanged from");
  }
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Numeric precision needs review");
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath("precision-qualified-infographic.png"));
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  rows[0][1] = "100"; rows[1][1] = "104"; rows[1][2] = "100";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toContainText("+4.0%");
  await expect(tile.getByRole("button", { name: "1 data check to review", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  await expect(review.locator(".report-evidence-drafts")).toContainText("Up 4%");
  await expect(review.getByRole("button", { name: "Add observation to takeaway", exact: true })).toBeEnabled();
});

test("evidence CSV is unavailable during a pending or failed refresh and uses recovered rows", async ({ page }, info) => {
  const tile = await open(page, ["movement_date_month", "new_mrr"], [["2026-08-01", "100"]], { chart: "line", dimensions: ["month:movement_date"] });
  const inspect = async () => {
    await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
    await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  };
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await inspect();
  await expect(evidence.getByRole("button", { name: "Download raw CSV", exact: true })).toBeEnabled();
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/query", async route => {
    await held;
    await route.fulfill({ status: 503, json: { error: "Synthetic source unavailable" } });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await inspect();
  await expect(evidence).toContainText("Waiting for the current query");
  await expect(evidence.getByRole("button", { name: "Download raw CSV", exact: true })).toHaveCount(0);
  release();
  await expect(evidence).toContainText("Synthetic source unavailable");
  await expect(evidence.getByRole("button", { name: "Download raw CSV", exact: true })).toHaveCount(0);
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date_month", "new_mrr"], rows: [["2026-08-01", "125"]], ms: 1 } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await inspect();
  const downloaded = page.waitForEvent("download");
  await evidence.getByRole("button", { name: "Download raw CSV", exact: true }).click();
  const path = info.outputPath("recovered-evidence.csv");
  await (await downloaded).saveAs(path);
  expect(await readFile(path, "utf8")).toBe("movement_date_month,new_mrr\r\n2026-08-01,125\r\n");
});

for (const value of [false, true, ""]) test(`scalar ${JSON.stringify(value)} is unavailable rather than a measured number`, async ({ page }) => {
  const tile = await open(page, ["new_mrr"], [[value]]);
  await expect(tile.locator(".stat .v")).toHaveText("—");
  await tile.getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("Non-numeric values: New MRR (USD)");
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share", exact: true });
  await expect(review).toContainText("No numeric values for new_mrr");
  await expect(review.getByRole("button", { name: "Export dashboard as PNG", exact: true })).toBeDisabled();
});

test("an invalid latest KPI observation stays unknown in the dashboard and infographic", async ({ page }) => {
  const tile = await open(page, ["movement_date_month", "new_mrr"], [["2026-07-01", "100"], ["2026-08-01", false]], { dimensions: ["month:movement_date"] });
  await expect(tile.locator(".kpi-value")).toHaveText("—");
  await expect(tile.locator(".kpi-delta")).toHaveText("no comparison");
  await expect(tile.locator(".spark-observation")).toHaveCount(1);
  await expect(tile.locator(".spark-missing")).toHaveText("Missing periods");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share", exact: true });
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.locator(".kpi-value")).toHaveText("—");
  await expect(review.locator(".kpi-delta")).toHaveText("no comparison");
  await expect(review.getByRole("article", { name: "Infographic presentation" })).toContainText("Non-numeric values: New MRR (USD)");
});

test("valid numeric strings retain real zeroes and server comparisons", async ({ page }) => {
  let tile = await open(page, ["new_mrr"], [["0"]]);
  await expect(tile.locator(".stat .v")).toHaveText("$0.00");
  tile = await open(page, ["movement_date_month", "new_mrr", "new_mrr__prev"], [["2026-08-01", "150", "100"]], { dimensions: ["month:movement_date"], compare: "prior" });
  await expect(tile.locator(".kpi-value")).toHaveText("$150.00");
  await expect(tile.locator(".kpi-delta")).toContainText("+50.0%");
});

for (const chart of ["line", "area"] as const) test(`${chart} preserves gaps at invalid measures rather than plotting zero or bridging the gap`, async ({ page }, info) => {
  const rows = [["2026-03-01", "100"], ["2026-04-01", "110"], ["2026-05-01", false], ["2026-06-01", ""], ["2026-07-01", "130"], ["2026-08-01", "140"]];
  const tile = await open(page, ["movement_date_month", "new_mrr"], rows, { chart, dimensions: ["month:movement_date"] });
  const line = tile.locator('g[aria-label="line"] path');
  await expect(line).toHaveCount(1);
  expect((await line.getAttribute("d"))!.match(/M/g)).toHaveLength(2);
  if (chart === "area") {
    const area = tile.locator('g[aria-label="area"] path');
    expect((await area.getAttribute("d"))!.match(/M/g)).toHaveLength(2);
  } else await expect(tile.locator('g[aria-label="dot"] circle')).toHaveCount(4);
  await tile.getByRole("button", { name: "1 data check to review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Metric definition and scope" })).toContainText("2 of 6 returned rows");
  await page.getByRole("dialog", { name: "Metric definition and scope" }).getByRole("button", { name: "Close", exact: true }).click();
  await tile.screenshot({ path: info.outputPath(`${chart}-invalid-values.png`) });
});

test("a raw table preserves invalid values for inspection", async ({ page }) => {
  const tile = await open(page, ["movement_type", "new_mrr"], [["new", 100], ["expansion", false]], { chart: "table", dimensions: ["movement_type"] });
  await expect(tile.locator("tbody tr")).toHaveCount(2);
  await expect(tile.getByRole("cell", { name: "false", exact: true })).toBeVisible();
  await expect(tile.getByRole("button", { name: "1 data check to review", exact: true })).toBeVisible();
});
