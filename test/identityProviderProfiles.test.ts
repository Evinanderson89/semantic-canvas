/**
 * Simulated identity-provider profiles. Each tenant reproduces the documented
 * shape of one vendor's discovery document, issuer, client authentication and
 * ID-token claims, and a real Canvas server signs in against it.
 *
 * This checks how Canvas handles those shapes. It is not acceptance against
 * Okta or Microsoft Entra: vendor behaviour outside these documented shapes,
 * tenant configuration and network paths are not exercised.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { generateKeyPairSync, sign, createHash, randomUUID, type KeyObject } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import YAML from "yaml";
import { loopbackRequest } from "../src/security/loopback.ts";

const host = "canvas.example.test", clientId = "0oa-canvas-client", clientSecret = "profile-secret-do-not-log";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
async function freePort() { const s = createHttpServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const port = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return port; }

interface TenantOptions {
  /** Issuer path exactly as the vendor publishes it; "" is a root issuer with no trailing slash. */
  issuerPath: string;
  authMethods: string[];
  /** Methods the application registration accepts when that is narrower than discovery advertises. */
  accepts?: string[];
  env?: Record<string, string>;
  access: object;
  /** Vendor-shaped claims for a simulated user, merged over iss/aud/nonce/iat/exp. */
  claims: (user: string) => Record<string, unknown>;
}
interface Tenant { issuer: string; call: (path: string, init?: RequestInit) => Promise<Response>; signIn: (user: string) => Promise<{ status: number; body: string; session?: any }>;
  clientAuthSeen: Set<string>; rotateKey: () => void; output: () => string; jwksFetches: () => number }

let root = "";
const cleanup: (() => Promise<void>)[] = [];
async function startTenant(name: string, options: TenantOptions): Promise<Tenant> {
  // Providers publish the next signing key before they use it; rotation promotes that published key.
  type SigningKey = { kid: string; privateKey: KeyObject; publicKey: KeyObject };
  const generate = (): SigningKey => ({ kid: `${name}-${randomUUID().slice(0, 8)}`, ...generateKeyPairSync("rsa", { modulusLength: 2048 }) });
  let key = generate(), next = generate();
  const newKey = () => { key = next; next = generate(); };
  const jwt = (claims: object) => { const body = `${encode({ alg: "RS256", typ: "JWT", kid: key.kid })}.${encode(claims)}`; return `${body}.${sign("RSA-SHA256", Buffer.from(body), key.privateKey).toString("base64url")}`; };
  const codes = new Map<string, { challenge: string; nonce: string; user: string }>();
  const clientAuthSeen = new Set<string>();
  let issuer = "", jwksFetches = 0;
  const idp = express(); idp.use(express.urlencoded({ extended: false }));
  const p = options.issuerPath;
  idp.get(`${p}/.well-known/openid-configuration`, (_q, r) => r.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: options.authMethods, code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "profile", "email", "groups"] }));
  idp.get(`${p}/keys`, (_q, r) => { jwksFetches++; r.json({ keys: [key, next].map(k => ({ ...k.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: k.kid })) }); });
  idp.post(`${p}/token`, (q, r) => {
    const basic = /^Basic (.+)$/.exec(q.header("authorization") ?? "")?.[1];
    const [basicId, basicSecret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [];
    const method = basic ? "client_secret_basic" : "client_secret_post";
    const id = basic ? basicId : q.body.client_id, secret = basic ? basicSecret : q.body.client_secret;
    clientAuthSeen.add(method);
    if (!(options.accepts ?? options.authMethods).includes(method) || id !== clientId || secret !== clientSecret) return r.status(401).json({ error: "invalid_client" });
    const pending = codes.get(q.body.code); codes.delete(q.body.code);
    if (!pending || createHash("sha256").update(q.body.code_verifier ?? "").digest("base64url") !== pending.challenge) return r.status(400).json({ error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    r.json({ token_type: "Bearer", access_token: "opaque-provider-token", expires_in: 3600, scope: "openid profile email",
      id_token: jwt({ iss: issuer, aud: clientId, nonce: pending.nonce, iat: now, exp: now + 3600, ...options.claims(pending.user) }) });
  });
  const server: Server = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, idp);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  issuer = `https://127.0.0.1:${(server.address() as any).port}${p}`;
  const dir = join(root, name), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const base = { adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } };
  await mkdtemp(dir).catch(() => {}); execFileSync("mkdir", ["-p", dir]);
  await writeFile(join(dir, "access.yaml"), YAML.stringify(options.access));
  await writeFile(join(dir, "sources.yaml"), YAML.stringify({ sources: [{ ...base, id: "public" }] }));
  let output = "";
  const app: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), SC_MODE: "team", SC_HOST: "127.0.0.1",
    SC_PUBLIC_URL: `https://${host}`, SC_OIDC_ISSUER: issuer, SC_OIDC_CLIENT_ID: clientId, SC_OIDC_CLIENT_SECRET: clientSecret, SC_ACCESS_PATH: join(dir, "access.yaml"), SC_DATA_DIR: join(dir, "data"),
    SC_ENV_PATH: join(dir, ".env"), SOURCES_PATH: join(dir, "sources.yaml"), RLS_PATH: resolve("security/policies.yaml"), PORT: String(port), SC_SERVE_UI: "false", ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", d => output += d); app.stderr?.on("data", d => output += d);
  cleanup.push(async () => { if (app.exitCode === null) { app.kill("SIGTERM"); await new Promise(r => app.once("exit", r)); } await new Promise<void>(r => server.close(() => r())); });
  const call = (path: string, init: RequestInit = {}) => loopbackRequest(url + path, { method: init.method, body: init.body as string, headers: { host, ...init.headers as Record<string, string> } });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) { if (app.exitCode !== null) throw new Error(`${name} server exited: ${output}`); try { ready = (await call("/healthz")).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 100)); }
  if (!ready) throw new Error(`${name} server did not start: ${output}`);
  const signIn = async (user: string) => {
    const start = await call("/api/auth/login");
    if (start.status !== 302) return { status: start.status, body: await start.text() };
    const destination = new URL(start.headers.get("location")!);
    const code = randomUUID(); codes.set(code, { challenge: destination.searchParams.get("code_challenge")!, nonce: destination.searchParams.get("nonce")!, user });
    const loginCookie = start.headers.getSetCookie()[0].split(";")[0];
    const callback = await call(`/api/auth/callback?code=${code}&state=${destination.searchParams.get("state")}`, { headers: { cookie: loginCookie } });
    const body = await callback.text();
    const cookie = callback.headers.getSetCookie().find(c => c.startsWith("__Host-sc_session="))?.split(";")[0];
    if (callback.status !== 302 || !cookie) return { status: callback.status, body };
    return { status: 302, body, session: await (await call("/api/auth/session", { headers: { cookie } })).json() };
  };
  return { issuer, call, signIn, clientAuthSeen, rotateKey: newKey, output: () => output, jwksFetches: () => jwksFetches };
}

const admins = "semantic-canvas-admins", viewers = "semantic-canvas-viewers";
const bind = (group: string, role: string, principal = role === "admin" ? "admin" : "emea") => ({ group, role, principal, sources: role === "admin" ? ["*"] : ["public"] });
const entraAdmins = "6f1c2a9e-0b7d-4c55-9d0a-1e2f3a4b5c6d", entraViewers = "b2d4f6a8-1c3e-4a5b-8c7d-9e0f1a2b3c4d", tid = "9188040d-6c67-4c5b-b112-36a304b66dad";
let okta: Tenant, oktaOrg: Tenant, oktaBasicApp: Tenant, oktaMisconfigured: Tenant, entra: Tenant, entraRoles: Tenant;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sc-idp-profiles-"));
  await writeFile(join(root, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-config", join(root, "openssl.cnf")], { stdio: "ignore" });
  const oktaClaims = (user: string) => ({ sub: `00u${user}`, name: "Okta Person", email: `${user}@example.com`, preferred_username: `${user}@example.com`, ver: 1, jti: `ID.${randomUUID()}`, amr: ["pwd"], idp: "00oexampleidp", auth_time: Math.floor(Date.now() / 1000), at_hash: "placeholder",
    // Okta emits group names only when a groups claim is configured for the app or authorization server.
    ...(user === "admin" ? { groups: ["Everyone", admins] } : user === "viewer" ? { groups: ["Everyone", viewers] } : user === "both" ? { groups: [viewers, "Everyone", admins] } : user === "outsider" ? { groups: ["Everyone"] } : {}) });
  const entraBase = (user: string) => ({ sub: `pairwise-${user}`, oid: `00000000-0000-0000-0000-${user.padEnd(12, "0").slice(0, 12)}`, tid, ver: "2.0", name: "Entra Person", preferred_username: `${user}@contoso.example`, rh: "0.placeholder", uti: randomUUID() });
  const oktaAccess = { groupsClaim: "groups", bindings: [bind(admins, "admin"), bind(viewers, "viewer")] };
  [okta, oktaOrg, oktaBasicApp, oktaMisconfigured, entra, entraRoles] = await Promise.all([
    // Okta custom authorization server: issuer has a path and no trailing slash; web apps default to client_secret_basic.
    startTenant("okta", { issuerPath: "/oauth2/default", authMethods: ["client_secret_basic", "client_secret_post"], claims: oktaClaims,
      access: { groupsClaim: "groups", bindings: [bind(admins, "admin"), bind(viewers, "viewer")] } }),
    // Okta org authorization server: root issuer with no path and no trailing slash, basic authentication only.
    startTenant("okta-org", { issuerPath: "", authMethods: ["client_secret_basic"], claims: oktaClaims,
      access: { groupsClaim: "groups", bindings: [bind(admins, "admin"), bind(viewers, "viewer")] } }),
    // Okta advertises both methods, but each application accepts only the one it is registered with (basic by default).
    startTenant("okta-basic-app", { issuerPath: "/oauth2/default", authMethods: ["client_secret_basic", "client_secret_post"], accepts: ["client_secret_basic"], claims: oktaClaims,
      access: oktaAccess, env: { SC_OIDC_CLIENT_AUTH: "client_secret_basic" } }),
    startTenant("okta-misconfigured", { issuerPath: "/oauth2/default", authMethods: ["client_secret_basic", "client_secret_post"], accepts: ["client_secret_basic"], claims: oktaClaims, access: oktaAccess }),
    // Entra v2.0: tenant-scoped issuer; groups are object IDs; over 200 groups become an overage reference instead of a groups claim.
    startTenant("entra", { issuerPath: `/${tid}/v2.0`, authMethods: ["client_secret_post", "client_secret_basic"],
      claims: user => ({ ...entraBase(user), ...(user === "admin" ? { groups: [entraViewers, entraAdmins] } : user === "viewer" ? { groups: [entraViewers] }
        : user === "overage" || user === "overage-bound" ? { _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: `https://graph.microsoft.com/v1.0/users/x/getMemberObjects` } } } : {}) }),
      access: { groupsClaim: "groups", bindings: [{ subject: "pairwise-overage-bound", role: "editor", principal: "emea", sources: ["public"] }, bind(entraAdmins, "admin"), bind(entraViewers, "viewer")] } }),
    // Entra app roles: a `roles` claim of role values, read by pointing groupsClaim at it.
    startTenant("entra-roles", { issuerPath: `/${tid}/v2.0`, authMethods: ["client_secret_post"],
      claims: user => ({ ...entraBase(user), ...(user === "admin" ? { roles: ["Canvas.Admin"] } : user === "viewer" ? { roles: ["Canvas.Viewer"], groups: [entraAdmins] } : {}) }),
      access: { groupsClaim: "roles", bindings: [bind("Canvas.Admin", "admin"), bind("Canvas.Viewer", "viewer")] } }),
  ]);
}, 120_000);
afterAll(async () => { await Promise.all(cleanup.map(stop => stop())); if (root) await rm(root, { recursive: true, force: true }); });

it("Okta custom authorization server: maps group names from a path issuer", async () => {
  expect(okta.issuer).toMatch(/\/oauth2\/default$/);
  expect((await okta.signIn("admin")).session).toMatchObject({ authenticated: true, canAdmin: true, user: { role: "admin", name: "Okta Person" } });
  expect((await okta.signIn("viewer")).session).toMatchObject({ authenticated: true, canEdit: false, user: { role: "viewer" } });
  // Binding order decides, not the order of groups in the token.
  expect((await okta.signIn("both")).session.user.role).toBe("admin");
});

it("Okta: an account with no matching group, or no groups claim at all, is refused with guidance", async () => {
  for (const user of ["outsider", "no-groups-claim"]) {
    const refused = await okta.signIn(user);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatch(/no Semantic Canvas access/);
  }
  expect(okta.output()).toContain("auth.access_denied");
});

it("Okta org authorization server: signs in with a root issuer and basic client authentication", async () => {
  expect(new URL(oktaOrg.issuer).pathname).toBe("/");
  expect(oktaOrg.issuer.endsWith("/")).toBe(false);
  const admin = await oktaOrg.signIn("admin");
  expect(admin.status, admin.body + oktaOrg.output()).toBe(302);
  expect(admin.session.user.role).toBe("admin");
  expect([...oktaOrg.clientAuthSeen]).toEqual(["client_secret_basic"]);
});

it("Okta application registered for basic authentication: works when configured, and fails with a reason code when not", async () => {
  expect((await oktaBasicApp.signIn("admin")).session?.user.role).toBe("admin");
  expect([...oktaBasicApp.clientAuthSeen]).toEqual(["client_secret_basic"]);
  const refused = await oktaMisconfigured.signIn("admin");
  expect(refused.status).toBe(400);
  // An operator can tell a client-authentication mismatch from a bad token without seeing any secret.
  expect(oktaMisconfigured.output()).toMatch(/"event":"auth.callback_failed"[^\n]*"errorType":"invalid_client"/);
});

it("Entra: maps group object IDs from a tenant-scoped v2.0 issuer", async () => {
  expect((await entra.signIn("admin")).session).toMatchObject({ canAdmin: true, user: { role: "admin", name: "Entra Person" } });
  expect((await entra.signIn("viewer")).session.user.role).toBe("viewer");
});

it("Entra group overage: refused rather than guessed, unless the account has a subject binding", async () => {
  // Entra replaces the groups claim with a Graph reference for large memberships. Canvas does not call Graph.
  const overage = await entra.signIn("overage");
  expect(overage.status).toBe(403);
  expect(overage.body).toMatch(/no Semantic Canvas access/);
  expect((await entra.signIn("overage-bound")).session).toMatchObject({ canEdit: true, canAdmin: false, user: { role: "editor" } });
});

it("Entra app roles: a roles claim grants access and group IDs in the same token do not", async () => {
  expect((await entraRoles.signIn("admin")).session.user.role).toBe("admin");
  // This token also carries the admin group's object ID; only the configured claim is read.
  expect((await entraRoles.signIn("viewer")).session.user.role).toBe("viewer");
  expect((await entraRoles.signIn("no-roles")).status).toBe(403);
});

it("derives distinct, stable account IDs per provider and keeps provider material out of logs", async () => {
  const [a, b, c] = [await okta.signIn("admin"), await okta.signIn("admin"), await oktaOrg.signIn("admin")];
  expect(a.session.user.id).toBe(b.session.user.id);
  // The same subject at a different issuer is a different account.
  expect(c.session.user.id).not.toBe(a.session.user.id);
  for (const tenant of [okta, oktaOrg, oktaBasicApp, oktaMisconfigured, entra, entraRoles]) for (const secret of [clientSecret, "opaque-provider-token", "@example.com", "@contoso.example"]) expect(tenant.output()).not.toContain(secret);
});

it("verifies the ID token signature and follows a pre-published signing-key rotation without a restart", async () => {
  expect((await entra.signIn("admin")).status).toBe(302);
  expect(entra.jwksFetches()).toBeGreaterThan(0);
  entra.rotateKey();
  const rotated = await entra.signIn("admin");
  expect(rotated.status, rotated.body + entra.output()).toBe(302);
  // A second rotation moves to a key published after the last fetch. That one attempt fails closed:
  // the unknown key is never accepted. Canvas then re-reads the provider's keys, so the retry succeeds.
  entra.rotateKey();
  const unknown = await entra.signIn("admin");
  expect(unknown.status).toBe(400);
  expect(entra.output()).toMatch(/"event":"auth.callback_failed"[^\n]*"errorType":"OAUTH_KEY_SELECTION_FAILED"/);
  for (let i = 0; i < 100 && !entra.output().includes("auth.provider_keys_refreshed"); i++) await new Promise(r => setTimeout(r, 50));
  expect(entra.output()).toContain("auth.provider_keys_refreshed");
  const retried = await entra.signIn("admin");
  expect(retried.status, retried.body).toBe(302);
  expect(retried.session.user.role).toBe("admin");
});
