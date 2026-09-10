import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
const spec = (): DashboardSpec => ({ title: `Filter journey ${crypto.randomUUID()}`, tabs: [{ id: "overview", title: "Overview" }, { id: "detail", title: "Detail" }], tiles: [
  { id: "a", tabId: "overview", title: "Signups overview", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "bar", layout: { x: 24, y: 190, w: 750, h: 350 } },
  { id: "b", tabId: "detail", title: "Signups detail", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "bar", layout: { x: 24, y: 190, w: 750, h: 350 } },
] });
async function open(page: any, d: DashboardSpec) {
  const id = crypto.randomUUID();
  const saved = await page.request.post("/api/dashboards", { data: { id, spec: d, canvas: { ...DEFAULT_CANVAS, width: 1000, height: 850 }, revision: 0 } }); expect(saved.ok()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click(); await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(d.title) }).click(); return id;
}
test("authors shared filters, carries selections across tabs and saves the whole document", async ({ page }) => {
  const d = spec(), id = await open(page, d);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Catalogue field", { exact: true }).selectOption("dim_users.country"); await page.getByLabel("Label", { exact: true }).fill("Country");
  await expect(page.getByText("2 of 2 charts", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Save filter", exact: true }).click();
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Choose Country", exact: true }).click(); await page.getByRole("checkbox", { name: "US", exact: true }).check(); await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  const query = page.waitForResponse(r => r.url().endsWith("/api/query") && r.request().postDataJSON()?.id === "b" && r.request().postDataJSON()?.where?.some((f: any) => f.values?.includes("US")));
  await page.getByRole("tab", { name: /Detail/ }).click(); expect((await query).ok()).toBe(true);
  await expect(page.getByLabel("Dashboard filters")).toContainText("US"); await expect(page.locator(".node")).toHaveCount(1);
  await page.getByRole("button", { name: "Tab actions", exact: true }).click(); await page.getByRole("button", { name: "Duplicate tab", exact: true }).click(); await expect(page.getByRole("tab", { name: /Detail \(copy\)/ })).toBeVisible();
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await expect(page.locator(".save-status")).toHaveText("Saved");
  const persisted = await (await page.request.get(`/api/dashboards/${id}`)).json(); expect(persisted.spec.tabs).toHaveLength(3); expect(persisted.spec.tiles).toHaveLength(4); expect(persisted.spec.filters[0].bindings).toHaveLength(3); expect(persisted.spec.filters[0].defaultValue).toBeUndefined();
});
test("copies charts to a tab and preserves tabs through undo and save", async ({ page }) => {
  const d = spec(); await open(page, d);
  await page.getByRole("button", { name: "Dashboard actions", exact: true }).click(); await page.getByRole("button", { name: "Copy charts to…", exact: true }).click();
  await page.getByLabel("Destination tab", { exact: true }).selectOption("detail"); await page.getByRole("button", { name: "Copy 1 charts", exact: true }).click();
  await page.getByRole("tab", { name: /Detail/ }).click(); await expect(page.locator(".node")).toHaveCount(2);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z"); await expect(page.locator(".node")).toHaveCount(1);
  await page.getByRole("tab", { name: /Overview/ }).click(); await expect(page.locator(".node")).toHaveCount(1);
  await page.getByRole("button", { name: "Add tab", exact: true }).click(); await page.getByLabel("Tab name", { exact: true }).fill("Retention"); await page.getByRole("button", { name: "Save tab", exact: true }).click(); await expect(page.locator(".node")).toHaveCount(0);
  await page.getByRole("tab", { name: /Overview/ }).click(); await expect(page.locator(".node")).toHaveCount(1);
});
test("reviews a PDF reference into live charts, tabs and visible placeholders", async ({ page }) => {
  await page.route("**/api/agent/status", r => r.fulfill({ json: { configured: true } }));
  const item = { id: "mrr", kind: "metric", label: "Ending MRR", metrics: ["ending_mrr"], dimensions: [], grain: "none", chart: "kpi", x: 0, y: 0, w: 0.5, h: 0.3 };
  await page.route("**/api/reference/analyze", r => r.fulfill({ json: { blueprint: { title: "Reference demo", pages: [ { title: "Growth", aspectRatio: 1.5, items: [item] }, { title: "Planning", aspectRatio: 1.5, items: [{ ...item, id: "unknown", label: "Profit forecast", metrics: ["Profit forecast"] }] } ] } } }));
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin"); await page.getByRole("button", { name: "Recreate from reference", exact: true }).click();
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage(); await page.getByLabel("Upload dashboard reference", { exact: true }).setInputFiles({ name: "dashboard.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await page.getByRole("button", { name: "Read reference", exact: true }).click(); await expect(page.getByText("Uses the metric’s native month reporting period.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Match Profit forecast", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Create with 1 placeholders", exact: true }).click(); await expect(page.locator(".dash-title")).toHaveText("Reference demo"); await expect(page.locator(".kpi")).toHaveCount(1);
  await page.getByRole("tab", { name: /Planning/ }).click(); await expect(page.locator(".note-text")).toContainText("Needs a catalogue match");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await expect(page.locator(".save-status")).toHaveText("Saved");
});
test("reference import explains provider setup and rejects invalid files at the API", async ({ page }) => {
  await page.route("**/api/agent/status", r => r.fulfill({ json: { configured: false } })); await page.goto("/"); await page.getByRole("button", { name: "Recreate from reference", exact: true }).click();
  await expect(page.getByRole("button", { name: "Read reference", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "Open Connections", exact: true })).toBeVisible();
  const result = await page.request.post("/api/reference/analyze", { data: { mime: "application/pdf", data: Buffer.from("plain text is not a PDF").toString("base64") } }); expect(result.status()).toBe(400);
});

test("copying into saved dashboards protects concurrent changes", async ({ page }) => {
  const source = spec(), target = spec(), targetId = crypto.randomUUID(), surface = { ...DEFAULT_CANVAS, width: 1000, height: 850 };
  expect((await page.request.post("/api/dashboards", { data: { id: targetId, spec: target, canvas: surface, revision: 0 } })).ok()).toBe(true);
  await open(page, source);
  await page.getByRole("button", { name: "Dashboard actions", exact: true }).click(); await page.getByRole("button", { name: "Copy charts to…", exact: true }).click();
  await page.getByLabel("Destination dashboard", { exact: true }).selectOption(targetId); await expect(page.getByRole("button", { name: "Copy 1 charts", exact: true })).toBeEnabled();
  target.title = "Changed by a teammate";
  expect((await page.request.post("/api/dashboards", { data: { id: targetId, spec: target, canvas: surface, revision: 1 } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Copy 1 charts", exact: true }).click(); await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/changed|revision|conflict/i);
  expect((await (await page.request.get(`/api/dashboards/${targetId}`)).json()).spec.tiles).toHaveLength(2);
  await page.getByLabel("Destination dashboard", { exact: true }).selectOption("current"); await page.getByLabel("Destination dashboard", { exact: true }).selectOption(targetId); await expect(page.getByRole("button", { name: "Copy 1 charts", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Copy 1 charts", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  const copied = await (await page.request.get(`/api/dashboards/${targetId}`)).json(); expect(copied.spec.title).toBe("Changed by a teammate"); expect(copied.spec.tiles).toHaveLength(3); expect(copied.revision).toBe(3);
});

test("the save endpoint rejects misleading filter connections", async ({ request }) => {
  const d = spec(); d.filters = [{ id: "forged", label: "Country", field: "dim_users.country", control: "select", scope: "tab", tabId: "overview", bindings: [{ tileId: "b", field: "dim_users.country" }] }];
  const result = await request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec: d, canvas: DEFAULT_CANVAS, revision: 0 } }); expect(result.status()).toBe(400); expect(await result.text()).toContain("scope");
});
