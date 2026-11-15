import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

for (const change of ["query", "title"] as const) test(`assistant ${change} edit handles existing drill scope without changing other charts`, async ({ page, request }) => {
  const queries: any[] = [];
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/query", route => {
    const q = route.request().postDataJSON(); queries.push(q);
    const [grain, field] = q.dimensions[0].split(":");
    return route.fulfill({ json: { columns: [`${field.split(".").at(-1)}_${grain}`, ...q.metrics], rows: [["2026-06-01", ...q.metrics.map(() => 100)], ["2026-06-08", ...q.metrics.map(() => 130)]], ms: 1 } });
  });
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: {
    title: "Revise the focal chart", reason: "Use the requested analysis.", actions: [change === "query"
      ? { type: "query", id: "hero", metrics: ["web_sessions"], dimensions: ["week:session_date"] }
      : { type: "title", id: "hero", title: "Revenue story" }],
  } } }));
  const id = crypto.randomUUID(), title = `Drill edit ${id}`;
  const tiles = ["hero", "support"].map((id, i) => ({ id, title: id === "hero" ? "Revenue trend" : "Supporting trend", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "barGrouped", layout: { x: 24 + i * 548, y: 24, w: 524, h: 360 } }));
  expect((await request.post("/api/dashboards", { data: { id, spec: { title, tiles }, canvas: { ...DEFAULT_CANVAS, width: 1120, height: 700 } } })).ok()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const hero = page.getByRole("group", { name: "Revenue trend", exact: true });
  const support = page.getByRole("group", { name: "Supporting trend", exact: true });
  for (const chart of [hero, support]) {
    await chart.locator('g[aria-label="bar"] rect').first().click();
    await expect(chart.locator(".drill-crumbs")).toBeVisible();
  }
  const before = queries.filter(q => q.id === "hero").at(-1);
  expect(before.dimensions).toEqual(["day:movement_date"]);
  await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
  const assistant = page.getByRole("region", { name: "Canvas assistant" });
  await assistant.getByPlaceholder("Message the agent…").fill("Revise the focal chart");
  await assistant.getByRole("button", { name: "Send", exact: true }).click();
  await assistant.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(assistant).toContainText("Changes applied.");
  await assistant.getByRole("button", { name: "Close", exact: true }).click();
  await expect(support.locator(".drill-crumbs")).toBeVisible();

  if (change === "query") {
    await expect.poll(() => queries.filter(q => q.id === "hero").at(-1)?.metrics).toEqual(["web_sessions"]);
    await expect(hero.locator(".drill-crumbs")).toHaveCount(0);
    const changed = queries.filter(q => q.id === "hero" && q.metrics[0] === "web_sessions");
    expect(changed.length).toBeGreaterThan(0);
    for (const q of changed) {
      expect(q.dimensions).toEqual(["week:session_date"]);
      expect(q.where.some((f: any) => f.id === "drill:hero")).toBe(false);
    }
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect.poll(() => queries.filter(q => q.id === "hero").at(-1)?.dimensions).toEqual(["month:movement_date"]);
    await expect(hero.locator(".drill-crumbs")).toHaveCount(0);
    await expect(support.locator(".drill-crumbs")).toBeVisible();
  } else {
    await expect(page.getByRole("group", { name: "Revenue story", exact: true }).locator(".drill-crumbs")).toBeVisible();
    expect(queries.filter(q => q.id === "hero").at(-1)).toEqual(before);
  }
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const stored = await (await request.get(`/api/dashboards/${id}`)).json();
  for (const tile of stored.spec.tiles) {
    expect(tile.dimensions).toEqual(["month:movement_date"]);
    expect(tile.where ?? []).toEqual([]);
  }
});
