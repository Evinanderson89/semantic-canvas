import { test, expect, type Page } from "@playwright/test";

async function savedDesign(page: Page) {
  const id = crypto.randomUUID(), title = `History recovery ${id}`;
  const spec = { title, tiles: [{ id: "note", kind: "text", text: "Earlier decision", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 500, h: 160 } }] };
  expect((await page.request.post("/api/dashboards", { data: { id, spec } })).ok()).toBe(true);
  expect((await page.request.post("/api/dashboards", { data: { id, revision: 1, spec: { ...spec, tiles: [{ ...spec.tiles[0], text: "Current decision" }] } } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: title, exact: false }).click();
  return { id, spec };
}

for (const failure of ["network", "malformed", "empty"] as const) test(`version list recovers from ${failure} without leaving a permanent spinner`, async ({ page }, info) => {
  const { id } = await savedDesign(page);
  let recover = false;
  await page.route(`**/api/dashboards/${id}/versions`, route => recover ? route.continue() : failure === "network"
    ? route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } })
    : route.fulfill({ json: { versions: failure === "empty" ? [] : [{ revision: "two" }] } }));
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog.getByRole("button", { name: "Restore as draft" })).toBeDisabled();
  if (failure === "empty") await expect(dialog).toContainText("No saved versions are available");
  else await expect(dialog.getByRole("alert")).toContainText(failure === "network" ? "temporarily unavailable" : "could not be read");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  if (failure === "network") await dialog.screenshot({ path: info.outputPath("version-history-recovery.png") });
  recover = true;
  await dialog.getByRole("button", { name: failure === "empty" ? "Reload history" : "Retry loading history", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Layout of version 2" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore as draft" })).toBeEnabled();
  await dialog.locator("footer").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".note-text")).toHaveText("Current decision");
  await expect(page.locator(".save-status")).toHaveText("Saved");
});

for (const failure of ["network", "wrong-dashboard", "wrong-revision", "malformed"] as const) test(`version preview rejects ${failure} and retries the selected version`, async ({ page }) => {
  const { id } = await savedDesign(page);
  let recover = false;
  await page.route(`**/api/dashboards/${id}/versions/1`, async route => {
    if (recover) return route.continue();
    if (failure === "network") return route.fulfill({ status: 503, json: { error: "This version is temporarily unavailable" } });
    const response = await route.fetch(), body = await response.json();
    if (failure === "wrong-dashboard") body.id = "another-dashboard";
    if (failure === "wrong-revision") body.revision = 2;
    if (failure === "malformed") body.spec.tiles = [{ kind: "text" }];
    return route.fulfill({ json: body });
  });
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog.getByRole("img", { name: "Layout of version 2" })).toBeVisible();
  await dialog.getByRole("button", { name: /Version 1/ }).click();
  await expect(dialog.getByRole("alert")).toContainText(failure === "network" ? "temporarily unavailable" : "requested saved version");
  await expect(dialog.getByRole("button", { name: "Restore as draft" })).toBeDisabled();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  recover = true;
  await dialog.getByRole("button", { name: "Retry loading version" }).click();
  await expect(dialog.getByRole("img", { name: "Layout of version 1" })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Restore as draft" }).click();
  await expect(page.locator(".note-text")).toHaveText("Earlier decision");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  expect((await (await page.request.get(`/api/dashboards/${id}`)).json()).revision).toBe(2);
});

test("a slow version response cannot replace the newer selection", async ({ page }) => {
  const { id } = await savedDesign(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/api/dashboards/${id}/versions/1`, async route => {
    const response = await route.fetch(); arrived(); await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog.getByRole("img", { name: "Layout of version 2" })).toBeVisible();
  await dialog.getByRole("button", { name: /Version 1/ }).click();
  await requested;
  await expect(dialog.getByRole("button", { name: "Restore as draft" })).toBeDisabled();
  await dialog.getByRole("button", { name: /Version 2/ }).click();
  await expect(dialog.getByRole("img", { name: "Layout of version 2" })).toBeVisible();
  release();
  await dialog.getByRole("button", { name: "Restore as draft" }).click();
  await expect(page.locator(".note-text")).toHaveText("Current decision");
});
