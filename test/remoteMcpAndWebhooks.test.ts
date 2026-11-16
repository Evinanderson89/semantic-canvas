import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRemoteMcp, remoteToolsForRole } from "../src/mcp/remote.ts";
import { sendAlertWebhook, type AlertWebhookResult } from "../src/activity/webhook.ts";
import { mountChartActivity } from "../src/activity/server.ts";
import { CompanyAuth } from "../src/security/auth.ts";
import { closeStore, openStore, saveDashboard } from "../src/store/store.ts";
import { conn, model, tile } from "./fixtures.ts";

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe("Remote MCP endpoint (src/mcp/remote.ts)", () => {
  let apiServer: Server;
  let apiPort = 0;
  let previousUrl: string | undefined;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  const savedDashboards: any[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get("/api/model", (req, res) => {
      lastHeaders = req.headers;
      res.json(model);
    });
    app.post("/api/query", (req, res) => {
      lastHeaders = req.headers;
      res.json({
        columns: ["revenue"],
        rows: [[4200]],
        ms: 2,
        truncated: false,
        warnings: [],
        source: { id: req.header("x-sc-source") ?? "public", label: "Public" },
        principal: req.header("x-sc-principal") ?? null,
      });
    });
    app.post("/api/dashboards", (req, res) => {
      lastHeaders = req.headers;
      savedDashboards.push(req.body);
      res.json({ ok: true, id: req.body.id, revision: 1 });
    });

    apiServer = createHttpServer(app);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    apiPort = (apiServer.address() as any).port;
    previousUrl = process.env.SEMANTIC_CANVAS_URL;
    process.env.PORT = String(apiPort);
  });

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.SEMANTIC_CANVAS_URL;
    else process.env.SEMANTIC_CANVAS_URL = previousUrl;
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  it("handles initialize, notifications/initialized, and invalid JSON-RPC envelopes", async () => {
    const deps = { source: "public", principal: "emea", role: "viewer" as const };

    const initRes = mockRes();
    await handleRemoteMcp(
      { body: { jsonrpc: "2.0", id: 1, method: "initialize" } } as any,
      initRes,
      deps,
    );
    expect(initRes.statusCode).toBe(200);
    expect(initRes.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "semantic-canvas", version: "0.1.0" },
      },
    });

    const notifRes = mockRes();
    await handleRemoteMcp(
      { body: { jsonrpc: "2.0", id: 2, method: "notifications/initialized" } } as any,
      notifRes,
      deps,
    );
    expect(notifRes.statusCode).toBe(200);
    expect(notifRes.body).toMatchObject({ ok: true, result: { ok: true } });

    const invalidRes = mockRes();
    await handleRemoteMcp({ body: { jsonrpc: "1.0" } } as any, invalidRes, deps);
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.body.error.code).toBe(-32600);

    const unknownMethodRes = mockRes();
    await handleRemoteMcp(
      { body: { jsonrpc: "2.0", id: 3, method: "resources/list" } } as any,
      unknownMethodRes,
      deps,
    );
    expect(unknownMethodRes.statusCode).toBe(404);
    expect(unknownMethodRes.body.error.code).toBe(-32601);
  });

  it("filters tools/list by viewer vs editor/admin roles and excludes ask_user", async () => {
    const viewerRes = mockRes();
    await handleRemoteMcp(
      { body: { jsonrpc: "2.0", id: "v1", method: "tools/list" } } as any,
      viewerRes,
      { source: "public", principal: "emea", role: "viewer" },
    );
    const viewerToolNames = viewerRes.body.result.tools.map((t: any) => t.name);
    expect(viewerToolNames).toContain("query_metric");
    expect(viewerToolNames).toContain("describe_model");
    expect(viewerToolNames).not.toContain("save_dashboard");
    expect(viewerToolNames).not.toContain("arrange_dashboard");
    expect(viewerToolNames).not.toContain("ask_user");

    const editorRes = mockRes();
    await handleRemoteMcp(
      { body: { jsonrpc: "2.0", id: "e1", method: "tools/list" } } as any,
      editorRes,
      { source: "public", principal: "emea", role: "editor" },
    );
    const editorToolNames = editorRes.body.result.tools.map((t: any) => t.name);
    expect(editorToolNames).toContain("query_metric");
    expect(editorToolNames).toContain("save_dashboard");
    expect(editorToolNames).toContain("arrange_dashboard");
    expect(editorToolNames).not.toContain("ask_user");
    expect(remoteToolsForRole("admin").map((t) => t.name)).toEqual(editorToolNames);
  });

  it("executes governed tools/call in the caller context and enforces role and schema checks", async () => {
    const forwarded = {
      cookie: "__Host-sc_session=verified-token",
      csrf: "csrf-123",
      host: `127.0.0.1:${apiPort}`,
      origin: `http://127.0.0.1:${apiPort}`,
      expires: Date.now() + 60_000,
    };
    const viewerDeps = { source: "public", principal: "emea", role: "viewer" as const, forwarded };
    const editorDeps = { source: "public", principal: "emea", role: "editor" as const, forwarded };

    // Viewer can run read-only governed query_metric under bound source & principal
    const queryRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "query_metric", arguments: { metrics: ["revenue"] } },
        },
      } as any,
      queryRes,
      viewerDeps,
    );
    expect(queryRes.statusCode).toBe(200);
    expect(queryRes.body.result.isError).toBe(false);
    expect(JSON.parse(queryRes.body.result.content[0].text)).toMatchObject({
      rows: [[4200]],
      principal: "emea",
      source: { id: "public" },
    });
    expect(lastHeaders.cookie).toBe("__Host-sc_session=verified-token");
    expect(lastHeaders["x-sc-source"]).toBe("public");
    expect(lastHeaders["x-sc-principal"]).toBe("emea");

    // Viewer cannot call save_dashboard
    const forbiddenRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "save_dashboard",
            arguments: { id: "d1", name: "Dash", spec: { title: "Dash", tiles: [] } },
          },
        },
      } as any,
      forbiddenRes,
      viewerDeps,
    );
    expect(forbiddenRes.statusCode).toBe(403);
    expect(forbiddenRes.body.result.isError).toBe(true);

    // Editor can call save_dashboard
    const saveRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: {
            name: "save_dashboard",
            arguments: { id: "d1", name: "Dash", spec: { title: "Dash", tiles: [] } },
          },
        },
      } as any,
      saveRes,
      editorDeps,
    );
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.result.isError).toBe(false);
    expect(savedDashboards).toHaveLength(1);

    // Scope mismatch on principal is rejected by runToolInContext
    const mismatchRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "query_metric", arguments: { metrics: ["revenue"], principal: "admin" } },
        },
      } as any,
      mismatchRes,
      viewerDeps,
    );
    expect(mismatchRes.statusCode).toBe(400);
    expect(mismatchRes.body.result.isError).toBe(true);
    expect(mismatchRes.body.error.message).toMatch(/restricted to principal/);

    // Invalid tool arguments rejected by Zod schema
    const badArgsRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: { name: "query_metric", arguments: { metrics: [] } },
        },
      } as any,
      badArgsRes,
      viewerDeps,
    );
    expect(badArgsRes.statusCode).toBe(400);
    expect(badArgsRes.body.result.isError).toBe(true);

    // Unknown or excluded tool rejected with 404
    const unknownToolRes = mockRes();
    await handleRemoteMcp(
      {
        body: {
          jsonrpc: "2.0",
          id: 15,
          method: "tools/call",
          params: { name: "ask_user", arguments: { question: "Hello?" } },
        },
      } as any,
      unknownToolRes,
      editorDeps,
    );
    expect(unknownToolRes.statusCode).toBe(404);
    expect(unknownToolRes.body.result.isError).toBe(true);
  });
});

describe("Outbound alert webhooks (src/activity/webhook.ts & src/activity/server.ts)", () => {
  let webhookServer: Server;
  let webhookUrl = "";
  let receivedPayloads: any[] = [];
  let nextStatus = 200;
  let dataDir = "";

  const samplePayload = {
    dashboardId: "exec-overview",
    dashboardTitle: "Executive Overview",
    tileId: "rev-tile",
    tileTitle: "Monthly Revenue",
    metric: "revenue",
    summary: "Revenue dropped below 500 in 2026-08-01",
    checkedAt: "2026-09-09T12:00:00.000Z",
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sc-webhook-test-"));
    await openStore(join(dataDir, "library.duckdb"));
    const app = express();
    app.use(express.json());
    app.post("/hook", (req, res) => {
      receivedPayloads.push(req.body);
      res.status(nextStatus).json({ ok: nextStatus < 400 });
    });
    webhookServer = createHttpServer(app);
    await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    const port = (webhookServer.address() as any).port;
    webhookUrl = `http://127.0.0.1:${port}/hook`;
  });

  afterAll(async () => {
    await closeStore();
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("delivers Slack and JSON payload to valid endpoints and rejects SSRF / invalid URLs", async () => {
    expect(await sendAlertWebhook(undefined, samplePayload)).toEqual({ sent: false });
    expect(await sendAlertWebhook("   ", samplePayload)).toEqual({ sent: false });
    expect(await sendAlertWebhook("not-a-valid-url", samplePayload)).toMatchObject({ sent: false, error: expect.stringMatching(/Invalid/) });
    expect(await sendAlertWebhook("https://user:pass@example.com/hook", samplePayload)).toMatchObject({ sent: false, error: expect.stringMatching(/credentials/) });
    expect(await sendAlertWebhook("http://169.254.169.254/latest/meta-data/", samplePayload)).toMatchObject({ sent: false, error: expect.stringMatching(/not allowed|HTTPS/) });
    expect(await sendAlertWebhook("https://169.254.169.254/latest/meta-data/", samplePayload)).toMatchObject({ sent: false, error: expect.stringMatching(/not allowed/) });
    expect(await sendAlertWebhook("http://10.0.0.42:8080/internal", samplePayload)).toMatchObject({ sent: false, error: expect.stringMatching(/HTTPS/) });

    receivedPayloads = [];
    const okResult = await sendAlertWebhook(webhookUrl, samplePayload);
    expect(okResult).toEqual({ sent: true, status: 200 });
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toEqual({
      event: "alert.triggered",
      dashboardId: "exec-overview",
      dashboardTitle: "Executive Overview",
      tileId: "rev-tile",
      tileTitle: "Monthly Revenue",
      metric: "revenue",
      summary: "Revenue dropped below 500 in 2026-08-01",
      checkedAt: "2026-09-09T12:00:00.000Z",
      text: "*[Semantic Canvas Alert]* Monthly Revenue (revenue): Revenue dropped below 500 in 2026-08-01",
    });

    nextStatus = 502;
    const failResult = await sendAlertWebhook(webhookUrl, samplePayload);
    expect(failResult).toEqual({ sent: false, status: 502, error: "Webhook returned HTTP 502" });
    nextStatus = 200;
  });

  it("fires webhook once when a watched chart transitions to triggered in mountChartActivity", async () => {
    receivedPayloads = [];
    const results: AlertWebhookResult[] = [];
    let resolveHook: (() => void) | null = null;
    const waitForHook = () => new Promise<void>((r) => { resolveHook = r; });

    const app = express();
    app.use(express.json());
    const auth = new CompanyAuth({ mode: "local", scopes: "openid", sessionSeconds: 3600 });
    const fakeSource: any = {
      id: "demo",
      label: "Demo",
      status: "ready",
      model,
      conn: {
        ...conn,
        execute: async () => ({ columns: ["revenue"], rows: [[120]], sql: "", ms: 1 }),
      },
    };
    const rls = { principals: { emea: { id: "emea", name: "EMEA", claims: { region: ["EMEA"] } } }, policies: [] };
    const safe = (fn: (req: any, res: any) => any) => async (req: any, res: any) => {
      try { await fn(req, res); }
      catch (e: any) { res.status(e.status ?? 400).json({ error: e.message }); }
    };
    mountChartActivity(app, {
      safe,
      auth,
      source: () => fakeSource,
      sources: () => [fakeSource],
      principal: () => rls.principals.emea,
      rls: () => rls,
      webhookUrl,
      onWebhookResult: (res) => {
        results.push(res);
        resolveHook?.();
      },
    });

    const chart = tile({ id: "rev-tile", title: "Revenue Watch", metrics: ["revenue"], dimensions: [] });
    await saveDashboard(
      { id: "watch-dash", name: "Watch Dashboard", spec: { title: "Watch Dashboard", tiles: [chart] } },
      { source: "demo", model: model.name },
    );

    const server = createHttpServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const putRes = await fetch(`${baseUrl}/api/chart-activity/watch-dash/rev-tile/alert`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rule: { metric: "revenue", mode: "threshold", operator: "below", threshold: 500 },
          revision: 1,
          version: 0,
        }),
      });
      expect(putRes.status).toBe(200);

      const hookPromise = waitForHook();
      const check1 = await fetch(`${baseUrl}/api/chart-activity/watch-dash/rev-tile/alerts/check`, { method: "POST" });
      expect(check1.status).toBe(200);
      await hookPromise;

      expect(results).toEqual([{ sent: true, status: 200 }]);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        event: "alert.triggered",
        dashboardId: "watch-dash",
        dashboardTitle: "Watch Dashboard",
        tileId: "rev-tile",
        tileTitle: "Revenue Watch",
        metric: "revenue",
      });

      // Second check on the same breachKey does not re-fire the webhook
      const check2 = await fetch(`${baseUrl}/api/chart-activity/watch-dash/rev-tile/alerts/check`, { method: "POST" });
      expect(check2.status).toBe(200);
      expect(receivedPayloads).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
