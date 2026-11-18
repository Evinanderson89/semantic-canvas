import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_CANVAS, THEME_PRESETS } from "../src/canvas/presets.ts";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import { loopbackRequest } from "../src/security/loopback.ts";
import {
  buildLocalDigestPreview,
  buildStarterYaml,
  buildYamlImportPayload,
  normalizeDigestPayload,
  normalizeOperationsSnapshot,
  summarizeYamlDiff,
} from "../src/app/CommercialDrawers.tsx";
import {
  addTileReferenceLine,
  buildDriversPayload,
  buildLineagePayload,
  getTileReferenceLines,
  normalizeDriversPayload,
  normalizeLineagePayload,
  removeTileReferenceLine,
} from "../src/app/TileLineageAndDrivers.tsx";

describe("Commercial Drawers & Inspector Lineage/Drivers UI Helpers + API Integration", () => {
  let model: Model;
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
    const loaded = await duckglueAdapter.load(resolve("sample-data/warehouse.yaml"));
    if (!loaded) throw new Error("Failed to load sample-data/warehouse.yaml");
    model = loaded;

    root = await mkdtemp(join(tmpdir(), "sc-commercial-drawers-"));
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
      }),
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

  it("exposes curated THEME_PRESETS and manages tile reference lines cleanly", () => {
    expect(THEME_PRESETS.map((t) => t.id)).toEqual([
      "broadside",
      "newsroom-dark",
      "swiss-grid",
      "studio-warm",
    ]);

    const baseTile: TileSpec = {
      id: "t-mrr",
      title: "Ending MRR",
      metrics: ["ending_mrr"],
      dimensions: ["month:fct_saas_monthly.month"],
      layout: { x: 0, y: 0, w: 400, h: 280 },
    };

    expect(getTileReferenceLines(baseTile)).toEqual([]);

    const withFirst = addTileReferenceLine(baseTile, "Q4 Target", 250000);
    expect(getTileReferenceLines(withFirst)).toEqual([{ label: "Q4 Target", value: 250000 }]);
    expect(withFirst.format?.targetValue).toBe(250000);
    expect(withFirst.format?.targetLabel).toBe("Q4 Target");

    const withSecond = addTileReferenceLine(withFirst, "Stretch Goal", 300000);
    expect(getTileReferenceLines(withSecond)).toHaveLength(2);

    const afterRemoveFirst = removeTileReferenceLine(withSecond, 0);
    expect(getTileReferenceLines(afterRemoveFirst)).toEqual([
      { label: "Stretch Goal", value: 300000 },
    ]);
    expect(afterRemoveFirst.format?.targetValue).toBe(300000);
    expect(afterRemoveFirst.format?.targetLabel).toBe("Stretch Goal");
  });

  it("integrates TileLineageAndDrivers payloads with POST /api/query/lineage and POST /api/query/drivers", async () => {
    const lineageTile: TileSpec = {
      id: "t-lineage",
      metrics: ["mrr"],
      dimensions: ["dim_users.country"],
      where: [
        {
          id: "f-tier",
          field: "dim_plans.plan_tier",
          source: "dimension",
          mode: "discrete",
          values: ["pro"],
        },
      ],
      layout: { x: 0, y: 0, w: 500, h: 320 },
    };

    const lineageRes = await loopbackRequest(`${url}/api/query/lineage`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sc-principal": "admin" },
      body: JSON.stringify(buildLineagePayload(lineageTile)),
    });
    expect(lineageRes.status).toBe(200);
    const lineageBody = await lineageRes.json();
    const lineageView = normalizeLineagePayload(lineageBody);
    expect(lineageView.sql).toContain("fct_subscriptions");
    expect(lineageView.metrics[0]?.name).toBe("mrr");
    expect(lineageView.tables).toEqual(
      expect.arrayContaining(["fct_subscriptions", "dim_users", "dim_plans"]),
    );
    expect(lineageView.joins.length).toBeGreaterThanOrEqual(2);
    expect(lineageView.filters).toContain("dim_plans.plan_tier");

    const driversTile: TileSpec = {
      id: "t-drivers",
      metrics: ["net_new_mrr"],
      dimensions: ["month:fct_mrr_movements.movement_date"],
      layout: { x: 0, y: 0, w: 500, h: 320 },
    };

    const driversRes = await loopbackRequest(`${url}/api/query/drivers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sc-principal": "admin" },
      body: JSON.stringify(buildDriversPayload(driversTile)),
    });
    expect(driversRes.status).toBe(200);
    const driversBody = await driversRes.json();
    const driversView = normalizeDriversPayload(driversBody);
    expect(driversView.metric).toBe("net_new_mrr");
    expect(driversView.dimensions.length).toBeGreaterThan(0);
    expect(driversView.dimensions[0]?.topDrivers.length).toBeGreaterThan(0);
    expect(typeof driversView.dimensions[0]?.topDrivers[0]?.value).toBe("string");
    expect(typeof driversView.dimensions[0]?.topDrivers[0]?.contribution).toBe("number");
    expect(typeof driversView.dimensions[0]?.topDrivers[0]?.share).toBe("number");
  });

  it("integrates YamlCodeSyncDialog, ExecutiveDigestDialog, and OperationsAuditDialog with backend routes", async () => {
    const initialSpec: DashboardSpec = {
      title: "Commercial Executive Pulse",
      tiles: [
        {
          id: "t-ending-mrr",
          title: "Ending MRR",
          kind: "metric",
          metrics: ["ending_mrr"],
          dimensions: ["month:fct_saas_monthly.month"],
          compare: "prior",
          chart: "kpi",
          layout: { x: 24, y: 24, w: 320, h: 160 },
        },
      ],
    };

    // Unsaved draft digest preview
    const draftPreview = buildLocalDigestPreview(initialSpec, model);
    expect(draftPreview.briefFingerprint).toBeNull();
    expect(draftPreview.highlights).toHaveLength(1);
    expect(draftPreview.highlights[0]?.metric).toBe("ending_mrr");
    expect(draftPreview.markdown).toContain("Snapshot with integrity checksum");
    expect(draftPreview.markdown).toContain("verifies snapshot content integrity");

    // Save dashboard so we can test server digest & YAML sync
    const saveRes = await loopbackRequest(`${url}/api/dashboards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "commercial-pulse",
        name: initialSpec.title,
        spec: initialSpec,
        canvas: { ...DEFAULT_CANVAS, theme: "studio-warm" },
        schemaVersion: 1,
        revision: 0,
      }),
    });
    expect(saveRes.status).toBe(200);

    // Executive Digest · Snapshot with integrity checksum
    const digestRes = await loopbackRequest(`${url}/api/dashboards/commercial-pulse/digest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(digestRes.status).toBe(200);
    const digestView = normalizeDigestPayload(await digestRes.json(), initialSpec, model);
    expect(digestView.briefFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(digestView.highlights).toHaveLength(1);
    expect(digestView.markdown).toContain("Executive Digest");
    expect(digestView.markdown).toContain("Snapshot with integrity checksum");
    expect(digestView.markdown).toContain("verifies snapshot content integrity");
    expect(digestView.html).toContain("<article");
    expect(digestView.html).toContain("verifies snapshot content integrity");

    // YAML export & import-yaml diff validation
    const updatedSpec: DashboardSpec = {
      ...initialSpec,
      tiles: [
        ...initialSpec.tiles,
        {
          id: "t-nrr",
          title: "Net Revenue Retention",
          kind: "metric",
          metrics: ["nrr"],
          dimensions: ["month:fct_saas_monthly.month"],
          chart: "line",
          layout: { x: 368, y: 24, w: 480, h: 280 },
        },
      ],
    };
    const yamlString = buildStarterYaml("commercial-pulse", updatedSpec, DEFAULT_CANVAS);
    const importRes = await loopbackRequest(`${url}/api/dashboards/import-yaml`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildYamlImportPayload(yamlString, initialSpec, true)),
    });
    expect(importRes.status).toBe(200);
    const importBody = await importRes.json();
    const diffSummary = summarizeYamlDiff(importBody, initialSpec);
    expect(diffSummary).toEqual({
      addedTiles: 1,
      removedTiles: 0,
      modifiedTiles: 0,
      changedFilters: 0,
    });

    // Operations metrics, manifest & audit log
    const [metricsRes, manifestRes, auditRes] = await Promise.all([
      loopbackRequest(`${url}/api/operations/metrics`),
      loopbackRequest(`${url}/api/operations/manifest`),
      loopbackRequest(`${url}/api/operations/audit?limit=25`),
    ]);
    expect(metricsRes.status).toBe(200);
    expect(manifestRes.status).toBe(200);
    expect(auditRes.status).toBe(200);

    const opsView = normalizeOperationsSnapshot(
      await metricsRes.json(),
      await manifestRes.json(),
      await auditRes.json(),
    );
    expect(opsView.manifest.version).toBe("0.1.0");
    expect(opsView.manifest.capabilities).toEqual(
      expect.arrayContaining(["dbt", "cube", "snowflake", "openai", "gemini"]),
    );
    expect(opsView.telemetry.readySources).toBe(1);
    expect(opsView.auditEvents.length).toBeGreaterThan(0);
    expect(opsView.auditEvents[0]?.action).toBe("audit.dashboard_saved");
  });
});
