import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider is replaced so these cases run in this process; the simulated
// provider profiles cover the same paths against a real server over HTTPS.
const oidc = vi.hoisted(() => ({
  discovery: vi.fn(), authorizationCodeGrant: vi.fn(), refreshTokenGrant: vi.fn(), enableNonRepudiationChecks: vi.fn(),
  ClientSecretBasic: vi.fn((secret: string) => ({ method: "client_secret_basic", secret })),
  ClientSecretPost: vi.fn((secret: string) => ({ method: "client_secret_post", secret })),
  randomPKCECodeVerifier: () => "verifier", randomNonce: () => "nonce", randomState: () => "state",
  calculatePKCECodeChallenge: async () => "challenge",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => new URL(`https://idp.example.test/authorize?state=${params.state}`),
}));
vi.mock("openid-client", () => oidc);
import { CompanyAuth, loadAuthConfig, type AuthConfig } from "../src/security/auth.ts";

const access = { groupsClaim: "groups", bindings: [{ group: "admins", role: "admin" as const, principal: "admin", sources: ["*"] }] };
const config = (extra: Partial<AuthConfig> = {}): AuthConfig => ({ mode: "team", scopes: "openid", sessionSeconds: 3600, publicUrl: "https://canvas.example.test",
  issuer: "https://idp.example.test/", clientId: "canvas", clientSecret: "secret", access, ...extra });
const provider = (methods?: string[]) => ({ serverMetadata: () => ({ token_endpoint_auth_methods_supported: methods }) });
const methodsUsed = () => oidc.discovery.mock.calls.map(call => call[3].method);

let server: Server | undefined;
beforeEach(() => { for (const mock of [oidc.discovery, oidc.authorizationCodeGrant, oidc.refreshTokenGrant, oidc.enableNonRepudiationChecks]) mock.mockReset(); });
afterEach(async () => { vi.useRealTimers(); if (server) await new Promise(resolve => server!.close(resolve)); server = undefined; });

it("chooses client authentication from configuration, then discovery, and always enables signature checks", async () => {
  oidc.discovery.mockResolvedValue(provider(["client_secret_basic", "client_secret_post"]));
  await new CompanyAuth(config()).start();
  expect(methodsUsed()).toEqual(["client_secret_post"]);
  oidc.discovery.mockReset().mockResolvedValue(provider(["client_secret_basic"]));
  await new CompanyAuth(config()).start();
  // Discovery advertises only the header method: reconnect with it.
  expect(methodsUsed()).toEqual(["client_secret_post", "client_secret_basic"]);
  oidc.discovery.mockReset().mockResolvedValue(provider(["client_secret_basic", "client_secret_post"]));
  await new CompanyAuth(config({ clientAuth: "client_secret_basic" })).start();
  expect(methodsUsed()).toEqual(["client_secret_basic"]);
  // An explicit choice is never overridden, and a provider that omits the list keeps the default.
  oidc.discovery.mockReset().mockResolvedValue(provider(["client_secret_basic"]));
  await new CompanyAuth(config({ clientAuth: "client_secret_post" })).start();
  oidc.discovery.mockResolvedValue(provider(undefined));
  await new CompanyAuth(config()).start();
  expect(methodsUsed()).toEqual(["client_secret_post", "client_secret_post"]);
  expect(oidc.enableNonRepudiationChecks).toHaveBeenCalledTimes(5);
});

it("validates SC_OIDC_CLIENT_AUTH at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-team-signin-"));
  try {
    await writeFile(join(dir, "access.yaml"), JSON.stringify(access));
    const env = { SC_MODE: "team", SC_PUBLIC_URL: "https://canvas.example.test", SC_OIDC_ISSUER: "https://idp.example.test", SC_OIDC_CLIENT_ID: "canvas", SC_OIDC_CLIENT_SECRET: "secret", SC_ACCESS_PATH: join(dir, "access.yaml") };
    expect((await loadAuthConfig(env)).clientAuth).toBeUndefined();
    expect((await loadAuthConfig({ ...env, SC_OIDC_CLIENT_AUTH: " client_secret_basic " })).clientAuth).toBe("client_secret_basic");
    await expect(loadAuthConfig({ ...env, SC_OIDC_CLIENT_AUTH: "private_key_jwt" })).rejects.toThrow(/SC_OIDC_CLIENT_AUTH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("records a safe reason code for a failed callback and re-reads provider keys only for an unknown key, at most once per interval", async () => {
  const events: [string, unknown][] = [];
  oidc.discovery.mockResolvedValue(provider(["client_secret_post"]));
  const auth = new CompanyAuth(config(), (event, data) => events.push([event, data]));
  await auth.start();
  const app = express(); auth.mount(app);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const attempt = async () => {
    const start = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
    const cookie = start.headers.getSetCookie()[0].split(";")[0];
    return fetch(`${base}/api/auth/callback?code=c&state=state`, { headers: { cookie }, redirect: "manual" });
  };
  const failures = () => events.filter(([event]) => event === "auth.callback_failed").map(([, data]) => (data as any).errorType);
  const refreshed = () => events.filter(([event]) => event === "auth.provider_keys_refreshed").length;

  oidc.authorizationCodeGrant.mockRejectedValueOnce(Object.assign(new Error("client authentication failed"), { error: "invalid_client" }));
  expect((await attempt()).status).toBe(400);
  // Messages can carry URLs or claims: a value that is not a short code is never logged.
  oidc.authorizationCodeGrant.mockRejectedValueOnce(Object.assign(new Error("x"), { error: "https://idp.example.test/?token=abc", code: "bad code with spaces", name: "" }));
  expect((await attempt()).status).toBe(400);
  oidc.authorizationCodeGrant.mockRejectedValueOnce("not an error object");
  expect((await attempt()).status).toBe(400);
  expect(failures()).toEqual(["invalid_client", "unknown", "unknown"]);
  expect(oidc.discovery).toHaveBeenCalledTimes(1);

  const unknownKey = () => Object.assign(new Error("no applicable keys found"), { code: "OAUTH_KEY_SELECTION_FAILED" });
  oidc.authorizationCodeGrant.mockRejectedValueOnce(unknownKey()).mockRejectedValueOnce(unknownKey());
  expect((await attempt()).status).toBe(400);
  expect((await attempt()).status).toBe(400);
  await vi.waitFor(() => expect(refreshed()).toBe(1));
  // Two failures inside the interval reconnect once.
  expect(oidc.discovery).toHaveBeenCalledTimes(2);

  // A failed reconnect keeps the working configuration and is recorded.
  const realNow = Date.now; vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11_000);
  oidc.discovery.mockRejectedValueOnce(new Error("provider unreachable"));
  oidc.authorizationCodeGrant.mockRejectedValueOnce(unknownKey());
  expect((await attempt()).status).toBe(400);
  await vi.waitFor(() => expect(events.some(([event]) => event === "auth.provider_refresh_failed")).toBe(true));
  vi.restoreAllMocks();
  expect((await fetch(`${base}/api/auth/login`, { redirect: "manual" })).status).toBe(302);
});

it("validates SC_SESSION_RECHECK_SECONDS at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-team-recheck-"));
  try {
    await writeFile(join(dir, "access.yaml"), JSON.stringify(access));
    const env = { SC_MODE: "team", SC_PUBLIC_URL: "https://canvas.example.test", SC_OIDC_ISSUER: "https://idp.example.test", SC_OIDC_CLIENT_ID: "canvas", SC_OIDC_CLIENT_SECRET: "secret", SC_ACCESS_PATH: join(dir, "access.yaml") };
    expect((await loadAuthConfig(env)).recheckSeconds).toBe(300);
    expect((await loadAuthConfig({ ...env, SC_SESSION_RECHECK_SECONDS: "0" })).recheckSeconds).toBe(0);
    for (const bad of ["5", "3601", "1.5", "soon"]) await expect(loadAuthConfig({ ...env, SC_SESSION_RECHECK_SECONDS: bad })).rejects.toThrow(/SC_SESSION_RECHECK_SECONDS/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("re-checks an open session with the provider and ends it when access is revoked or changed, but not during an outage", async () => {
  const events: [string, any][] = [];
  oidc.discovery.mockResolvedValue(provider(["client_secret_post"]));
  const claims = (groups: string[], sub = "u1") => ({ sub, name: "Person", groups });
  let now = Date.now(); const realNow = Date.now; vi.spyOn(Date, "now").mockImplementation(() => now);
  const auth = new CompanyAuth(config({ recheckSeconds: 300 }), (event, data) => events.push([event, data]));
  await auth.start();
  const app = express(); auth.mount(app); app.use("/api", auth.guard); app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (refreshToken: string | undefined) => {
    oidc.authorizationCodeGrant.mockResolvedValueOnce({ claims: () => claims(["admins"]), refresh_token: refreshToken });
    const start = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
    const callback = await fetch(`${base}/api/auth/callback?code=c&state=state`, { headers: { cookie: start.headers.getSetCookie()[0].split(";")[0] }, redirect: "manual" });
    return callback.headers.getSetCookie().find(c => c.startsWith("__Host-sc_session="))!.split(";")[0];
  };
  const ping = (cookie: string) => fetch(`${base}/api/ping`, { headers: { cookie } }).then(r => r.status);
  const names = () => events.map(([event]) => event).filter(event => event.startsWith("auth.session") || event.startsWith("auth.recheck"));

  // Not due yet: no provider call.
  let cookie = await signIn("r1");
  expect(await ping(cookie)).toBe(200);
  expect(oidc.refreshTokenGrant).not.toHaveBeenCalled();
  // Due: unchanged access continues, the rotated refresh token is used next time, and concurrent requests share one call.
  now += 301_000;
  oidc.refreshTokenGrant.mockResolvedValueOnce({ claims: () => claims(["admins"]), refresh_token: "r2" });
  expect(await Promise.all([ping(cookie), ping(cookie), ping(cookie)])).toEqual([200, 200, 200]);
  expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(1);
  expect(oidc.refreshTokenGrant.mock.calls[0][1]).toBe("r1");
  // A provider without an ID token on refresh still confirms the session is alive.
  now += 301_000;
  oidc.refreshTokenGrant.mockResolvedValueOnce({ claims: () => undefined });
  expect(await ping(cookie)).toBe(200);
  expect(oidc.refreshTokenGrant.mock.calls[1][1]).toBe("r2");
  // Outage: the session stands, and the check is retried after a minute rather than on every request.
  now += 301_000;
  oidc.refreshTokenGrant.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }));
  expect(await ping(cookie)).toBe(200);
  expect(await ping(cookie)).toBe(200);
  expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(3);
  now += 61_000;
  oidc.refreshTokenGrant.mockRejectedValueOnce(Object.assign(new Error("busy"), { error: "temporarily_unavailable" }));
  expect(await ping(cookie)).toBe(200);
  // Group membership changed at the provider: the session ends.
  now += 61_000;
  oidc.refreshTokenGrant.mockResolvedValueOnce({ claims: () => claims(["someone-else"]) });
  expect(await ping(cookie)).toBe(401);
  expect(await ping(cookie)).toBe(401);
  // The provider refuses the refresh (disabled account, revoked or expired provider session): the session ends.
  cookie = await signIn("r9"); now += 301_000;
  oidc.refreshTokenGrant.mockRejectedValueOnce(Object.assign(new Error("Token is not active"), { error: "invalid_grant" }));
  expect(await ping(cookie)).toBe(401);
  // A different account answering for this session ends it too.
  cookie = await signIn("r10"); now += 301_000;
  oidc.refreshTokenGrant.mockResolvedValueOnce({ claims: () => claims(["admins"], "u2") });
  expect(await ping(cookie)).toBe(401);
  // No refresh token from the provider: behaviour is unchanged and no check is attempted.
  const calls = oidc.refreshTokenGrant.mock.calls.length;
  cookie = await signIn(undefined); now += 301_000;
  expect(await ping(cookie)).toBe(200);
  expect(oidc.refreshTokenGrant).toHaveBeenCalledTimes(calls);
  expect(names()).toEqual(["auth.recheck_unavailable", "auth.recheck_unavailable", "auth.session_access_changed", "auth.session_revoked", "auth.session_access_changed"]);
  expect(JSON.stringify(events)).not.toMatch(/r1|r2|r9|Token is not active/);
  Date.now = realNow;
});
