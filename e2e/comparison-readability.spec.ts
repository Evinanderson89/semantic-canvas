import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

test("retention crossing 100% stays visible in headline values and the authored report takeaway", async ({ page }, info) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", "nrr", "nrr__prev"], rows: [["2026-07-01", 1.0004, 1.002], ["2026-08-01", .9996, 1.0004]], ms: 1,
  } }));
  const id = crypto.randomUUID(), title = `Retention review ${id.slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: { id, spec: { title, tiles: [
    { id: "retention", title: "Net revenue retention", chart: "kpi", metrics: ["nrr"], compare: "prior", dimensions: ["month:fct_saas_monthly.month"], layout: { x: 24, y: 24, w: 560, h: 300 } },
  ] }, canvas: DEFAULT_CANVAS } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  await expect(page.locator(".node .kpi-value")).toHaveText("99.96%");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  await expect(review.locator(".brief-observation-statement")).toContainText("was 99.96%");
  await expect(review.locator(".brief-observation-statement")).toContainText("from 100.04%");
  await review.getByRole("button", { name: "Add observation to takeaway", exact: true }).click();
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.locator(".kpi-value")).toHaveText("99.96%");
    await expect(review.locator(".report-takeaway")).toContainText("was 99.96%");
    await expect(review.locator(".report-takeaway")).toContainText("from 100.04%");
  }
  await review.getByRole("button", { name: "Expand presentation", exact: true }).click();
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath("retention-threshold-infographic.png"));
});

test("small movements stay distinct from zero across the dashboard, story and infographic", async ({ page }, info) => {
  const values: Record<string, [number, number]> = {
    cost_per_click: [99.99, 100], click_through_rate: [.0351254, .035126], ad_clicks: [100, 100],
  };
  await page.route("**/api/query", route => {
    const metric = route.request().postDataJSON().metrics[0], [latest, previous] = values[metric];
    return route.fulfill({ json: { columns: ["spend_date_month", metric, `${metric}__prev`],
      rows: [["2026-07-01", previous, previous], ["2026-08-01", latest, previous]], ms: 1 } });
  });
  const id = crypto.randomUUID(), title = `Small changes ${id}`;
  const tiles = Object.keys(values).map((metric, i) => ({ id: metric, chart: "kpi", metrics: [metric], compare: "prior",
    dimensions: ["month:fct_marketing_spend.spend_date"], layout: { x:24 + i * 364, y:24, w:344, h:168 } }));
  expect((await page.request.post("/api/dashboards", { data: { id, spec: { title, tiles }, canvas: DEFAULT_CANVAS } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact:true }).click();
  await page.getByRole("dialog").getByRole("button", { name:title, exact:false }).click();
  const expected = ["Down <0.1%vs prior period", "Down <0.1 ppvs prior period", "+0.0%vs prior period"];
  await expect(page.locator(".node .kpi-delta")).toHaveText(expected);
  await page.getByRole("button", { name:"Review and share", exact:true }).click();
  const review = page.getByRole("dialog", { name:"Review and share" });
  await review.getByText("Build your brief from the evidence", { exact:true }).click();
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name:mode, exact:true }).click();
    await expect(review.locator(".kpi-delta")).toHaveText(expected);
    await expect(review.locator(".report-evidence-drafts")).toContainText("Down 0.01%");
    await expect(review.locator(".report-evidence-drafts")).toContainText("percentage points");
    await expect(review.locator(".report-evidence-drafts")).toContainText("Unchanged");
  }
  // The longer truthful label must fit the existing headline cards.
  for (const label of await review.locator(".kpi-delta > span:first-child").all()) {
    expect(await label.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await review.screenshot({path:info.outputPath("small-comparisons-infographic.png")});
});
