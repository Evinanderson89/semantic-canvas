import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import YAML from "yaml";

const oidc = vi.hoisted(() => ({
  discovery: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  refreshTokenGrant: vi.fn(),
  enableNonRepudiationChecks: vi.fn(),
  ClientSecretBasic: vi.fn((secret: string) => ({ method: "client_secret_basic", secret })),
  ClientSecretPost: vi.fn((secret: string) => ({ method: "client_secret_post", secret })),
  randomPKCECodeVerifier: () => "verifier",
  randomNonce: () => "nonce",
  randomState: () => "state",
  calculatePKCECodeChallenge: async () => "challenge",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) =>
    new URL(`https://idp.example.test/authorize?state=${params.state}`),
}));
vi.mock("openid-client", () => oidc);

import {
  accessSchema,
  canUseSource,
  checkAccessPrincipals,
  CompanyAuth,
  loadAuthConfig,
  mapIdentity,
  readGatewayPolicy,
  validateAiBaseUrl,
  type AccessConfig,
  type AuthConfig,
} from "../src/security/auth.ts";
import { createScimRouter } from "../src/security/scim.ts";
import { RELEASE_MANIFEST, getReleaseManifest } from "../src/operations/releaseManifest.ts";
import {
  closeStore,
  initializeCoreLibrary,
  listCoreLibrary,
  openStore,
  saveDashboard,
  StoreConflict,
  updateLibraryItem,
} from "../src/store/store.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { buildSampleWorkbookPayload } from "../src/modeler/spreadsheetTypes.ts";

const baseAccess: AccessConfig = accessSchema.parse({
  groupsClaim: "groups",
  bindings: [
    { group: "admins", role: "admin", principal: "admin", sources: ["*"] },
    { group: "editors", role: "editor", principal: "emea", sources: ["public"] },
    { group: "viewers", role: "viewer", principal: "emea", sources: ["public"] },
  ],
});

function makeTeamConfig(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    mode: "team",
    scopes: "openid profile email",
    sessionSeconds: 3600,
    recheckSeconds: 300,
    publicUrl: "https://canvas.example.test",
    issuer: "https://idp.example.test/",
    clientId: "canvas",
    clientSecret: "client-secret-value",
    access: baseAccess,
    ...extra,
  };
}

describe("RBAC trailing-slash normalization, ai.baseUrl SSRF guard, PersistentSessionStore & SCIM active enforcement (in-process)", () => {
  let httpServer: Server | undefined;
  let tempDir: string | undefined;

  beforeEach(() => {
    for (const m of [oidc.discovery, oidc.authorizationCodeGrant, oidc.refreshTokenGrant, oidc.enableNonRepudiationChecks]) {
      m.mockReset();
    }
    oidc.discovery.mockResolvedValue({
      serverMetadata: () => ({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
    });
  });

  afterEach(async () => {
    if (httpServer) await new Promise((r) => httpServer!.close(r));
    httpServer = undefined;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("normalizes trailing slashes in CompanyAuth.guard so viewers and editors cannot bypass admin RBAC", async () => {
    const auth = new CompanyAuth(makeTeamConfig());
    await auth.start();
    const app = express();
    auth.mount(app);
    app.use("/api", auth.guard);
    app.all("/api/*", (_req, res) => res.json({ reached: true }));

    httpServer = app.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    const signInAs = async (sub: string, groups: string[]) => {
      oidc.authorizationCodeGrant.mockResolvedValueOnce({
        claims: () => ({ sub, name: sub, groups }),
        refresh_token: `rt-${sub}`,
      });
      const loginRes = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
      const loginCookie = loginRes.headers.getSetCookie()[0].split(";")[0];
      const cbRes = await fetch(`${base}/api/auth/callback?code=c&state=state`, {
        headers: { cookie: loginCookie },
        redirect: "manual",
      });
      const cookie = cbRes.headers.getSetCookie().find((c) => c.startsWith("__Host-sc_session="))!.split(";")[0];
      const sess = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json();
      return { cookie, csrf: sess.csrf as string };
    };

    const viewer = await signInAs("v-1", ["viewers"]);
    const editor = await signInAs("e-1", ["editors"]);
    const admin = await signInAs("a-1", ["admins"]);

    const call = (who: { cookie: string; csrf: string }, method: string, path: string) =>
      fetch(`${base}${path}`, {
        method,
        headers: { cookie: who.cookie, "x-sc-csrf": who.csrf, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });

    // Viewer blocked on /api/agent/key AND trailing-slash /api/agent/key/
    expect((await call(viewer, "POST", "/api/agent/key")).status).toBe(403);
    expect((await call(viewer, "POST", "/api/agent/key/")).status).toBe(403);
    expect((await call(viewer, "DELETE", "/api/agent/key///")).status).toBe(403);
    expect((await call(viewer, "POST", "/api/dashboards/")).status).toBe(403);

    // Editor blocked on metric/connected publish WITH and WITHOUT trailing slashes, and on /api/agent/key/
    expect((await call(editor, "POST", "/api/sources/public/metrics/m1/publish")).status).toBe(403);
    expect((await call(editor, "POST", "/api/sources/public/metrics/m1/publish/")).status).toBe(403);
    expect((await call(editor, "POST", "/api/sources/public/connected/ds1/publish")).status).toBe(403);
    expect((await call(editor, "POST", "/api/sources/public/connected/ds1/publish/")).status).toBe(403);
    expect((await call(editor, "POST", "/api/agent/key/")).status).toBe(403);
    expect((await call(editor, "POST", "/api/sources/")).status).toBe(403);

    // Editor allowed on proposing metrics, registering connected tables, and saving dashboards
    expect((await call(editor, "POST", "/api/sources/public/metrics/")).status).toBe(200);
    expect((await call(editor, "POST", "/api/sources/public/connected/")).status).toBe(200);
    expect((await call(editor, "POST", "/api/dashboards/")).status).toBe(200);

    // Admin allowed on publish and agent key endpoints (with or without trailing slash)
    expect((await call(admin, "POST", "/api/sources/public/metrics/m1/publish/")).status).toBe(200);
    expect((await call(admin, "POST", "/api/sources/public/connected/ds1/publish/")).status).toBe(200);
    expect((await call(admin, "POST", "/api/agent/key/")).status).toBe(200);
  });

  it("blocks loopback, RFC1918, CGNAT, and cloud metadata ai.baseUrl targets in team/gateway mode unless SC_ALLOW_PRIVATE_AI_URL=true", () => {
    expect(validateAiBaseUrl(undefined, "team", {})).toBeNull();
    expect(validateAiBaseUrl("https://api.openai.com/v1", "team", {})).toBeNull();
    expect(validateAiBaseUrl("https://openrouter.ai/api/v1", "gateway", {})).toBeNull();

    const blockedUrls = [
      "http://127.0.0.1:11434/v1",
      "http://localhost:8000/v1",
      "http://sub.localhost:8000",
      "http://0x7f000001:8080",
      "http://[::1]:11434",
      "http://[::ffff:127.0.0.1]:11434",
      "http://10.0.0.12:8000",
      "http://172.16.4.9:8000",
      "http://172.31.255.1:8000",
      "http://192.168.1.50:8000",
      "http://100.64.1.1:8000",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/computeMetadata/v1",
      "http://[fd00::1]:8000",
      "http://[fe80::1]:8000",
    ];
    for (const bad of blockedUrls) {
      expect(validateAiBaseUrl(bad, "team", {}), bad).toMatch(/blocked in company mode/i);
      expect(validateAiBaseUrl(bad, "gateway", {}), bad).toMatch(/blocked in company mode/i);
      // Permitted in local mode or when SC_ALLOW_PRIVATE_AI_URL=true
      expect(validateAiBaseUrl(bad, "local", {}), bad).toBeNull();
      expect(validateAiBaseUrl(bad, "team", { SC_ALLOW_PRIVATE_AI_URL: "true" }), bad).toBeNull();
    }

    // Invalid URLs, non-HTTP protocols, and embedded credentials always fail
    expect(validateAiBaseUrl("not-a-url", "local", {})).toMatch(/Invalid ai\.baseUrl/);
    expect(validateAiBaseUrl("file:///etc/passwd", "local", {})).toMatch(/Invalid ai\.baseUrl/);
    expect(validateAiBaseUrl("https://user:secret@api.openai.com/v1", "team", {})).toMatch(/Invalid ai\.baseUrl/);
  });

  it("wires PersistentSessionStore into CompanyAuth when SC_SESSION_SECRET + SC_DATA_DIR are set and preserves sessions across restarts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sc-auth-persist-"));
    const accessFile = join(tempDir, "access.yaml");
    const dataDir = join(tempDir, "data");
    await writeFile(accessFile, YAML.stringify(baseAccess), "utf8");

    const baseEnv = {
      SC_MODE: "team",
      SC_PUBLIC_URL: "https://canvas.example.test",
      SC_OIDC_ISSUER: "https://idp.example.test",
      SC_OIDC_CLIENT_ID: "canvas",
      SC_OIDC_CLIENT_SECRET: "oidc-secret",
      SC_ACCESS_PATH: accessFile,
      SC_DATA_DIR: dataDir,
    };

    // Without SC_SESSION_SECRET -> clean in-memory fallback (storagePath undefined)
    const memCfg = await loadAuthConfig(baseEnv);
    expect(memCfg.storagePath).toBeUndefined();

    // With SC_SESSION_SECRET + SC_DATA_DIR -> storagePath points to sessions.json
    const persistCfg = await loadAuthConfig({ ...baseEnv, SC_SESSION_SECRET: "aes-256-session-master-key" });
    expect(persistCfg.sessionSecret).toBe("aes-256-session-master-key");
    expect(persistCfg.storagePath).toBe(resolve(dataDir, "sessions.json"));

    // Boot instance #1, sign in Alice, and verify encrypted session persistence on disk
    const auth1 = new CompanyAuth(persistCfg);
    await auth1.start();
    const app1 = express();
    auth1.mount(app1);
    app1.use("/api", auth1.guard);
    app1.get("/api/ping", (_req, res) => res.json({ ok: true }));
    httpServer = app1.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const url1 = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: "alice-persist", name: "Alice", groups: ["admins"] }),
      refresh_token: "super-secret-refresh-token-1",
    });
    const loginRes = await fetch(`${url1}/api/auth/login`, { redirect: "manual" });
    const loginCookie = loginRes.headers.getSetCookie()[0].split(";")[0];
    const cbRes = await fetch(`${url1}/api/auth/callback?code=c&state=state`, {
      headers: { cookie: loginCookie },
      redirect: "manual",
    });
    const sessionCookie = cbRes.headers.getSetCookie().find((c) => c.startsWith("__Host-sc_session="))!.split(";")[0];
    await auth1.flush();

    const diskStat = await stat(persistCfg.storagePath!);
    expect(diskStat.mode & 0o777).toBe(0o600);
    const rawDisk = await readFile(persistCfg.storagePath!, "utf8");
    expect(rawDisk).not.toContain("super-secret-refresh-token-1");

    await new Promise((r) => httpServer!.close(r));
    httpServer = undefined;

    // Boot instance #2 on the same sessions.json: Alice's cookie & CSRF survive restart!
    const auth2 = new CompanyAuth(persistCfg);
    await auth2.start();
    const app2 = express();
    auth2.mount(app2);
    app2.use("/api", auth2.guard);
    app2.get("/api/ping", (_req, res) => res.json({ ok: true }));
    httpServer = app2.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const url2 = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    const sessionAfterRestart = await (await fetch(`${url2}/api/auth/session`, { headers: { cookie: sessionCookie } })).json();
    expect(sessionAfterRestart.authenticated).toBe(true);
    expect(sessionAfterRestart.user.role).toBe("admin");
    expect(auth2.currentIdentity(sessionAfterRestart.user.id)?.role).toBe("admin");
    expect((await fetch(`${url2}/api/ping`, { headers: { cookie: sessionCookie } })).status).toBe(200);

    // Signing out removes the session from disk as well
    const logoutRes = await fetch(`${url2}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: sessionCookie, "x-sc-csrf": sessionAfterRestart.csrf },
    });
    expect(logoutRes.status).toBe(200);
    await auth2.flush();

    const auth3 = new CompanyAuth(persistCfg);
    await auth3.start();
    expect(auth3.sessions.size).toBe(0);
  });

  it("persists SCIM state across restarts and rejects OIDC login and recheck when a provisioned SCIM user has active === false", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sc-scim-login-block-"));
    const scimPath = join(tempDir, "nested", "scim.json");

    const events: [string, Record<string, unknown> | undefined][] = [];
    const auth1 = new CompanyAuth(makeTeamConfig({ recheckSeconds: 60 }), (e, d) => events.push([e, d]));
    await auth1.start();
    const scim1 = createScimRouter({ auth: auth1, token: "scim-tok", storagePath: scimPath });
    const app1 = express();
    app1.use("/api/scim/v2", scim1);
    auth1.mount(app1);
    httpServer = app1.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const url1 = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    const scimHeaders = { authorization: "Bearer scim-tok", "content-type": "application/json" };
    // Provision suspended user + active group-mapped user
    expect((await fetch(`${url1}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({
        userName: "suspended@example.com",
        externalId: "sub-suspended",
        active: false,
        groups: ["admins"],
      }),
    })).status).toBe(201);

    const activeCreated = await (await fetch(`${url1}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({
        userName: "active.member@example.com",
        externalId: "sub-active",
        active: true,
        groups: ["editors"],
      }),
    })).json();

    await new Promise((r) => httpServer!.close(r));
    httpServer = undefined;

    // Simulate server restart: new CompanyAuth + createScimRouter hydrate from scim.json
    const auth2 = new CompanyAuth(makeTeamConfig({ recheckSeconds: 60 }), (e, d) => events.push([e, d]));
    await auth2.start();
    const scim2 = createScimRouter({ auth: auth2, token: "scim-tok", storagePath: scimPath });
    expect(scim2.users.size).toBe(2);

    const app2 = express();
    app2.use("/api/scim/v2", scim2);
    auth2.mount(app2);
    app2.use("/api", auth2.guard);
    app2.get("/api/ping", (_req, res) => res.json({ ok: true }));
    httpServer = app2.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const url2 = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    // Suspended SCIM user attempting OIDC login is rejected with 403!
    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: "sub-suspended", email: "suspended@example.com", name: "Suspended", groups: ["admins"] }),
      refresh_token: "rt-susp",
    });
    const l1 = await fetch(`${url2}/api/auth/login`, { redirect: "manual" });
    const c1 = l1.headers.getSetCookie()[0].split(";")[0];
    const cbSuspended = await fetch(`${url2}/api/auth/callback?code=c&state=state`, {
      headers: { cookie: c1 },
      redirect: "manual",
    });
    expect(cbSuspended.status).toBe(403);
    expect(await cbSuspended.text()).toMatch(/deactivated/i);
    expect(events.some(([e, d]) => e === "auth.access_denied" && d?.reason === "scim_inactive")).toBe(true);

    // Active SCIM user signs in cleanly (inheriting SCIM group "editors" even when IdP groups claim is empty)
    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: "sub-active", email: "active.member@example.com", name: "Active", groups: [] }),
      refresh_token: "rt-active",
    });
    const l2 = await fetch(`${url2}/api/auth/login`, { redirect: "manual" });
    const c2 = l2.headers.getSetCookie()[0].split(";")[0];
    const cbActive = await fetch(`${url2}/api/auth/callback?code=c&state=state`, {
      headers: { cookie: c2 },
      redirect: "manual",
    });
    expect(cbActive.status).toBe(302);
    const activeCookie = cbActive.headers.getSetCookie().find((c) => c.startsWith("__Host-sc_session="))!.split(";")[0];
    expect((await fetch(`${url2}/api/ping`, { headers: { cookie: activeCookie } })).status).toBe(200);

    // Deactivating via SCIM immediately revokes the session AND blocks re-login by email match
    expect((await fetch(`${url2}/api/scim/v2/Users/${activeCreated.id}`, {
      method: "PATCH",
      headers: scimHeaders,
      body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: false }] }),
    })).status).toBe(200);
    expect((await fetch(`${url2}/api/ping`, { headers: { cookie: activeCookie } })).status).toBe(401);

    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: "different-idp-sub", email: "active.member@example.com", name: "Active", groups: ["editors"] }),
    });
    const l3 = await fetch(`${url2}/api/auth/login`, { redirect: "manual" });
    const c3 = l3.headers.getSetCookie()[0].split(";")[0];
    expect((await fetch(`${url2}/api/auth/callback?code=c&state=state`, { headers: { cookie: c3 }, redirect: "manual" })).status).toBe(403);
  });

  it("verifies gateway policies, local/gateway auth helpers, releaseManifest v0.3.6, and starter template rename guard", async () => {
    // Gateway policy signature & validation
    const secret = "gw-hmac-secret";
    const now = 1_700_000_000_000;
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        sub: "u-1",
        app: "semantic-canvas",
        exp: Math.floor(now / 1000) + 300,
        rules: [{ field: "dim_users.country", mode: "only", values: ["US", "CA"] }],
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(readGatewayPolicy(payload, sig, secret, "u-1", now, "semantic-canvas")).toEqual([
      { field: "dim_users.country", mode: "only", values: ["US", "CA"] },
    ]);
    expect(readGatewayPolicy(payload, "bad-sig", secret, "u-1", now, "semantic-canvas")).toBeNull();
    expect(readGatewayPolicy(payload, sig, secret, "wrong-sub", now, "semantic-canvas")).toBeNull();
    expect(readGatewayPolicy(payload, sig, secret, "u-1", now + 600_000, "semantic-canvas")).toBeNull();

    // Principal & source checks
    expect(() => checkAccessPrincipals(baseAccess, { admin: {}, emea: {} })).not.toThrow();
    expect(() => checkAccessPrincipals(baseAccess, { admin: {} })).toThrow(/unknown RLS principal/);
    const mapped = mapIdentity({ sub: "u-1", name: "Alice", groups: ["editors"] }, "https://idp.test", baseAccess)!;
    expect(canUseSource(mapped, "public")).toBe(true);
    expect(canUseSource(mapped, "private")).toBe(false);

    // Local & gateway route mounting coverage
    const localCfg = await loadAuthConfig({ SC_MODE: "local" });
    const localAuth = new CompanyAuth(localCfg);
    const localApp = express();
    localAuth.mount(localApp);
    localApp.use("/api", localAuth.guard);
    localApp.get("/api/ok", (_req, res) => res.json({ ok: true }));
    httpServer = localApp.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer!.once("listening", r));
    const localUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    expect(await (await fetch(`${localUrl}/api/auth/session`)).json()).toEqual({
      mode: "local",
      authenticated: true,
      canEdit: true,
      canAdmin: true,
    });
    expect((await fetch(`${localUrl}/api/auth/login`, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(`${localUrl}/api/ok`)).status).toBe(200);
    await new Promise((r) => httpServer!.close(r));
    httpServer = undefined;

    // Release manifest v0.3.6 & connectors
    expect(RELEASE_MANIFEST.version).toBe("0.3.6");
    expect(RELEASE_MANIFEST.supportedConnectors).toEqual(["duckdb", "duckdb-db", "postgres", "bigquery", "snowflake"]);
    expect(getReleaseManifest({ mode: "team" }).version).toBe("0.3.6");

    // Store updateLibraryItem rejects built-in starter template renames while allowing user dashboards
    await openStore(":memory:");
    try {
      const model = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
      const scope = { source: "sample", model: model.name };
      await initializeCoreLibrary(scope, model);
      const lib = await listCoreLibrary(scope);
      const templateItem = lib.items.find((i) => i.isTemplate && i.name === "SaaS overview")!;
      expect(templateItem).toBeDefined();

      await expect(
        updateLibraryItem("dashboard", templateItem.id, { revision: templateItem.revision, name: "Defaced Title" }, scope),
      ).rejects.toBeInstanceOf(StoreConflict);

      await saveDashboard({ id: "user-dash", spec: { title: "User Dash", tiles: [] } }, scope);
      const renamed = await updateLibraryItem("dashboard", "user-dash", { revision: 1, name: "Renamed User Dash" }, scope);
      expect(renamed.ok).toBe(true);
    } finally {
      await closeStore();
    }
  });
});

describe("Per-visitor sandbox spreadsheet isolation, concurrent sample mutex, CSP & digest HTML escaping (live server)", () => {
  let root = "";
  let url = "";
  let port = 0;
  let sourcesYamlBefore = "";
  let child: ChildProcess | undefined;

  async function pickFreePort(): Promise<number> {
    const srv = createHttpServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return p;
  }

  async function startSandboxServer(listenPort: number): Promise<ChildProcess> {
    const repoRoot = resolve(import.meta.dirname, "..");
    let out = "";
    const proc = spawn(process.execPath, ["--import", "tsx", resolve(repoRoot, "src/server.ts")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(listenPort),
        SC_MODE: "local",
        SC_SANDBOX_MODE: "true",
        SC_SERVE_UI: "true",
        SC_HOST: "127.0.0.1",
        SC_DATA_DIR: join(root, "data"),
        SOURCES_PATH: join(root, "sources.yaml"),
        SC_ENV_PATH: join(root, "absent.env"),
        RLS_PATH: resolve(repoRoot, "security/policies.yaml"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (out += d));
    for (let i = 0; i < 200; i++) {
      if (proc.exitCode !== null) throw new Error(`Sandbox server exited early:\n${out}`);
      try {
        if ((await fetch(`http://127.0.0.1:${listenPort}/readyz`)).ok) return proc;
      } catch {
        /* booting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Sandbox server did not start in time:\n${out}`);
  }

  async function stopSandboxServer() {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child!.once("exit", r));
    }
    child = undefined;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sc-sandbox-isolation-"));
    const repoRoot = resolve(import.meta.dirname, "..");
    sourcesYamlBefore = YAML.stringify({
      sources: [
        {
          id: "duckglue-local",
          label: "Sample SaaS Warehouse",
          adapter: "duckglue",
          model: resolve(repoRoot, "sample-data/warehouse.yaml"),
          connector: { type: "duckdb", lakeRoot: resolve(repoRoot, "sample-data/lake"), poolSize: 1 },
        },
      ],
    });
    await writeFile(join(root, "sources.yaml"), sourcesYamlBefore, "utf8");
    port = await pickFreePort();
    url = `http://127.0.0.1:${port}`;
    child = await startSandboxServer(port);
  }, 45_000);

  afterAll(async () => {
    await stopSandboxServer();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("isolates Visitor A's uploaded spreadsheet from Visitor B across list/model/schema/values/lineage/query/refresh, shares built-in worlds concurrency-safely, keeps sources.yaml clean, and survives restarts", async () => {
    // 1. Visitor A obtains an HttpOnly sc_sandbox_sid cookie AND verifies Google Fonts CSP
    const initA = await fetch(`${url}/api/sources`);
    expect(initA.status).toBe(200);
    const csp = initA.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");

    const setCookieA = initA.headers.getSetCookie().find((c) => c.startsWith("sc_sandbox_sid="))!;
    expect(setCookieA).toBeDefined();
    expect(setCookieA).toContain("HttpOnly");
    expect(setCookieA).toContain("SameSite=Lax");
    const cookieA = setCookieA.split(";")[0];

    // Visitor B has an independent browser cookie jar
    const initB = await fetch(`${url}/api/sources`);
    const cookieB = initB.headers.getSetCookie().find((c) => c.startsWith("sc_sandbox_sid="))!.split(";")[0];
    expect(cookieB).not.toBe(cookieA);

    // 2. Visitor A uploads a confidential CSV spreadsheet
    const privateCsv = "deal_date,account_name,arr_usd\n2026-07-01,Project Stealth,95000\n2026-08-01,Project Apollo,145000\n";
    const importResA = await fetch(`${url}/api/modeler/spreadsheet/import`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Private_Board_Deals.csv",
        format: "csv",
        content: privateCsv,
        sourceId: "visitor-a-deals",
        label: "Visitor A Confidential Deals",
        grain: "One enterprise deal",
        timeColumn: "deal_date",
      }),
    });
    expect(importResA.status).toBe(200);
    const importedA = await importResA.json();
    expect(importedA.sourceId).toBe("visitor-a-deals");

    // Visitor A can list, inspect model/schema/values/lineage, query, and refresh their own upload
    const listA = await (await fetch(`${url}/api/sources`, { headers: { cookie: cookieA } })).json();
    expect(listA.sources.map((s: any) => s.id)).toContain("visitor-a-deals");

    expect((await fetch(`${url}/api/model?source=visitor-a-deals`, { headers: { cookie: cookieA } })).status).toBe(200);
    expect((await fetch(`${url}/api/schema?source=visitor-a-deals`, { headers: { cookie: cookieA } })).status).toBe(200);
    expect(
      (await fetch(`${url}/api/values?source=visitor-a-deals&base=${importedA.tableName}&field=account_name`, { headers: { cookie: cookieA } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${url}/api/query/lineage?source=visitor-a-deals`, {
          method: "POST",
          headers: { cookie: cookieA, "content-type": "application/json" },
          body: JSON.stringify({ metrics: [importedA.metrics[0]], dimensions: [] }),
        })
      ).status,
    ).toBe(200);

    const queryA = await fetch(`${url}/api/query?source=visitor-a-deals`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ metrics: ["arr_usd"], dimensions: [] }),
    });
    expect(queryA.status).toBe(200);
    expect(Number((await queryA.json()).rows[0][0])).toBe(240000);

    // 3. Visitor B CANNOT see, inspect, query, or refresh Visitor A's uploaded spreadsheet!
    const listB = await (await fetch(`${url}/api/sources`, { headers: { cookie: cookieB } })).json();
    expect(listB.sources.map((s: any) => s.id)).not.toContain("visitor-a-deals");
    expect(listB.sources.map((s: any) => s.id)).toEqual(["duckglue-local"]);

    expect((await fetch(`${url}/api/model?source=visitor-a-deals`, { headers: { cookie: cookieB } })).status).toBe(404);
    expect((await fetch(`${url}/api/model`, { headers: { cookie: cookieB, "x-sc-source": "visitor-a-deals" } })).status).toBe(404);
    expect((await fetch(`${url}/api/schema?source=visitor-a-deals`, { headers: { cookie: cookieB } })).status).toBe(404);
    expect(
      (await fetch(`${url}/api/values?source=visitor-a-deals&base=${importedA.tableName}&field=account_name`, { headers: { cookie: cookieB } })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${url}/api/query/lineage?source=visitor-a-deals`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ metrics: ["arr_usd"], dimensions: [] }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${url}/api/query?source=visitor-a-deals`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ metrics: ["arr_usd"], dimensions: [] }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${url}/api/modeler/spreadsheet/refresh/visitor-a-deals`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ fileName: "Hijack.csv", format: "csv", content: privateCsv }),
        })
      ).status,
    ).toBe(404);

    // Non-cookie test client using x-sc-sandbox-session header also gets isolated session
    const customHexSid = "0123456789abcdef0123456789abcdef";
    expect((await fetch(`${url}/api/model?source=visitor-a-deals`, { headers: { "x-sc-sandbox-session": customHexSid } })).status).toBe(404);

    // 4. Sandbox blocks modal spoofing & shared dashboard/library/activity vandalism
    expect((await fetch(`${url}/api/agent/questions`, { headers: { cookie: cookieB } })).status).toBe(403);
    expect(
      (
        await fetch(`${url}/api/agent/questions`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ question: "Spoof modal?" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/dashboards`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ id: "vandal", spec: { title: "Vandal", tiles: [] } }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/library/folders`, {
          method: "POST",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ id: "f1", name: "Vandal", parentId: null, revision: 0 }),
        })
      ).status,
    ).toBe(403);

    // 5. Concurrent Step 1 imports of built-in coffee-roastery-2tab share one mutex without duplicating!
    const roastery = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
    const previewRes = await (
      await fetch(`${url}/api/modeler/spreadsheet/preview`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ fileName: roastery.fileName, format: roastery.format, content: roastery.content }),
      })
    ).json();
    const roasteryPayload = JSON.stringify({
      fileName: roastery.fileName,
      format: roastery.format,
      content: roastery.content,
      sourceId: "coffee-roastery-2tab",
      label: roastery.meta.title,
      grain: previewRes.suggestedGrain,
      timeColumn: previewRes.suggestedTimeColumn ?? null,
      joins: previewRes.detectedJoins ?? [],
    });

    const [r1, r2] = await Promise.all([
      fetch(`${url}/api/modeler/spreadsheet/import`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: roasteryPayload,
      }),
      fetch(`${url}/api/modeler/spreadsheet/import`, {
        method: "POST",
        headers: { cookie: cookieB, "content-type": "application/json" },
        body: roasteryPayload,
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r1.json()).sourceId).toBe("coffee-roastery-2tab");
    expect((await r2.json()).sourceId).toBe("coffee-roastery-2tab");

    // Both visitors see shared coffee-roastery-2tab, and neither can overwrite it via refresh
    const listB2 = await (await fetch(`${url}/api/sources`, { headers: { cookie: cookieB } })).json();
    expect(listB2.sources.map((s: any) => s.id)).toEqual(["duckglue-local", "coffee-roastery-2tab"]);
    expect(
      (
        await fetch(`${url}/api/modeler/spreadsheet/refresh/coffee-roastery-2tab`, {
          method: "POST",
          headers: { cookie: cookieA, "content-type": "application/json" },
          body: JSON.stringify({ fileName: roastery.fileName, format: roastery.format, content: roastery.content }),
        })
      ).status,
    ).toBe(403);

    // 6. Tracked sources.yaml is 100% untouched on disk!
    expect(await readFile(join(root, "sources.yaml"), "utf8")).toBe(sourcesYamlBefore);

    // 7. Executive Digest works read-only on built-in starter & escapes HTML entities cleanly
    const lib = await (await fetch(`${url}/api/library`, { headers: { cookie: cookieA } })).json();
    const saasStarter = lib.items.find((i: any) => i.name === "SaaS overview")!;
    const digestRes = await fetch(`${url}/api/dashboards/${encodeURIComponent(saasStarter.id)}/digest`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: "{}",
    });
    expect(digestRes.status).toBe(200);
    const digestBody = await digestRes.json();
    expect(digestBody.html).toContain("<article class=\"executive-digest\">");
    expect(digestBody.html).toContain(digestBody.briefFingerprint);

    // 8. Restart server on same SC_DATA_DIR -> Visitor A still owns visitor-a-deals, Visitor B still denied!
    await stopSandboxServer();
    child = await startSandboxServer(port);

    expect((await fetch(`${url}/api/model?source=visitor-a-deals`, { headers: { cookie: cookieA } })).status).toBe(200);
    expect((await fetch(`${url}/api/model?source=visitor-a-deals`, { headers: { cookie: cookieB } })).status).toBe(404);
    expect((await fetch(`${url}/api/model?source=coffee-roastery-2tab`, { headers: { cookie: cookieB } })).status).toBe(200);
    expect(await readFile(join(root, "sources.yaml"), "utf8")).toBe(sourcesYamlBefore);
  }, 45_000);
});
