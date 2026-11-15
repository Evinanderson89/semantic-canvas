import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CompanyAuth, identityOf, type ForwardedAuth, type GatewayPolicyRule } from "../src/security/auth.ts";
import { api, TOOLS, runToolInContext } from "../src/agent/tools.ts";
import { mountChartActivity } from "../src/activity/server.ts";
import { openStore, closeStore, saveDashboard, exportLibrary, mutateActivity } from "../src/store/store.ts";
import { createHash } from "node:crypto";
import { compileTile, buildPredicate } from "../src/compiler/compile.ts";
import { requireScope, scopedField } from "../src/security/queryScope.ts";
import { model, conn, tile } from "./fixtures.ts";

let provider: Server, server: Server, url: string, issuer: string, auth: CompanyAuth, db: DuckDBConnection;
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwt: string;
let savedAuth: ForwardedAuth | undefined;
const secret = "synthetic-boundary-test-secret";
const connector = { ...conn, relation: (table: string) => `"${table}"` };
const who = { id: "reviewer", name: "Reviewer" };
const cfg = { policies: [], principals: { reviewer: who } };
const activityModel = structuredClone(model);
let activity: ReturnType<typeof mountChartActivity>, activityQueries = 0;
const rules: GatewayPolicyRule[] = [{ field: "dim_users.country", mode: "only", values: ["GB"] }];
const sign = (over: object = {}) => {
  const body = Buffer.from(JSON.stringify({ v: 1, sub: "reviewer", app: "semantic-canvas", exp: Math.floor(Date.now() / 1000) + 120, rules, ...over })).toString("base64url");
  return { "x-gateway-policy": body, "x-gateway-policy-sig": createHmac("sha256", secret).update(body).digest("base64url") };
};
const rows = async (sql: string) => (await db.runAndReadAll(sql)).getRows();
const close = (s: Server) => new Promise<void>(resolve => s.close(() => resolve()));

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "boundary", alg: "RS256" };
  provider = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(provider.address() as any).port}`;
  jwt = await new SignJWT({ groups: ["reviewers"] }).setProtectedHeader({ alg: "RS256", kid: "boundary" }).setIssuer(issuer).setSubject("reviewer").setAudience("canvas").setExpirationTime("10m").sign(keys.privateKey);
  auth = new CompanyAuth({ mode: "gateway", issuer, clientId: "canvas", jwksUri: `${issuer}/keys`, publicUrl: "http://semantic-canvas.test", policySecret: secret, appSlug: "semantic-canvas", scopes: "openid", sessionSeconds: 600,
    access: { groupsClaim: "groups", bindings: [{ group: "reviewers", role: "viewer", principal: "reviewer", sources: ["sample"] }] } });
  await auth.start();
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run("CREATE TABLE fct_sales (sale_id VARCHAR, user_id VARCHAR, amount DOUBLE); INSERT INTO fct_sales VALUES ('one','a',10),('two','b',20); CREATE TABLE dim_users (user_id VARCHAR, country VARCHAR); INSERT INTO dim_users VALUES ('a','GB'),('b','US')");
  const app = express(); app.use(express.json()); auth.mount(app); app.use("/api", auth.guard);
  app.get("/api/identity", (req, res) => { savedAuth = auth.forwarded(req); res.json({ identity: identityOf(req) }); });
  app.all("/api/query", async (req, res, next) => { try {
    const scope = requireScope(model, "fct_sales", cfg, null, identityOf(req)?.policy);
    const sql = compileTile(model, connector, tile({ where: scope.filters }), { role: identityOf(req)?.role });
    res.json({ rows: await rows(sql), applied: scope.filters.map(f => f.id) });
  } catch (e) { next(e); } });
  app.get("/api/profile", async (req, res, next) => { try {
    const from = scopedField(model, connector, "fct_sales", "dim_users.country", cfg, null, identityOf(req)?.policy);
    res.json({ rows: await rows(`SELECT DISTINCT value FROM ${from} ORDER BY value`) });
  } catch (e) { next(e); } });
  app.get("/api/agent-test", async (req, res, next) => { try {
    const result = await runToolInContext({ source: "sample", auth: auth.forwarded(req) }, async () => ({
      query: await TOOLS.find(t => t.name === "query_metric")!.handler({ metrics: ["revenue"], dimensions: [] }),
      profile: await TOOLS.find(t => t.name === "profile_field")!.handler({ base: "fct_sales", fields: ["dim_users.country"] }),
    }));
    res.json(result);
  } catch (e) { next(e); } });
  await openStore(":memory:");
  await saveDashboard({ id: "activity-boundary", spec: { title: "Scoped discussion", tiles: [tile()] } }, { source: "sample", model: model.name });
  const source = { id: "sample", label: "Synthetic", adapter: "test", status: "ready" as const, model: activityModel, conn: { ...connector, execute: async (sql: string) => { activityQueries++; const result = await db.runAndReadAll(sql); return { columns: result.columnNames(), rows: result.getRows(), sql, ms: 0 }; } } };
  activity = mountChartActivity(app, { auth, source: () => source, sources: () => [source], principal: () => who, rls: () => cfg,
    safe: fn => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next) });
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.config.access!.bindings[0].role = "viewer"; activityModel.metrics.revenue.reviewed = true; });
afterAll(async () => { await activity.stop(); await Promise.all([close(server), close(provider)]); await closeStore(); db.closeSync(); });

for (const credential of ["cookie", "bearer"]) it(`keeps direct queries, agent queries, profiling and cached identity in the same scope with ${credential} authentication`, async () => {
  vi.stubEnv("PORT", new URL(url).port);
  const headers = { ...(credential === "cookie" ? { cookie: `gw_session=${jwt}` } : { authorization: `Bearer ${jwt}` }), ...sign() };
  const direct = await (await fetch(`${url}/api/query`, { headers })).json();
  expect(direct.rows).toEqual([[10]]);
  const agent = await fetch(`${url}/api/agent-test`, { headers }); expect(agent.status).toBe(200);
  expect(await agent.json()).toEqual({ query: direct, profile: { rows: [["GB"]] } });
  const identity = (await (await fetch(`${url}/api/identity`, { headers })).json()).identity;
  expect(auth.currentIdentity(identity.id)?.policy).toEqual(rules);
  expect(savedAuth?.gatewayPolicy).toEqual({ body: headers["x-gateway-policy"], signature: headers["x-gateway-policy-sig"] });
  if (credential === "bearer") { expect(savedAuth?.authorization).toBe(`Bearer ${jwt}`); expect(savedAuth?.cookie).toBeUndefined(); }
});

for (const failure of ["bad-signature", "expired", "other-subject", "other-app", "bad-rules", "missing-signature", "missing-body", "empty-body", "invalid-json"]) it(`rejects ${failure} policy before serving data or retaining a usable identity`, async () => {
  const cookie = `gw_session=${jwt}`;
  const validIdentity = (await (await fetch(`${url}/api/identity`, { headers: { cookie, ...sign() } })).json()).identity;
  let policy: Record<string, string> = sign(failure === "expired" ? { exp: 1 } : failure === "other-subject" ? { sub: "someone-else" } : failure === "other-app" ? { app: "other" } : failure === "bad-rules" ? { rules: [{ field: "country", mode: "only", values: ["GB"] }] } : {});
  if (failure === "bad-signature") policy["x-gateway-policy-sig"] = "not-a-signature";
  if (failure === "missing-signature") delete policy["x-gateway-policy-sig"];
  if (failure === "missing-body") delete policy["x-gateway-policy"];
  if (failure === "empty-body") policy["x-gateway-policy"] = "";
  if (failure === "invalid-json") { policy["x-gateway-policy"] = Buffer.from("not JSON").toString("base64url"); policy["x-gateway-policy-sig"] = createHmac("sha256", secret).update(policy["x-gateway-policy"]).digest("base64url"); }
  const response = await fetch(`${url}/api/query`, { headers: { cookie, ...policy } });
  expect(response.status).toBe(403); expect(await response.json()).not.toHaveProperty("rows");
  expect(auth.currentIdentity(validIdentity.id)).toBeNull();
});

it("allows a verified empty rule set and an intentionally absent policy", async () => {
  for (const policy of [sign({ rules: [] }), {}]) {
    const response = await fetch(`${url}/api/query`, { headers: { cookie: `gw_session=${jwt}`, ...policy } });
    expect(response.status).toBe(200); expect((await response.json()).rows).toEqual([[30]]);
  }
});
it("expires tool and background identity access with the signed policy, even while the login remains valid", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const identity = (await (await fetch(`${url}/api/identity`, { headers: { cookie: `gw_session=${jwt}`, ...sign({ exp }) } })).json()).identity;
  expect(savedAuth?.expires).toBe(exp * 1000);
  vi.spyOn(Date, "now").mockReturnValue(exp * 1000);
  expect(auth.currentIdentity(identity.id)).toBeNull();
  await expect(runToolInContext({ auth: savedAuth }, () => api("/api/query"))).rejects.toThrow(/expired/);
});
for (const [mode, values, total, countries] of [
  ["only", [], null, []], ["not", [], 30, [["GB"], ["US"]]],
  ["only", ["GB"], 10, [["GB"]]], ["not", ["GB"], 20, [["US"]]],
] as const) it(`enforces ${mode} [${values}] identically for queries and discovery`, async () => {
  const policy = [{ field: "dim_users.country", mode, values: [...values] }];
  const headers = { cookie: `gw_session=${jwt}`, ...sign({ rules: policy }) };
  expect((await (await fetch(`${url}/api/query`, { headers })).json()).rows).toEqual([[total]]);
  expect((await (await fetch(`${url}/api/profile`, { headers })).json()).rows).toEqual(countries);
});
it("keeps ordinary empty filters optional while denying an empty local RLS grant", () => {
  const empty = { id: "user-filter", field: "dim_users.country", source: "dimension" as const, mode: "discrete" as const, values: [] };
  expect(buildPredicate(model, connector, "fct_sales", empty)).toBeNull();
  expect(buildPredicate(model, connector, "fct_sales", { ...empty, id: "rls:region" })?.sql).toBe("FALSE");
});


const activityPath = "/api/chart-activity/activity-boundary/t1";
async function activityCall(path: string, policy: Record<string, string>, method = "GET", body?: unknown) {
  const headers: Record<string, string> = { cookie: `gw_session=${jwt}`, ...policy, "content-type": "application/json" };
  const session = await (await fetch(`${url}/api/auth/session`, { headers })).json();
  headers["x-sc-csrf"] = session.csrf;
  return fetch(`${url}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it("isolates comments, summaries and replies by signed gateway scope, including legacy records", async () => {
  const gb = sign(), us = sign({ rules: [{ field: "dim_users.country", mode: "only", values: ["US"] }] });
  expect((await activityCall(activityPath + "/comments", gb, "POST", { body: "GB-only evidence" })).status).toBe(201);
  const own = await (await activityCall(activityPath, gb)).json(); expect(own.threads).toHaveLength(1);
  expect((await (await activityCall(activityPath, us)).json()).threads).toEqual([]);
  expect((await (await activityCall("/api/chart-activity/activity-boundary", us)).json()).summary).toEqual({});
  expect((await activityCall(`${activityPath}/comments/${own.threads[0].id}/replies`, us, "POST", { body: "Cross-scope reply" })).status).toBe(404);
  const equivalent = sign({ rules: [{ field: "dim_users.country", mode: "only", values: ["GB", "GB"] }, ...rules] });
  expect((await (await activityCall(activityPath, equivalent)).json()).threads).toHaveLength(1);
  const oldAudience = createHash("sha256").update(JSON.stringify({ principal: who, policies: [] })).digest("hex");
  await mutateActivity({ source: "sample", dashboardId: "activity-boundary", audience: oldAudience }, "t1", () => ({
    id: "legacy-thread", type: "thread", source: "sample", dashboardId: "activity-boundary", tileId: "t1", audience: oldAudience, ownerId: "legacy-author",
    body: { id: "legacy-thread", authorId: "legacy-author", authorName: "Legacy", body: "Unknown historical scope", createdAt: new Date().toISOString(), resolved: false, replies: [] },
  }));
  expect((await (await activityCall(activityPath, {})).json()).threads).toEqual([]);
});
it("blocks unpublished metric activity and alert previews for viewers before executing a query", async () => {
  activityModel.metrics.revenue.reviewed = false;
  const before = activityQueries;
  const payload = { rule: { metric: "revenue", mode: "threshold", threshold: 0 }, revision: 1 };
  expect((await activityCall(activityPath + "/alerts/preview", {}, "POST", payload)).status).toBe(403);
  expect((await activityCall(activityPath + "/alert", {}, "PUT", { ...payload, version: 0 })).status).toBe(403);
  expect((await activityCall(activityPath, {})).status).toBe(403);
  expect(activityQueries).toBe(before);
  activityModel.metrics.revenue.reviewed = true;
  const allowed = await activityCall(activityPath + "/alerts/preview", {}, "POST", payload);
  expect(allowed.status).toBe(200); expect((await allowed.json()).evaluation.value).toBe(30);
});
it("rechecks the owner's current publication permissions before scheduled evaluation", async () => {
  activityModel.metrics.revenue.reviewed = false;
  auth.config.access!.bindings[0].role = "editor";
  const created = await activityCall(activityPath + "/alert", {}, "PUT", { rule: { metric: "revenue", mode: "threshold", threshold: 0 }, revision: 1, version: 0 });
  expect(created.status).toBe(200);
  auth.config.access!.bindings[0].role = "viewer";
  await activityCall("/api/identity", {});
  const before = activityQueries;
  activity.start();
  await vi.waitFor(async () => { const record = (await exportLibrary()).activity?.find(r => r.type === "alert"); expect((record?.body as any).evaluation?.state).toBe("needs_review"); });
  await activity.stop();
  const stored = (await exportLibrary()).activity?.find(r => r.type === "alert");
  expect(activityQueries).toBe(before);
  expect((stored?.body as any).events).toEqual([]);
});
