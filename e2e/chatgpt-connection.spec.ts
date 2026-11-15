import { expect, test } from "@playwright/test";

test("offers a scoped ChatGPT tunnel setup and verifies real local tools without claiming ChatGPT is connected", async ({ page, context }) => {
  const duplicateKeys: string[] = [];
  page.on("console", message => { if (message.text().includes("same key")) duplicateKeys.push(message.text()); });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect ChatGPT", exact: true });
  await panel.getByRole("button", { name: "Connect ChatGPT", exact: true }).click();
  await expect(panel.getByLabel("ChatGPT dashboard access")).toHaveValue("explore");
  await expect(panel.getByRole("button", { name: "Check ChatGPT local tools" })).toHaveCount(0);
  await panel.getByLabel("ChatGPT row-access principal").selectOption("emea");
  await panel.getByRole("button", { name: "Check ChatGPT local tools", exact: true }).click();
  await expect(panel).toContainText("Local MCP check passed: 8 tools");
  await expect(panel).toContainText("ChatGPT and the tunnel have not been checked");
  await panel.getByLabel("OpenAI tunnel ID").fill("tunnel_local_test");
  const command = panel.getByLabel("ChatGPT tunnel commands");
  await expect(command).toContainText("127.0.0.1:5274");
  await expect(command).toContainText("chatgptServer.ts");
  await panel.getByRole("button", { name: "Copy tunnel commands", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("tunnel-client init");
  expect(copied).toContain("emea");
  expect(copied).not.toContain("API_KEY=");
  await panel.getByLabel("ChatGPT dashboard access").selectOption("build");
  await expect(panel).not.toContainText("Local MCP check passed");
  await panel.getByRole("button", { name: "Check ChatGPT local tools", exact: true }).click();
  await expect(panel).toContainText("Local MCP check passed: 10 tools");
  await expect(panel).toContainText("create, overwrite and rearrange saved dashboards");
  await panel.getByRole("button", { name: "Copy ChatGPT starter prompt" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Ask before saving");
  await panel.getByLabel("OpenAI tunnel ID").fill("tunnel_x; echo bad");
  await expect(command).toHaveCount(0);
  await panel.getByLabel("OpenAI tunnel ID").fill("tunnel_local_test");
  await panel.getByRole("heading", { name: "Explore and build dashboards from ChatGPT." }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../outputs/semantic-canvas-local/chatgpt-connection.png" });
  await page.setViewportSize({ width: 900, height: 900 });
  await panel.getByLabel("ChatGPT dashboard access").scrollIntoViewIfNeeded();
  const dimensions = await panel.getByLabel("ChatGPT dashboard access").evaluate(el => ({ width: el.getBoundingClientRect().width, parent: el.parentElement!.getBoundingClientRect().width }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.parent);
  expect(duplicateKeys).toEqual([]);
});

test("a scope change cancels a pending check and never presents its old success", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/setup/chatgpt/check?*", async route => {
    await delayed;
    await route.fulfill({ json: { tools: 8, metrics: 47, checkedAt: new Date().toISOString() } }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect ChatGPT", exact: true });
  await panel.getByRole("button", { name: "Connect ChatGPT", exact: true }).click();
  await panel.getByLabel("ChatGPT row-access principal").selectOption("emea");
  await panel.getByRole("button", { name: "Check ChatGPT local tools" }).click();
  await expect(panel.getByRole("button", { name: "Checking local MCP…" })).toBeDisabled();
  await panel.getByLabel("ChatGPT row-access principal").selectOption("amer");
  release();
  await expect(panel.getByRole("button", { name: "Check ChatGPT local tools" })).toBeEnabled();
  await expect(panel).not.toContainText("Local MCP check passed");
});

test("company mode explains its boundary without offering local setup commands", async ({ page }) => {
  await page.route("**/api/setup/chatgpt?*", route => route.fulfill({ json: { available: false, reason: "Company sign-in delegation is not supported yet." } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Connect ChatGPT", exact: true });
  await panel.getByRole("button", { name: "Connect ChatGPT", exact: true }).click();
  await expect(panel).toContainText("Company sign-in delegation is not supported yet");
  await expect(panel.getByLabel("ChatGPT row-access principal")).toHaveCount(0);
  await expect(panel.locator("pre")).toHaveCount(0);
});
