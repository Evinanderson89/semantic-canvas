import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test("AI redesign previews real charts, applies once, and restores with undo", async ({ page }) => {
  let attempts = 0;
  let original: any;
  const description = "Recurring revenue headlines, monthly new-business trends, web sessions and country signups.";
  const reason = "A trend supports comparison across reporting periods. ".repeat(24) + "Full rationale retained.";
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => {
    const input = route.request().postDataJSON();
    expect(input.mode).toBe("redesign");
    if (++attempts === 1) return route.fulfill({ status: 500, json: { error: "The provider is temporarily unavailable." } });
    original = input.document.spec;
    const target = input.document.spec.tiles.find((t: any) => t.metrics.includes("new_mrr"));
    return route.fulfill({ json: { text: "Lead with recurring revenue, then inspect the monthly trend.", proposal: {
      title: "A clearer revenue story", reason,
      actions: [{ type: "describe", description }, { type: "query", id: target.id, dimensions: ["month:movement_date"] }, { type: "chart", id: target.id, chart: "line" }, { type: "arrange", layout: "executive" }],
    } } });
  });
  await page.goto("/"); await openStarter(page, "Dashboard cleanup demo");
  const geometry = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style")));
  const initial = await geometry();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: /Powered by AI Reimagine with AI/ }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry redesign", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "A clearer revenue story", exact: true })).toBeVisible();
  const proposed = dialog.locator(".ai-redesign-tile").filter({ has: page.getByRole("heading", { name: "New MRR (USD)", exact: true }) });
  await expect(proposed.locator("figure svg")).toBeVisible();
  const headlineOrder = await dialog.locator(".ai-redesign-tile").evaluateAll(nodes => nodes
    .filter(node => node.querySelector(".kpi"))
    .map(node => ({ label: node.querySelector(".kpi-label")?.textContent, top: node.getBoundingClientRect().top, left: node.getBoundingClientRect().left }))
    .sort((a, b) => a.top - b.top || a.left - b.left).map(node => node.label));
  expect(headlineOrder).toEqual(["Ending MRR (USD)", "Net revenue retention", "CAC (USD)"]);
  expect(await geometry()).toEqual(initial);
  const impact = dialog.getByRole("region", { name: "Verified proposal changes" });
  await expect(impact).toContainText("1 existing chart changes the analysis");
  await expect(impact).toContainText("This proposal does not edit metric definitions");
  const descriptionChanges = impact.getByRole("region", { name: "Dashboard description changes" });
  await expect(descriptionChanges).toContainText(original.description);
  await expect(descriptionChanges).toContainText(description);
  await impact.locator("summary").filter({ hasText: "New MRR (USD)" }).click();
  await expect(impact).toContainText("movement_type");
  await expect(impact).toContainText("month:movement_date");
  await expect(impact).toContainText("Breakdown / reporting grain");
  await dialog.screenshot({ path: "test-results/redesign-impact.png" });
  await dialog.getByRole("button", { name: "Before", exact: true }).click();
  await expect(dialog.locator(".ai-redesign-preview-caption")).toContainText("Your current dashboard");
  await dialog.getByRole("button", { name: "Proposed dashboard", exact: true }).click();
  const rationale = dialog.locator("details").filter({ has: page.getByText("AI design rationale", { exact: true }) });
  await expect(rationale).not.toHaveAttribute("open", "");
  await rationale.locator("summary").click();
  await expect(rationale.locator("p").first()).toHaveText(reason);
  await rationale.locator("summary").click();
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.locator("footer")).toContainText("Redesign applied");
  expect(await geometry()).not.toEqual(initial);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
  // Save the restored document: verify query definitions as well as geometry.
  const undoSaved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const undoResponse = await undoSaved;
  expect(undoResponse.ok()).toBe(true);
  const restored = undoResponse.request().postDataJSON();
  expect(restored.spec.tiles).toEqual(original.tiles);
  expect(restored.spec.description).toBe(original.description);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect.poll(geometry).not.toEqual(initial);
  const redoSaved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const redoResponse = await redoSaved;
  expect(redoResponse.ok()).toBe(true);
  const saved = redoResponse.request().postDataJSON();
  expect(saved.spec.description).toBe(description);
  expect(saved.spec.tiles.find((t: any) => t.metrics.includes("new_mrr"))).toMatchObject({ chart: "line", dimensions: ["month:movement_date"] });
  await page.reload();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  const reopened = page.waitForResponse(r => r.url().endsWith(`/api/dashboards/${saved.id}`) && r.request().method() === "GET");
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: saved.spec.title, exact: false }).first().click();
  const reopenedDocument = await (await reopened).json();
  expect(reopenedDocument.spec).toEqual(saved.spec);
  expect(reopenedDocument.canvas).toEqual(saved.canvas);
  await expect(page.locator(".node").filter({ has: page.getByRole("heading", { name: "New MRR (USD)", exact: true }) }).locator('g[aria-label="line"]')).toBeVisible();
});

test("redesign previews monthly categorical bars and mixed-unit line labels", async ({ page }, testInfo) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => {
    const tiles = route.request().postDataJSON().document.spec.tiles;
    const mrr = tiles.find((t: any) => t.metrics.includes("new_mrr"));
    const traffic = tiles.find((t: any) => t.metrics.includes("web_sessions"));
    return route.fulfill({ json: { proposal: {
      title: "Monthly comparisons", reason: "Nothing is removed.",
      actions: [
        { type: "query", id: mrr.id, metrics: ["net_new_mrr"], dimensions: ["month:movement_date", "movement_type"] },
        { type: "chart", id: mrr.id, chart: "bar" },
        { type: "query", id: traffic.id, metrics: ["web_sessions", "signup_conversion_rate"], dimensions: ["month:session_date"] },
        { type: "chart", id: traffic.id, chart: "line" },
      ],
    } } });
  });
  await page.goto("/"); await openStarter(page, "Dashboard cleanup demo");
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: /Powered by AI Reimagine with AI/ }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  const bars = dialog.locator(".ai-redesign-tile").filter({ has: page.getByRole("heading", { name: "New MRR (USD)", exact: true }) });
  await expect(bars).toContainText("Oct 24");
  await expect(bars).toContainText("Aug 26");
  await expect(bars).toContainText("expansion");
  const traffic = dialog.locator(".ai-redesign-tile").filter({ has: page.getByRole("heading", { name: "Web sessions", exact: true }) });
  await expect(traffic).toContainText("5.4%");
  await expect(dialog.locator(".chart-err")).toHaveCount(0);
  const removed = dialog.getByRole("region", { name: "Metrics no longer shown" });
  await expect(removed).toContainText("New MRR (USD)");
  await expect(removed).not.toContainText("Web sessions");
  await expect(removed).toBeVisible();
  const substitutions = dialog.getByRole("region", { name: "Metric substitutions" });
  await expect(substitutions).toBeVisible();
  await expect(substitutions).toContainText("Before: New MRR (USD)");
  await expect(substitutions).toContainText("Proposed: Net new MRR (USD)");
  const additions = dialog.getByRole("region", { name: "Metrics added to charts" });
  await expect(additions).toContainText("Web sessions (existing chart): Signup conversion rate");
  await expect(additions).toContainText("New MRR (USD) (existing chart): Net new MRR (USD)");
  await additions.screenshot({ path: testInfo.outputPath("metric-additions.png") });
  const rationale = dialog.locator("details").filter({ has: page.getByText("AI design rationale", { exact: true }) });
  await expect(rationale).not.toHaveAttribute("open", "");
  await expect(dialog.getByText("Nothing is removed.", { exact: true })).not.toBeVisible();
  expect(await dialog.getByRole("region", { name: "Verified proposal changes" }).evaluate(el => {
    const rationale = el.parentElement!.querySelector(":scope > details")!;
    return !!(el.compareDocumentPosition(rationale) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await rationale.locator("summary").click();
  await expect(rationale).toContainText("Nothing is removed.");

});

test("a rationale that contradicts calculated facts is shown with a warning, not hidden or rewritten", async ({ page }, info) => {
  let hadDescription = false, accurate = false;
  const invented = "The dashboard description is replaced because the prior one was vague. Period KPIs are from 6 returned monthly rows.";
  const sound = "Adds a monthly trend so the reader can compare reporting periods. The trend query returned 23 rows.";
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => {
    const spec = route.request().postDataJSON().document.spec;
    hadDescription = !!spec.description?.trim();
    const target = spec.tiles.find((t: any) => t.metrics.includes("new_mrr"));
    return route.fulfill({ json: { text: "", research: [{ metrics: ["new_mrr"], dimensions: ["month:movement_date"], where: [], compare: "none", limit: 36, rowsChecked: 23, partial: { start: true, end: false }, truncated: false }],
      proposal: { title: "Revenue through time", reason: accurate ? sound : invented,
        actions: [{ type: "describe", description: "Monthly new-business revenue." }, { type: "query", id: target.id, dimensions: ["month:movement_date"] }, { type: "chart", id: target.id, chart: "line" }, { type: "arrange", layout: "executive" }] } } });
  });
  await page.goto("/"); await openStarter(page, "Dashboard cleanup demo");
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: /Powered by AI Reimagine with AI/ }).click();
  const dialog = page.getByRole("dialog", { name: "Reimagine this dashboard" });
  await dialog.getByRole("button", { name: "Show me a better dashboard", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Revenue through time", exact: true })).toBeVisible();
  const warnings = dialog.getByRole("note", { name: "Rationale checks" });
  await expect(warnings).toContainText("Check this rationale before relying on it");
  await expect(warnings).toContainText("cites 6 rows, but the governed queries in this review returned 23 rows");
  if (!hadDescription) await expect(warnings).toContainText("the dashboard had none");
  // The rationale itself is shown in full, exactly as written.
  await expect(dialog.getByText(invented, { exact: true })).toBeVisible();
  await warnings.screenshot({ path: info.outputPath("rationale-warning.png") });
  // The proposal's charts are checked separately and remain usable.
  await expect(dialog.getByRole("button", { name: "Apply redesign", exact: true })).toBeEnabled();
  // An accurate rationale carries no warning.
  accurate = true;
  await dialog.getByRole("button", { name: "Generate another version", exact: true }).click();
  await expect(dialog.getByText(sound, { exact: true })).toBeAttached();
  await expect(warnings).toHaveCount(0);
});
