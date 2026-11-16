import { expect, test, type Locator } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

/** Read browser-resolved colors, including color-mix(), and composite opacity. */
async function contrast(element: Locator, property: "color" | "borderTopColor" = "color", pseudo?: string) {
  await element.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))); });
  return element.evaluate((el, { property, pseudo }) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3] / 255 + back[i] * (1 - front[3] / 255));
    const chain: Element[] = []; for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node);
    let background = [255, 255, 255], opacity = 1;
    for (const node of chain) {
      const style = getComputedStyle(node);
      // A control's outer border is identified against its surroundings, not
      // against its own fill (the checked switch uses the same color for both).
      if (node !== el || property !== "borderTopColor") background = over(rgba(style.backgroundColor), background);
      opacity *= Number(style.opacity);
    }
    const style = getComputedStyle(el, pseudo);
    if (pseudo) opacity *= Number(style.opacity);
    const foreground = rgba(style[property]); foreground[3] *= opacity;
    const effective = over(foreground, background);
    const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const a = luminance(effective), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground: effective, background, opacity };
  }, { property, pseudo });
}

for (const theme of ["light", "dark"] as const) test(`${theme} chart controls remain visible at rest and settings have clear boundaries`, async ({ page }, info) => {
  await page.goto("/");
  if (theme === "dark") await page.getByRole("button", { name: "Switch to dark appearance" }).click();
  await openStarter(page, "SaaS overview");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const readings: Record<string, unknown> = {};
  for (const name of ["Chart chats", "Chart notifications"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    await toggle.uncheck(); await page.mouse.move(0, 0); await toggle.blur();
    readings[`${name} off border`] = await contrast(toggle, "borderTopColor");
    expect.soft((readings[`${name} off border`] as any).ratio).toBeGreaterThanOrEqual(3);
    await toggle.check(); await page.mouse.move(0, 0); await toggle.blur();
    readings[`${name} on border`] = await contrast(toggle, "borderTopColor");
    expect.soft((readings[`${name} on border`] as any).ratio).toBeGreaterThanOrEqual(3);
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const tile = page.getByRole("group", { name: "Recurring revenue · monthly closing balance", exact: true });
  await page.mouse.move(0, 0);
  const more = tile.getByRole("button", { name: "More chart actions", exact: true });
  readings.more = await contrast(more);
  expect.soft((readings.more as any).ratio).toBeGreaterThanOrEqual(3);
  // Exercise each presentation class on actual chart-control markup, independently
  // of alert scheduling and comment persistence (covered in activity.spec.ts).
  const comment = tile.getByRole("button", { name: /^Chart comments/ });
  for (const state of ["", "has-activity", "is-watching", "has-alert"]) {
    await comment.evaluate((el, state) => { el.classList.remove("has-activity", "is-watching", "has-alert"); if (state) el.classList.add(state); }, state);
    const reading = await contrast(comment.locator("svg")); readings[state || "idle"] = reading;
    expect.soft(reading.ratio, `${theme} ${state || "idle"}: ${JSON.stringify(reading)}`).toBeGreaterThanOrEqual(3);
  }
  await info.attach("computed-contrast", { body: JSON.stringify(readings, null, 2), contentType: "application/json" });
});
