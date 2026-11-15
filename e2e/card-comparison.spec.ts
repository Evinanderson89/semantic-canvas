import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

for (const chart of ["kpi", "stat"]) test(`${chart} comparisons agree across controls, queries, narrative and saved presentations`, async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let missing = false;
  const requests: { compare?: string }[] = [];
  await page.route("**/api/query", route => {
    const request = route.request().postDataJSON(); requests.push(request);
    const rows: unknown[][] = [["2026-06-01", 50], ["2026-07-01", 80], ["2026-08-01", 100]];
    const columns = ["movement_date_month", "new_mrr"];
    if (request.compare === "prior" || request.compare === "yoy") {
      columns.push("new_mrr__prev");
      rows.forEach((row, i) => row.push(missing ? null : request.compare === "yoy" ? 40 : i ? rows[i - 1][1] : null));
    }
    return route.fulfill({ json: { columns, rows, ms: 1 } });
  });
  const id = crypto.randomUUID(), title = `Comparison contract ${id.slice(0, 8)}`;
  const saved = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: DEFAULT_CANVAS, spec: { title, tiles: [
    { id: "revenue", title: "Revenue", chart, metrics: ["new_mrr"], dimensions: ["month:movement_date"], layout: { x: 24, y: 24, w: 560, h: 300 } },
  ] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("group", { name: "Revenue", exact: true }).click();
  const tile = page.locator(".node .tile"), inspector = page.locator(".inspector");
  const compare = inspector.locator("section").filter({ has: page.getByRole("heading", { name: "Compare", exact: true }) });
  await expect(compare.getByRole("button", { name: "vs prior", exact: true })).toHaveClass(/\bon\b/);
  await expect(tile.locator(".kpi-delta")).toHaveText("+25.0%vs prior period");
  expect(requests.at(-1)?.compare).toBe("prior");
  await expect(compare.getByRole("button", { name: "% change", exact: true })).toHaveCount(0);
  await compare.getByRole("button", { name: "vs first shown", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toHaveText("+100.0%vs first shown period");
  expect(requests.at(-1)?.compare).toBe("none");
  const review = page.getByRole("dialog", { name: "Review and share" });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.locator(".kpi-delta")).toHaveText("+100.0%vs first shown period");
    await expect(review.locator(".report-evidence-drafts")).toContainText("Up 100% from $50 in the first shown period (2026-06-01)");
  }
  await review.getByLabel("What decision should this help someone make?").fill("How has revenue changed within the shown period?");
  const marker = review.getByRole("region", { name: "Brief evidence review" });
  await marker.getByRole("button", { name: "Mark brief reviewed", exact: true }).click();
  await expect(marker).toContainText("Evidence and brief match your review");
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Comparison: vs first shown");
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath(`first-period-${chart}.png`));
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await compare.getByRole("button", { name: "none", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toHaveText("comparison off");
  // First and None share the same query. Narrative must still update immediately.
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  await expect(review.locator(".report-evidence-drafts")).toContainText("was $100");
  await expect(review.locator(".report-evidence-drafts")).not.toContainText("Up 100%");
  await expect(review.locator(".kpi-delta")).toHaveText("comparison off");
  await expect(marker).toContainText("Review needed");
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Comparison: none");
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await tile.getByTitle("Sparkline options", { exact: true }).click();
  await tile.locator(".spark-menu").getByRole("button", { name: "vs last year", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toHaveText("+150.0%vs same period last year");
  await expect(compare.getByRole("button", { name: "vs last year", exact: true })).toHaveClass(/\bon\b/);
  expect(requests.at(-1)?.compare).toBe("yoy");
  missing = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toHaveText("no comparison");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  await expect(review.locator(".report-evidence-drafts")).toContainText("requested comparison value is unavailable");
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  missing = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(tile.locator(".kpi-delta")).toContainText("+150.0%");
  const saving = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saving;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().spec.tiles[0]).toMatchObject({ chart, compare: "yoy", compareShow: "value", spark: { compare: "prior" } });
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await expect(tile.locator(".kpi-delta")).toHaveText("+150.0%vs same period last year");
});
