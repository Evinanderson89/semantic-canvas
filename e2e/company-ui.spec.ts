import { openStarter } from "./library-helpers.ts";
import { test, expect } from "@playwright/test";

test("company sign-in keeps data behind the sign-in screen", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { mode: "team", authenticated: false } }));
  let modelRequests = 0; page.on("request", request => { if (request.url().endsWith("/api/model")) modelRequests++; });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Continue with company sign-in" })).toHaveAttribute("href", "/api/auth/login");
  expect(modelRequests).toBe(0);
  await expect(page.getByLabel("Acting as")).toHaveCount(0);
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
