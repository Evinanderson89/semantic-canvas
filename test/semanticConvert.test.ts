import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import {
  convertSemanticLayer,
  exportSemanticModel,
  parseSemanticLayerText,
  SEMANTIC_FORMATS,
  translateSnippetToFormat,
  type SemanticLayerFormat,
} from "../src/semantic/convert.ts";
import { coachSemanticModel } from "../src/semantic/coach.ts";
import type { Model } from "../src/semantic/model.ts";
import { loopbackRequest } from "../src/security/loopback.ts";

describe("Universal Multi-Dialect Semantic Layer Converter (Unit)", () => {
  let warehouseModel: Model;

  beforeAll(async () => {
    const loaded = await duckglueAdapter.load(resolve("sample-data/warehouse.yaml"));
    if (!loaded) throw new Error("Failed to load sample-data/warehouse.yaml");
    warehouseModel = loaded;
  });

  it("exports SEMANTIC_FORMATS metadata for all 5 dialects", () => {
    expect(SEMANTIC_FORMATS.map((f) => f.id)).toEqual([
      "duckglue",
      "snowflake",
      "metricflow",
      "glue",
      "cube",
    ]);
    expect(SEMANTIC_FORMATS.map((f) => f.filename)).toEqual([
      "model.yaml",
      "snowflake_semantic_model.yaml",
      "metricflow_semantic_models.yml",
      "aws_glue_semantic_catalog.yaml",
      "cubes.yml",
    ]);
  });

  it("exports sample_warehouse to all 5 formats and round-trips each back into a normalized Model", () => {
    const formats: SemanticLayerFormat[] = [
      "duckglue",
      "snowflake",
      "metricflow",
      "glue",
      "cube",
    ];
    const tableCount = Object.keys(warehouseModel.tables).length;
    const metricCount = Object.keys(warehouseModel.metrics).length;
    const joinCount = warehouseModel.joins.length;

    for (const fmt of formats) {
      const exported = exportSemanticModel(warehouseModel, fmt);
      expect(exported.format).toBe(fmt);
      expect(exported.content.length).toBeGreaterThan(200);
      expect(exported.summary.tables).toBe(tableCount);
      expect(exported.summary.metrics).toBe(metricCount);
      expect(exported.summary.joins).toBe(joinCount);

      const doc = YAML.parse(exported.content);
      if (fmt === "duckglue") {
        expect(doc.model.name).toBe("sample_warehouse");
        expect(doc.tables.fct_subscriptions).toBeDefined();
        expect(doc.metrics.mrr).toBeDefined();
      } else if (fmt === "snowflake") {
        expect(doc.name).toBe("sample_warehouse");
        expect(Array.isArray(doc.tables)).toBe(true);
        expect(Array.isArray(doc.relationships)).toBe(true);
      } else if (fmt === "metricflow") {
        expect(Array.isArray(doc.semantic_models)).toBe(true);
        expect(Array.isArray(doc.metrics)).toBe(true);
        expect(doc.semantic_models.some((sm: any) => sm.model === "ref('fct_subscriptions')")).toBe(true);
      } else if (fmt === "glue") {
        expect(doc.CatalogId).toBe("aws-glue-semantic-catalog");
        expect(doc.DatabaseInput.Name).toBe("sample_warehouse");
        expect(Array.isArray(doc.TableInputs)).toBe(true);
        expect(doc.SemanticLayerExtension.metrics.length).toBe(metricCount);
      } else if (fmt === "cube") {
        expect(Array.isArray(doc.cubes)).toBe(true);
        expect(doc.cubes.some((c: any) => c.name === "fct_subscriptions")).toBe(true);
      }

      // Auto-detect and parse back into Model
      const parsed = parseSemanticLayerText(exported.content, "auto");
      expect(parsed.detectedFormat).toBe(fmt);
      expect(parsed.model.name).toBe("sample_warehouse");
      expect(Object.keys(parsed.model.tables).length).toBe(tableCount);
      expect(Object.keys(parsed.model.metrics).length).toBe(metricCount);
      expect(parsed.model.joins.length).toBe(joinCount);
      expect(parsed.model.metrics.mrr).toBeDefined();
      expect(parsed.model.metrics.mrr.baseTable).toBe("fct_subscriptions");
      expect(parsed.model.metrics.mrr_per_subscriber.type).toBe("ratio");
      expect(parsed.model.metrics.cumulative_net_new_mrr.type).toBe("cumulative");
    }
  });

  it("converts cross-dialect chains (DuckGlue -> Snowflake -> MetricFlow -> AWS Glue -> Cube -> DuckGlue)", () => {
    const sf = convertSemanticLayer({
      model: warehouseModel,
      targetFormat: "snowflake",
    });
    expect(sf.sourceFormat).toBe("duckglue");
    expect(sf.targetFormat).toBe("snowflake");

    const mf = convertSemanticLayer({
      content: sf.content,
      sourceFormat: "auto",
      targetFormat: "metricflow",
    });
    expect(mf.sourceFormat).toBe("snowflake");
    expect(mf.targetFormat).toBe("metricflow");

    const glue = convertSemanticLayer({
      content: mf.content,
      sourceFormat: "auto",
      targetFormat: "glue",
    });
    expect(glue.sourceFormat).toBe("metricflow");
    expect(glue.targetFormat).toBe("glue");

    const cube = convertSemanticLayer({
      content: glue.content,
      sourceFormat: "auto",
      targetFormat: "cube",
    });
    expect(cube.sourceFormat).toBe("glue");
    expect(cube.targetFormat).toBe("cube");

    const backToDuckglue = convertSemanticLayer({
      content: cube.content,
      sourceFormat: "auto",
      targetFormat: "duckglue",
    });
    expect(backToDuckglue.sourceFormat).toBe("cube");
    expect(backToDuckglue.targetFormat).toBe("duckglue");
    expect(backToDuckglue.summary.tables).toBe(Object.keys(warehouseModel.tables).length);
    expect(backToDuckglue.summary.metrics).toBe(Object.keys(warehouseModel.metrics).length);
    expect(backToDuckglue.summary.joins).toBe(warehouseModel.joins.length);
  });

  it("populates snippetsByFormat across all 5 dialects in coachSemanticModel findings and questionAnalysis", () => {
    const draftModel: Model = {
      source: "duckglue",
      name: "draft_commerce",
      tables: {
        fct_orders: {
          name: "fct_orders",
          grain: "",
          synonyms: [],
          partitionKeys: [],
          primaryKey: "order_id",
          columns: [
            { name: "order_id", type: "string" },
            { name: "customer_id", type: "string" },
            { name: "order_date", type: "date" },
            { name: "revenue_usd", type: "double" },
          ],
        },
        dim_customers: {
          name: "dim_customers",
          grain: "one row per customer_id",
          synonyms: ["customers"],
          partitionKeys: [],
          primaryKey: "customer_id",
          columns: [
            { name: "customer_id", type: "string" },
            { name: "segment", type: "string" },
          ],
        },
      },
      metrics: {
        total_revenue: {
          name: "total_revenue",
          label: "Total Revenue",
          baseTable: "fct_orders",
          expression: "SUM(fct_orders.revenue_usd)",
          unit: "currency",
          filter: null,
          synonyms: [],
        },
        order_count: {
          name: "order_count",
          label: "Orders",
          baseTable: "fct_orders",
          expression: "COUNT(fct_orders.order_id)",
          filter: null,
          synonyms: [],
        },
      },
      joins: [],
    };

    const report = coachSemanticModel(draftModel, {
      question: "Revenue per order by customer segment over time",
    });

    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(finding.snippetsByFormat).toBeDefined();
      expect(finding.snippetsByFormat?.duckglue).toBe(finding.yamlSnippet);
      expect(finding.snippetsByFormat?.snowflake.length).toBeGreaterThan(10);
      expect(finding.snippetsByFormat?.metricflow.length).toBeGreaterThan(10);
      expect(finding.snippetsByFormat?.glue.length).toBeGreaterThan(10);
      expect(finding.snippetsByFormat?.cube.length).toBeGreaterThan(10);
    }

    expect(report.questionAnalysis?.snippetsByFormat).toBeDefined();
    expect(report.questionAnalysis?.snippetsByFormat?.snowflake).toContain("relationships:");
    expect(report.questionAnalysis?.snippetsByFormat?.metricflow).toContain("metrics:");
    expect(report.questionAnalysis?.snippetsByFormat?.glue).toContain("SemanticLayerExtension:");
    expect(report.questionAnalysis?.snippetsByFormat?.cube).toContain("cubes:");

    // Direct translateSnippetToFormat check
    const ratioSnippet = [
      "metrics:",
      "  aov:",
      "    label: Average Order Value",
      "    base_table: fct_orders",
      "    type: ratio",
      "    numerator: total_revenue",
      "    denominator: order_count",
    ].join("\n");
    expect(translateSnippetToFormat(ratioSnippet, "snowflake")).toContain("NULLIF");
    expect(translateSnippetToFormat(ratioSnippet, "metricflow")).toContain("type_params:");
    expect(translateSnippetToFormat(ratioSnippet, "glue")).toContain("SemanticLayerExtension:");
    expect(translateSnippetToFormat(ratioSnippet, "cube")).toContain("cubes:");
  });
});

describe("GET /api/model/export, POST /api/model/convert, and MCP convert_semantic_model Integration", () => {
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
    root = await mkdtemp(join(tmpdir(), "sc-semantic-convert-"));
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

  it("serves GET /api/model/export across all 5 formats and rejects unknown formats", async () => {
    for (const fmt of ["duckglue", "snowflake", "metricflow", "glue", "cube"] as const) {
      const res = await loopbackRequest(`${url}/api/model/export?format=${fmt}`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.format).toBe(fmt);
      expect(typeof body.filename).toBe("string");
      expect(typeof body.content).toBe("string");
      expect(body.summary.tables).toBeGreaterThan(0);
      expect(body.summary.metrics).toBeGreaterThan(0);
    }

    const badRes = await loopbackRequest(`${url}/api/model/export?format=lookml`);
    expect(badRes.status).toBe(400);
  });

  it("serves POST /api/model/convert for both active model and external YAML content", async () => {
    // 1. Export active model to Snowflake Cortex Analyst via POST /api/model/convert
    const activeRes = await loopbackRequest(`${url}/api/model/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetFormat: "snowflake" }),
    });
    expect(activeRes.status).toBe(200);
    const activeBody: any = await activeRes.json();
    expect(activeBody.sourceFormat).toBe("duckglue");
    expect(activeBody.targetFormat).toBe("snowflake");
    expect(activeBody.filename).toBe("snowflake_semantic_model.yaml");

    // 2. Convert that Snowflake YAML into Cube YAML via POST /api/model/convert
    const externalRes = await loopbackRequest(`${url}/api/model/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: activeBody.content,
        sourceFormat: "auto",
        targetFormat: "cube",
      }),
    });
    expect(externalRes.status).toBe(200);
    const externalBody: any = await externalRes.json();
    expect(externalBody.sourceFormat).toBe("snowflake");
    expect(externalBody.targetFormat).toBe("cube");
    expect(externalBody.filename).toBe("cubes.yml");
    expect(externalBody.content).toContain("cubes:");
  });

  it("exposes convert_semantic_model via POST /api/mcp (tools/list and tools/call)", async () => {
    const listRes = await loopbackRequest(`${url}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listRes.status).toBe(200);
    const listBody: any = await listRes.json();
    const convertTool = listBody.result.tools.find(
      (t: any) => t.name === "convert_semantic_model",
    );
    expect(convertTool).toBeDefined();
    expect(convertTool.inputSchema.properties).toHaveProperty("targetFormat");
    expect(convertTool.inputSchema.properties).toHaveProperty("content");
    expect(convertTool.inputSchema.properties).toHaveProperty("sourceFormat");

    const callRes = await loopbackRequest(`${url}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "convert_semantic_model",
          arguments: {
            targetFormat: "metricflow",
          },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody: any = await callRes.json();
    expect(callBody.result.isError).toBe(false);
    const converted = JSON.parse(callBody.result.content[0].text);
    expect(converted.targetFormat).toBe("metricflow");
    expect(converted.filename).toBe("metricflow_semantic_models.yml");
    expect(converted.content).toContain("semantic_models:");
  });
});
