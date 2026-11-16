import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

const headers = { "x-sc-principal": "admin" };
const rule = (threshold: number) => ({ metric: "new_mrr", mode: "threshold", operator: "above", threshold });
async function fixture(page: Page, existing = true) {
  const id = crypto.randomUUID(), title = `Alert concurrency ${id}`;
  const saved = await page.request.post("/api/dashboards", { headers, data: { id, revision: 0, canvas: DEFAULT_CANVAS,
    spec: { title, tiles: [{ id: "chart", title: "New business", metrics: ["new_mrr"], dimensions: [], chart: "stat", layout: { x: 24, y: 24, w: 400, h: 220 } }] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const url = `/api/chart-activity/${id}/chart`;
  const document = await (await page.request.get(`/api/dashboards/${id}`, { headers })).json();
  const revision = document.revision;
  if (existing) expect((await page.request.put(`${url}/alert`, { headers, data: { rule: rule(10), revision, version: 0, expectedId: null } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Chart notifications", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Fake time drives polling; disable transitions so screenshots show settled control states.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.getByRole("button", { name: /^Chart alerts/ }).click();
  const drawer = page.getByRole("dialog", { name: "New business" });
  if (existing) await drawer.getByRole("button", { name: "Edit alert", exact: true }).click();
  await expect(drawer.getByLabel("Threshold (metric units)")).toBeEnabled();
  const read = async () => (await (await page.request.get(url, { headers })).json()).alert;
  const update = async (threshold: number) => {
    const alert = await read();
    const response = await page.request.put(`${url}/alert`, { headers, data: { rule: rule(threshold), revision, version: alert?.version ?? 0, expectedId: alert?.id ?? null } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const poll = async () => {
    const response = page.waitForResponse(r => r.url().endsWith(url) && r.request().method() === "GET");
    await page.clock.fastForward(15_000); await response;
  };
  return { drawer, read, update, poll, url, revision };
}

test("polling preserves an alert draft and requires explicit loading of another editor's settings", async ({ page }) => {
  const { drawer, read, update, poll } = await fixture(page);
  await drawer.getByLabel("Threshold (metric units)").fill("25");
  await update(90); await poll();
  await expect(drawer.getByText("This watch changed while you were editing.")).toBeVisible();
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("25");
  await expect(drawer.getByRole("button", { name: "Update alert", exact: true })).toBeDisabled();
  expect((await read()).threshold).toBe(90);
  const disabledColor = await drawer.getByRole("button", { name: "Update alert", exact: true }).evaluate(el => getComputedStyle(el).backgroundColor);
  const enabledColor = await drawer.getByRole("button", { name: "Load latest settings" }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(disabledColor).not.toBe(enabledColor);
  await page.screenshot({ path: "test-results/alert-conflict.png" });
  await drawer.getByRole("button", { name: "Load latest settings" }).click();
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("90");
  await drawer.getByLabel("Threshold (metric units)").fill("95");
  await drawer.getByRole("button", { name: "Update alert", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Edit alert", exact: true })).toBeVisible();
  expect((await read()).threshold).toBe(95);
  await drawer.getByRole("button", { name: "Close chart activity" }).click();
  await page.getByRole("button", { name: /^Chart alerts/ }).click();
  await drawer.getByRole("button", { name: "Edit alert", exact: true }).click();
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("95");
});

test("server rejects an edit between polls, including a replacement alert with the same version", async ({ page }) => {
  const { drawer, read, update, poll, url } = await fixture(page);
  await drawer.getByLabel("Threshold (metric units)").fill("25");
  const old = await read();
  expect((await page.request.delete(`${url}/alert`, { headers, data: { version: old.version, expectedId: old.id } })).ok()).toBe(true);
  await update(90);
  const replacement = await read();
  expect(replacement.version).toBe(old.version); expect(replacement.id).not.toBe(old.id);
  // No polling occurs before submission: the backend must catch the ID mismatch.
  const pending = page.waitForResponse(r => r.url().endsWith(`${url}/alert`) && r.request().method() === "PUT");
  await drawer.getByRole("button", { name: "Update alert", exact: true }).click();
  expect((await pending).status()).toBe(409);
  await expect(drawer.getByRole("alert")).toContainText("This alert changed");
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("25");
  expect((await read()).threshold).toBe(90);
  for (const method of ["patch", "delete"] as const) {
    const response = await page.request[method](`${url}/alert`, { headers, data: { version: old.version, expectedId: old.id, ...(method === "patch" ? { enabled: false } : {}) } });
    expect(response.status()).toBe(409);
  }
  // Library backups also permit non-UUID IDs; an opaque stale ID is a conflict, not malformed input.
  expect((await page.request.patch(`${url}/alert`, { headers, data: { version: old.version, expectedId: "restored-watch", enabled: false } })).status()).toBe(409);
  await poll();
  await drawer.getByRole("button", { name: "Load latest settings" }).click();
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("90");
  // A standard version conflict also rejects the draft even before a poll.
  await update(100);
  const pendingVersion = page.waitForResponse(r => r.url().endsWith(`${url}/alert`) && r.request().method() === "PUT");
  await drawer.getByRole("button", { name: "Update alert", exact: true }).click();
  expect((await pendingVersion).status()).toBe(409);
  expect((await read()).threshold).toBe(100);
});

test("creating an alert elsewhere does not hide or rebase a new alert draft", async ({ page }) => {
  const { drawer, update, poll, read } = await fixture(page, false);
  await drawer.getByLabel("Threshold (metric units)").fill("25");
  await update(90); await poll();
  await expect(drawer.getByLabel("Threshold (metric units)")).toHaveValue("25");
  await expect(drawer.getByRole("button", { name: "Create alert", exact: true })).toBeDisabled();
  expect((await read()).threshold).toBe(90);
  await drawer.getByRole("button", { name: "Cancel editing" }).click();
  await expect(drawer.getByRole("button", { name: "Edit alert", exact: true })).toBeVisible();
});
