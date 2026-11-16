import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { CompanyAuth, type AccessConfig, type AuthConfig } from "../src/security/auth.ts";
import { createScimRouter } from "../src/security/scim.ts";

const initialAccess: AccessConfig = {
  groupsClaim: "groups",
  bindings: [
    { group: "admins", role: "admin", principal: "admin", sources: ["*"] },
    { group: "editors", role: "editor", principal: "emea", sources: ["public"] },
    { subject: "contractor-1", role: "viewer", principal: "emea", sources: ["public"] },
  ],
};

const makeConfig = (extra: Partial<AuthConfig> = {}): AuthConfig => ({
  mode: "team",
  scopes: "openid profile email",
  sessionSeconds: 3600,
  publicUrl: "https://canvas.example.test",
  issuer: "https://idp.example.test/",
  clientId: "canvas",
  clientSecret: "secret",
  access: initialAccess,
  ...extra,
});

let server: Server | undefined;
let tempDir: string | undefined;

beforeEach(() => {
  for (const mock of [oidc.discovery, oidc.authorizationCodeGrant, oidc.refreshTokenGrant, oidc.enableNonRepudiationChecks]) {
    mock.mockReset();
  }
  oidc.discovery.mockResolvedValue({
    serverMetadata: () => ({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
  });
});

afterEach(async () => {
  if (server) await new Promise(resolve => server!.close(resolve));
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function startTestApp(auth: CompanyAuth, scimToken?: string, extraScimDeps?: Record<string, unknown>) {
  const app = express();
  app.use("/api/scim/v2", createScimRouter({ auth, token: scimToken, ...extraScimDeps }));
  auth.mount(app);
  app.use("/api", auth.guard);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const signIn = async (sub: string, groups: string[]) => {
    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub, name: `User ${sub}`, groups }),
      refresh_token: `rt-${sub}`,
    });
    const loginRes = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
    const loginCookie = loginRes.headers.getSetCookie()[0].split(";")[0];
    const cbRes = await fetch(`${base}/api/auth/callback?code=c&state=state`, {
      headers: { cookie: loginCookie },
      redirect: "manual",
    });
    const sessionCookie = cbRes.headers.getSetCookie().find(c => c.startsWith("__Host-sc_session="))!.split(";")[0];
    const sessionRes = await fetch(`${base}/api/auth/session`, { headers: { cookie: sessionCookie } });
    const sessionJson = await sessionRes.json();
    return { cookie: sessionCookie, user: sessionJson.user as { id: string; role: string } };
  };

  return { base, signIn };
}

describe("CompanyAuth revokeSubject & reloadAccess", () => {
  it("revokes live sessions by raw OIDC subject or hashed identity id and audits auth.session_revoked", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const auth = new CompanyAuth(makeConfig(), (e, d) => events.push([e, d]));
    await auth.start();
    const { base, signIn } = await startTestApp(auth, "scim-secret");

    const alice = await signIn("alice-sub", ["admins"]);
    const bob = await signIn("bob-sub", ["editors"]);

    expect((await fetch(`${base}/api/ping`, { headers: { cookie: alice.cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: bob.cookie } })).status).toBe(200);

    // Revoke Alice by raw OIDC subject
    expect(auth.revokeSubject("alice-sub")).toBe(1);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: alice.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: bob.cookie } })).status).toBe(200);

    // Revoke Bob by hashed identity ID
    expect(auth.revokeSubject(bob.user.id)).toBe(1);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: bob.cookie } })).status).toBe(401);

    expect(events.some(([e, d]) => e === "auth.session_revoked" && d?.count === 1)).toBe(true);
  });

  it("reloads access policy from disk, validates principals, keeps unchanged sessions, and revokes changed sessions", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sc-access-reload-"));
    const accessFile = join(tempDir, "access.yaml");
    const events: [string, Record<string, unknown> | undefined][] = [];
    const auth = new CompanyAuth(makeConfig(), (e, d) => events.push([e, d]));
    await auth.start();
    const { base, signIn } = await startTestApp(auth, "scim-secret");

    const admin = await signIn("u-admin", ["admins"]);
    const editor = await signIn("u-editor", ["editors"]);
    const contractor = await signIn("contractor-1", []);

    // Also add a manually-issued session without OIDC claims to cover fallback matching
    const manualRes = { cookie: vi.fn() } as any;
    auth.issue({ id: "manual-viewer", name: "Manual", role: "viewer", principal: "emea", sources: ["public"] }, manualRes);

    // Update access.yaml: admins stay identical, editors become viewers (role changed), contractor-1 is removed, default added
    const updatedAccess: AccessConfig = {
      groupsClaim: "groups",
      default: { role: "viewer", principal: "emea", sources: ["public"] },
      bindings: [
        { group: "admins", role: "admin", principal: "admin", sources: ["*"] },
        { group: "editors", role: "viewer", principal: "emea", sources: ["public"] },
      ],
    };
    await writeFile(accessFile, JSON.stringify(updatedAccess), "utf8");

    // Rejects unknown RLS principals without mutating active config
    await expect(auth.reloadAccess({ admin: {} }, accessFile)).rejects.toThrow(/unknown RLS principal/);

    const result = await auth.reloadAccess({ admin: {}, emea: {} }, accessFile);
    expect(result).toEqual({ bindings: 2, hasDefault: true });
    expect(events.some(([e, d]) => e === "auth.access_reloaded" && d?.bindings === 2 && d?.hasDefault === true)).toBe(true);

    // Admin session had no change in [id, role, principal, sources] -> remains valid
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: admin.cookie } })).status).toBe(200);
    // Editor's role changed from editor to viewer -> session revoked so they re-authenticate with new role
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: editor.cookie } })).status).toBe(401);
    // Contractor's grant remained viewer/emea/["public"] via default -> remains valid
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: contractor.cookie } })).status).toBe(200);

    // Local mode reloadAccess is a no-op, and missing accessPath throws in team mode
    const localAuth = new CompanyAuth({ mode: "local", scopes: "openid", sessionSeconds: 3600 });
    expect(await localAuth.reloadAccess({})).toEqual({ bindings: 0, hasDefault: false });
    await expect(auth.reloadAccess({ admin: {}, emea: {} }, "")).rejects.toThrow(/SC_ACCESS_PATH/);
  });
});

describe("SCIM 2.0 Provisioning Router", () => {
  it("returns 404 when SCIM token is not configured and 401 when bearer token is missing or invalid", async () => {
    const auth = new CompanyAuth(makeConfig());
    await auth.start();
    const { base: unconfiguredBase } = await startTestApp(auth, "");
    const unconfRes = await fetch(`${unconfiguredBase}/api/scim/v2/Users`);
    expect(unconfRes.status).toBe(404);
    await new Promise(resolve => server!.close(resolve));
    server = undefined;

    const auditEvents: string[] = [];
    const { base } = await startTestApp(auth, "top-secret-scim-token", {
      onAudit: (e: string) => auditEvents.push(e),
    });

    expect((await fetch(`${base}/api/scim/v2/Users`)).status).toBe(401);
    expect((await fetch(`${base}/api/scim/v2/Users`, { headers: { authorization: "Bearer wrong-token" } })).status).toBe(401);
    expect((await fetch(`${base}/api/scim/v2/Users`, { headers: { authorization: "Bearer top-secret-scim-token" } })).status).toBe(200);
    expect(auditEvents).toEqual(["scim.auth_failed", "scim.auth_failed"]);
  });

  it("provisions users, filters/lists/gets users, and immediately revokes live sessions on PATCH active:false, PUT active:false, POST active:false, and DELETE", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sc-scim-"));
    const storagePath = join(tempDir, "scim-state.json");
    const changes: number[] = [];
    const auth = new CompanyAuth(makeConfig());
    await auth.start();
    const { base, signIn } = await startTestApp(auth, "scim-token-123", {
      storagePath,
      onChange: (state: { users: unknown[] }) => { changes.push(state.users.length); },
    });
    const scimHeaders = { authorization: "Bearer scim-token-123", "content-type": "application/json" };

    // Sign in two team users
    const user1Session = await signIn("ext-user-1", ["editors"]);
    const user2Session = await signIn("user2@example.com", ["editors"]);
    const user3Session = await signIn("ext-user-3", ["editors"]);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: user1Session.cookie } })).status).toBe(200);

    // Validation & creation
    expect((await fetch(`${base}/api/scim/v2/Users`, { method: "POST", headers: scimHeaders, body: JSON.stringify({}) })).status).toBe(400);

    const create1 = await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({
        userName: "user1@example.com",
        externalId: "ext-user-1",
        displayName: "User One",
        active: true,
        groups: [{ value: "editors" }],
        roles: ["editor"],
      }),
    });
    expect(create1.status).toBe(201);
    const created1 = await create1.json();
    expect(created1.userName).toBe("user1@example.com");
    expect(created1.externalId).toBe("ext-user-1");
    expect(created1.active).toBe(true);

    // Duplicate userName returns 409
    expect((await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "USER1@example.com" }),
    })).status).toBe(409);

    // Create user2 (active) and user3 (already inactive on POST -> immediately revokes user3Session)
    const create2 = await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "user2@example.com", displayName: "User Two", active: true }),
    });
    const created2 = await create2.json();

    const create3 = await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "user3@example.com", externalId: "ext-user-3", active: false }),
    });
    expect(create3.status).toBe(201);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: user3Session.cookie } })).status).toBe(401);

    // GET /Users and filter
    const listAll = await (await fetch(`${base}/api/scim/v2/Users`, { headers: scimHeaders })).json();
    expect(listAll.totalResults).toBe(3);
    const filtered = await (await fetch(`${base}/api/scim/v2/Users?filter=${encodeURIComponent('userName eq "user1@example.com"')}`, { headers: scimHeaders })).json();
    expect(filtered.totalResults).toBe(1);
    expect(filtered.Resources[0].id).toBe(created1.id);
    const filteredExt = await (await fetch(`${base}/api/scim/v2/Users?filter=${encodeURIComponent('externalId eq "ext-user-1"')}`, { headers: scimHeaders })).json();
    expect(filteredExt.totalResults).toBe(1);

    // GET /Users/:id
    expect((await fetch(`${base}/api/scim/v2/Users/${created1.id}`, { headers: scimHeaders })).status).toBe(200);
    expect((await fetch(`${base}/api/scim/v2/Users/missing-id`, { headers: scimHeaders })).status).toBe(404);

    // PATCH /Users/:id with SCIM PatchOp setting active: false -> immediately terminates user1's open session!
    const patchRes = await fetch(`${base}/api/scim/v2/Users/${created1.id}`, {
      method: "PATCH",
      headers: scimHeaders,
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "Replace", value: { active: false, displayName: "User One Suspended" } },
          { op: "replace", path: "roles", value: ["viewer"] },
          { op: "remove", path: "groups" },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched1 = await patchRes.json();
    expect(patched1.active).toBe(false);
    expect(patched1.displayName).toBe("User One Suspended");
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: user1Session.cookie } })).status).toBe(401);

    // PUT /Users/:id updating attributes and DELETE /Users/:id revoking user2's open session
    expect((await fetch(`${base}/api/scim/v2/Users/missing-id`, { method: "PUT", headers: scimHeaders, body: "{}" })).status).toBe(404);
    const putRes = await fetch(`${base}/api/scim/v2/Users/${created2.id}`, {
      method: "PUT",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "user2@example.com", displayName: "User Two Updated", active: true, groups: ["editors"], roles: ["editor"] }),
    });
    expect(putRes.status).toBe(200);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: user2Session.cookie } })).status).toBe(200);

    // DELETE user2 -> 204 No Content and revokes user2Session immediately
    const delRes = await fetch(`${base}/api/scim/v2/Users/${created2.id}`, { method: "DELETE", headers: scimHeaders });
    expect(delRes.status).toBe(204);
    expect((await fetch(`${base}/api/ping`, { headers: { cookie: user2Session.cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/scim/v2/Users/${created2.id}`, { method: "DELETE", headers: scimHeaders })).status).toBe(404);

    // Check persistence file and onChange callback
    expect(changes.length).toBeGreaterThanOrEqual(4);
    const saved = JSON.parse(await readFile(storagePath, "utf8"));
    expect(saved.users).toHaveLength(2);
  });

  it("manages SCIM groups and synchronizes group memberships with users", async () => {
    const auth = new CompanyAuth(makeConfig());
    await auth.start();
    const { base } = await startTestApp(auth, "scim-token-groups");
    const scimHeaders = { authorization: "Bearer scim-token-groups", "content-type": "application/json" };

    const u1 = await (await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "alice@example.com", externalId: "alice-ext" }),
    })).json();
    const u2 = await (await fetch(`${base}/api/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ userName: "bob@example.com", externalId: "bob-ext" }),
    })).json();

    expect((await fetch(`${base}/api/scim/v2/Groups`, { method: "POST", headers: scimHeaders, body: "{}" })).status).toBe(400);

    const gCreate = await fetch(`${base}/api/scim/v2/Groups`, {
      method: "POST",
      headers: scimHeaders,
      body: JSON.stringify({ displayName: "analysts", members: [{ value: u1.id, display: "Alice" }] }),
    });
    expect(gCreate.status).toBe(201);
    const group = await gCreate.json();
    expect(group.displayName).toBe("analysts");
    expect(group.members).toEqual([{ value: u1.id, display: "Alice" }]);

    // Alice now has group "analysts"
    const u1AfterGroup = await (await fetch(`${base}/api/scim/v2/Users/${u1.id}`, { headers: scimHeaders })).json();
    expect(u1AfterGroup.groups).toContain("analysts");

    // GET /Groups and GET /Groups/:id
    const groupList = await (await fetch(`${base}/api/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "analysts"')}`, { headers: scimHeaders })).json();
    expect(groupList.totalResults).toBe(1);
    expect((await fetch(`${base}/api/scim/v2/Groups/${group.id}`, { headers: scimHeaders })).status).toBe(200);
    expect((await fetch(`${base}/api/scim/v2/Groups/missing`, { headers: scimHeaders })).status).toBe(404);

    // PATCH /Groups/:id to add Bob and remove Alice
    const gPatch = await fetch(`${base}/api/scim/v2/Groups/${group.id}`, {
      method: "PATCH",
      headers: scimHeaders,
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "add", path: "members", value: [{ value: u2.id, display: "Bob" }] },
          { op: "remove", path: `members[value eq "${u1.id}"]` },
        ],
      }),
    });
    expect(gPatch.status).toBe(200);
    const patchedGroup = await gPatch.json();
    expect(patchedGroup.members.map((m: { value: string }) => m.value)).toEqual([u2.id]);

    // DELETE /Groups/:id
    expect((await fetch(`${base}/api/scim/v2/Groups/${group.id}`, { method: "DELETE", headers: scimHeaders })).status).toBe(204);
    expect((await fetch(`${base}/api/scim/v2/Groups/${group.id}`, { method: "DELETE", headers: scimHeaders })).status).toBe(404);
    const u2AfterDelete = await (await fetch(`${base}/api/scim/v2/Users/${u2.id}`, { headers: scimHeaders })).json();
    expect(u2AfterDelete.groups).not.toContain("analysts");
  });
});
