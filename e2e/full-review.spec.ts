import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";
import { openStarter } from "./library-helpers.ts";
import { recommend, type FieldProfile } from "../src/suggest/recommend.ts";

const chart = (patch: Partial<TileSpec>): TileSpec => ({ id: "review-chart", title: "Review chart", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 850, h: 400 }, ...patch });
async function open(page: Page, tiles: TileSpec[]) {
  const spec: DashboardSpec = { title: `Full review ${crypto.randomUUID()}`, tiles };
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 900 }, revision: 0 } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
}

for (const kind of ["line", "combo"] as const) for (const reversed of [false, true]) for (const percent of [false, true]) {
  test(`${kind}: secondary ${percent ? "percent" : "currency"} axis preserves magnitude with ${reversed ? "small" : "large"} metric first`, async ({ page }, testInfo) => {
    const smallMetric = percent ? "nrr" : "expansion_mrr";
    const largeMetric = percent ? "ending_mrr" : "new_mrr";
    const metrics = reversed ? [smallMetric, largeMetric] : [largeMetric, smallMetric];
    const time = percent ? "fct_saas_monthly.month" : "movement_date";
    const timeColumn = percent ? "month_month" : "movement_date_month";
    const rows = [0.8403, 0.8404, 0.8406, 0.8407].map((small, i) => {
      const values = { [largeMetric]: 300000 + i * 50000, [smallMetric]: small };
      return [`2026-0${i + 3}-01`, ...metrics.map(m => values[m])];
    });
    await page.route("**/api/query", route => route.fulfill({ json: { columns: [timeColumn, ...metrics], rows, ms: 1 } }));
    await open(page, [chart({ chart: kind, metrics, dimensions: [`month:${time}`] })]);
    const tile = page.locator(".node .tile");
    await expect(tile.locator(".secondary-axis")).toBeVisible();
    const ticks = await tile.locator(".secondary-axis .tick text").allTextContents();
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ticks).size).toBe(ticks.length);
    await expect(tile.locator("figcaption")).toContainText("Independent scales");
    for (const tick of ticks) {
      // Unlike magnitude-only splitting, different units preserve selection
      // order. A percentage selected first belongs to the left axis.
      if (percent && reversed) {
        expect(tick).toMatch(/^\$\d+k$/);
        const value = Number(tick.replace("$", "").replace("k", "")) * 1000;
        expect(value).toBeGreaterThanOrEqual(kind === "combo" ? 0 : 300000);
        expect(value).toBeLessThanOrEqual(450000);
        continue;
      }
      expect(tick).toContain(percent ? "%" : "$");
      expect(tick).not.toMatch(/[kMB]/);
      const value = Number(tick.replaceAll(",", "").replace("$", "").replace("%", "")) / (percent ? 100 : 1);
      expect(value).toBeGreaterThanOrEqual(kind === "combo" ? 0 : .84029);
      expect(value).toBeLessThanOrEqual(.84071);
    }
    await expect(tile.locator("figure")).toContainText(/\$\d+k/);
    if (percent) await expect(tile.locator("figure")).toContainText("%");
    if (kind === "line" && !reversed && !percent) await tile.screenshot({ path: testInfo.outputPath("secondary-axis.png") });
  });
}

test("percent comparison plots one percent series and unknown comparisons block handoff readiness", async ({ page }) => {
  let missing = false;
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date_month", "new_mrr", "new_mrr__prev", "new_mrr__delta", "new_mrr__pct"], rows: [["2026-06-01", 12000, 10000, 2000, missing ? null : .2], ["2026-07-01", 15000, 12000, 3000, missing ? null : .25]], ms: 1 } }));
  await open(page, [chart({ compare: "prior", compareShow: "percent" })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator('g[aria-label="line"] path')).toHaveCount(1);
  await expect(tile).toContainText("Percentage change");
  await expect(tile.locator("figure")).toContainText("%");
  await expect(tile.locator("figure")).not.toContainText("$");
  missing = true;
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await expect(dialog).toContainText("No numeric values");
  await expect(dialog.getByRole("button", { name: "Copy review context" })).toBeEnabled();
});

test("horizontal categorical bars filter on their category rather than the value axis", async ({ page }) => {
  const queried: any[] = [];
  await page.route("**/api/query", route => { queried.push(route.request().postDataJSON()); return route.fulfill({ json: { columns: ["country", "new_mrr"], rows: [["US", 100], ["DE", 50]], ms: 1 } }); });
  await open(page, [chart({ chart: "barH", dimensions: ["dim_users.country"] })]);
  const bar = page.locator('.node g[aria-label="bar"] rect').first();
  await expect(bar).toBeVisible(); await bar.click();
  await expect.poll(() => queried.some(q => q.where?.some((f: any) => f.field === "dim_users.country" && f.values?.includes("US")))).toBe(true);
});

test("grouped temporal bars drill using the period instead of the series name", async ({ page }) => {
  const queried: any[] = [];
  await page.route("**/api/query", route => { const q = route.request().postDataJSON(); queried.push(q); return route.fulfill({ json: { columns: [q.dimensions[0].startsWith("day:") ? "movement_date_day" : "movement_date_month", "new_mrr", "expansion_mrr"], rows: [["2026-06-01", 100, 20], ["2026-07-01", 150, 30]], ms: 1 } }); });
  await open(page, [chart({ chart: "barGrouped", metrics: ["new_mrr", "expansion_mrr"] })]);
  await page.locator('.node g[aria-label="bar"] rect').first().click();
  await expect.poll(() => queried.some(q => q.dimensions[0].startsWith("week:") || q.dimensions[0].startsWith("day:"))).toBe(true);
  await expect(page.locator(".tile-crashed")).toHaveCount(0);
});

for (const scenario of [
  { grain: "week", next: "day", start: "2026-09-06", end: "2026-09-13" },
  { grain: "quarter", next: "month", start: "2026-08-01", end: "2026-11-01" },
  { grain: "year", next: "quarter", start: "2025-02-01", end: "2026-02-01" },
]) test(`chart click preserves the model's ${scenario.grain} calendar in the drill request`, async ({ page }) => {
  // UI fixtures verify the click-to-request wiring; drillCalendar.test.ts
  // separately executes the compiled filters against real synthetic rows.
  await page.route("**/api/model", async route => {
    const response = await route.fetch(), model = await response.json();
    await route.fulfill({ json: { ...model, calendar: { ...model.calendar, weekStart: "sunday", fiscalYearStartMonth: 2 } } });
  });
  const queried: any[] = [];
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(); queried.push(q);
    const grain = q.dimensions[0].split(":")[0];
    return route.fulfill({ json: { columns: [`movement_date_${grain}`, "new_mrr"], rows: [[scenario.start, 100]], ms: 1 } });
  });
  await open(page, [chart({ chart: "bar", dimensions: [`${scenario.grain}:movement_date`] })]);
  await page.locator('.node g[aria-label="bar"] rect').first().click();
  await expect.poll(() => queried.some(q => q.dimensions[0] === `${scenario.next}:movement_date` && q.where?.some((f: any) =>
    f.field === "movement_date" && f.min === scenario.start && f.max === scenario.end && f.maxExclusive === true))).toBe(true);
  await expect(page.locator(".tile-crashed")).toHaveCount(0);
});

test("design review does not mistake missing coarser values for a smoother trend", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  let coarserChecked = false;
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(), weekly = q.dimensions[0].startsWith("week:");
    if (weekly) coarserChecked = true;
    const rows = Array.from({ length: weekly ? 20 : 40 }, (_, i) => [
      new Date(Date.UTC(2026, 0, 5 + i * (weekly ? 7 : 1))).toISOString().slice(0, 10), weekly ? null : i % 2 ? 100 : 0,
    ]);
    return route.fulfill({ json: { columns: [`movement_date_${weekly ? "week" : "day"}`, "new_mrr"], rows, ms: 1 } });
  });
  await open(page, [chart({ dimensions: ["day:movement_date"] })]);
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  await expect.poll(() => coarserChecked).toBe(true);
  await expect(page.locator(".review-coverage")).toContainText("1 chart reviewed");
  await expect(page.getByRole("button", { name: "Switch to week", exact: true })).toHaveCount(0);
});

test("a chart that cannot show all selected fields is visibly blocked instead of dropping a breakdown", async ({ page }) => {
  await open(page, [chart({ dimensions: ["month:movement_date", "movement_type", "dim_users.country"] })]);
  await expect(page.locator(".node .chart-err")).toContainText("every selected breakdown");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await expect(dialog).toContainText("every selected breakdown");
  await expect(dialog.getByRole("button", { name: "Export dashboard as PNG" })).toBeDisabled();
});

for (const categoryFirst of [false, true]) test(`segmented lines preserve series, missing periods and drill direction (category first: ${categoryFirst})`, async ({ page }, testInfo) => {
  const queried: any[] = [];
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(); queried.push(q);
    const grain = q.dimensions.find((d: string) => d.includes(":"))?.split(":")[0] ?? "month";
    // Deliberately out of order: Enterprise is missing June; SMB has a null
    // June observation. Neither should turn into zero or a connecting line.
    const rows = [
      ["2026-08-01", "Enterprise", 160], ["2026-05-01", "Enterprise", 100], ["2026-07-01", "Enterprise", 140],
      ["2026-05-01", "SMB", 20], ["2026-06-01", "SMB", null], ["2026-07-01", "SMB", 30], ["2026-08-01", "SMB", 40],
    ];
    const columns = [`movement_date_${grain}`, "movement_type", "new_mrr"];
    return route.fulfill({ json: { columns: categoryFirst ? [columns[1], columns[0], columns[2]] : columns,
      rows: categoryFirst ? rows.map(([time, category, value]) => [category, time, value]) : rows, ms: 1 } });
  });
  const dimensions = categoryFirst ? ["movement_type", "month:movement_date"] : ["month:movement_date", "movement_type"];
  await open(page, [chart({ dimensions })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator(".chart-err")).toHaveCount(0);
  await expect(tile.locator('g[aria-label="line"] path')).toHaveCount(2);
  await expect(tile.locator('g[aria-label="dot"] circle')).toHaveCount(6);
  const paths = await tile.locator('g[aria-label="line"] path').evaluateAll(nodes => nodes.map(n => n.getAttribute("d")));
  expect(paths.every(d => (d?.match(/M/g) ?? []).length === 2)).toBe(true);
  await expect(tile.locator("figure")).toContainText("Enterprise");
  await expect(tile.locator("figure")).toContainText("SMB");
  for (const month of ["May 26", "Jun 26", "Jul 26", "Aug 26"]) await expect(tile.locator("figure")).toContainText(month);
  const first = tile.locator('g[aria-label="dot"] circle').first();
  await expect(first.locator("title")).toContainText("2026-05-01");
  await expect(first.locator("title")).toContainText("100");
  if (categoryFirst) await tile.screenshot({ path: testInfo.outputPath("category-lines.png") });
  await first.click();
  await expect.poll(() => queried.some(q => q.dimensions.includes("day:movement_date") && q.dimensions.includes("movement_type") &&
    q.where?.some((f: any) => f.field === "movement_date" && f.min === "2026-05-01" && f.max === "2026-06-01"))).toBe(true);
  expect(queried.some(q => q.where?.some((f: any) => f.field === "movement_type"))).toBe(false);
});

for (const scenario of [
  { name: "scalar measures", dimensions: [], roles: [], measures: 3 },
  { name: "time", dimensions: ["month:movement_date"], roles: ["temporal"], measures: 1 },
  { name: "two measures over time", dimensions: ["month:movement_date"], roles: ["temporal"], measures: 2 },
  { name: "three measures over time", dimensions: ["month:movement_date"], roles: ["temporal"], measures: 3 },
  { name: "geography", dimensions: ["dim_users.country"], roles: ["geo"], measures: 1 },
  { name: "two measures by geography", dimensions: ["dim_users.country"], roles: ["geo"], measures: 2 },
  { name: "two categorical breakdowns", dimensions: ["movement_type", "dim_users.country"], roles: ["categorical", "geo"], measures: 1 },
  { name: "time and category", dimensions: ["month:movement_date", "movement_type"], roles: ["temporal", "categorical"], measures: 1 },
  { name: "category and time", dimensions: ["movement_type", "month:movement_date"], roles: ["categorical", "temporal"], measures: 1 },
  { name: "three measures by category", dimensions: ["movement_type"], roles: ["categorical"], measures: 3 },
]) test(`every recommended ${scenario.name} chart renders all selected fields`, async ({ page }) => {
  test.setTimeout(90_000);
  const metrics = ["new_mrr", "expansion_mrr", "contraction_mrr"].slice(0, scenario.measures);
  const profiles: FieldProfile[] = scenario.dimensions.map((field, i) => ({ field, role: scenario.roles[i] as FieldProfile["role"],
    type: scenario.roles[i] === "temporal" ? "date" : "string", cardinality: 3, sample: scenario.roles[i] === "geo" ? ["US", "GB", "DE"] : [] }));
  const aliases = scenario.dimensions.map(d => d.includes(":") ? `${d.split(":")[1]}_${d.split(":")[0]}` : d.split(".").at(-1)!);
  let rows: unknown[][] = [[]];
  for (const role of scenario.roles) {
    const values = role === "temporal" ? ["2026-05-01", "2026-06-01", "2026-07-01"] : role === "geo" ? ["US", "GB", "DE"] : ["new", "expansion", "reactivation"];
    rows = rows.flatMap(row => values.map(value => [...row, value]));
  }
  rows = rows.map((row, i) => [...row, ...metrics.map((_, m) => 100 + i * 10 + m * 20)]);
  await page.route("**/api/query", route => route.fulfill({ json: { columns: [...aliases, ...metrics], rows, ms: 1 } }));
  for (const option of recommend(metrics, profiles)) {
    await test.step(option.kind, async () => {
      await open(page, [chart({ dimensions: scenario.dimensions, metrics, chart: option.kind })]);
      const tile = page.locator(".node .tile");
      await expect(tile.locator(".chart-err, .tile-crashed")).toHaveCount(0);
      if (option.kind === "table") {
        await expect(tile.locator("tbody tr")).toHaveCount(rows.length);
        await expect(tile.locator("thead th")).toHaveCount(aliases.length + metrics.length);
      } else if (option.kind === "kpi") {
        await expect(tile.locator(".kpi")).toBeVisible();
      } else {
        await expect(tile.locator("figure svg").last()).toBeVisible();
        if (option.kind === "areaStacked") await expect(tile.locator('g[aria-label="area"] path')).toHaveCount(scenario.dimensions.length === 2 ? 3 : metrics.length);
        if (option.kind === "line") {
          await expect(tile.locator('g[aria-label="line"] path')).toHaveCount(scenario.dimensions.length === 2 ? 3 : metrics.length);
          await expect(tile.locator('g[aria-label="dot"] circle')).toHaveCount(rows.length * metrics.length);
        }
        if (option.kind === "barStacked" || option.kind === "barGrouped") await expect(tile.locator('g[aria-label="bar"] rect')).toHaveCount(rows.length * metrics.length);
      }
    });
  }
});

test("date-looking category names stay categories and incomplete stacks stay unknown", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_type", "movement_date_month", "new_mrr"],
    rows: [["2025-01-01", "2026-05-01", 10], ["2025-01-01", "2026-06-01", 20], [null, "2026-05-01", 30]], ms: 1,
  } }));
  const dimensions = ["movement_type", "month:movement_date"];
  await open(page, [chart({ dimensions })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator('g[aria-label="line"] path')).toHaveCount(2);
  await expect(tile.locator("figure")).toContainText("2025-01-01");
  await expect(tile.locator("figure")).toContainText("Missing category");
  await expect(tile.locator('g[aria-label="dot"] circle')).toHaveCount(3);
  await open(page, [chart({ dimensions, chart: "areaStacked" })]);
  await expect(page.locator(".node .chart-err")).toContainText("every component in each period");
});

test("a KPI cannot silently discard a category or second measure", async ({ page }) => {
  for (const patch of [{ dimensions: ["month:movement_date", "movement_type"] }, { metrics: ["new_mrr", "expansion_mrr"] }]) {
    await open(page, [chart({ ...patch, chart: "kpi" })]);
    await expect(page.locator(".node .chart-err")).toContainText("every selected breakdown and measure");
    await page.getByRole("button", { name: "Review and share", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Review and share" }).getByRole("button", { name: "Export dashboard as PNG" })).toBeDisabled();
  }
});

test("a KPI on a declared date field uses the latest observation without inventing a comparison grain", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date", "new_mrr"],
    rows: [["2026-06-01", 120], ["2026-05-01", 100]], ms: 1 } }));
  await open(page, [chart({ dimensions: ["movement_date"], chart: "kpi" })]);
  const kpi = page.locator(".node .kpi");
  await expect(kpi.locator(".kpi-value")).toContainText("120");
  await expect(kpi.locator(".kpi-asof")).toContainText("2026-06-01");
  await expect(kpi.locator(".kpi-delta")).toHaveText("comparison off");
});

test("a scalar KPI keeps investigation and metric-scope actions", async ({ page }) => {
  await open(page, [chart({ metrics: ["new_signups"], dimensions: [], chart: "kpi" })]);
  const tile = page.locator(".node .tile");
  await expect(tile.getByRole("button", { name: "Open detail dashboard", exact: true })).toBeVisible();
  await tile.getByRole("button", { name: "More chart actions" }).click();
  await expect(tile.getByRole("button", { name: "Metric definition and scope" })).toBeVisible();
});

test("snapshot evidence explains the declared reporting period without certifying coverage", async ({ page }) => {
  await open(page, [chart({ metrics: ["cac"], dimensions: ["month:fct_saas_monthly.month"], title: "Monthly acquisition cost" })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator("figure svg")).toBeVisible();
  await tile.getByRole("button", { name: "More chart actions" }).click();
  await tile.getByRole("button", { name: "Metric definition and scope" }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("Declared source periods: whole month periods");
  await expect(evidence).toContainText("does not certify that every period has arrived");
  await expect(evidence).toContainText("2026-08-01");
});

test("redesign preview makes an unsupported active filter visible on the new chart", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: { title: "Retention context", reason: "Add governed retention", actions: [
    { type: "add", tile: chart({ id: "retention", metrics: ["nrr"], dimensions: ["month:fct_saas_monthly.month"], title: "Retention context", layout: { x: 24, y: 3000, w: 850, h: 400 } }) },
  ] } } }));
  await page.goto("/"); await openStarter(page, "MRR movements");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("dim_users.country");
  await page.getByLabel("Label", { exact: true }).fill("Country");
  await page.getByRole("button", { name: "Save filter", exact: true }).click();
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  await page.getByRole("checkbox", { name: "US", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Improve with AI", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard" }).click();
  await expect(dialog.locator(".ai-redesign-tile").filter({ has: page.getByRole("heading", { name: "Retention context", exact: true }) })).toContainText("Not filtered by Country");
});

test("a funnel preserves stage order, includes increases, and refuses missing components", async ({ page }) => {
  let missing = false;
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_type", "new_mrr"], rows: [["First stage", 100], ["Second stage", missing ? null : 150], ["Third stage", 50]], ms: 1 } }));
  await open(page, [chart({ chart: "funnel", dimensions: ["movement_type"] })]);
  const figure = page.locator(".node figure");
  await expect(figure).toContainText("150%");
  const labels = await figure.locator('g[aria-label="text"] text').allTextContents();
  expect(labels.slice(0, 3)).toEqual(["First stage", "Second stage", "Third stage"]);
  missing = true;
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await expect(dialog.locator(".chart-err")).toContainText("a value for every component");
  await expect(dialog.getByRole("button", { name: "Copy review context" })).toBeEnabled();
});


test("data evidence follows the current query and travels into the handoff", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_date_month", "new_mrr"], rows: [["2026-01-01", 10], ["2026-03-01", null]], ms: 1 } }));
  await open(page, [chart({})]);
  await page.locator(".node").getByRole("button", { name: "2 data checks to review" }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("1 of 2 returned rows have no value");
  await expect(evidence).toContainText("1 month period");
  await expect(evidence).toContainText("do not certify completeness");
  await expect(evidence).toContainText("Metric definitions");
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await expect(review).toContainText("2 data observations to review");
  await review.locator("details > summary").filter({ hasText: /^Review chart$/ }).click();
  await expect(review).toContainText("Gaps in the returned time series");
  await expect(review.getByRole("button", { name: "Copy review context" })).toBeEnabled();
});

test("local sign-in URL returns visitors to the app", async ({ page }) => {
  await page.goto("/api/auth/login");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Semantic Canvas", { exact: true }).first()).toBeVisible();
});

test("donut numeric strings produce correct shares, a visible full ring and readable category labels", async ({ page }, testInfo) => {
  let rows: unknown[][] = [["new", "10"], ["expansion", "20"], ["reactivation", "30"]];
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["movement_type", "new_mrr"], rows, ms: 1 } }));
  await open(page, [chart({ chart: "donut", dimensions: ["movement_type"] })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator(".donut-legend")).toContainText("16.7%");
  await expect(tile.locator(".donut-legend")).toContainText("33.3%");
  await expect(tile.locator(".donut-legend")).toContainText("50.0%");
  const bounds = await tile.locator("figure").evaluate(el => ({ figure: el.getBoundingClientRect().toJSON(), parent: el.parentElement!.getBoundingClientRect().toJSON() }));
  expect(bounds.figure.left).toBeGreaterThanOrEqual(bounds.parent.left);
  expect(bounds.figure.right).toBeLessThanOrEqual(bounds.parent.right + 1);
  await tile.screenshot({ path: testInfo.outputPath("donut-shares.png") });
  rows = [["new", "10"], ["expansion", 0]];
  await open(page, [chart({ chart: "donut", dimensions: ["movement_type"] })]);
  await expect(tile.locator(".donut-legend")).toContainText("100.0%");
  const path = tile.locator('svg[role="img"] path').first();
  const box = await path.evaluate(el => { const box = (el as SVGGraphicsElement).getBBox(); return { width: box.width, height: box.height }; });
  expect(box.width).toBeGreaterThan(100); expect(box.height).toBeGreaterThan(100);
  rows = [["new", "10"], ["expansion", "invalid"]];
  await open(page, [chart({ chart: "donut", dimensions: ["movement_type"] })]);
  await expect(tile.locator(".chart-err")).toContainText("finite value");
});

test("waterfall keeps a source category called Total separate from the generated total and filters only real components", async ({ page }, testInfo) => {
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ json: { columns: ["movement_type", "new_mrr"], rows: [["Total", 10], ["Other", -2]], ms: 1 } });
  });
  await open(page, [chart({ chart: "waterfall", dimensions: ["movement_type"] })]);
  const tile = page.locator(".node .tile"), bars = tile.locator('g[aria-label="bar"] rect');
  await expect(bars).toHaveCount(3);
  const positions = await bars.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().x));
  expect(new Set(positions).size).toBe(3);
  await expect(tile).toContainText("Net change");
  await tile.screenshot({ path: testInfo.outputPath("waterfall-total.png") });
  const before = queries.length;
  await bars.last().click();
  expect(queries.length).toBe(before);
  await bars.first().click();
  await expect.poll(() => queries.some(q => q.where.some((f: any) => f.values?.includes("Total")))).toBe(true);
});

test("warehouse bucket timestamps do not move to the previous month in a non-UTC browser", async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ json: { columns: ["movement_date_month", "new_mrr"], rows: [["2026-07-01 00:00:00", 10], ["2026-08-01 00:00:00", 20]], ms: 1 } });
  });
  try {
    await open(page, [chart({ chart: "bar" })]);
    await expect(page.locator('.node g[aria-label="x-axis tick label"]')).toContainText("Jul");
    await page.locator('.node g[aria-label="bar"] rect').first().click();
    await expect.poll(() => queries.some(q => q.where.some((f: any) => f.id?.startsWith("drill:") && f.min === "2026-07-01"))).toBe(true);
  } finally { await context.close(); }
});

test("country maps disclose unmatched places and missing shapes through the exported review", async ({ page }, testInfo) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["country", "new_mrr"], rows: [["US", 100], ["MG", "50"], ["SG", 10], ["Atlantis", 20], ["CM", 0], ["GB", null]], ms: 1,
  } }));
  await open(page, [chart({ chart: "map", dimensions: ["dim_users.country"] })]);
  const tile = page.locator(".node .tile");
  await expect(tile).toContainText("Map shows 3 of 6 returned rows");
  await expect(tile).toContainText("without a shape in this map: SG");
  await expect(tile).toContainText("unrecognized country keys: Atlantis");
  await expect(tile).toContainText("cannot be filled: GB");
  const titles = await tile.locator("svg title").allTextContents();
  expect(titles.some(text => /Madagascar:.*50/.test(text))).toBe(true);
  expect(titles.some(text => /Cameroon:.*0/.test(text) && !text.includes("no data"))).toBe(true);
  await tile.screenshot({ path: testInfo.outputPath("country-map-coverage.png") });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
  await expect(review.locator(".report-document")).toContainText("Some places are not represented on this map");
  await expect(review.locator(".report-document")).toContainText("Atlantis");
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(testInfo.outputPath("country-map-review.png"));
});

test("duplicate-country aliases and entirely unplottable geography cannot produce a misleading map", async ({ page }) => {
  let rows: unknown[][] = [["US", 10], ["USA", 90]];
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"], rows, ms: 1 } }));
  const spec = chart({ chart: "map", dimensions: ["dim_users.country"] });
  await open(page, [spec]);
  await expect(page.locator(".node .chart-err")).toContainText("same country");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await expect(review.getByRole("button", { name: "Export dashboard as PNG" })).toBeDisabled();
  await review.locator('.ai-redesign-brief > details > summary').filter({ hasText: "Review chart" }).click();
  await expect(review.locator(".ai-redesign-brief")).toContainText("No rows were summed or overwritten");
  rows = [["New York", 10], ["001", 90]];
  await open(page, [spec]);
  await expect(page.locator(".node .chart-err")).toContainText("No returned rows have both a drawable country and a numeric value");
});

for (const kind of ["combo", "heatmap"] as const) test(`${kind} keeps distinct intraday observations instead of merging their date labels`, async ({ page }, testInfo) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["event_ts", "event_count", "active_users"],
    rows: [["2026-07-01T09:00:00Z", 100, 80], ["2026-07-01T10:00:00Z", 150, 90], ["2026-07-01T11:00:00Z", 120, 85]], ms: 1,
  } }));
  await open(page, [chart({ chart: kind, metrics: ["event_count", "active_users"], dimensions: ["fct_events.event_ts"] })]);
  const tile = page.locator(".node .tile");
  const marks = tile.locator(`g[aria-label="${kind === "combo" ? "bar" : "cell"}"] rect`);
  await expect(marks).toHaveCount(kind === "combo" ? 3 : 6);
  const boxes = await marks.evaluateAll(nodes => nodes.map(n => ({ x: n.getBoundingClientRect().x, y: n.getBoundingClientRect().y })));
  expect(new Set(boxes.map(b => b.x)).size).toBe(3);
  if (kind === "heatmap") expect(new Set(boxes.map(b => b.y)).size).toBe(2);
  await expect(tile.locator('g[aria-label="x-axis tick label"]')).toContainText("UTC");
  await expect(tile.locator(".chart-err")).toHaveCount(0);
  const bounds = await tile.boundingBox();
  for (const text of await tile.locator('g[aria-label="x-axis tick label"] text').all()) {
    const label = await text.boundingBox();
    expect(label!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(label!.y + label!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  }
  await tile.screenshot({ path: testInfo.outputPath(`${kind}-intraday.png`) });
});

test("heatmap keeps temporal y buckets and identically named metrics in separate rows", async ({ page }) => {
  let temporal = true;
  await page.route("**/api/model", async route => {
    const response = await route.fetch(), model = await response.json();
    model.metrics.event_count.label = "Activity"; model.metrics.active_users.label = "Activity";
    await route.fulfill({ json: model });
  });
  await page.route("**/api/query", route => route.fulfill({ json: temporal ? {
    columns: ["device_platform", "event_ts", "event_count"], rows: [["web", "2026-07-01T09:00:00Z", 100], ["web", "2026-07-01T10:00:00Z", 150]], ms: 1,
  } : { columns: ["device_platform", "event_count", "active_users"], rows: [["web", 100, 80]], ms: 1 } }));
  const tile = page.locator(".node .tile"), cells = tile.locator('g[aria-label="cell"] rect');
  await open(page, [chart({ chart: "heatmap", metrics: ["event_count"], dimensions: ["dim_users.device_platform", "fct_events.event_ts"] })]);
  await expect(cells).toHaveCount(2);
  expect(new Set(await cells.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y))).size).toBe(2);
  await expect(tile.locator('g[aria-label="y-axis tick label"]')).toContainText("UTC");
  temporal = false;
  await open(page, [chart({ chart: "heatmap", metrics: ["event_count", "active_users"], dimensions: ["dim_users.device_platform"] })]);
  await expect(cells).toHaveCount(2);
  expect(new Set(await cells.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y))).size).toBe(2);
  await expect(tile.locator('g[aria-label="y-axis tick label"]')).toContainText("Activity (event_count)");
  await expect(tile.locator('g[aria-label="y-axis tick label"]')).toContainText("Activity (active_users)");
});

for (const kind of ["bar", "barH", "line"] as const) test(`${kind} ignores axis labels and empty margins but still selects actual observations`, async ({ page }) => {
  const queries: any[] = [];
  await page.route("**/api/query", route => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ json: kind === "line" ? { columns: ["movement_date_month", "new_mrr"], rows: [["2026-06-01", 100], ["2026-07-01", 150]], ms: 1 }
      : { columns: ["country", "new_mrr"], rows: [["US", 100], ["DE", 50]], ms: 1 } });
  });
  await open(page, [chart({ chart: kind, dimensions: kind === "line" ? ["month:movement_date"] : ["dim_users.country"] })]);
  const tile = page.locator(".node .tile"), svg = tile.locator("figure > svg");
  const mark = tile.locator(kind === "line" ? 'g[aria-label="dot"] circle' : 'g[aria-label="bar"] rect').first();
  await expect(mark).toBeVisible();
  const before = queries.length;
  await svg.click({ position: { x: 2, y: 2 } });
  await tile.locator(`g[aria-label="${kind === "barH" ? "y" : "x"}-axis tick label"] text`).first().click();
  await page.waitForTimeout(350); // Query updates debounce; allow an accidental request to reach the interceptor.
  expect(queries.length).toBe(before);
  await mark.click();
  await expect.poll(() => queries.some(q => kind === "line" ? q.where?.some((f: any) => f.id?.startsWith("drill:")) : q.where?.some((f: any) => f.values?.includes("US")))).toBe(true);
});

test("heatmap states independent color scales, keeps semantic units and exports missing-value context", async ({ page }, testInfo) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", "ending_mrr", "nrr", "grr"],
    rows: [["2026-06-01", 100000, .98, 1], ["2026-07-01", 110000, null, 1], ["2026-08-01", 120000, .94, 1]], ms: 1,
  } }));
  await open(page, [chart({ chart: "heatmap", metrics: ["ending_mrr", "nrr", "grr"], dimensions: ["month:fct_saas_monthly.month"], layout: { x: 24, y: 24, w: 850, h: 480 } })]);
  const tile = page.locator(".node .tile"), cells = tile.locator('g[aria-label="cell"] rect');
  await expect(cells).toHaveCount(9);
  await expect(tile.locator("figcaption")).toContainText("not amounts between rows");
  await expect(tile.locator("figcaption")).toContainText("Constant rows use the middle color");
  await expect(tile.locator("figcaption")).toContainText("not zero");
  const titles = await cells.locator("title").allTextContents();
  expect(titles.some(t => t.includes("$100k"))).toBe(true);
  expect(titles.some(t => t.includes("98.0%"))).toBe(true);
  expect(titles.some(t => t.includes("No data"))).toBe(true);
  const missing = cells.filter({ hasText: "No data" });
  expect(await missing.evaluate(el => getComputedStyle(el).strokeDasharray)).toBe("2px, 2px");
  await expect(tile.locator("figure")).toContainText("Within each metric");
  await expect(tile.locator('g[aria-description="Heatmap cell values"]')).toContainText("$100k");
  await expect(tile.locator('g[aria-description="Heatmap cell values"]')).toContainText("98.0%");
  await tile.screenshot({ path: testInfo.outputPath("heatmap-color-context.png") });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator("figcaption")).toContainText("not amounts between rows");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /Export .* as PNG/ }).click();
  await (await download).saveAs(testInfo.outputPath("heatmap-color-review.png"));
});

test("single-metric heatmaps show actual units, preserve missing categories and filter by source values", async ({ page }) => {
  const queries: any[] = [];
  await page.route("**/api/query", route => { queries.push(route.request().postDataJSON()); return route.fulfill({ json: {
    columns: ["country", "new_mrr"], rows: [["US", 100], ["DE", 0], [null, 50]], ms: 1,
  } }); });
  await open(page, [chart({ chart: "heatmap", dimensions: ["dim_users.country"] })]);
  const tile = page.locator(".node .tile"), cells = tile.locator('g[aria-label="cell"] rect');
  await expect(cells).toHaveCount(3);
  await expect(tile.locator("figcaption")).toContainText("one shared scale");
  await expect(tile.locator("figure")).toContainText("$");
  await expect(tile.locator('g[aria-label="x-axis tick label"]')).toContainText("Missing category");
  await expect(cells.filter({ hasText: "DE" }).locator("title")).toContainText("$0.00");
  await cells.filter({ hasText: /^US\n/ }).click();
  await expect.poll(() => queries.some(q => q.where?.some((f: any) => f.values?.includes("US")))).toBe(true);
});

test("duplicate heatmap cells block review instead of hiding one returned value", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_mrr"], rows: [["US", 100], ["US", 900]], ms: 1 } }));
  await open(page, [chart({ chart: "heatmap", dimensions: ["dim_users.country"] })]);
  await expect(page.locator(".chart-err")).toContainText("same heatmap cell");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review and share" }).getByRole("button", { name: /Export .* as PNG/ })).toBeDisabled();
});

for (const reversed of [false, true]) test(`scatter axes keep each metric's units (reversed: ${reversed})`, async ({ page }, testInfo) => {
  const metrics = reversed ? ["nrr", "ending_mrr"] : ["ending_mrr", "nrr"];
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", ...metrics], rows: [["2026-06-01", ...metrics.map(m => m === "nrr" ? ".98" : "100000")], ["2026-07-01", ...metrics.map(m => m === "nrr" ? ".94" : "120000")]], ms: 1,
  } }));
  await open(page, [chart({ chart: "scatter", metrics, dimensions: ["month:fct_saas_monthly.month"] })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator('g[aria-label="dot"] circle')).toHaveCount(2);
  const x = await tile.locator('g[aria-label="x-axis tick label"]').textContent(), y = await tile.locator('g[aria-label="y-axis tick label"]').textContent();
  expect(x).toContain(reversed ? "%" : "$"); expect(x).not.toContain(reversed ? "$" : "%");
  expect(y).toContain(reversed ? "$" : "%"); expect(y).not.toContain(reversed ? "%" : "$");
  const axisTitle = await tile.locator('g[aria-label="y-axis label"]').boundingBox();
  const tickLabels = await tile.locator('g[aria-label="y-axis tick label"]').boundingBox();
  expect(axisTitle!.x + axisTitle!.width).toBeLessThan(tickLabels!.x - 3);
  const titles = await tile.locator('g[aria-label="dot"] title').allTextContents();
  expect(titles[0]).toContain("$100k"); expect(titles[0]).toContain("98.0%");
  if (!reversed) await tile.screenshot({ path: testInfo.outputPath("scatter-metric-units.png") });
});

test("tables preserve metric and comparison units in the infographic", async ({ page }, testInfo) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", "nrr", "nrr__prev", "nrr__delta", "nrr__pct"],
    rows: [["2026-08-01", .94, .98, -.04, -.04 / .98]], ms: 1,
  } }));
  await open(page, [chart({ chart: "table", metrics: ["nrr"], dimensions: ["month:fct_saas_monthly.month"], compare: "prior" })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator("tbody")).toContainText("94.0%");
  await expect(tile.locator("tbody")).toContainText("−4 pp");
  await expect(tile.locator("tbody")).toContainText("−4.1%");
  await expect(tile.getByRole("columnheader", { name: /Change \(pp\)/ })).toBeVisible();
  await expect(tile.locator(".data-table-count")).toContainText("All returned rows shown");
  await expect(tile.locator(".data-table-count")).not.toContainText("Scroll");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator(".report-document tbody")).toContainText("−4 pp");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(testInfo.outputPath("table-comparison-units.png"));
});

test("snake_case rate hints stay percentages across cards, charts, tables and the infographic", async ({ page }, testInfo) => {
  await page.route("**/api/model", async route => {
    const model = await (await route.fetch()).json();
    // A synthetic, unannotated rate whose curated synonym supplies the unit hint.
    delete model.metrics.new_mrr.unit;
    model.metrics.new_mrr.label = "Attachment";
    model.metrics.new_mrr.synonyms = ["attach_rate"];
    await route.fulfill({ json: model });
  });
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_date_month", "new_mrr", "new_mrr__prev", "new_mrr__delta", "new_mrr__pct"],
    rows: [["2026-06-01", .4, .39, .01, .01 / .39], ["2026-07-01", .42, .4, .02, .05]], ms: 1,
  } }));
  await open(page, [
    chart({ id: "headline", title: "Attachment headline", chart: "kpi", compare: "prior", layout: { x: 24, y: 24, w: 300, h: 210 } }),
    chart({ id: "trend", title: "Attachment trend", chart: "line", layout: { x: 344, y: 24, w: 600, h: 330 } }),
    chart({ id: "detail", title: "Attachment detail", chart: "table", compare: "prior", layout: { x: 24, y: 380, w: 920, h: 300 } }),
  ]);
  const headline = page.getByRole("group", { name: "Attachment headline", exact: true });
  await expect(headline.locator(".kpi-value")).toHaveText("42.0%");
  await expect(headline.locator(".kpi-delta")).toContainText("+2.0 pp");
  const trend = page.getByRole("group", { name: "Attachment trend", exact: true });
  await expect(trend.locator('g[aria-label="y-axis tick label"]')).toContainText("%");
  await expect(trend.locator('g[aria-label="y-axis tick label"]')).not.toContainText("$");
  const detail = page.getByRole("group", { name: "Attachment detail", exact: true });
  await expect(detail.locator("tbody")).toContainText("42.0%");
  await expect(detail.getByRole("cell", { name: "2 pp", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator(".report-document .kpi-value")).toHaveText("42.0%");
  await expect(dialog.locator(".report-document").getByRole("cell", { name: "2 pp", exact: true })).toHaveCount(1);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(testInfo.outputPath("inferred-rate-units.png"));
});

test("table numeric-string sorting, overflow hints and CSV retain the actual returned values", async ({ page }) => {
  let large = false;
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["country", "new_mrr"], rows: large ? Array.from({ length: 60 }, (_, i) => [String(i).padStart(3, "0"), String(i)]) : [["US", "9"], ["GB", "100"], ["DE", "20"], ["CA", null]], ms: 1,
  } }));
  await open(page, [chart({ chart: "table", dimensions: ["dim_users.country"] })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator("tbody tr").first()).toHaveText("GB$100.00");
  await expect(tile.locator("tbody tr").last()).toHaveText("CA—");
  await expect(tile.locator(".data-table-count")).toContainText("All returned rows shown");
  await tile.getByRole("button", { name: "More chart actions" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await tile.getByRole("button", { name: "Download raw CSV" }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("country,new_mrr\r\nUS,9\r\nGB,100\r\nDE,20\r\nCA,\r\n");
  large = true;
  await open(page, [chart({ chart: "table", dimensions: ["dim_users.country"], layout: { x: 24, y: 24, w: 850, h: 300 } })]);
  await expect(tile.locator(".data-table-count")).toContainText("Scroll to see remaining");
  await expect(tile.locator("tbody tr").first()).toHaveText("059$59.00");
});

test("funnel labels remain readable for narrow and zero stages, including repeated names", async ({ page }, testInfo) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_type", "new_mrr"], rows: [["Initial accounts", 1000000], ["Follow-up", 100], ["Follow-up", 1], ["Complete", 0]], ms: 1,
  } }));
  await open(page, [chart({ chart: "funnel", dimensions: ["movement_type"] })]);
  const tile = page.locator(".node .tile"), bars = tile.locator('g[aria-label="bar"] rect');
  await expect(bars).toHaveCount(4);
  expect(new Set(await bars.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y))).size).toBe(4);
  await expect(tile.locator("figcaption")).toContainText("first stage");
  await expect(tile.locator("figcaption")).toContainText("do not establish a cohort conversion rate");
  const groups = tile.locator('g[aria-label="text"]');
  const stages = groups.nth(0).locator("text"), values = groups.nth(1).locator("text");
  await expect(stages).toHaveText(["Initial accounts", "Follow-up", "Follow-up", "Complete"]);
  await expect(values).toHaveText(["$1M · 100%", "$100.00 · <0.1%", "$1.00 · <0.1%", "$0.00 · 0%"]);
  const tileBounds = (await tile.boundingBox())!;
  for (let i = 0; i < 4; i++) {
    const label = (await stages.nth(i).boundingBox())!, bar = (await bars.nth(i).boundingBox())!, value = (await values.nth(i).boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(tileBounds.x);
    expect(label.x + label.width).toBeLessThan(bar.x);
    expect(value.x).toBeGreaterThan(bar.x + bar.width);
    expect(value.x + value.width).toBeLessThanOrEqual(tileBounds.x + tileBounds.width);
  }
  await tile.screenshot({ path: testInfo.outputPath("funnel-readable-stages.png") });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator("figcaption")).toContainText("first stage");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(testInfo.outputPath("funnel-readable-review.png"));
});

test("funnel dates use reporting labels and a zero first stage does not invent a percentage", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_date_month", "new_mrr"], rows: [["2026-06-01", 0], ["2026-07-01", 10]], ms: 1,
  } }));
  await open(page, [chart({ chart: "funnel" })]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator('g[aria-label="text"]').first().locator("text")).toHaveText(["Jun 26", "Jul 26"]);
  await expect(tile.locator("figcaption")).toContainText("first stage is zero");
  await expect(tile.locator('g[aria-label="text"]').nth(1)).toContainText("$10.00 · —");
  await expect(tile).not.toContainText("GMT");
  await expect(tile).not.toContainText("Infinity");
});

test("scalar funnel stages use semantic metric labels", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["new_mrr", "expansion_mrr"], rows: [[100, 30]], ms: 1,
  } }));
  await open(page, [chart({ chart: "funnel", metrics: ["new_mrr", "expansion_mrr"], dimensions: [] })]);
  const labels = page.locator('.node g[aria-label="text"]').first();
  await expect(labels).toContainText("New MRR (USD)");
  await expect(labels).toContainText("Expansion MRR (USD)");
});

test("an overcrowded funnel explains the remedy and cannot export unreadable stages", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_type", "new_mrr"], rows: Array.from({ length: 40 }, (_, i) => [`Stage ${i + 1}`, 100 - i]), ms: 1,
  } }));
  await open(page, [chart({ chart: "funnel", dimensions: ["movement_type"] })]);
  await expect(page.locator(".node .chart-err")).toContainText("Enlarge the funnel or use a table");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review and share" });
  await dialog.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(dialog.locator(".chart-err")).toContainText("too many stages");
  await expect(dialog.getByRole("button", { name: "Export infographic as PNG" })).toBeDisabled();
});
