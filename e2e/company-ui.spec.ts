import { openStarter } from "./library-helpers.ts";
import { test, expect } from "@playwright/test";

test("browser acceptance uses only the synthetic source and no configured AI provider", async ({ request }) => {
  const status = await (await request.get("/api/agent/status")).json();
  expect(status.configured).toBe(false);
  const sources = await (await request.get("/api/sources")).json();
  expect(sources.sources.map((s: any) => s.id)).toEqual(["duckglue-local"]);
});

test("an upstream 401 cannot sign a trusted local workspace out", async ({ page }) => {
  await page.route("**/api/failed-provider-probe", route => route.fulfill({ status: 401, json: { error: "Provider authentication failed" } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toBeVisible();
  await page.evaluate(() => fetch("/api/failed-provider-probe"));
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toHaveCount(0);
});

test("silent renewal updates the CSRF used by later writes", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/auth/session", route => {
    reads++;
    return route.fulfill({ json: { mode: "team", authenticated: true, user: { id: "renewing-editor", name: "Editor", role: "editor" }, csrf: reads === 1 ? "old-csrf" : "renewed-csrf", canEdit: true, canAdmin: false, gatewayUrl: "https://portal.example.test", expiresAt: Date.now() + (reads === 1 ? 60_000 : 3_600_000) } });
  });
  await page.route("https://portal.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(page.locator('iframe[src*="portal.example.test/auth/refresh"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://portal.example.test", data: { type: "gateway:session" } })));
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('iframe[src*="portal.example.test/auth/refresh"]')).toHaveCount(0);
  await page.getByRole("button", { name: /^Start from scratch/ }).click();
  const write = page.waitForRequest(r => r.url().endsWith("/api/dashboards") && r.method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await write).headers()["x-sc-csrf"]).toBe("renewed-csrf");
});

test("leaving an expired session cancels the renewal fallback instead of reopening it later", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/auth/session", route => {
    reads++;
    return route.fulfill({ json: { mode: "team", authenticated: true, user: { id: "expiring-editor", name: "Editor", role: "editor" }, csrf: "old-csrf", canEdit: true, canAdmin: false, gatewayUrl: "https://portal.example.test", expiresAt: Date.now() + 60_000 } });
  });
  await page.route("https://portal.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.route("**/api/expiry-probe", route => route.fulfill({ status: 401, json: { error: "Expired" } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(page.locator('iframe[src*="portal.example.test/auth/refresh"]')).toHaveCount(1);
  await page.evaluate(() => fetch("/api/expiry-probe"));
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toBeVisible();
  await expect(page.locator('iframe[src*="portal.example.test/auth/refresh"]')).toHaveCount(0);
  const before = reads;
  await page.clock.fastForward(70_000);
  expect(reads).toBe(before);
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toBeVisible();
});

test("company sign-in keeps data behind the sign-in screen", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/auth/session", route => route.fulfill({ json: { mode: "team", authenticated: false } }));
  const protectedRequests: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && path !== "/api/auth/session") protectedRequests.push(path); });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toHaveAttribute("href", "/api/auth/login");
  await page.clock.fastForward(120_000);
  expect(protectedRequests).toEqual([]);
  await expect(page.getByLabel("Acting as")).toHaveCount(0);
});

for (const change of ["account", "role", "policy", "signed out", "malformed session"] as const) test(`silent renewal closes the old workspace after ${change} changes`, async ({ page }) => {
  await page.clock.install();
  const original = { mode: "team", authenticated: true, user: { id: "renewal-original", name: "Original editor", role: "editor" }, csrf: "old-csrf", canEdit: true, canAdmin: false,
    gatewayUrl: "https://portal.example.test", expiresAt: Date.now() + 60_000 };
  const refreshed = change === "account" ? { ...original, user: { ...original.user, id: "renewal-other" } }
    : change === "role" ? { ...original, canEdit: false, user: { ...original.user, role: "viewer" } }
    : change === "policy" ? { ...original, policy: [{ field: "dim_users.country", mode: "only", values: ["DE"] }] }
    : change === "malformed session" ? { ...original, authenticated: "false" }
    : { mode: "team", authenticated: false, gatewayUrl: original.gatewayUrl };
  let reads = 0;
  await page.route("**/api/auth/session", route => route.fulfill({ json: ++reads === 1 ? original : refreshed }));
  await page.route("https://portal.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto("/");
  await page.getByRole("button", { name: /^Start from scratch/ }).click();
  await expect(page.getByLabel("Dashboard mode", { exact: true })).toContainText("EDIT MODE");
  await page.evaluate(() => { (window as any).__sessionEndings = 0; window.addEventListener("sc:session-ending", () => { (window as any).__sessionEndings++; }); });
  await page.clock.fastForward(5_000);
  await expect(page.locator('iframe[src*="portal.example.test/auth/refresh"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://portal.example.test", data: { type: "gateway:session" } })));
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toBeVisible();
  await expect(page.getByLabel("Dashboard mode", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__sessionEndings)).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem("sc:team:renewal-original:drafts"))).toContain("Untitled dashboard");
  expect(await page.evaluate(() => sessionStorage.getItem("sc:team:renewal-other:drafts"))).toBeNull();
  await page.clock.fastForward(120_000);
  expect(reads).toBe(2);
});

test("pending and malformed sign-in responses never start protected data requests", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/session", async route => { await held; await route.fulfill({ json: { mode: "team", authenticated: "false", canEdit: true, canAdmin: true } }); });
  const protectedRequests: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && path !== "/api/auth/session") protectedRequests.push(path); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  expect(protectedRequests).toEqual([]);
  release();
  await expect(page.getByText("We couldn’t verify your workspace session. Check the connection and try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  expect(protectedRequests).toEqual([]);
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toHaveCount(0);
});
test("viewer workspace hides role simulation and editing controls", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { mode: "team", authenticated: true, user: { id: "test-viewer", name: "Company viewer", role: "viewer" }, csrf: "test-csrf", canEdit: false, canAdmin: false } }));
  await page.goto("/");
  await expect(page.getByText("Your metrics, in focus.")).toBeVisible();
  await expect(page.getByLabel("Acting as")).toHaveCount(0);
  await openStarter(page, "Dashboard cleanup demo");
  await expect(page.getByRole("button", { name: "Save dashboard", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit dashboard", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Smart arrange", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add source", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review setup", exact: true })).toHaveCount(0);
});
test("administrator can review setup and download a library backup", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  await expect(page.getByText("Service is running", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download dashboard library", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^semantic-canvas-library-.*\.json$/);
});

test("company edits use CSRF and account-specific drafts survive session expiry without appearing for another user", async ({ page }) => {
  let userId = "editor-one";
  await page.route("**/api/auth/session", route => route.fulfill({ json: { mode: "team", authenticated: true, user: { id: userId, name: userId, role: "editor" }, csrf: "browser-session-csrf", canEdit: true, canAdmin: false } }));
  await page.goto("/");
  await page.getByRole("button", { name: /^Start from scratch/ }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("sc:team:editor-one:drafts"))).toContain("Untitled dashboard");
  expect(await page.evaluate(() => localStorage.getItem("sc:drafts"))).toBeNull();
  const saved = page.waitForRequest(r => r.url().endsWith("/api/dashboards") && r.method() === "POST");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  expect((await saved).headers()["x-sc-csrf"]).toBe("browser-session-csrf");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: false }).click();
  await page.getByRole("button", { name: /^Start from scratch/ }).click();
  await page.route("**/api/agent/status", route => route.fulfill({ status: 401, json: { error: "Session expired" } }));
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("sc:team:editor-one:drafts"))).toContain("Untitled dashboard");
  await page.unroute("**/api/agent/status"); userId = "editor-two";
  await page.reload();
  await expect(page.getByRole("button", { name: /^Start from scratch/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Recover draft:/ })).toHaveCount(0);
});


test("an account change in another tab closes the old account's workspace", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { mode: "team", authenticated: true, user: { id: "original-user", name: "Original", role: "viewer" }, csrf: "first-csrf", canEdit: false, canAdmin: false } }));
  await page.goto("/");
  await expect(page.getByText("Your metrics, in focus.")).toBeVisible();
  await page.route("**/api/agent/status", route => route.fulfill({ headers: { "x-sc-user-id": "different-user" }, json: { configured: false } }));
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toBeVisible();
  await expect(page.getByText("Your metrics, in focus.")).toHaveCount(0);
});
