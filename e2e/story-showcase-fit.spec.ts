import { expect, test } from "@playwright/test";
import { showcaseStarters } from "../src/library/showcase.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

for (const width of [640, 1120]) test(`MRR story fits at ${width}px`, async ({ page }, info) => {
  const title = `MRR story ${crypto.randomUUID()}`;
  const saved = await page.request.post("/api/dashboards", {
    data: {
      id: crypto.randomUUID(),
      spec: { ...showcaseStarters()["MRR movements"], title },
      canvas: { ...DEFAULT_CANVAS, width, height: 4000 },
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  await expect(page.getByLabel("Acting as", { exact: true })).toHaveValue("admin");
  await expect(page.locator(".kpi-value").first()).not.toHaveText("—");
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  const heading = page.locator(".heading-text").first();
  const bounds = await heading.evaluate(el => {
    const node = el.closest(".node")!.getBoundingClientRect();
    const text = el.getBoundingClientRect();
    return { bottom: text.bottom, containerBottom: node.bottom };
  });
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.containerBottom + 1);
  for (const card of await page.locator(".node").filter({ has: page.locator(".kpi") }).all()) {
    await expect(card.locator(".kpi-value")).not.toHaveText("—");
    const r = await card.boundingBox();
    expect(r!.y).toBeGreaterThanOrEqual(bounds.bottom);
  }
  await page.getByText("Net new MRR", { exact: true }).first().click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(page.locator(".inspector")).toContainText("Choose a comparison period.");
  await page.screenshot({ path: info.outputPath("mrr-story-editor.png") });
});
