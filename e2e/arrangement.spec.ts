import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test("story and executive arrangements preview before applying and support undo", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/"); await openStarter(page, "SaaS overview");
  const geometry = () => page.locator(".node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style")));
  const initial = await geometry();
  await page.getByRole("button", { name: "Smart arrange", exact: true }).click();
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tell a story", exact: true })).toHaveAttribute("aria-pressed", "true");
  const story = await page.getByRole("img", { name: "Proposed dashboard layout" }).innerHTML();
  expect(await geometry()).toEqual(initial);
  await page.getByRole("button", { name: "Build an executive dashboard", exact: true }).click();
  expect(await page.getByRole("img", { name: "Proposed dashboard layout" }).innerHTML()).not.toEqual(story);
  await page.getByRole("button", { name: "Tell a story", exact: true }).click();
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  expect(await geometry()).not.toEqual(initial);
  await expect(page.locator(".heading-text")).toHaveText(["At a glance", "How it's changing", "Supporting context"]);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(geometry).toEqual(initial);
});
