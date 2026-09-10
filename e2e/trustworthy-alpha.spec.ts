import { openStarter } from "./library-helpers.ts";
import { expect, test, type Page } from "@playwright/test";

async function scratch(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
}
async function save(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  return result.json();
}
async function note(page: Page) {
  await page.getByRole("button", { name: /^Text$/ }).click();
  await page.getByText("Text note", { exact: true }).click();
  await expect(page.locator(".node.selected")).toBeVisible();
}

test("new canvases get new saved identities; saved dashboards reopen from Home", async ({ page, request }) => {
  await scratch(page); await note(page);
  const first = await save(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  const second = await save(page);
  expect(second.id).not.toBe(first.id);
  const original = await request.get(`/api/dashboards/${first.id}`);
  expect((await original.json()).spec.tiles).toHaveLength(1);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await expect(page.getByText("Saved dashboards", { exact: true })).toBeVisible();
});

test("refresh and role changes preserve authored work and actually query again", async ({ page, request }) => {
  await page.goto("/");
  await openStarter(page, "SaaS overview");
  await expect(page.locator(".tile figure").first()).toBeVisible();
  await note(page);
  const first = await save(page);
  const before = await (await request.get(`/api/dashboards/${first.id}`)).json();
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/query"));
  await page.getByTitle("Refresh", { exact: true }).click();
  await refreshed;
  await page.getByLabel("Acting as").selectOption("emea");
  await expect(page.locator(".err").first()).toContainText("Access denied");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.getByLabel("Acting as").selectOption("admin");
  await expect(page.locator(".tile figure").first()).toBeVisible();
  const next = await save(page);
  expect(next.id).toBe(first.id);
  const after = await (await request.get(`/api/dashboards/${first.id}`)).json();
  expect(after.spec).toEqual(before.spec);
  expect(after.canvas).toEqual(before.canvas);
});

test("a failed save keeps edits and an actionable error; retry succeeds", async ({ page }) => {
  await scratch(page); await note(page);
  await page.route("**/api/dashboards", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, json: { error: "Disk full" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save failed: Disk full");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await expect(page.locator(".tile")).toHaveCount(1);
  await page.unroute("**/api/dashboards");
  await save(page);
});

test("canvas settings participate in save status and undo", async ({ page }) => {
  await scratch(page); await save(page);
  const canvas = page.locator(".canvas-surface");
  const before = await canvas.getAttribute("style");
  await page.getByRole("button", { name: "Canvas settings" }).click();
  await page.getByLabel("Canvas size", { exact: true }).selectOption("phone");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await page.getByTitle("Refresh", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  expect(await canvas.getAttribute("style")).toBe(before);
});

test("leaving unsaved work keeps a recoverable draft with its tiles", async ({ page }) => {
  await scratch(page); await note(page);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Recover draft: Untitled dashboard", exact: true }).click();
  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
});

test("API rejects invalid saves, stale writes, unavailable sources and remote origins", async ({ request }) => {
  const id = crypto.randomUUID();
  const body = { id, spec: { title: "API regression", tiles: [] } };
  const created = await request.post("/api/dashboards", { data: body });
  expect(created.status()).toBe(200);
  expect((await request.post("/api/dashboards", { data: body })).status()).toBe(409);
  expect((await request.post("/api/dashboards", { data: { id: "bad", spec: {} } })).status()).toBe(400);
  expect((await request.get("/api/model", { headers: { "x-sc-source": "missing" } })).status()).toBe(404);
  expect((await request.post("/api/dashboards", { data: body, headers: { origin: "https://untrusted.example" } })).status()).toBe(403);
});

test("all discovery endpoints enforce roles, and unsupported pre-aggregate scopes deny access", async ({ request }) => {
  const headers = { "x-sc-principal": "emea" };
  const values = await request.get("/api/values?base=dim_users&field=country", { headers });
  expect(values.status()).toBe(200);
  const allowed = new Set(["GB", "DE", "FR", "NL", "SE"]);
  for (const entry of (await values.json()).values) expect(allowed.has(entry.value)).toBe(true);
  const profile = await request.get("/api/profile?base=dim_users&fields=country", { headers });
  expect(profile.status()).toBe(200);
  for (const value of (await profile.json()).fields[0].sample) expect(allowed.has(value)).toBe(true);
  for (const path of ["/api/values?base=fct_saas_monthly&field=month", "/api/extent?base=fct_saas_monthly&field=month", "/api/profile?base=fct_saas_monthly&fields=month"])
    expect((await request.get(path, { headers })).status()).toBe(403);
});

test("edits made while saving stay unsaved after the earlier write completes", async ({ page, request }) => {
  await scratch(page); await note(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/dashboards", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/dashboards") && r.method() === "POST");
  const finished = page.waitForResponse((r) => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await sent;
  await note(page);
  release();
  const saved = await (await finished).json();
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await expect(page.locator(".tile")).toHaveCount(2);
  expect((await (await request.get(`/api/dashboards/${saved.id}`)).json()).spec.tiles).toHaveLength(1);
  await page.unroute("**/api/dashboards");
  await save(page);
  expect((await (await request.get(`/api/dashboards/${saved.id}`)).json()).spec.tiles).toHaveLength(2);
});
