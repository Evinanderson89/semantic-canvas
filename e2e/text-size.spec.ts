import { expect, test } from "@playwright/test";

test("text size supports deliberate edits without saving invalid or unfinished values", async ({ page, request }) => {
  const id = crypto.randomUUID(), title = `Text sizing ${id}`;
  const spec = { title, tiles: [
    { id: "first", title: "First note", kind: "text", text: "First note", metrics: [], dimensions: [], format: { textSize: 24 }, layout: { x: 24, y: 24, w: 600, h: 180 } },
    { id: "second", title: "Second note", kind: "text", text: "Second note", metrics: [], dimensions: [], format: { textSize: 32 }, layout: { x: 24, y: 228, w: 600, h: 180 } },
  ] };
  expect((await request.post("/api/dashboards", { data: { id, spec } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const first = page.locator(".note-text").filter({ hasText: "First note" });
  await first.click();
  const size = page.locator(".inspector").getByRole("spinbutton", { name: /Size/ });
  await expect(size).toHaveValue("24");
  for (const invalid of ["", "0", "-10", "501"]) {
    await size.fill(invalid);
    await expect(size).toHaveValue(invalid);
    await expect(size).toHaveAttribute("aria-invalid", "true");
    await expect(first).toHaveCSS("font-size", "24px");
    await expect(page.locator(".save-status")).toHaveText("Saved");
    await size.press("Tab");
    await expect(size).toHaveValue("24");
  }
  await size.fill("36.5");
  await size.press("Enter");
  await expect(first).toHaveCSS("font-size", "36.5px");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await size.fill("100");
  await size.press("Escape");
  await expect(size).toHaveValue("36.5");
  await expect(first).toHaveCSS("font-size", "36.5px");
  await size.fill("1"); await size.press("Tab");
  await expect(first).toHaveCSS("font-size", "1px");
  await size.fill("500"); await size.press("Tab");
  await expect(first).toHaveCSS("font-size", "500px");
  await size.fill("36.5"); await size.press("Tab");
  await size.fill("999");
  await page.locator(".note-text").filter({ hasText: "Second note" }).click();
  await expect(size).toHaveValue("32");
  const saved = page.waitForResponse(r => r.url().endsWith("/api/dashboards") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const current = await (await request.get(`/api/dashboards/${id}`)).json();
  expect(current.spec.tiles.map((t: any) => t.format.textSize)).toEqual([36.5, 32]);
  const original = await (await request.get(`/api/dashboards/${id}/versions/1`)).json();
  expect(original.spec.tiles.map((t: any) => t.format.textSize)).toEqual([24, 32]);
});
