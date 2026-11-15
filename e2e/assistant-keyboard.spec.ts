import { expect, test } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
  await page.goto("/");
  await openStarter(page, "Dashboard cleanup demo");
});

test("assistant opening labels and focuses the composer and closing restores the toggle", async ({ page }) => {
  const toggle = page.locator(".agent-chat-toggle");
  await toggle.focus(); await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Canvas assistant", exact: true });
  const input = panel.getByRole("textbox", { name: "Message the agent", exact: true });
  await expect(input).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await input.fill("Help me tell the retention story");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Help me tell the retention story");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(toggle).toBeFocused();
});

test("sending, stopping and failed responses leave a usable keyboard composer", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route("**/api/agent/chat", async route => {
    if (++requests === 1) { await gate; await route.fulfill({ json: { text: "Cancelled answer" } }).catch(() => {}); }
    else await route.fulfill({ status: 503, json: { error: "Synthetic provider unavailable" } });
  });
  await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
  const panel = page.getByRole("region", { name: "Canvas assistant", exact: true });
  const input = panel.getByRole("textbox", { name: "Message the agent", exact: true });
  await input.fill("Find the strongest comparison"); await page.keyboard.press("Enter");
  try {
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("readonly", "");
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await expect(input).toBeEditable();
  } finally { release(); }
  await input.fill("Try the comparison again"); await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toContainText("Synthetic provider unavailable");
  await expect(input).toBeFocused();
  await expect(input).toBeEditable();
  await expect(panel.getByRole("log", { name: "Conversation" })).not.toContainText("Cancelled answer");
});

for (const action of ["Apply changes", "Dismiss"]) test(`${action} returns focus from the removed proposal to the composer`, async ({ page }) => {
  await page.route("**/api/agent/chat", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { proposal: { title: "Clarify the first chart", reason: "Use an explicit chart label.",
      actions: [{ type: "title", id: body.document.spec.tiles[0].id, title: "Reviewed chart label" }] } } });
  });
  await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
  const panel = page.getByRole("region", { name: "Canvas assistant", exact: true });
  const input = panel.getByRole("textbox", { name: "Message the agent", exact: true });
  await input.fill("Clarify this chart"); await page.keyboard.press("Enter");
  const button = panel.getByRole("button", { name: action, exact: true });
  await button.focus(); await page.keyboard.press("Enter");
  await expect(panel.locator(".canvas-proposal")).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.fill("Continue with the next improvement");
  await expect(input).toHaveValue("Continue with the next improvement");
});

test("an arriving reply does not take focus away from canvas editing", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agent/chat", async route => { await gate; await route.fulfill({ json: { text: "Inspect the existing revenue base." } }); });
  await page.getByRole("button", { name: "Open agent chat", exact: true }).click();
  const panel = page.getByRole("region", { name: "Canvas assistant", exact: true });
  await panel.getByRole("textbox", { name: "Message the agent", exact: true }).fill("Review the current story");
  await page.keyboard.press("Enter");
  try {
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Web sessions", exact: true }).focus();
  } finally { release(); }
  await expect(panel.getByRole("log", { name: "Conversation" })).toContainText("Inspect the existing revenue base.");
  await expect(page.getByRole("group", { name: "Web sessions", exact: true })).toBeFocused();
});
