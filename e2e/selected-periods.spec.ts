import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

test("selected partial months stay visible without invented KPI changes or story conclusions", async ({ page }, info) => {
  const id = crypto.randomUUID(), title = `Selected reporting window ${id.slice(0, 8)}`;
  const fields = { metrics: ["web_sessions"], dimensions: ["month:fct_web_sessions.session_date"],
    where: [{ id: "window", source: "dimension", field: "fct_web_sessions.session_date", mode: "range", min: "2025-10-15", max: "2025-12-15" }] };
  const query = await page.request.post("/api/query", { headers: { "x-sc-principal": "admin" }, data: { ...fields, compare: "prior" } });
  expect(query.ok(), await query.text()).toBe(true);
  const result = await query.json();
  expect(result.rows.map((r: unknown[]) => r[0])).toEqual(["2025-10-01", "2025-11-01", "2025-12-01"]);
  expect(result.partial).toEqual({ start: false, end: false, selected: { start: true, end: true } });
  expect(result.rows.every((r: unknown[]) => r[result.columns.indexOf("web_sessions__prev")] === null)).toBe(true);
  const saved = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 850 }, spec: { title, tiles: [
    { ...fields, id: "trend", title: "Selected traffic", chart: "line", compare: "prior", layout: { x: 24, y: 24, w: 900, h: 350 } },
    { ...fields, id: "prior", title: "Prior period", chart: "kpi", compare: "prior", layout: { x: 24, y: 398, w: 438, h: 300 } },
    { ...fields, id: "first", title: "First shown period", chart: "kpi", compare: "none", spark: { compare: "first" }, layout: { x: 486, y: 398, w: 438, h: 300 } },
  ] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const trend = page.getByRole("group", { name: "Selected traffic", exact: true });
  await expect(trend.locator("figure")).toBeVisible();
  await expect(page.locator(".node .kpi-delta")).toHaveText(["partial period · no comparison", "partial period · no comparison"]);
  await expect(trend.getByRole("status")).toContainText("Selected window includes partial observed periods");
  await trend.getByRole("button", { name: "Inspect selected period", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("These rows remain visible");
  await expect(evidence).toContainText("does not prove missing source data");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  await expect(review.locator(".report-evidence-drafts")).toContainText("partial observed edge periods");
  await expect(review.locator(".report-evidence-drafts")).not.toContainText("Down ");
  await review.screenshot({ path: info.outputPath("selected-period-review.png") });
});
