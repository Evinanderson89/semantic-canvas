import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

async function open(page: Page, spec: DashboardSpec) {
  const id = crypto.randomUUID();
  const response = await page.request.post("/api/dashboards", { data: { id, revision: 0, canvas: { ...DEFAULT_CANVAS, width: 1100, height: 900 }, spec } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
  return id;
}

test("presentation keeps evidence beside each chart and groups identical full notes below the section", async ({ page }, info) => {
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON();
    return route.fulfill({ json: { columns: ["month_month", ...q.metrics], rows: Array.from({ length: 24 }, (_, i) =>
      [new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10), ...q.metrics.map((m: string) => m === "nrr" ? i === 0 ? null : 1.02 : 300)]), ms: 1 } });
  });
  await open(page, { title: `Executive evidence ${crypto.randomUUID()}`, tiles: [
    { id: "heading", kind: "heading", text: "Growth and retention", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 1000, h: 64 } },
    ...["retention", "retention-copy", "acquisition"].map((id, i) => ({ id, title: id === "retention" ? "Retention headline" : id === "retention-copy" ? "Retention comparison" : "Acquisition cost", metrics: [i < 2 ? "nrr" : "cac"], dimensions: ["month:fct_saas_monthly.month"], chart: "kpi" as const, section: "heading", layout: { x: 24 + i * 350, y: 100, w: 330, h: 210 } })),
  ] });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` })).toBeEnabled();
    for (const id of ["retention", "retention-copy"]) {
      const chart = review.locator(`[data-report-tile="${id}"]`);
      await expect(chart.getByRole("link", { name: "Data note 1: Missing values: Net revenue retention" })).toBeVisible();
      await expect(chart).toContainText("1 of 24 returned rows");
      await expect(chart).not.toContainText("What to check");
    }
    const notes = review.getByRole("complementary", { name: "Data notes for Growth and retention" });
    await expect(notes.locator(".quality-finding")).toHaveCount(1);
    await expect(notes).toContainText("Retention headline · Retention comparison");
    await expect(notes).toContainText("Why it matters:");
    await expect(notes).toContainText("What to check:");
    const reference = review.locator('[data-report-tile="retention"]').getByRole("link", { name: "Data note 1: Missing values: Net revenue retention" });
    await reference.click();
    await expect(notes.getByRole("region", { name: "Data note 1: Missing values: Net revenue retention" })).toBeFocused();
    const widths = await review.locator(".report-grid,.report-section-notes").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
    expect(widths[1]).toBeCloseTo(widths[0], 0);
  }
  await review.getByRole("button", { name: "Expand presentation", exact: true }).click();
  await review.getByRole("article", { name: "Infographic presentation" }).screenshot({ path: info.outputPath("executive-data-notes.png") });
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(info.outputPath("executive-data-notes-export.png"));
});

test("monthly bars remain complete and readable in paired and unpaired infographic rows", async ({ page }) => {
  const kinds = ["line", "bar", "barGrouped", "barStacked", "combo"] as const;
  const tiles = kinds.map((chart, i) => ({ id: `monthly-${i}`, title: `Monthly ${chart}`, chart,
    metrics: chart === "bar" || chart === "line" ? ["ending_mrr"] : ["ending_mrr", "starting_mrr"],
    dimensions: ["month:fct_saas_monthly.month"], layout: { x: 24, y: 24 + i * 400, w: 700, h: 380 } }));
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON();
    return route.fulfill({ json: { columns: ["month_month", ...q.metrics], rows: Array.from({ length: 24 }, (_, i) =>
      [new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10), ...q.metrics.map((_: string, j: number) => 1000 + i * 100 - j * 50)]), ms: 1 } });
  });
  // A note separates the final support chart: it must fill its own row.
  await open(page, { title: `Monthly label review ${crypto.randomUUID()}`, tiles: [
    ...tiles.slice(0, 4), { id: "note", kind: "text", text: "Acquisition context", metrics: [], dimensions: [], layout: { x: 24, y: 1570, w: 700, h: 40 } }, tiles[4],
  ] });
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
  for (const i of [1, 2, 3, 4]) {
    const tile = review.locator(`[data-report-tile="monthly-${i}"]`);
    await expect(tile.locator('g[aria-label="bar"] rect')).toHaveCount(i === 2 || i === 3 ? 48 : 24);
    await expect(async () => {
      const groups = await tile.locator('g[aria-label="x-axis tick label"], g[aria-label="fx-axis tick label"]').evaluateAll(nodes => nodes.map(n =>
        [...n.querySelectorAll("text")].map(t => ({ text: t.textContent, left: t.getBoundingClientRect().left, right: t.getBoundingClientRect().right }))));
      const dates = groups.find(g => g.some(t => t.text?.includes("Sep 24")));
      expect(dates).toBeDefined();
      expect(dates!.length).toBeLessThan(24);
      expect(dates!.at(-1)!.text).toBe("Aug 26");
      expect(dates!.every((d, j) => !j || d.left - dates![j - 1].right >= 4), JSON.stringify(dates)).toBe(true);
    }).toPass();
  }
  const widths = await review.locator('.report-grid > [data-report-tile]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.getAttribute("data-report-tile"), n.getBoundingClientRect().width])));
  expect(widths["monthly-1"]).toBeLessThan(widths["monthly-0"] * .6);
  expect(widths["monthly-3"]).toBeCloseTo(widths["monthly-0"], 0);
  expect(widths["monthly-4"]).toBeCloseTo(widths["monthly-0"], 0);
});

test("messy dashboard becomes a checked redesign, a story and an exportable infographic without changing its numbers", async ({ page }, info) => {
  const reviewTitle = `SaaS operating review · ${crypto.randomUUID().slice(0, 6)}`;
  const queries = new Map<string, string>();
  page.on("request", r => { if (r.url().endsWith("/api/query") && r.method() === "POST") { const q = r.postDataJSON(); queries.set(q.id, JSON.stringify(q)); } });
  // Only the provider response is simulated; queries, previews, edits, persistence and PNG rendering are real.
  await page.route("**/api/agent/**", route => {
    if (route.request().url().endsWith("/status")) return route.fulfill({ json: { configured: true } });
    if (!route.request().url().endsWith("/chat")) return route.fulfill({ status: 503, json: { error: "No provider call is permitted in this test." } });
    const input = route.request().postDataJSON();
    const find = (metric: string) => input.document.spec.tiles.find((t: any) => t.metrics.includes(metric)).id;
    return route.fulfill({ json: { proposal: { title: "A clearer operating review", reason: "Keep the headline metrics, replace the isolated new-business category with a trend, and make traffic less noisy.", actions: [
      { type: "rename", title: reviewTitle },
      { type: "query", id: find("web_sessions"), dimensions: ["week:fct_web_sessions.session_date"] },
      { type: "query", id: find("new_mrr"), dimensions: ["month:fct_mrr_movements.movement_date"] },
      { type: "chart", id: find("new_mrr"), chart: "line" },
      { type: "arrange", layout: "executive" },
    ] } } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /Try the design playground/ }).click();
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await expect(page.locator(".node")).toHaveCount(6);
  const overlaps = () => page.locator(".node").evaluateAll(nodes => {
    const boxes = nodes.map(n => n.getBoundingClientRect());
    return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
  });
  expect(await overlaps()).toBe(true);
  await page.getByRole("button", { name: "Improve with AI", exact: true }).click();
  const redesign = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await redesign.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  await expect(redesign.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  await expect(redesign).toContainText("Breakdown / reporting grain");
  await redesign.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await redesign.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(overlaps).toBe(false);
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await expect(page.locator(".heading-text")).toHaveCount(4);
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saved; expect(response.ok()).toBe(true);
  const payload = response.request().postDataJSON(), id = payload.id;
  const original = await (await page.request.get(`/api/dashboards/${id}`)).json();
  const baseline = new Map(queries);
  const model = await (await page.request.get("/api/model")).json();
  const kpis = await page.locator(".node .kpi-value").allTextContents();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByLabel("What decision should this help someone make?").fill("Is growth becoming more durable?");
  await review.getByLabel("What should happen next?").fill("Finance and Customer Success: inspect renewal cohorts before increasing acquisition spend.");
  await review.getByLabel("What should the reader take away?").fill("Review recurring revenue alongside retention before deciding where to invest next.");
  await expect(review.getByRole("button", { name: "Export dashboard as PNG" })).toBeEnabled();
  for (const mode of ["Story", "Infographic", "Dashboard", "Infographic"]) {
    queries.clear();
    await review.getByRole("group", { name: "Presentation format" }).getByRole("button", { name: mode, exact: true }).click();
    await expect(review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` })).toBeEnabled();
    await expect(review.locator(".report-document .kpi-value")).toHaveText(kpis);
    for (const [tileId, query] of baseline) expect(queries.get(tileId), `${mode}: ${tileId} query`).toBe(query);
    await expect(review.locator(".report-document")).toContainText("Review recurring revenue alongside retention");
    await expect(review.locator(".report-document")).toContainText(`Reporting date: ${model.calendar.today}`);
  }
  await expect(review.locator(".report-document .data-table-count")).toContainText("All returned rows shown");
  await expect(review.locator(".ai-redesign-brief")).toContainText("1 data observation to review");
  await expect(review.locator(".report-document .quality-finding")).toHaveCount(1);
  await expect(review.locator(".report-document .scope-note")).toHaveCount(2);
  await expect(review.locator(".report-document .scope-note").first()).toContainText("Reporting scope");
  await expect(review.locator(".report-document .data-table-scroll tbody tr")).toHaveCount(10);
  const picker = review.getByRole("group", { name: "Choose evidence for the infographic" });
  const chosen = original.spec.tiles.filter((t: any) => t.metrics.some((name: string) => ["ending_mrr", "nrr", "new_mrr"].includes(name)));
  expect(chosen).toHaveLength(3);
  for (const t of original.spec.tiles.filter((t: any) => (t.kind ?? "metric") === "metric" && !chosen.some((c: any) => c.id === t.id))) {
    await picker.getByRole("checkbox", { name: t.title, exact: true }).uncheck();
  }
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
  await expect(review.locator(".report-document .kpi-value")).toHaveCount(2);
  await expect(review.locator(".report-document")).toContainText("3 of 6 charts");
  await expect(review.locator(".report-omitted")).toContainText("Web sessions");
  await expect(review.locator(".report-next-step")).toContainText("Finance and Customer Success");
  for (const t of chosen) expect(queries.get(t.id)).toBe(baseline.get(t.id));
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  const retentionEvidence = review.locator(".report-evidence-drafts section").filter({ has: page.getByRole("heading", { name: "Net revenue retention", exact: true }) });
  await expect(retentionEvidence).toContainText("percentage points");
  await expect(retentionEvidence).toContainText("month bucket starting 2026-08-01");
  const observation = await retentionEvidence.locator(".brief-observation-statement").innerText();
  await retentionEvidence.getByRole("button", { name: "Add observation to takeaway" }).click();
  await expect(review.getByLabel("What should the reader take away?")).toHaveValue(new RegExp("metric nrr"));
  await expect(review.locator(".report-takeaway")).toContainText(observation);
  await expect(review.locator(".report-takeaway")).toContainText("Missing values: nrr");
  await expect(retentionEvidence.getByRole("button", { name: "Added", exact: true })).toBeDisabled();
  await review.getByRole("button", { name: "Expand presentation", exact: true }).click();
  const infographic = review.getByRole("article", { name: "Infographic presentation" });
  const headings = await infographic.locator(".headline-tile .kpi-value").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
  expect(Math.max(...headings) - Math.min(...headings)).toBeLessThan(2);
  // Expansion commits before ResizeObserver redraws the plots. Assert the
  // settled layout while still failing persistent clipping or collisions.
  await expect(async () => {
    const axes = await infographic.locator('svg [aria-label="x-axis tick label"]').evaluateAll(groups => groups.map(group => {
      const svg = group.closest("svg")!.getBoundingClientRect();
      const labels = [...group.querySelectorAll("text")].map(n => n.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      return { count: labels.length, inside: labels.every(r => r.left >= svg.left && r.right <= svg.right),
        spaced: labels.every((r, i) => !i || r.left - labels[i - 1].right >= 4),
        labels: [...group.querySelectorAll("text")].map(n => n.textContent),
        bounds: { left: svg.left, right: svg.right }, positions: labels.map(r => ({ left: r.left, right: r.right })) };
    }));
    expect(axes.length).toBeGreaterThan(0);
    expect(axes.every(axis => axis.count > 0 && axis.inside && axis.spaced), JSON.stringify(axes)).toBe(true);
  }).toPass({ timeout: 12_000 });
  await infographic.screenshot({ path: info.outputPath("infographic-preview.png") });
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  const png = await download;
  expect(png.suggestedFilename()).toMatch(/-infographic\.png$/);
  const exported = info.outputPath("infographic-export.png"); await png.saveAs(exported);
  const bytes = await readFile(exported);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(1000); expect(bytes.readUInt32BE(20)).toBeGreaterThan(1500);
  await expect(review.getByRole("status").filter({ hasText: "PNG downloaded" })).toBeVisible();
  await review.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(review.getByRole("status").filter({ hasText: "Dashboard and brief saved" })).toBeVisible();
  const persisted = (await (await page.request.get(`/api/dashboards/${id}`)).json()).spec;
  expect(persisted.tiles).toEqual(original.spec.tiles);
  expect(persisted.filters).toEqual(original.spec.filters);
  expect(persisted.tabs[0].brief.question).toBe("Is growth becoming more durable?");
  expect(persisted.tabs[0].brief.takeaway).toContain(observation);
  expect(new Set(persisted.tabs[0].brief.evidenceIds)).toEqual(new Set(chosen.map((t: any) => t.id)));
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.reload(); await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(original.spec.title) }).first().click();
  await expect(page.locator(".node .kpi-value")).toHaveText(kpis);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await expect(review.getByLabel("What decision should this help someone make?")).toHaveValue("Is growth becoming more durable?");
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.locator(".report-document")).toContainText("3 of 6 charts");
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
});

test("presentation keeps filter exceptions, drilled scope and missing-data evidence visible on a narrow screen", async ({ page }, info) => {
  const requests: any[] = [];
  const spec: DashboardSpec = { title: `Presentation scope ${crypto.randomUUID()}`, tiles: [
    { id: "growth", title: "New business", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "bar", layout: { x: 24, y: 24, w: 700, h: 380 } },
    { id: "retention", title: "Retention", metrics: ["nrr"], dimensions: ["month:month"], chart: "kpi", layout: { x: 750, y: 24, w: 300, h: 200 } },
  ], filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", defaultValue: { values: ["US"] }, bindings: [{ tileId: "growth", field: "dim_users.country" }] }] };
  // Synthetic gaps make the data-quality message deterministic; query/renderer wiring remains live.
  await page.route("**/api/query", async route => {
    const q = route.request().postDataJSON(); requests.push(q);
    if (q.id !== "growth") return route.continue();
    const drilled = q.dimensions[0].startsWith("day:");
    return route.fulfill({ json: { columns: [drilled ? "movement_date_day" : "movement_date_month", "new_mrr"], rows: drilled ? [["2026-06-01", 100], ["2026-06-03", null]] : [["2026-06-01", 100], ["2026-07-01", 130]], ms: 1 } });
  });
  await open(page, spec);
  await page.locator('.node g[aria-label="bar"] rect').first().click();
  await expect.poll(() => requests.some(q => q.dimensions[0].startsWith("day:"))).toBe(true);
  const drilled = requests.filter(q => q.id === "growth").at(-1);
  expect(drilled.where.some((f: any) => f.values?.includes("US"))).toBe(true);
  expect(drilled.where.some((f: any) => f.id === "drill:growth" && f.maxExclusive)).toBe(true);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  for (const mode of ["Story", "Infographic"]) {
    requests.length = 0;
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` })).toBeEnabled();
    expect(requests.find(q => q.id === "growth")).toEqual(drilled);
    await expect(review.locator('[data-report-tile="growth"]')).toContainText("Gaps in the returned time series");
    await expect(review.locator('[data-report-tile="growth"]')).toContainText("Missing values: New MRR (USD)");
    await expect(review.locator('[data-report-tile="growth"]')).toContainText("includes US");
    await expect(review.locator('[data-report-tile="retention"] .report-chart-context')).toContainText("Not filtered by Country");
  }
  await review.getByText("Build your brief from the evidence", { exact: true }).click();
  const drafts = review.locator(".report-evidence-drafts");
  const missing = drafts.locator("section").filter({ has: page.getByRole("heading", { name: "New business", exact: true }) });
  await expect(missing).toContainText("no numeric value for the day bucket starting 2026-06-03");
  await missing.getByRole("button", { name: "Add observation to takeaway" }).click();
  await expect(review.getByLabel("What should the reader take away?")).toHaveValue(/includes US/);
  await expect(review.getByLabel("What should the reader take away?")).toHaveValue(/Gaps in the returned time series/);
  const unfiltered = drafts.locator("section").filter({ has: page.getByRole("heading", { name: "Retention", exact: true }) });
  await unfiltered.getByRole("button", { name: "Add next question" }).click();
  await expect(review.getByLabel("What should happen next?")).toHaveValue(/Not filtered by Country/);
  await review.getByRole("button", { name: "Expand presentation", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(review).toBeVisible();
  expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const report = review.locator(".report-document");
  expect(await report.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("presentation-mobile.png") });
});

test("brief edits survive a failed save, remain tab-specific, and missing or empty evidence cannot be exported", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const spec: DashboardSpec = { title: `Brief recovery ${crypto.randomUUID()}`, tabs: [
    { id: "growth", title: "Growth", brief: { question: "Original question", takeaway: "", nextStep: "", evidenceIds: ["removed-chart"] } },
    { id: "retention", title: "Retention" },
  ], tiles: [
    { id: "growth-chart", tabId: "growth", title: "Growth evidence", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 700, h: 350 } },
    { id: "retention-chart", tabId: "retention", title: "Retention evidence", metrics: ["nrr"], dimensions: ["month:month"], chart: "kpi", layout: { x: 24, y: 24, w: 350, h: 220 } },
  ] };
  const id = await open(page, spec);
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("no longer available");
  const exportButton = review.getByRole("button", { name: "Export infographic as PNG" });
  await expect(exportButton).toBeDisabled();
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  const missingContext = await page.evaluate(() => navigator.clipboard.readText());
  expect(missingContext).toContain("Unavailable evidence selections: removed-chart");
  expect(missingContext).toContain("Incomplete presentation. PNG export is unavailable");
  await review.getByRole("button", { name: "Include all charts" }).click();
  await expect(exportButton).toBeEnabled();
  await review.getByRole("checkbox", { name: "Growth evidence" }).uncheck();
  await expect(exportButton).toBeDisabled();
  await expect(review).toContainText("Select at least one chart to export");
  await review.getByRole("button", { name: "Copy review context", exact: true }).click();
  const emptyContext = await page.evaluate(() => navigator.clipboard.readText());
  expect(emptyContext).toContain("Selected evidence: 0 of 1 charts");
  expect(emptyContext).toContain("Incomplete presentation. PNG export is unavailable");
  expect(emptyContext).not.toContain("Unavailable evidence selections");
  await review.getByRole("checkbox", { name: "Growth evidence" }).check();
  await review.getByLabel("What decision should this help someone make?").fill("Should we increase acquisition spend?");
  let rejectSave = true;
  await page.route("**/api/dashboards", route => route.request().method() === "POST" && rejectSave
    ? route.fulfill({ status: 503, json: { error: "Synthetic save outage" } }) : route.continue());
  await review.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(review.getByRole("status").filter({ hasText: "Could not save" })).toBeVisible();
  await expect(review.getByLabel("What decision should this help someone make?")).toHaveValue("Should we increase acquisition spend?");
  await expect(review.getByRole("button", { name: "Infographic", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).spec.tabs[0].brief.question).toBe("Original question");
  rejectSave = false;
  await review.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(review.getByRole("status").filter({ hasText: "Dashboard and brief saved" })).toBeVisible();
  await review.getByLabel("What should happen next?").fill("Ask Finance to review the acquisition assumptions.");
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.getByRole("tab", { name: /^Retention/ }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await expect(review.getByLabel("What decision should this help someone make?")).toHaveValue("");
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.getByRole("tab", { name: /^Growth/ }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await expect(review.getByLabel("What should happen next?")).toHaveValue("Ask Finance to review the acquisition assumptions.");
  await expect(review).toContainText("Save to keep the dashboard and brief");
});

test("saved brief review survives unchanged queries but flags changed results, scope and authored interpretation", async ({ page }, info) => {
  let currentValue = 1.01, timing = 2;
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", "nrr", "nrr__prev"],
    rows: [["2026-07-01", 1.02, 1.03], ["2026-08-01", currentValue, 1.02]],
    ms: timing++, sql: "SELECT monthly_nrr", principal: "admin", rlsApplied: [],
  } }));
  const spec: DashboardSpec = { title: `Retention operating review · ${crypto.randomUUID().slice(0, 6)}`, tiles: [
    { id: "retention", title: "Retention evidence", metrics: ["nrr"], dimensions: ["month:month"], chart: "kpi", layout: { x: 24, y: 24, w: 350, h: 220 } },
  ] };
  const id = await open(page, spec);
  const review = page.getByRole("dialog", { name: "Review and share" });
  const marker = review.getByRole("region", { name: "Brief evidence review" });
  const reopen = async () => {
    await page.reload();
    await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
    await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
    await page.getByRole("button", { name: "Review and share", exact: true }).click();
  };
  const save = async () => {
    await review.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await expect(review.getByRole("status").filter({ hasText: "Dashboard and brief saved" })).toBeVisible();
  };
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByLabel("What should the reader take away?").fill("Monthly retention was 101% in August. Inspect renewal cohorts.");
  await expect(marker).toContainText("has not been marked reviewed");
  await expect(marker.getByRole("button", { name: "Mark brief reviewed" })).toBeEnabled();
  await marker.getByRole("button", { name: "Mark brief reviewed" }).click();
  await expect(marker).toContainText("Evidence and brief match your review");
  await save();
  const persisted = (await (await page.request.get(`/api/dashboards/${id}`)).json()).spec.tabs[0].brief;
  expect(persisted.review.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(persisted.review).sort()).toEqual(["fingerprint", "reviewedAt", "version"]);
  await reopen();
  await expect(marker).toContainText("Evidence and brief match your review");
  for (const mode of ["Story", "Infographic"]) {
    await review.getByRole("button", { name: mode, exact: true }).click();
    await expect(marker).toContainText("Evidence and brief match your review");
  }
  // New query values must not silently update or endorse the saved prose.
  currentValue = .97;
  await reopen();
  await expect(marker).toContainText("Review needed");
  await expect(review.getByLabel("What should the reader take away?")).toHaveValue(/101%/);
  await expect(review.locator(".report-document .kpi-value")).toContainText("97");
  await expect(review.locator(".report-review-note")).toContainText("Review needed");
  await review.getByLabel("What should the reader take away?").fill("Monthly retention fell to 97%; inspect renewal cohorts.");
  await marker.getByRole("button", { name: "Mark brief reviewed" }).click();
  await expect(marker).toContainText("Evidence and brief match your review");
  await save();
  await review.getByLabel("What should happen next?").fill("Ask Finance to investigate.");
  await expect(marker).toContainText("Review needed");
  await marker.getByRole("button", { name: "Mark brief reviewed" }).click();
  await save();
  // Scope changes matter even when the returned values happen to match.
  const document = await (await page.request.get(`/api/dashboards/${id}`)).json();
  document.spec.tiles[0].where = [{ id: "period", source: "dimension", field: "fct_saas_monthly.month", mode: "range", min: "2026-07-01", max: "2026-09-01", maxExclusive: true }];
  const changed = await page.request.post("/api/dashboards", { data: { id, revision: document.revision, canvas: document.canvas, spec: document.spec } });
  expect(changed.ok(), await changed.text()).toBe(true);
  await reopen();
  await expect(marker).toContainText("Review needed");
  await marker.getByRole("button", { name: "Mark brief reviewed" }).click();
  await save();
  await page.route("**/api/model", async route => {
    const response = await route.fetch(), body = await response.json();
    body.metrics.nrr.expression += " + 0";
    await route.fulfill({ json: body });
  });
  await reopen();
  await expect(marker).toContainText("Review needed");
  await review.getByRole("button", { name: "Infographic", exact: true }).click();
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Export infographic as PNG" }).click();
  await (await download).saveAs(info.outputPath("brief-needs-review.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(review.getByRole("button", { name: "Export infographic as PNG" })).toBeEnabled();
  await marker.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("brief-review-mobile.png") });
});
