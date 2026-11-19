import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
});

test("a first Ending MRR chart supplies its required month and becomes a usable KPI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Add a chart", exact: true }).click();
  const picker = page.locator(".picker");
  await picker.getByRole("button", { name: /Ending MRR/ }).click();
  await picker.getByRole("button", { name: /Choose visualization/ }).click();
  await expect(picker).toContainText("reporting period required");
  await picker.getByRole("button", { name: /KPI card/ }).click();
  await picker.getByRole("button", { name: "Add tile", exact: true }).click();
  await expect(page.locator(".node .kpi")).toContainText("$202.8k");
  await expect(page.locator(".node .kpi")).toContainText("Aug 2026");
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await expect(review).toContainText("1 of 1 selected charts queried and rendered");
  await expect(review.getByRole("button", { name: "Copy review context" })).toBeEnabled();
  await review.getByRole("button", { name: "Show chart alerts" }).click();
  await expect(page.getByRole("button", { name: "Chart alerts", exact: true })).toBeVisible();
});

for (const chart of ["bar", "barStacked", "barGrouped"]) test(`AI preview preserves all movement measures in ${chart}`, async ({ page }) => {
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: {
    title: "Growth evidence", reason: "Show all monthly contributions.", actions: [
      { type: "add", tile: { id: "heading", kind: "heading", title: "Growth drivers", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 1000, h: 60 } } },
      { type: "add", tile: { id: "mrr", title: "Ending MRR", metrics: ["ending_mrr"], dimensions: [], chart: "stat", compare: "prior", layout: { x: 24, y: 100, w: 400, h: 180 } } },
      { type: "add", tile: { id: "movements", title: "Movement evidence", metrics: ["new_mrr", "expansion_mrr", "contraction_mrr", "churned_mrr"], dimensions: ["month:movement_date"], chart, layout: { x: 24, y: 320, w: 1100, h: 400 } } },
    ] } } }));
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Build with AI", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard" }).click();
  await expect(dialog.locator(".heading-text")).toHaveText("Growth drivers");
  await expect(dialog.locator(".kpi")).toContainText("$202.8k");
  for (const label of ["New MRR (USD)", "Expansion MRR (USD)", "Contraction MRR (USD)", "Churned MRR (USD)"]) await expect(dialog.locator("figure")).toContainText(label);
  await expect(dialog.locator(".chart-err")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Proposed dashboard", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await expect(dialog.locator("footer")).toContainText("Redesign applied");
});

test("a failed query cannot be applied as a finished redesign", async ({ page }) => {
  await page.route("**/api/query", route => route.fulfill({ status: 503, json: { error: "Sample warehouse unavailable" } }));
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: { title: "Revenue overview", reason: "Show monthly revenue", actions: [
    { type: "add", tile: { id: "mrr", title: "Ending MRR", metrics: ["ending_mrr"], dimensions: ["month:month"], chart: "kpi", layout: { x: 24, y: 24, w: 400, h: 180 } } },
  ] } } }));
  await page.goto("/"); await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Build with AI", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard" }).click();
  await expect(dialog.locator(".redesign-checks")).toContainText("Preview needs attention");
  await expect(dialog.locator(".redesign-checks")).toContainText("Sample warehouse unavailable");
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeDisabled();
  await expect(page.locator(".node")).toHaveCount(0);
  await page.unroute("**/api/query");
  await dialog.getByRole("button", { name: "Retry chart checks", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  await expect(dialog.locator(".kpi")).toContainText("$202.8k");
});
