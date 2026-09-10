import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

test("folders organize saved dashboards and a persisted view can be reused and undone", async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 8), folderName = `Growth ${suffix}`, dashboardName = `Growth story ${suffix}`, viewName = `Revenue section ${suffix}`;
  const id = crypto.randomUUID();
  const spec = { title: dashboardName, tiles: [
    { id: "heading", kind: "heading", metrics: [], dimensions: [], text: "At a glance", layout: { x: 24, y: 24, w: 750, h: 60 } },
    { id: "revenue", title: "Ending MRR", metrics: ["ending_mrr"], dimensions: ["month:month"], chart: "kpi", section: "heading", layout: { x: 24, y: 108, w: 360, h: 180 } },
  ] };
  expect((await request.post("/api/dashboards", { data: { id, spec, canvas: { ...DEFAULT_CANVAS, width: 1000 } } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "CoreCanvas Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "CoreCanvas Library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(folderName);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: `Library actions for ${dashboardName}`, exact: true }).click();
  await page.getByRole("button", { name: "Rename or move", exact: true }).click();
  const folders = (await (await request.get("/api/library")).json()).folders;
  const folder = folders.find((f: any) => f.name === folderName);
  await dialog.getByLabel("Parent folder", { exact: true }).selectOption(folder.id);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await (await request.get(`/api/dashboards/${id}`)).json()).folderId).toBe(folder.id);
  await page.locator(".core-library").getByRole("button", { name: new RegExp(`^${folderName}`) }).click();
  await page.getByRole("button", { name: `Open dashboard ${dashboardName}`, exact: true }).click();
  await expect(page.locator(".node")).toHaveCount(2);
  await page.getByRole("button", { name: "Views", exact: true }).click();
  await page.getByRole("button", { name: /^Save a view Keep/ }).click();
  await dialog.getByLabel("View name", { exact: true }).fill(viewName);
  await dialog.getByLabel("Save view folder", { exact: true }).selectOption(folder.id);
  const saved = page.waitForResponse(r => r.url().endsWith("/api/library/views") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save view", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Views", exact: true }).click();
  await page.getByRole("button", { name: /^Browse saved views/ }).click();
  await dialog.getByRole("searchbox", { name: "Search library" }).fill(viewName);
  await dialog.getByRole("button", { name: `Insert view ${viewName}`, exact: true }).click();
  await expect(page.locator(".node")).toHaveCount(2);
  await expect(page.locator(".kpi-value")).toContainText("203");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".node")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".node")).toHaveCount(2);
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  const library = await (await request.get("/api/library")).json();
  expect(library.items.find((i: any) => i.name === viewName)).toMatchObject({ kind: "view", folderId: folder.id });
  await page.getByRole("button", { name: "CoreCanvas Library", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search library" }).fill(viewName);
  await page.getByRole("button", { name: `Preview view ${viewName}`, exact: true }).click();
  await expect(dialog.getByRole("img", { name: `Layout of ${viewName}` })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(d => d.scrollWidth <= d.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/library-view-mobile.png" });
});

test("library API rejects invalid metrics, cyclic folders and stale moves", async ({ request }) => {
  const root = crypto.randomUUID(), child = crypto.randomUUID();
  expect((await request.post("/api/library/folders", { data: { id: root, name: root } })).status()).toBe(200);
  expect((await request.post("/api/library/folders", { data: { id: child, name: "Child", parentId: root } })).status()).toBe(200);
  expect((await request.post("/api/library/folders", { data: { id: root, name: root, parentId: child, revision: 1 } })).status()).toBe(409);
  expect((await request.delete(`/api/library/folders/${root}`, { data: { revision: 1 } })).status()).toBe(409);
  const invalid = await request.post("/api/library/views", { data: { id: crypto.randomUUID(), name: "Invalid", canvas: DEFAULT_CANVAS, spec: { title: "Invalid", tiles: [{ id: "x", metrics: ["unknown_metric"], dimensions: [], layout: { x: 0, y: 0, w: 300, h: 200 } }] } } });
  expect(invalid.status()).toBe(400);
  expect((await request.post("/api/library/folders", { data: { id: child, name: `Changed ${child}`, revision: 1 } })).status()).toBe(200);
  expect((await request.post("/api/library/folders", { data: { id: child, name: "Stale", revision: 1 } })).status()).toBe(409);
});


test("the folder structure replaces topics and new dashboards keep their folder through draft recovery", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText("Explore by topic", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand folder Examples", exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "CoreCanvas Library", exact: true }).click();
  await expect(page.locator(".library-folder-card").filter({ hasText: "Shared views" })).toContainText("3 folders");
  await page.locator(".library-folder-target").filter({ hasText: "Shared views" }).click();
  await expect(page.locator(".library-folder-target strong")).toHaveText(["KPI summaries", "Trends & comparisons", "Story sections"]);
  await page.locator(".library-folder-target").filter({ hasText: "Story sections" }).click();
  await page.getByRole("button", { name: "+ New dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByText("Text note", { exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Recover draft: Untitled dashboard", exact: true }).click();
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const response = await saved; expect(response.ok()).toBe(true);
  const library = await (await request.get("/api/library")).json();
  const folder = library.folders.find((f: any) => f.name === "Story sections");
  expect(response.request().postDataJSON().folderId).toBe(folder.id);
  expect(library.items.find((i: any) => i.id === response.request().postDataJSON().id)?.folderId).toBe(folder.id);
  await request.delete(`/api/dashboards/${response.request().postDataJSON().id}`, { data: { revision: 1 } });
});
