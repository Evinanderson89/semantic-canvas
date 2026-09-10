import { api, runToolInContext } from "../src/agent/tools.ts";
import { loopbackRequest } from "../src/security/loopback.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import YAML from "yaml";
import { accessSchema, loadAuthConfig, mapIdentity } from "../src/security/auth.ts";

let root = "", issuer = "", url = "", output = "", appProcess: ChildProcess, provider: ReturnType<typeof createServer>;
const host = "canvas.example.test";
const codes = new Map<string, { challenge: string; nonce: string; sub: string; groups: string[] }>();
const clientSecret = "test-client-secret-do-not-log";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (claims: object) => { const body = `${encode({ alg: "RS256", kid: "test-key" })}.${encode(claims)}`; return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`; };
const policy = accessSchema.parse({ groupsClaim: "groups", bindings: [
  { group: "admins", role: "admin", principal: "admin", sources: ["*"] },
  { group: "editors", role: "editor", principal: "emea", sources: ["public"] },
  { group: "viewers", role: "viewer", principal: "emea", sources: ["public"] },
] });
async function freePort() { const s = createHttpServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const port = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return port; }
const call = (path: string, init: RequestInit = {}) => loopbackRequest(url + path, { method: init.method, body: init.body as string, headers: { host, ...init.headers as Record<string, string> } });
interface Login { cookie: string; csrf: string; user: { id: string; role: string } }
async function begin(sub: string, groups: string[]) {
  const start = await call("/api/auth/login"); expect(start.status).toBe(302);
  const destination = new URL(start.headers.get("location")!);
  expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
  const code = randomUUID(); codes.set(code, { challenge: destination.searchParams.get("code_challenge")!, nonce: destination.searchParams.get("nonce")!, sub, groups });
  return { code, state: destination.searchParams.get("state")!, cookie: start.headers.getSetCookie()[0].split(";")[0] };
}
async function login(sub: string, groups: string[]): Promise<Login> {
  const pending = await begin(sub, groups);
  const callback = await call(`/api/auth/callback?code=${pending.code}&state=${pending.state}`, { headers: { cookie: pending.cookie } });
  expect(callback.status, await callback.clone().text()).toBe(302);
  const setCookie = callback.headers.getSetCookie().find(c => c.startsWith("__Host-sc_session="))!;
  expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("Secure"); expect(setCookie).toContain("SameSite=Lax");
  const cookie = setCookie.split(";")[0];
  const session = await (await call("/api/auth/session", { headers: { cookie } })).json();
  expect(session.authenticated).toBe(true); return { cookie, csrf: session.csrf, user: session.user };
}
const headers = (s: Login) => ({ cookie: s.cookie, "x-sc-csrf": s.csrf, "content-type": "application/json" });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sc-company-"));
  await writeFile(join(root, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-config", join(root, "openssl.cnf")], { stdio: "ignore" });
  const idp = express(); idp.use(express.urlencoded({ extended: false }));
  idp.get("/.well-known/openid-configuration", (_q, r) => r.json({ issuer, authorization_endpoint: issuer + "authorize", token_endpoint: issuer + "token", jwks_uri: issuer + "jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] }));
  idp.get("/jwks", (_q, r) => r.json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test-key" }] }));
  idp.post("/token", (q, r) => {
    const pending = codes.get(q.body.code); codes.delete(q.body.code);
    if (!pending || q.body.client_secret !== clientSecret || q.body.client_id !== "canvas" || createHash("sha256").update(q.body.code_verifier ?? "").digest("base64url") !== pending.challenge) return r.status(400).json({ error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    r.json({ token_type: "Bearer", access_token: "private-provider-token", expires_in: 300, id_token: jwt({ iss: issuer, aud: "canvas", sub: pending.sub, groups: pending.groups, nonce: pending.nonce, iat: now, exp: now + 300, name: "Private Person" }) });
  });
  provider = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, idp);
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r)); issuer = `https://127.0.0.1:${(provider.address() as any).port}/`;
  const port = await freePort(); url = `http://127.0.0.1:${port}`;
  await writeFile(join(root, "access.yaml"), YAML.stringify(policy));
  const base = { adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } };
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ sources: [{ ...base, id: "public" }, { ...base, id: "private" }] }));
  appProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), SC_MODE: "team", SC_HOST: "127.0.0.1", SC_PUBLIC_URL: `https://${host}`, SC_OIDC_ISSUER: issuer, SC_OIDC_CLIENT_ID: "canvas", SC_OIDC_CLIENT_SECRET: clientSecret, SC_ACCESS_PATH: join(root, "access.yaml"), SC_DATA_DIR: join(root, "data"), SC_ENV_PATH: join(root, ".env"), SOURCES_PATH: join(root, "sources.yaml"), RLS_PATH: resolve("security/policies.yaml"), PORT: String(port), SC_SERVE_UI: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  appProcess.stdout?.on("data", d => output += d); appProcess.stderr?.on("data", d => output += d);
  for (let i = 0; i < 200; i++) { if (appProcess.exitCode !== null) throw new Error(output); try { if ((await call("/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Company server did not start: " + output);
}, 60_000);
afterAll(async () => { if (appProcess && appProcess.exitCode === null) { appProcess.kill("SIGTERM"); await new Promise(r => appProcess.once("exit", r)); } if (provider) await new Promise<void>(r => provider.close(() => r())); if (root) await rm(root, { recursive: true, force: true }); });

it("fails closed for missing team configuration, unmapped users and ambiguous rules", async () => {
  await expect(loadAuthConfig({ SC_MODE: "team" })).rejects.toThrow(/required/);
  expect(mapIdentity({ sub: "nobody", groups: ["unassigned"] }, issuer, policy)).toBeNull();
  expect(accessSchema.safeParse({ bindings: [{ subject: "a", group: "b", role: "admin", principal: "admin", sources: ["*"] }] }).success).toBe(false);
  expect((await call("/api/model")).status).toBe(401);
  expect((await call("/api/model", { headers: { "x-sc-principal": "admin" } })).status).toBe(401);
  expect((await call("/healthz")).status).toBe(200);
  const attempt = await begin("nobody", ["unassigned"]);
  expect((await call(`/api/auth/callback?code=${attempt.code}&state=${attempt.state}`, { headers: { cookie: attempt.cookie } })).status).toBe(403);
});
it("completes HTTPS OIDC code exchange with PKCE and rejects state, nonce and replay", async () => {
  const s = await login("admin", ["admins"]); expect(s.user.role).toBe("admin");
  const attempt = await begin("admin", ["admins"]);
  expect((await call(`/api/auth/callback?code=${attempt.code}&state=forged`, { headers: { cookie: attempt.cookie } })).status).toBe(400);
  expect((await call(`/api/auth/callback?code=${attempt.code}&state=${attempt.state}`, { headers: { cookie: attempt.cookie } })).status).toBe(400);
  const wrongNonce = await begin("admin", ["admins"]); codes.get(wrongNonce.code)!.nonce = "forged";
  expect((await call(`/api/auth/callback?code=${wrongNonce.code}&state=${wrongNonce.state}`, { headers: { cookie: wrongNonce.cookie } })).status).toBe(400);
});
it("enforces source access and server principal despite forged client headers", async () => {
  const s = await login("viewer", ["viewers"]);
  const list = await (await call("/api/sources", { headers: headers(s) })).json(); expect(list.sources.map((s: any) => s.id)).toEqual(["public"]);
  expect((await call("/api/model", { headers: { ...headers(s), "x-sc-source": "private" } })).status).toBe(403);
  expect((await call("/api/model?source=private", { headers: headers(s) })).status).toBe(403);
  const response = await call("/api/values?base=dim_users&field=country", { headers: { ...headers(s), "x-sc-principal": "admin" } });
  expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain("GB"); expect(text).not.toContain('"US"');
  const query = await call("/api/query", { method: "POST", headers: { ...headers(s), "x-sc-principal": "admin" }, body: JSON.stringify({ metrics: ["event_count"], dimensions: [] }) });
  expect(query.status).toBe(200); expect(await query.json()).toMatchObject({ principal: "emea", rlsApplied: ["rls:region"] });
});
it("allows editor saves, denies viewers and protects administration and CSRF", async () => {
  const viewer = await login("viewer-two", ["viewers"]), editor = await login("editor", ["editors"]), admin = await login("admin-two", ["admins"]);
  const document = { id: "company-dashboard", spec: { title: "Company", tiles: [] } };
  expect((await call("/api/dashboards", { method: "POST", headers: headers(viewer), body: JSON.stringify(document) })).status).toBe(403);
  expect((await call("/api/dashboards", { method: "POST", headers: { ...headers(editor), "x-sc-csrf": "é".repeat(editor.csrf.length) }, body: JSON.stringify(document) })).status).toBe(403);
  expect((await call("/api/dashboards", { method: "POST", headers: headers(editor), body: JSON.stringify(document) })).status).toBe(200);
  expect((await call("/api/dashboards/company-dashboard", { headers: headers(viewer) })).status).toBe(200);
  for (const path of ["/api/setup", "/api/operations/status", "/api/operations/backup", "/api/sources/public/config"]) expect((await call(path, { headers: headers(editor) })).status).toBe(403);
  expect((await call("/api/agent/key", { method: "POST", headers: headers(editor), body: JSON.stringify({ apiKey: "must-not-log-this-key" }) })).status).toBe(403);
  expect((await call("/api/setup", { headers: headers(admin) })).status).toBe(200);
  const backup = await (await call("/api/operations/backup", { headers: headers(admin) })).json(); expect(backup.dashboards).toHaveLength(1);
  expect((await call("/api/setup", { headers: { ...headers(admin), origin: "https://evil.test" } })).status).toBe(403);
});
it("isolates private assistant questions between users and revokes logout", async () => {
  const a = await login("a", ["editors"]), b = await login("b", ["editors"]);
  const question = await (await call("/api/agent/questions", { method: "POST", headers: headers(a), body: JSON.stringify({ question: "Private question do-not-log" }) })).json();
  expect((await (await call("/api/agent/questions", { headers: headers(b) })).json()).questions).toEqual([]);
  expect((await call(`/api/agent/questions/${question.id}`, { headers: headers(b) })).status).toBe(404);
  expect((await call(`/api/agent/questions/${question.id}/answer`, { method: "POST", headers: headers(b), body: JSON.stringify({ answer: "forged" }) })).status).toBe(404);
  expect((await call("/api/auth/logout", { method: "POST", headers: { cookie: a.cookie } })).status).toBe(403);
  expect((await call("/api/auth/logout", { method: "POST", headers: headers(a) })).status).toBe(200);
  expect((await call("/api/model", { headers: headers(a) })).status).toBe(401);
});
it("keeps credentials, callback query strings and private content out of structured logs", () => {
  expect(output).not.toContain(clientSecret); expect(output).not.toContain("private-provider-token"); expect(output).not.toContain("must-not-log-this-key"); expect(output).not.toContain("Private question do-not-log"); expect(output).not.toContain("Private Person"); expect(output).not.toContain("?code=");
  expect(output).toContain('"event":"audit.change"'); expect(output).toContain('"requestId"');
});

it("forwards the signed-in session for embedded tools and ignores forged scope arguments", async () => {
  const s = await login("tool-editor", ["editors"]), previous = process.env.PORT;
  process.env.PORT = new URL(url).port;
  try {
    const result = await runToolInContext({ source: "public", principal: "emea", auth: { cookie: s.cookie, csrf: s.csrf, host, origin: `https://${host}` } }, () => api("/api/query", { source: "private", principal: "admin", body: { metrics: ["event_count"], dimensions: [] } }));
    expect(result.principal).toBe("emea");
  } finally { if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous; }
});
it("scopes chart discussions to data permissions and watches to their authenticated owner", async () => {
  const editor = await login("discussion-editor", ["editors"]), viewer = await login("discussion-viewer", ["viewers"]), admin = await login("discussion-admin", ["admins"]);
  const tile = { id: "events", metrics: ["event_count"], dimensions: [], layout: { x: 0, y: 0, w: 400, h: 240 } };
  const document = { id: "discussion-dashboard", spec: { title: "Discussion", tiles: [tile] } };
  expect((await call("/api/dashboards", { method: "POST", headers: headers(editor), body: JSON.stringify(document) })).status).toBe(200);
  const path = "/api/chart-activity/discussion-dashboard/events";
  const comment = await call(path + "/comments", { method: "POST", headers: headers(viewer), body: JSON.stringify({ body: "A scoped observation" }) });
  expect(comment.status, await comment.clone().text()).toBe(201);
  const shared = await (await call(path, { headers: headers(editor) })).json();
  expect(shared.threads).toHaveLength(1); expect(shared.threads[0].authorId).toBe(viewer.user.id);
  expect((await (await call(path, { headers: headers(admin) })).json()).threads).toHaveLength(0);
  expect((await call(path, { headers: { ...headers(viewer), "x-sc-source": "private" } })).status).toBe(403);
  expect((await call(path + "/comments", { method: "POST", headers: { cookie: viewer.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "No CSRF" }) })).status).toBe(403);
  expect((await call(path + "/comments", { method: "POST", headers: headers(viewer), body: JSON.stringify({ body: "Forged name", authorId: editor.user.id }) })).status).toBe(400);
  const payload = { rule: { metric: "event_count", mode: "threshold", threshold: 0 }, revision: 1, version: 0 };
  expect((await call(path + "/alert", { method: "PUT", headers: headers(viewer), body: JSON.stringify(payload) })).status).toBe(200);
  expect((await (await call(path, { headers: headers(editor) })).json()).alert).toBeNull();
  expect((await call(path + "/alerts/check", { method: "POST", headers: headers(viewer) })).status).toBe(200);
  expect((await call(path + "/alerts/check", { method: "POST", headers: headers(viewer) })).status).toBe(200);
  const checked = await (await call(path, { headers: headers(viewer) })).json();
  expect(checked.alert.evaluation.state).toBe("triggered"); expect(checked.alert.events).toHaveLength(1);
  expect((await call(path + "/alert", { method: "PATCH", headers: headers(viewer), body: JSON.stringify({ enabled: false, version: 1 }) })).status).toBe(200);
  expect((await call(path + "/alert", { method: "PUT", headers: headers(viewer), body: JSON.stringify({ ...payload, version: 2 }) })).status).toBe(200);
  expect((await (await call(path, { headers: headers(viewer) })).json()).alert.enabled).toBe(false);
  expect((await call(path + "/alerts/check", { method: "POST", headers: headers(viewer) })).status).toBe(400);
  expect((await call(path + "/alert", { method: "PATCH", headers: headers(viewer), body: JSON.stringify({ enabled: true, version: 3 }) })).status).toBe(200);
  const query = await (await call("/api/query", { method: "POST", headers: headers(viewer), body: JSON.stringify({ metrics: ["event_count"], dimensions: [] }) })).json();
  expect(checked.alert.evaluation.value).toBe(Number(query.rows[0][0]));
  expect((await call(path + "/alert", { method: "PUT", headers: headers(viewer), body: JSON.stringify(payload) })).status).toBe(409);
  await call("/api/dashboards", { method: "POST", headers: headers(editor), body: JSON.stringify({ ...document, revision: 1, spec: { ...document.spec, tiles: [{ ...tile, where: [{ id: "country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["GB"] }] }] } }) });
  await call(path + "/alerts/check", { method: "POST", headers: headers(viewer) });
  expect((await (await call(path, { headers: headers(viewer) })).json()).alert.evaluation.state).toBe("needs_review");
});
it("provisions the first source from an empty registry and keeps its uploaded model", async () => {
  const s = await login("setup-admin", ["admins"]);
  const upload = await call("/api/setup/model", { method: "POST", headers: headers(s), body: JSON.stringify({ adapter: "duckglue", content: await readFile("sample-data/warehouse.yaml", "utf8") }) });
  expect(upload.status).toBe(200); const { path } = await upload.json(); expect(path).toContain(join(root, "data", "models"));
  // Exercise the empty registry on disk; the current live sources remain available until commit.
  await writeFile(join(root, "sources.yaml"), "sources: []\n");
  const add = await call("/api/sources", { method: "POST", headers: headers(s), body: JSON.stringify({ id: "first-source", label: "First source", adapter: "duckglue", model: path, connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }) });
  expect(add.status, await add.clone().text()).toBe(200); expect((await add.json()).sources.map((s: any) => s.id)).toEqual(["first-source"]);
  const config = YAML.parse(await readFile(join(root, "sources.yaml"), "utf8")); expect(config.sources[0].model).toBe(path);
  const concurrent = await Promise.all(["second-source", "third-source"].map(id => call("/api/sources", { method: "POST", headers: headers(s), body: JSON.stringify({ id, adapter: "duckglue", model: path, connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }) })));
  expect(concurrent.map(r => r.status)).toEqual([200, 200]);
  expect(YAML.parse(await readFile(join(root, "sources.yaml"), "utf8")).sources.map((s: any) => s.id)).toEqual(["first-source", "second-source", "third-source"]);
});
