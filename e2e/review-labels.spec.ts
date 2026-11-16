import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

for (const surface of ["dashboard", "chart"] as const) {
  for (const change of ["coarsen", "trend", "remove"] as const) {
    for (const authored of [false, true]) test(`${surface} review ${authored ? "preserves authored titles" : "updates automatic titles"} after ${change}, including save and undo`, async ({ page, request }) => {
      await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
      const model = await (await request.get("/api/model")).json();
      const metric = change === "coarsen" ? "web_sessions" : "new_mrr";
      const label = model.metrics[metric].label;
      const dimensions = change === "coarsen" ? ["day:fct_web_sessions.session_date"] : ["fct_mrr_movements.movement_type"];
      const originalTitle = authored ? "Where should we focus next?" : change === "coarsen" ? label : `${label} by movement type`;
      const expectedTitle = authored ? originalTitle : change === "remove" ? label : `${label} over time`;
      const title = `Review labels ${crypto.randomUUID()}`;
      const tile = { id: "subject", title: originalTitle, metrics: [metric], dimensions, chart: change === "coarsen" ? "line" : "bar", limit: 1000, layout: { x: 24, y: 24, w: 850, h: 400 } };
      const created = await request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec: { title, tiles: [tile] }, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 700 } } });
      expect(created.ok(), await created.text()).toBe(true);
      await page.goto("/");
      await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
      await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
      await expect(page.locator(".tile figure svg")).toBeVisible();
      if (surface === "chart") {
        await page.locator(".tile").getByRole("button", { name: "More chart actions", exact: true }).click();
        await page.locator(".tile").getByRole("button", { name: "Design review", exact: true }).click();
      } else await page.getByRole("button", { name: "Design review", exact: true }).click();
      const review = surface === "chart" ? page.locator(".beautify-pop") : page.getByRole("dialog", { name: "Design review" });
      await review.getByRole("button", { name: change === "coarsen" ? "Switch to week" : change === "trend" ? "Show over time" : "Remove breakdown", exact: true }).click();
      if (surface === "dashboard") await review.getByRole("button", { name: "Close", exact: true }).click();
      else await expect(review).toHaveCount(0);
      await expect(page.locator(".tile h4, .tile .kpi-label")).toHaveText(expectedTitle);
      const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
      const response = await saved; expect(response.ok()).toBe(true);
      const next = response.request().postDataJSON().spec.tiles[0];
      expect(next).toMatchObject({ title: expectedTitle, metrics: [metric], limit: 1000,
        dimensions: change === "coarsen" ? ["week:fct_web_sessions.session_date"] : change === "trend" ? ["month:fct_mrr_movements.movement_date"] : [] });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await expect(page.locator(".tile h4, .tile .kpi-label")).toHaveText(originalTitle);
      await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
    });
  }
}
