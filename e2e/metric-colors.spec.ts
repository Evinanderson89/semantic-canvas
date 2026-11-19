import { expect, test, type Locator } from "@playwright/test";

const markColor = (chart: Locator, label: string) => chart.locator('g[aria-label="bar"] rect').filter({ has: chart.page().locator("title", { hasText: label }) }).first().evaluate(el => getComputedStyle(el).fill);

test("metric colors survive chart subsets, chart types, presentation modes and selected exports", async ({ page }, info) => {
  const title = `Metric colors ${crypto.randomUUID()}`;
  const kinds = ["barGrouped", "barGrouped", "combo", "area"] as const;
  const names = ["All movements", "Plan comparison", "Combined view", "New business trend"];
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(), tiers = q.dimensions[0]?.includes("plan_tier");
    return route.fulfill({ json: { columns: [tiers ? "plan_tier" : "movement_date_month", ...q.metrics],
      rows: (tiers ? ["business", "team"] : ["2026-07-01", "2026-08-01"]).map((bucket, i) => [bucket, ...q.metrics.map((m: string) => ({ new_mrr: 100, expansion_mrr: 80, churned_mrr: 20 })[m]!* (i + 1))]), ms: 1 } });
  });
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(),
    canvas: { width: 1400, height: 1000, preset: "custom", snap: true, grid: 8, locked: false },
    spec: { title, tiles: kinds.map((chart, i) => ({ id: `chart-${i}`, title: names[i], chart,
      metrics: i === 0 ? ["new_mrr", "expansion_mrr", "churned_mrr"] : i === 3 ? ["new_mrr"] : ["expansion_mrr", "new_mrr"],
      dimensions: [i === 1 ? "dim_plans.plan_tier" : "month:fct_mrr_movements.movement_date"],
      layout: { x: 24 + (i % 2) * 680, y: 24 + Math.floor(i / 2) * 400, w: 650, h: 370 } })) } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  const colorChecks = async (tile: (i: number) => Locator) => {
    await expect.poll(() => markColor(tile(0), "New MRR (USD)")).toBe("rgb(8, 145, 178)");
    expect(await markColor(tile(1), "New MRR (USD)")).toBe("rgb(8, 145, 178)");
    expect(await markColor(tile(0), "Expansion MRR (USD)")).toBe(await markColor(tile(1), "Expansion MRR (USD)"));
    expect(await tile(2).locator('g[aria-label="line"] path').first().evaluate(el => getComputedStyle(el).stroke)).toBe("rgb(8, 145, 178)");
    expect(await tile(3).locator('g[aria-label="line"] path').first().evaluate(el => getComputedStyle(el).stroke)).toBe("rgb(8, 145, 178)");
  };
  await colorChecks(i => page.locator(".node").filter({ has: page.getByText(names[i], { exact: true }) }));
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` })).toBeEnabled();
    await colorChecks(i => review.locator(`[data-report-tile="chart-${i}"]`));
  }
  await review.getByRole("checkbox", { name: "All movements", exact: true }).uncheck();
  await expect(review.locator('[data-report-tile="chart-0"]')).toHaveCount(0);
  expect(await markColor(review.locator('[data-report-tile="chart-1"]'), "New MRR (USD)")).toBe("rgb(8, 145, 178)");
  await review.getByRole("button", { name: "Expand presentation", exact: true }).click();
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(info.outputPath("consistent-metric-colors.png"));
});

test("new revenue and churn stay visually distinct when unrelated dashboard metrics fill the palette", async ({ page }, info) => {
  const title = `Extended metric colors ${crypto.randomUUID()}`;
  const movementMetrics = ["new_mrr", "expansion_mrr", "churned_mrr", "contraction_mrr"];
  const spec = { title, tiles: [
    ...[movementMetrics, ["new_mrr", "churned_mrr"]].map((metrics, i) => ({ id: `movement-${i}`, title: i ? "Focused movements" : "All movements", chart: "barGrouped", metrics,
      dimensions: ["month:fct_mrr_movements.movement_date"], layout: { x: 24 + i * 600, y: 24, w: 580, h: 360 } })),
    ...["ending_mrr", "nrr", "cac", "ltv_cac_ratio"].map((metric, i) => ({ id: `headline-${i}`, title: metric, chart: "kpi", metrics: [metric],
      dimensions: ["month:fct_saas_monthly.month"], layout: { x: 24 + i * 300, y: 400, w: 280, h: 200 } })),
  ] };
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec,
    canvas: { width: 1240, height: 650, preset: "custom", snap: true, grid: 8, locked: false } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  const chart = (name: string) => page.locator(".node").filter({ has: page.getByText(name, { exact: true }) });
  await expect(chart("All movements").locator('g[aria-label="bar"] rect').first()).toBeVisible();
  const labels = ["New MRR (USD)", "Expansion MRR (USD)", "Churned MRR (USD)", "Contraction MRR (USD)"];
  const colors = await Promise.all(labels.map(label => markColor(chart("All movements"), label)));
  expect(new Set(colors).size).toBe(4);
  expect(await markColor(chart("Focused movements"), labels[0])).toBe(colors[0]);
  expect(await markColor(chart("Focused movements"), labels[2])).toBe(colors[2]);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` })).toBeEnabled();
    const all = review.locator('[data-report-tile="movement-0"]');
    expect(await Promise.all(labels.map(label => markColor(all, label)))).toEqual(colors);
  }
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(info.outputPath("distinct-revenue-movements.png"));
  await review.getByRole("checkbox", { name: "All movements", exact: true }).uncheck();
  expect(await markColor(review.locator('[data-report-tile="movement-1"]'), labels[0])).toBe(colors[0]);
});
