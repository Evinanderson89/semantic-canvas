import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test("AI redesign previews real charts, applies once, and restores with undo", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => {
    const input = route.request().postDataJSON();
    expect(input.mode).toBe("redesign");
    if (++attempts === 1) return route.fulfill({ status: 500, json: { error: "The provider is temporarily unavailable." } });
    const target = input.document.spec.tiles.find((t: any) => t.metrics.includes("new_mrr"));
    return route.fulfill({ json: { text: "Lead with recurring revenue, then inspect the monthly trend.", proposal: {
      title: "A clearer revenue story", reason: "A trend is more useful than the isolated category.",
      actions: [{ type: "query", id: target.id, dimensions: ["month:movement_date"] }, { type: "chart", id: target.id, chart: "line" }, { type: "arrange", layout: "executive" }],
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
  expect(await geometry()).toEqual(initial);
  await dialog.getByRole("button", { name: "Before", exact: true }).click();
  await expect(dialog.locator(".ai-redesign-preview-caption")).toContainText("Your current dashboard");
  await dialog.getByRole("button", { name: "Proposed dashboard", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.locator("footer")).toContainText("Redesign applied");
  expect(await geometry()).not.toEqual(initial);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
});

test("redesign previews monthly categorical bars and mixed-unit line labels", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/chat", route => {
    const tiles = route.request().postDataJSON().document.spec.tiles;
    const mrr = tiles.find((t: any) => t.metrics.includes("new_mrr"));
    const traffic = tiles.find((t: any) => t.metrics.includes("web_sessions"));
    return route.fulfill({ json: { proposal: {
      title: "Monthly comparisons", reason: "Compare movements through time and distinguish rate from volume.",
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
});
