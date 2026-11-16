import { expect, test } from "@playwright/test";

test("connects through the local MCP check and offers both clients without an API key", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: false } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect Claude", exact: true });
  await panel.getByRole("button", { name: "Connect Claude", exact: true }).click();
  await expect(panel).toContainText("no Anthropic API key is needed");
  await expect(panel.getByLabel("Claude Desktop configuration")).toContainText("http://127.0.0.1:5274");
  await panel.getByRole("button", { name: "Copy Desktop configuration", exact: true }).click();
  const desktop = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(desktop.mcpServers["semantic-canvas"].env).toEqual({ SEMANTIC_CANVAS_URL: "http://127.0.0.1:5274" });
  await panel.getByRole("button", { name: "Test local connection", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Local MCP check passed" })).toContainText("11 tools");
  await expect(panel).toContainText("does not contact Claude or verify your client configuration");
  await panel.getByRole("button", { name: "Claude Code", exact: true }).click();
  await panel.getByRole("button", { name: "Copy Claude Code command", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("claude mcp add-json --scope user semantic-canvas");
  await panel.getByRole("button", { name: "Copy starter prompt", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("ask me before saving a new dashboard");
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../outputs/semantic-canvas-local/claude-connection.png", fullPage: true });
});

test("reports a failed local check and lets the user retry without claiming Claude is connected", async ({ page }) => {
  let checks = 0;
  await page.route("**/api/setup/claude/check?*", route => {
    checks++;
    return checks === 1 ? route.fulfill({ status: 503, json: { error: "Metric source is unavailable. Try again." } })
      : route.fulfill({ json: { tools: 11, metrics: 48, source: "sample", checkedAt: new Date().toISOString() } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect Claude", exact: true });
  await panel.getByRole("button", { name: "Connect Claude", exact: true }).click();
  await panel.getByRole("button", { name: "Test local connection", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Metric source is unavailable");
  await expect(panel).not.toContainText("Local MCP check passed");
  await panel.getByRole("button", { name: "Test local connection", exact: true }).click();
  await expect(panel).toContainText("Local MCP check passed");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("does not offer configuration or a probe when the server reports company mode", async ({ page }) => {
  await page.route("**/api/setup/claude", route => route.fulfill({ json: { available: false, reason: "Authenticated company connections are not supported yet." } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect Claude", exact: true });
  await panel.getByRole("button", { name: "Connect Claude", exact: true }).click();
  await expect(panel).toContainText("Authenticated company connections are not supported yet");
  await expect(panel.getByRole("button", { name: "Test local connection", exact: true })).toHaveCount(0);
  await expect(panel.locator("pre")).toHaveCount(0);
});
