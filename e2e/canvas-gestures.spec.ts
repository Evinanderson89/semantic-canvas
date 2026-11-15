import { expect, test, type Page } from "@playwright/test";
import type { TileSpec } from "../src/compiler/spec.ts";

const state = async (page: Page) => JSON.parse(await page.locator("#gesture-state").textContent() ?? "null") as { tiles: TileSpec[]; selected: string[]; history: number };
const layouts = async (page: Page) => (await state(page)).tiles.map(t => t.layout);
async function begin(page: Page, handle?: string) {
  const target = page.locator(".node").first().locator(handle ? `.handle.${handle}` : ".node-inner");
  const box = (await target.boundingBox())!;
  const start = { x: box.x + (handle ? box.width / 2 : 30), y: box.y + (handle ? box.height / 2 : 30) };
  await page.evaluate(() => window.addEventListener("pointerdown", e => { document.body.dataset.pointerId = String(e.pointerId); }, { once: true, capture: true }));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return { ...start, pointerId: Number(await page.locator("body").getAttribute("data-pointer-id")) };
}
test.beforeEach(async ({ page }) => { await page.goto("/e2e/fixtures/canvas-gestures.html"); });

test("holding a resize key respects the pointer minimum and creates one undo boundary", async ({ page }) => {
  const before = await layouts(page);
  await page.locator(".node").first().focus();
  await page.keyboard.down("Alt"); await page.keyboard.down("Shift");
  for (let i = 0; i < 30; i++) await page.keyboard.down("ArrowUp");
  await page.keyboard.up("ArrowUp"); await page.keyboard.up("Shift"); await page.keyboard.up("Alt");
  expect((await layouts(page))[0].h).toBe(60);
  expect((await state(page)).history).toBe(1);
  await page.getByRole("button", { name: "Undo gesture", exact: true }).click();
  expect(await layouts(page)).toEqual(before);
});

test("pointer cancellation restores the layout and cannot become a sticky drag or an undo entry", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + 73, start.y);
  await expect.poll(() => layouts(page)).not.toEqual(before);
  await expect(page.locator(".guide")).not.toHaveCount(0);
  await page.locator(".node").first().dispatchEvent("pointercancel", { pointerId: start.pointerId, bubbles: true });
  await expect.poll(() => layouts(page), { timeout: 2000 }).toEqual(before);
  await expect(page.locator(".canvas-surface")).not.toHaveClass(/dragging/);
  await expect(page.locator(".guide")).toHaveCount(0);
  await page.mouse.move(start.x + 140, start.y + 100);
  await page.mouse.up();
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).history).toBe(0);
});

test("shift-click can remove a selected tile without replacing the rest of the selection", async ({ page }) => {
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.locator(".node").nth(1).locator(".node-inner").click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await state(page)).selected, { timeout: 2000 }).toEqual(["a", "c"]);
  expect((await state(page)).history).toBe(0);
});

test("a click with fractional pointer jitter does not create an undo entry", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + .2, start.y + .2);
  await page.mouse.up();
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).history).toBe(0);
});

test("capture released before pointerup cancels even without another movement", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + 73, start.y + 59);
  await expect.poll(() => layouts(page)).not.toEqual(before);
  await page.locator(".node").first().evaluate((node, id) => node.releasePointerCapture(id), start.pointerId);
  await page.mouse.up();
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).history).toBe(0);
  await expect(page.locator(".canvas-surface")).not.toHaveClass(/dragging/);
});

for (const interruption of ["Escape", "capture loss", "window blur", "canvas lock", "resize cancel"]) {
  test(`${interruption} restores only the unfinished gesture and lets subsequent pointer events pass harmlessly`, async ({ page }) => {
    const before = await layouts(page), start = await begin(page, interruption === "resize cancel" ? "se" : undefined);
    await page.mouse.move(start.x + 73, start.y + 59);
    await expect.poll(() => layouts(page)).not.toEqual(before);
    if (interruption === "Escape") await page.keyboard.press("Escape");
    else if (interruption === "capture loss") {
      await page.locator(".node").first().evaluate((node, id) => node.releasePointerCapture(id), start.pointerId);
      await page.mouse.move(start.x + 74, start.y + 59);
    } else if (interruption === "window blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else if (interruption === "canvas lock") await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-update", { detail: "lock" })));
    else await page.locator(".node").first().dispatchEvent("pointercancel", { pointerId: start.pointerId, bubbles: true });
    await expect.poll(() => layouts(page)).toEqual(before);
    await expect(page.locator(".canvas-surface")).not.toHaveClass(/dragging/);
    await page.mouse.move(start.x + 160, start.y + 100);
    await page.mouse.up();
    expect(await layouts(page)).toEqual(before);
    expect((await state(page)).history).toBe(0);
  });
}

test("shift-selected groups move at the current zoom, keep pins and card sizes, and undo once", async ({ page }) => {
  await page.getByRole("button", { name: "Zoom to 75%", exact: true }).click();
  await page.getByRole("button", { name: "Enable snapping", exact: true }).click();
  await page.locator(".node").nth(1).locator(".node-inner").click({ modifiers: ["Shift"] });
  await page.locator(".node").nth(2).locator(".node-inner").click({ modifiers: ["Shift"] });
  expect((await state(page)).selected).toEqual(["a", "b", "c"]);
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + 73, start.y + 59, { steps: 4 });
  // A model-driven title update during dragging must survive both completion
  // and undo; the gesture owns geometry, not that unrelated content edit.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-update", { detail: "rename" })));
  await expect.poll(async () => (await state(page)).tiles[0].title).toBe("Revenue updated");
  await page.mouse.up();
  const after = await state(page);
  expect(after.selected).toEqual(["a", "b", "c"]);
  expect(after.tiles[0].layout).toEqual({ ...before[0], x: before[0].x + 96, y: before[0].y + 80 });
  expect(after.tiles[1].layout).toEqual({ ...before[1], x: before[1].x + 96, y: before[1].y + 80 });
  expect(after.tiles[2].layout).toEqual(before[2]);
  expect(after.history).toBe(1);
  await page.getByRole("button", { name: "Undo gesture", exact: true }).click();
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).tiles[0].title).toBe("Revenue updated");
  expect((await state(page)).history).toBe(0);
});

test("another pointer cannot move, cancel, or commit the active pointer's gesture", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  for (const type of ["pointermove", "pointerup", "pointercancel"]) await page.locator(".node").first().dispatchEvent(type, {
    pointerId: start.pointerId + 100, clientX: start.x + 200, clientY: start.y + 100, buttons: 1, bubbles: true,
  });
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).history).toBe(0);
  // Unrelated pointers must not turn the initial press into a drag.
  await expect(page.locator(".canvas-surface")).not.toHaveClass(/dragging/);
  await page.mouse.move(start.x + 73, start.y + 59);
  await expect(page.locator(".canvas-surface")).toHaveClass(/dragging/);
  await page.mouse.up();
  const completed = await layouts(page);
  expect(completed).not.toEqual(before);
  expect((await state(page)).history).toBe(1);
  await page.locator(".node").first().dispatchEvent("lostpointercapture", { pointerId: start.pointerId, bubbles: true });
  expect(await layouts(page)).toEqual(completed);
  expect((await state(page)).history).toBe(1);
});

test("moving away and returning to the original geometry does not create an undo entry", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + 73, start.y + 59);
  await page.mouse.move(start.x, start.y);
  await page.mouse.up();
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).history).toBe(0);
});

test("cancellation preserves concurrent content edits and never resurrects a removed tile", async ({ page }) => {
  const before = await layouts(page), start = await begin(page);
  await page.mouse.move(start.x + 73, start.y + 59);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-update", { detail: "rename" })));
  await expect.poll(async () => (await state(page)).tiles[0].title).toBe("Revenue updated");
  await page.locator(".node").first().dispatchEvent("pointercancel", { pointerId: start.pointerId, bubbles: true });
  expect(await layouts(page)).toEqual(before);
  expect((await state(page)).tiles[0].title).toBe("Revenue updated");
  await page.mouse.up();
  const second = await begin(page);
  await page.mouse.move(second.x + 73, second.y + 59);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-update", { detail: "remove" })));
  await expect(page.locator(".node")).toHaveCount(2);
  await page.evaluate(id => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id })), second.pointerId);
  await page.mouse.up();
  expect((await state(page)).tiles.map(t => t.id)).toEqual(["b", "c"]);
  expect((await state(page)).history).toBe(0);
});
