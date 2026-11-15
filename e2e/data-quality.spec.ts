import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function openSample(page: Page, chart = "line", dimensions = ["month:movement_date", "dim_users.country"], metrics = ["new_mrr"]) {
  const title = `Revenue coverage review · ${crypto.randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: {
    id: crypto.randomUUID(), revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 700 },
    spec: { title, tiles: [{ id: "segment-revenue", title: "New revenue by country", chart,
      metrics, dimensions,
      layout: { x: 24, y: 24, w: 900, h: 420 } }] },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
}

test("cumulative metric evidence explains calendar windows and incomplete input coverage", async ({ page }, info) => {
  await openSample(page, "line", ["month:movement_date"], ["trailing_3_period_net_new_mrr", "cumulative_net_new_mrr"]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator("svg")).not.toHaveCount(0);
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  const trailing = evidence.locator(".metric-contract").filter({ hasText: "trailing_3_period_net_new_mrr" });
  await expect(trailing).toContainText("3 reporting periods, including the current period");
  await expect(trailing).toContainText("missing periods do not pull in older values");
  await expect(trailing).toContainText("Date and dimension filters restrict the input");
  await expect(trailing).toContainText("does not certify complete period coverage");
  await trailing.getByText("Inspect input definitions (1)", { exact: true }).click();
  const input = trailing.locator(".metric-inputs li");
  await expect(input).toContainText("Accumulated input");
  await expect(input).toContainText("SUM(fct_mrr_movements.mrr_delta_usd)");
  await expect(input).toContainText("Default table time field: fct_mrr_movements.movement_date");
  const running = evidence.locator(".metric-contract").filter({ hasText: "cumulative_net_new_mrr" });
  await expect(running).toContainText("Since the start of the query input");
  await expect(running).toContainText("add the opening MRR balance");
  await trailing.scrollIntoViewIfNeeded();
  await evidence.screenshot({ path: info.outputPath("cumulative-period-evidence.png") });
});

test("ratio inputs expose their independent definitions and filters with keyboard and narrow-screen access", async ({ page }, info) => {
  await openSample(page, "stat", [], ["mrr_per_subscriber"]);
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("A zero denominator produces an unavailable value");
  const toggle = evidence.getByText("Inspect input definitions (2)", { exact: true });
  const inputs = evidence.locator(".metric-inputs li");
  await expect(inputs.first()).not.toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(inputs).toHaveCount(2);
  const numerator = inputs.filter({ has: page.getByRole("heading", { name: "MRR (USD)", exact: true }) });
  const denominator = inputs.filter({ has: page.getByRole("heading", { name: "Paying subscribers", exact: true }) });
  await expect(numerator).toContainText("Numerator");
  await expect(numerator).toContainText("SUM(fct_subscriptions.mrr_usd)");
  await expect(denominator).toContainText("Denominator");
  await expect(denominator).toContainText("COUNT(DISTINCT fct_subscriptions.user_id)");
  for (const input of [numerator, denominator]) {
    await expect(input).toContainText("Base table: fct_subscriptions");
    await expect(input).toContainText("Metric-level filter: fct_subscriptions.status = 'active'");
  }
  await toggle.scrollIntoViewIfNeeded();
  await evidence.locator(".metric-inputs").screenshot({ path: info.outputPath("ratio-input-evidence.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await denominator.scrollIntoViewIfNeeded();
  expect(await evidence.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await evidence.locator(".metric-evidence-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await evidence.screenshot({ path: info.outputPath("ratio-input-evidence-narrow.png") });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(inputs.first()).not.toBeVisible();
});

test("a derived metric exposes each referenced component rather than treating its expression as source SQL", async ({ page }) => {
  await openSample(page, "line", ["month:movement_date"], ["quick_ratio"]);
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("gross_new_mrr / NULLIF(churned_mrr + contraction_mrr, 0)");
  await evidence.getByText("Inspect input definitions (3)", { exact: true }).click();
  const inputs = evidence.locator(".metric-inputs li");
  await expect(inputs).toHaveCount(3);
  const additions = inputs.filter({ has: page.getByRole("heading", { name: "Gross new MRR (USD)", exact: true }) });
  await expect(additions).toContainText("IN ('new','expansion','reactivation')");
  await expect(additions).toContainText("Reactivation is included");
  await expect(inputs.filter({ has: page.getByRole("heading", { name: "Churned MRR (USD)", exact: true }) })).toContainText("THEN -fct_mrr_movements.mrr_delta_usd");
  await expect(inputs.filter({ has: page.getByRole("heading", { name: "Contraction MRR (USD)", exact: true }) })).toContainText("THEN -fct_mrr_movements.mrr_delta_usd");
});

test("a cross-table ratio shows each input's own base table and default reporting date", async ({ page }) => {
  await openSample(page, "line", ["month:fct_mrr_movements.movement_date"], ["new_customers_per_session"]);
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await evidence.getByText("Inspect input definitions (2)", { exact: true }).click();
  const inputs = evidence.locator(".metric-inputs li");
  const customers = inputs.filter({ has: page.getByRole("heading", { name: "New paying customers", exact: true }) });
  const sessions = inputs.filter({ has: page.getByRole("heading", { name: "Web sessions", exact: true }) });
  await expect(customers).toContainText("Base table: fct_mrr_movements");
  await expect(customers).toContainText("Default table time field: fct_mrr_movements.movement_date");
  await expect(sessions).toContainText("Base table: fct_web_sessions");
  await expect(sessions).toContainText("Default table time field: fct_web_sessions.session_date");
});

test("segment-specific findings explain their impact and survive presentation, copy and export", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let repaired = false;
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_date_month", "country", "new_mrr"], ms: 1,
    rows: [["2026-01-01", "US", 100], ["2026-03-01", "US", 140],
      ["2026-01-01", "DE", 20], ["2026-02-01", "DE", 30], ["2026-03-01", "DE", 40],
      ...(repaired ? [["2026-02-01", "US", 120]] : [])],
  } }));
  await openSample(page);
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText('dim_users.country="US"');
  await expect(evidence).not.toContainText('dim_users.country="DE"');
  await expect(evidence).toContainText("Why it matters:");
  await expect(evidence).toContainText("Other segments' rows do not establish its missing values.");
  await expect(evidence).toContainText("do not fill gaps with zero");
  await evidence.screenshot({ path: info.outputPath("segment-quality-evidence.png") });
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    const presentation = review.getByRole("article", { name: `${mode} presentation` });
    await expect(presentation).toContainText('dim_users.country="US"');
    await expect(presentation).toContainText("Why it matters:");
    await expect(presentation).toContainText("Other segments' rows do not establish its missing values.");
  }
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('dim_users.country="US"');
  expect(copied).toContain("Why it matters:");
  expect(copied).toContain("What to check:");
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath("segment-quality-infographic.png"));
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  repaired = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(tile.getByRole("button", { name: /data check.*to review/ })).toHaveCount(0);
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Metric definition and scope" })).toContainText("No issues found by the returned-row checks.");
  await expect(page.getByRole("dialog", { name: "Metric definition and scope" }).locator(".metric-inputs")).toHaveCount(0);
});

test("unassigned categories stay visible and their quality guidance follows shared formats until corrected", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let repaired = false;
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["country", "new_mrr"], ms: 1,
    rows: [[repaired ? "DE" : null, 10], [repaired ? "GB" : "", 20], ["US", 100]],
  } }));
  await openSample(page, "table", ["dim_users.country"]);
  const tile = page.locator(".node .tile");
  await expect(tile.locator("tbody tr")).toHaveCount(3);
  await tile.getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("Unassigned breakdown values: dim_users.country");
  await expect(evidence).toContainText("2 of 3 returned rows");
  await expect(evidence).toContainText("1 missing (null or absent); 1 blank text");
  await expect(evidence).toContainText("not counts of customers or source records");
  await expect(evidence).toContainText("whether an unassigned group is intentional");
  await evidence.screenshot({ path: info.outputPath("unassigned-category-evidence.png") });
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Dashboard", "Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    const presentation = review.getByRole("article", { name: `${mode} presentation` });
    await expect(presentation).toContainText("Unassigned breakdown values: dim_users.country");
    await expect(presentation).toContainText("Excluding the rows may change totals, rankings or category shares.");
    await expect(presentation.locator("tbody tr")).toHaveCount(3);
  }
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("2 of 3 returned rows");
  expect(copied).toContain("do not silently drop, rename or merge these rows");
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG", exact: true }).click();
  await (await download).saveAs(info.outputPath("unassigned-category-infographic.png"));
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  repaired = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(tile.getByRole("button", { name: /data check.*to review/ })).toHaveCount(0);
  await expect(tile.locator("tbody tr")).toHaveCount(3);
  await expect(tile).toContainText("DE");
  await expect(tile).toContainText("GB");
});

test("a missing non-temporal breakdown column produces an explicit data check", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["new_mrr"], ms: 1, rows: [[100]],
  } }));
  await openSample(page, "table", ["dim_users.country"]);
  await page.locator(".node").getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("A requested breakdown is missing");
  await expect(evidence).toContainText("The result is missing dim_users.country.");
  await expect(evidence).toContainText("Rows cannot be assigned reliably to the requested categories.");
  await expect(evidence).not.toContainText("No issues found by the returned-row checks.");
});

test("a table identifies repeated dates within the same segment without treating other segments as duplicates", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["movement_date_month", "country", "new_mrr"], ms: 1,
    rows: [["2026-01-01", "US", 100], ["2026-01-01", "US", 110], ["2026-01-01", "DE", 20]],
  } }));
  await openSample(page, "table");
  await expect(page.locator(".node tbody tr")).toHaveCount(3);
  await page.locator(".node").getByRole("button", { name: "1 data check to review", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope" });
  await expect(evidence).toContainText("Repeated periods within a segment");
  await expect(evidence).toContainText("1 extra row repeats a reporting date");
  await expect(evidence).toContainText('dim_users.country="US"');
  await expect(evidence).not.toContainText('dim_users.country="DE"');
  await expect(evidence).toContainText("This alone does not prove duplicate source records.");
});
