import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test("review follows accepted edits and remembers dismissed ideas", async ({ page }) => {
  const requests: any[] = [];
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/agent/dashboard-story", route => {
    const input = route.request().postDataJSON(); requests.push(input);
    return route.fulfill({ json: {
      title: "Optional title", order: input.tiles.map((t: any) => t.id), layout: null,
      summary: "Inspect the contribution to recurring revenue.", notes: [], additions: [
        { metrics: ["new_mrr"], breakdown: "time", title: "New business trend", reason: "Inspect the contribution." },
        { metrics: ["churned_mrr"], breakdown: "time", title: "Churned revenue trend", reason: "Inspect lost revenue." },
      ],
    } });
  });
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const count = await page.locator(".node").count();
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Design review" });
  await panel.getByRole("button", { name: "Keep current title", exact: true }).click();
  await panel.locator(".addition-item").filter({ hasText: "Churned revenue trend" }).getByRole("button", { name: "Not useful", exact: true }).click();
  await panel.locator(".addition-item").filter({ hasText: "New business trend" }).getByRole("button", { name: "Add this tile", exact: true }).click();
  await expect(page.locator(".node")).toHaveCount(count + 1);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].tiles).toHaveLength(count + 1);
  expect(requests[1].review.decisions.map((d: any) => d.status)).toEqual(["dismissed", "dismissed", "applied"]);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Keep current title", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Add this tile", exact: true })).toHaveCount(0);

  await panel.getByRole("checkbox", { name: "Keep reviewing while this panel is open" }).uncheck();
  await page.locator(".node").filter({ has: page.getByRole("heading", { name: "Ending MRR (USD) over time", exact: true }) }).press("Alt+ArrowLeft");
  await page.waitForTimeout(1000); // Exceeds the review debounce; paused reviews must not request AI.
  expect(requests).toHaveLength(2);
  await panel.getByRole("button", { name: "Review this goal", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
});

test("a structured canvas can be refined again without closing review", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const headings = await page.locator(".heading-text").allTextContents();
  await page.getByRole("button", { name: "Design review", exact: true }).click();
  const chart = page.locator(".node").filter({ has: page.getByRole("heading", { name: "Ending MRR (USD) over time", exact: true }) });
  await chart.press("Alt+ArrowLeft");
  const panel = page.getByRole("dialog", { name: "Design review" });
  await panel.getByRole("button", { name: "Preview story structure", exact: true }).click();
  await panel.getByRole("button", { name: "Apply story structure", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(page.locator(".heading-text")).toHaveText(headings);
  await expect(panel.locator(".review-coverage")).toContainText("6 charts reviewed");
});
