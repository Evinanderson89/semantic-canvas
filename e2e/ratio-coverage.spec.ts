import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

test("the sample ratio API strips internal coverage columns and scopes evidence to its visible window", async ({ request }) => {
  const query = async (limit: number) => {
    const response = await request.post("/api/query", { headers: { "x-sc-principal": "admin" }, data: { metrics: ["new_customers_per_session"], dimensions: ["month:movement_date"], compare: "prior", limit } });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const full = await query(1000);
  expect(full.rows.length).toBeGreaterThan(3);
  expect(full.columns.some((c: string) => c.startsWith("__ratio"))).toBe(false);
  if (full.partial.ratio?.length) expect(full.warnings.join(" ")).toContain("Inspect partial.ratio");
  for (const issue of full.partial.ratio ?? []) {
    const row = full.rows.find((r: unknown[]) => String(r[0]).slice(0, 10) === issue.period);
    expect(row).toBeTruthy(); expect(row[full.columns.indexOf("new_customers_per_session__prev")]).toBeNull();
  }
  const limited = await query(1);
  expect(limited.rows).toEqual([full.rows.at(-1)]);
  expect(limited.truncated).toBe(true);
  expect((limited.partial.ratio ?? []).every((r: { period: string }) => r.period === String(limited.rows[0][0]).slice(0, 10))).toBe(true);
});

test("ratio evidence survives chart, KPI and presentation views without hiding valid later comparisons", async ({ page }, info) => {
  let latestVerified = false;
  await page.route("**/api/query", route => {
    const query = route.request().postDataJSON();
    const columns = ["movement_date_month", "new_customers_per_session"];
    const rows: unknown[][] = [["2026-05-01", .01], ["2026-06-01", .01], ["2026-07-01", .01], ["2026-08-01", .02]];
    if (query.compare === "prior") { columns.push("new_customers_per_session__prev"); rows.forEach((r, i) => r.push(latestVerified && i === rows.length - 1 ? .01 : null)); }
    const issue = (month: string) => ({ period: `${month}-01`, numeratorStart: `${month}-01`, numeratorEnd: `${month}-30`, denominatorStart: `${month}-01`, denominatorEnd: `${month}-15` });
    return route.fulfill({ json: { columns, rows, ms: 1, partial: { start: false, end: false, ratio: [issue("2026-05"), issue("2026-06"), issue("2026-07"), ...latestVerified ? [] : [issue("2026-08")]] } } });
  });
  const id = crypto.randomUUID(), title = `Ratio coverage ${id.slice(0, 8)}`;
  const fields = { metrics: ["new_customers_per_session"], dimensions: ["month:movement_date"] };
  const saved = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 850 }, spec: { title, tiles: [
    { ...fields, id: "ratio", title: "Acquisition ratio", chart: "line", compare: "prior", layout: { x: 24, y: 24, w: 900, h: 350 } },
    { ...fields, id: "prior", title: "Ratio vs prior", chart: "kpi", compare: "prior", layout: { x: 24, y: 398, w: 438, h: 300 } },
    { ...fields, id: "first", title: "Ratio vs first shown", chart: "kpi", compare: "none", spark: { compare: "first" }, layout: { x: 486, y: 398, w: 438, h: 300 } },
  ] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/"); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const trend = page.getByRole("group", { name: "Acquisition ratio", exact: true });
  await expect(trend.locator("figure")).toBeVisible();
  await expect(trend.getByRole("status")).toContainText("Ratio input periods need review");
  await expect(page.locator(".node .kpi-delta")).toHaveText(["input coverage · no comparison", "input coverage · no comparison"]);
  const inspect = trend.getByRole("button", { name: "Inspect input periods", exact: true });
  await inspect.focus(); await inspect.press("Enter");
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("numerator 2026-06-01 to 2026-06-30; denominator 2026-06-01 to 2026-06-15");
  await expect(evidence).toContainText("matching boundaries do not certify complete data");
  await evidence.getByText("Inspect affected input periods (4)", { exact: true }).click();
  const periods = evidence.getByRole("region", { name: "Affected ratio input periods" });
  await expect(periods.locator("tbody tr")).toHaveCount(4);
  await expect(periods.locator("tbody tr").last()).toContainText("2026-08-01 to 2026-08-15");
  await periods.scrollIntoViewIfNeeded();
  await evidence.screenshot({ path: info.outputPath("ratio-input-coverage.png") });
  await page.keyboard.press("Escape");
  await expect(inspect).toBeFocused();
  latestVerified = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("group", { name: "Ratio vs prior", exact: true }).locator(".kpi-delta")).toContainText("+1.0 pp");
  await expect(page.getByRole("group", { name: "Ratio vs first shown", exact: true }).locator(".kpi-delta")).toHaveText("input coverage · no comparison");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.locator(".report-evidence-drafts")).toContainText("Review both input windows");
    await expect(review.locator(".report-evidence-drafts")).not.toContainText("Up ");
    await expect(review.locator(".result-warning").first()).toContainText("Ratio input periods need review");
  }
});

test("all affected ratio periods remain accessible beyond the first page and on a narrow screen", async ({ page }, info) => {
  const periods = Array.from({ length: 55 }, (_, i) => {
    const month = new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7);
    return { period: `${month}-01`, numeratorStart: `${month}-01`, numeratorEnd: `${month}-28`, denominatorStart: `${month}-01`, denominatorEnd: `${month}-15` };
  });
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date_month", "new_customers_per_session"], rows: periods.map(p => [p.period, .01]), ms: 1,
    partial: { start: false, end: false, ratio: periods } } }));
  const id = crypto.randomUUID(), title = `Long ratio evidence ${id}`;
  const saved = await page.request.post("/api/dashboards", { data: { id, spec: { title, tiles: [{ id: "ratio", title: "Ratio inputs", metrics: ["new_customers_per_session"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 900, h: 400 } }] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/"); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Inspect input periods", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await evidence.getByText("Inspect affected input periods (55)", { exact: true }).click();
  const table = evidence.getByRole("region", { name: "Affected ratio input periods" });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await evidence.getByRole("button", { name: "Show next 5 rows", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(55);
  await expect(table.locator("tbody tr").last()).toContainText(periods.at(-1)!.denominatorEnd);
  await expect(evidence.getByRole("button", { name: /Show next/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await table.focus(); await page.keyboard.press("End");
  expect(await evidence.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await table.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await evidence.screenshot({ path: info.outputPath("ratio-periods-narrow.png") });
});
