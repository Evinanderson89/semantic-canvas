import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { computeGovernanceMetrics } from "../src/operations/usageMetrics.ts";
import {
  RELEASE_MANIFEST,
  getReleaseManifest,
  verifySuiteCompatibility,
} from "../src/operations/releaseManifest.ts";
import { loopbackRequest } from "../src/security/loopback.ts";

describe("computeGovernanceMetrics", () => {
  it("computes enterprise ROI, governance, and security rollups from audit events and counters", () => {
    const result = computeGovernanceMetrics({
      auditEvents: [
        { id: "1", ts: "2026-11-16T00:00:00Z", event: "audit.dashboard_saved", actor: "alice", details: { id: "d1", locked: true } },
        { id: "2", ts: "2026-11-16T00:01:00Z", event: "audit.dashboard_saved", actor: "bob", details: { id: "d2", locked: false } },
        { id: "3", ts: "2026-11-16T00:02:00Z", event: "audit.dashboard_deleted", actor: "alice", details: { id: "d2" } },
        { id: "4", ts: "2026-11-16T00:03:00Z", event: "audit.metric_proposed", actor: "bob", details: { metric: "m1" } },
        { id: "5", ts: "2026-11-16T00:04:00Z", event: "audit.metric_published", actor: "alice", details: { metric: "m1" } },
        { id: "6", ts: "2026-11-16T00:05:00Z", event: "scim.user_created", actor: null, details: { id: "u1" } },
        { id: "7", ts: "2026-11-16T00:06:00Z", event: "scim.user_deactivated", actor: null, details: { id: "u1" } },
        { id: "8", ts: "2026-11-16T00:07:00Z", event: "auth.signed_in", actor: "carol", details: {} },
        { id: "9", ts: "2026-11-16T00:08:00Z", event: "auth.session_revoked", actor: "u1", details: {} },
        { id: "10", ts: "2026-11-16T00:09:00Z", event: "auth.session_access_changed", actor: "bob", details: {} },
        { id: "11", ts: "2026-11-16T00:10:00Z", event: "audit.rate_limited", actor: "carol", details: { operation: "query" } },
      ],
      counters: { requests: 200, errors: 4, queries: 80, queryErrors: 4 },
      sources: [
        { id: "warehouse", status: "ready", tables: 6, metrics: 14 },
        { id: "cube-mart", status: "ready", tables: 3, metrics: 8 },
        { id: "broken-sf", status: "error", tables: 10, metrics: 50 },
      ],
      uptimeSeconds: 3600,
    });

    expect(result.uniqueActors).toBe(4); // alice, bob, carol, u1
    expect(result.dashboardsSaved).toBe(2);
    expect(result.lockedDashboardsSaved).toBe(1);
    expect(result.dashboardsDeleted).toBe(1);
    expect(result.metricsProposed).toBe(1);
    expect(result.metricsPublished).toBe(1);
    expect(result.scimOperations).toBe(2);
    expect(result.securityEvents).toMatchObject({
      signedIn: 1,
      sessionRevoked: 1,
      sessionAccessChanged: 1,
      rateLimited: 1,
      total: 4,
      "auth.signed_in": 1,
      "auth.session_revoked": 1,
      "auth.session_access_changed": 1,
      "audit.rate_limited": 1,
    });
    expect(result.queryReliability).toBeCloseTo(0.95, 5);
    expect(result.readySources).toBe(2);
    expect(result.totalGovernedMetrics).toBe(22);
    expect(result.uptimeSeconds).toBe(3600);
  });

  it("handles zero queries and telemetry failure field aliases cleanly", () => {
    const result = computeGovernanceMetrics({
      auditEvents: [],
      counters: { requests: 5, failures: 0, queries: 0, queryFailures: 0 },
      sources: [{ id: "empty", status: "ready" }],
      uptimeSeconds: 12,
    });

    expect(result.uniqueActors).toBe(0);
    expect(result.queryReliability).toBe(1);
    expect(result.readySources).toBe(1);
    expect(result.totalGovernedMetrics).toBe(0);
  });
});

describe("releaseManifest and verifySuiteCompatibility", () => {
  it("returns version-pinned suite release manifest and merges runtime options", () => {
    expect(RELEASE_MANIFEST.product).toBe("semantic-canvas");
    expect(RELEASE_MANIFEST.supportedAdapters).toEqual(["duckglue", "dbt", "snowflake-semantic", "cube"]);
    expect(RELEASE_MANIFEST.supportedConnectors).toEqual(["duckdb", "duckdb-db", "snowflake"]);

    const manifest = getReleaseManifest({ mode: "gateway", aiProvider: "openai" });
    expect(manifest).toEqual({
      product: "semantic-canvas",
      version: "0.1.0",
      libraryFormatVersion: 2,
      connectedOverlayVersion: 1,
      gatewayPolicyVersion: 1,
      mcpProtocolVersion: "2025-03-26",
      scimSchemaVersion: "2.0",
      supportedAdapters: ["duckglue", "dbt", "snowflake-semantic", "cube"],
      supportedConnectors: ["duckdb", "duckdb-db", "snowflake"],
      supportedAiProviders: ["anthropic", "openai", "gemini", "openai-compatible"],
      compatibility: {
        gatewayMinVersion: "0.1.0",
        ingestMinVersion: "0.1.0",
      },
      mode: "gateway",
      aiProvider: "openai",
    });
  });

  it("verifies compatible and incompatible Gateway/Ingest peers", () => {
    expect(
      verifySuiteCompatibility({
        gatewayVersion: "0.1.0",
        ingestVersion: "0.2.3",
        policyVersion: 1,
        libraryFormatVersion: 2,
      })
    ).toEqual({ compatible: true, issues: [] });

    expect(verifySuiteCompatibility({})).toEqual({ compatible: true, issues: [] });

    const outdated = verifySuiteCompatibility({
      gatewayVersion: "0.0.9",
      ingestVersion: "0.0.1",
      policyVersion: 2,
      libraryFormatVersion: 3,
    });
    expect(outdated.compatible).toBe(false);
    expect(outdated.issues).toHaveLength(4);
    expect(outdated.issues[0]).toContain("gatewayVersion 0.0.9 is below minimum required 0.1.0");
    expect(outdated.issues[1]).toContain("ingestVersion 0.0.1 is below minimum required 0.1.0");
    expect(outdated.issues[2]).toContain("Unsupported policyVersion 2");
    expect(outdated.issues[3]).toContain("Unsupported libraryFormatVersion 3");

    const malformed = verifySuiteCompatibility({
      gatewayVersion: "not-a-semver",
      ingestVersion: "1.x",
      libraryFormatVersion: 0,
    });
    expect(malformed.compatible).toBe(false);
    expect(malformed.issues).toHaveLength(3);
  });
});

describe("operations metrics, manifest, and compatibility endpoints", () => {
  let root = "";
  let url = "";
  let appProcess: ChildProcess;

  async function freePort(): Promise<number> {
    const s = createHttpServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as any).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sc-ops-manifest-"));
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    await writeFile(
      join(root, "sources.yaml"),
      YAML.stringify({
        sources: [
          {
            id: "public",
            label: "Public",
            adapter: "duckglue",
            model: resolve("sample-data/warehouse.yaml"),
            connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 },
          },
        ],
      })
    );
    let output = "";
    appProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: {
        ...process.env,
        SC_MODE: "local",
        SC_HOST: "127.0.0.1",
        SC_DATA_DIR: join(root, "data"),
        SC_ENV_PATH: join(root, ".env"),
        SOURCES_PATH: join(root, "sources.yaml"),
        RLS_PATH: resolve("security/policies.yaml"),
        PORT: String(port),
        SC_SERVE_UI: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout?.on("data", (d) => (output += d));
    appProcess.stderr?.on("data", (d) => (output += d));
    for (let i = 0; i < 200; i++) {
      if (appProcess.exitCode !== null) throw new Error(output);
      try {
        if ((await loopbackRequest(`${url}/readyz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Server did not start: " + output);
  }, 45_000);

  afterAll(async () => {
    if (appProcess && appProcess.exitCode === null) {
      appProcess.kill("SIGTERM");
      await new Promise((r) => appProcess.once("exit", r));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("serves GET /api/operations/manifest, GET /api/operations/metrics, and POST /api/operations/compatibility", async () => {
    const manifestRes = await loopbackRequest(`${url}/api/operations/manifest`);
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.product).toBe("semantic-canvas");
    expect(manifest.mode).toBe("local");
    expect(manifest.supportedAdapters).toContain("cube");

    const okCompat = await loopbackRequest(`${url}/api/operations/compatibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayVersion: "0.1.0", ingestVersion: "0.1.2", policyVersion: 1, libraryFormatVersion: 2 }),
    });
    expect(okCompat.status).toBe(200);
    expect(await okCompat.json()).toEqual({ compatible: true, issues: [] });

    const badCompat = await loopbackRequest(`${url}/api/operations/compatibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gatewayVersion: "0.0.1", policyVersion: 99 }),
    });
    expect(badCompat.status).toBe(422);
    const badBody = await badCompat.json();
    expect(badBody.compatible).toBe(false);
    expect(badBody.issues.length).toBe(2);

    const metricsRes = await loopbackRequest(`${url}/api/operations/metrics`);
    expect(metricsRes.status).toBe(200);
    const metrics = await metricsRes.json();
    expect(metrics.readySources).toBe(1);
    expect(metrics.totalGovernedMetrics).toBeGreaterThan(0);
    expect(metrics.queryReliability).toBe(1);
    expect(typeof metrics.uptimeSeconds).toBe("number");
  });
});
