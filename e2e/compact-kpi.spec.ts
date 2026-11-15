import { expect, test } from "@playwright/test";

test("a compact KPI keeps its data check, trend and date range readable", async ({ page }, info) => {
  await page.route("**/api/query", route => route.fulfill({ json: {
    columns: ["month_month", "nrr", "nrr__prev"],
    rows: [["2026-06-01", null, null], ["2026-07-01", 1.044, null], ["2026-08-01", 1.028, 1.044]], ms: 1,
  } }));
  const title = `Compact KPI ${crypto.randomUUID()}`;
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(),
    canvas: { width: 1000, height: 700, preset: "custom", snap: true, grid: 8, locked: false },
    spec: { title, tiles: [{ id: "retention", title: "Net revenue retention — August 2026", metrics: ["nrr"],
      dimensions: ["month:month"], chart: "kpi", compare: "prior", layout: { x: 24, y: 24, w: 306, h: 156 } }] },
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  const card = page.locator(".node .tile"), kpi = card.locator(".kpi");
  await expect(kpi.locator(".kpi-value")).toHaveText("102.8%");
  await expect(kpi.locator(".spark-range")).toContainText("Missing values");
  await expect(kpi.locator(".spark-range")).toContainText("2026-08-01");
  for (const mode of ["edit", "preview"] as const) {
    if (mode === "preview") await page.getByRole("button", { name: "Preview dashboard", exact: true }).click();
    await expect(card.getByRole("button", { name: "1 data check to review", exact: true })).toBeVisible();
    const geometry = await card.evaluate(el => {
      const body = el.querySelector(".kpi-body")!, bounds = body.getBoundingClientRect();
      return { overflow: body.scrollHeight - body.clientHeight,
        children: [".kpi-head", ".kpi-asof", ".kpi-value", ".kpi-delta", ".spark", ".spark-range"].map(selector => {
          const r = el.querySelector(selector)!.getBoundingClientRect();
          return { selector, top: r.top - bounds.top, bottom: r.bottom - bounds.bottom, height: r.height };
        }) };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    for (const r of geometry.children) {
      expect(r.top, r.selector).toBeGreaterThanOrEqual(0);
      expect(r.bottom, r.selector).toBeLessThanOrEqual(1);
      expect(r.height, r.selector).toBeGreaterThan(0);
    }
    await card.screenshot({ path: info.outputPath(`compact-kpi-${mode}.png`) });
  }
  await card.getByRole("button", { name: "1 data check to review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Metric definition and scope" })).toContainText("Missing values");
});
