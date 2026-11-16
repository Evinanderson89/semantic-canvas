import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  COACH_CATEGORIES,
  COACH_PRESET_QUESTIONS,
  coachSemanticModel,
  inferSmartSynonyms,
  type AnalysisGoal,
} from "../src/semantic/coach.ts";
import { proposalProblems } from "../src/modeler/proposals.ts";
import type { Model } from "../src/semantic/model.ts";
import { loopbackRequest } from "../src/security/loopback.ts";
import { SemanticCoachDialog, SemanticCoachPanel } from "../src/app/SemanticCoach.tsx";

describe("Semantic Layer Coach & Analysis Readiness Advisor (Unit)", () => {
  const needsCoachingModel: Model = {
    source: "duckglue",
    name: "ecommerce_draft",
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
          { name: "created_at", type: "timestamp" },
          { name: "gross_revenue_usd", type: "double" },
          { name: "discount_amount", type: "double" },
          { name: "status", type: "string" },
        ],
      },
      dim_customers: {
        name: "dim_customers",
        grain: "one row per customer_id",
        synonyms: ["customers", "buyers"],
        partitionKeys: [],
        primaryKey: "customer_id",
        columns: [
          { name: "customer_id", type: "string" },
          { name: "segment", type: "string" },
          { name: "region", type: "string" },
        ],
      },
      fct_sessions: {
        name: "fct_sessions",
        grain: "one row per session_id",
        synonyms: ["sessions"],
        partitionKeys: ["session_date"],
        primaryKey: "session_id",
        connected: {
          status: "unreviewed",
          loadedAt: "2026-11-16T00:00:00Z",
          provenance: {
            source: "s3://lake/sessions",
            loadedAt: "2026-11-16T00:00:00Z",
            loadedBy: "ingest",
            rows: 5000,
          },
        },
        columns: [
          { name: "session_id", type: "string" },
          { name: "customer_id", type: "string" },
          { name: "session_date", type: "date" },
        ],
      },
    },
    metrics: {
      total_revenue: {
        name: "total_revenue",
        label: "Total Revenue",
        baseTable: "fct_orders",
        expression: "SUM(fct_orders.gross_revenue_usd)",
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
      completed_orders: {
        name: "completed_orders",
        label: "Completed Orders",
        baseTable: "fct_orders",
        expression: "COUNT(fct_orders.order_id)",
        filter: "fct_orders.status = 'completed'",
        description: "Orders that completed checkout.",
        synonyms: ["paid orders"],
      },
      session_count: {
        name: "session_count",
        label: "Session Count",
        baseTable: "fct_sessions",
        expression: "COUNT(*)",
        description: "Total web sessions.",
        synonyms: [],
      },
    },
    joins: [],
  };

  it("evaluates all 5 categories, generates YAML snippets, and produces valid 1-click proposedMetric definitions", () => {
    const report = coachSemanticModel(needsCoachingModel);

    expect(report.modelName).toBe("ecommerce_draft");
    expect(report.overallScore).toBeGreaterThanOrEqual(15);
    expect(report.overallScore).toBeLessThan(100);
    expect(Object.keys(report.categoryScores)).toEqual([
      "time_series",
      "driver_attribution",
      "ratios_and_funnels",
      "cohorts_and_cumulative",
      "agent_readiness",
    ]);

    // 1. time_series: fct_orders is missing timeColumn (has created_at), fct_sessions has session_date but missing reportingLag
    const timeFindings = report.findings.filter((f) => f.category === "time_series");
    expect(timeFindings.some((f) => f.target === "fct_orders.created_at" && f.yamlSnippet.includes("timeColumn: created_at"))).toBe(true);
    expect(timeFindings.some((f) => f.target === "fct_sessions" && f.yamlSnippet.includes("reportingLag: 2"))).toBe(true);

    // 2. driver_attribution: isolated fct_orders and fct_sessions have customer_id matching dim_customers.customer_id
    const driverFindings = report.findings.filter((f) => f.category === "driver_attribution");
    const joinFinding = driverFindings.find((f) => f.id.includes("fct_orders:dim_customers"));
    expect(joinFinding).toBeDefined();
    expect(joinFinding?.yamlSnippet).toContain("left: fct_orders");
    expect(joinFinding?.yamlSnippet).toContain("leftOn: customer_id");
    expect(joinFinding?.yamlSnippet).toContain("right: dim_customers");
    expect(joinFinding?.yamlSnippet).toContain("rightOn: customer_id");
    expect(joinFinding?.yamlSnippet).toContain("type: left");

    // 3. ratios_and_funnels: unit economics ratio (SUM revenue / COUNT orders) AND conversion ratio (completed_orders / order_count)
    const ratioFindings = report.findings.filter((f) => f.category === "ratios_and_funnels");
    const unitEconFinding = ratioFindings.find((f) => f.id.includes("unit_economics"));
    expect(unitEconFinding).toBeDefined();
    expect(unitEconFinding?.yamlSnippet).toContain("type: ratio");
    expect(unitEconFinding?.yamlSnippet).toContain("numerator: total_revenue");
    expect(unitEconFinding?.yamlSnippet).toContain("denominator: order_count");
    expect(unitEconFinding?.yamlSnippet).toContain("format: currency");
    expect(unitEconFinding?.proposedMetric).toBeDefined();
    expect(unitEconFinding?.proposedMetric?.expression).toContain("NULLIF");
    expect(proposalProblems(needsCoachingModel, unitEconFinding!.proposedMetric!)).toEqual([]);

    const conversionFinding = ratioFindings.find((f) => f.id.includes("conversion"));
    expect(conversionFinding).toBeDefined();
    expect(conversionFinding?.yamlSnippet).toContain("format: percent");
    expect(conversionFinding?.proposedMetric).toBeDefined();
    expect(proposalProblems(needsCoachingModel, conversionFinding!.proposedMetric!)).toEqual([]);

    // 4. cohorts_and_cumulative: fct_sessions has timeColumn (session_date) and simple metric (session_count) but no cumulative metric
    const cohortFindings = report.findings.filter((f) => f.category === "cohorts_and_cumulative");
    expect(cohortFindings.length).toBeGreaterThanOrEqual(1);
    expect(cohortFindings[0].yamlSnippet).toContain("type: cumulative");
    expect(cohortFindings[0].yamlSnippet).toContain("metric: session_count");
    expect(cohortFindings[0].yamlSnippet).toContain("window: 6");

    // 5. agent_readiness: missing grain on fct_orders, unreviewed table fct_sessions, missing descriptions & smart synonyms
    const agentFindings = report.findings.filter((f) => f.category === "agent_readiness");
    expect(agentFindings.some((f) => f.id.includes("missing_grain:fct_orders"))).toBe(true);
    expect(agentFindings.some((f) => f.id.includes("unreviewed_table:fct_sessions"))).toBe(true);
    const revMeta = agentFindings.find((f) => f.target === "total_revenue");
    expect(revMeta).toBeDefined();
    expect(revMeta?.yamlSnippet).toContain("sales");
    expect(revMeta?.yamlSnippet).toContain("recurring revenue");
  });

  it("generates domain-aware smart synonyms across revenue, orders, customers, and churn", () => {
    expect(inferSmartSynonyms("mrr", "Monthly Recurring Revenue")).toEqual(
      expect.arrayContaining(["sales", "recurring revenue", "top line"]),
    );
    expect(inferSmartSynonyms("order_count", "Orders")).toEqual(
      expect.arrayContaining(["volume", "transactions"]),
    );
    expect(inferSmartSynonyms("active_customers", "Customers")).toEqual(
      expect.arrayContaining(["accounts", "buyers", "logos"]),
    );
    expect(inferSmartSynonyms("logo_churn", "Churned Subscriptions")).toEqual(
      expect.arrayContaining(["attrition", "cancellations"]),
    );
  });

  it("filters findings by goal while always computing overallScore and categoryScores", () => {
    const full = coachSemanticModel(needsCoachingModel, { goal: "all" });
    const goals: Exclude<AnalysisGoal, "all">[] = [
      "time_series",
      "driver_attribution",
      "ratios_and_funnels",
      "cohorts_and_cumulative",
      "agent_readiness",
    ];

    for (const goal of goals) {
      const scoped = coachSemanticModel(needsCoachingModel, { goal });
      expect(scoped.overallScore).toBe(full.overallScore);
      expect(scoped.categoryScores).toEqual(full.categoryScores);
      expect(scoped.findings.length).toBeGreaterThan(0);
      expect(scoped.findings.every((f) => f.category === goal)).toBe(true);
    }
  });

  it("coaches custom questions for missing ratios, unjoined tables, and unmodelled numeric columns", () => {
    // 1. Question needing a ratio metric AND a missing join between fct_orders and dim_customers
    const q1 = coachSemanticModel(needsCoachingModel, {
      question: "Revenue per order by customer segment over time",
    });
    expect(q1.questionAnalysis).toBeDefined();
    expect(q1.questionAnalysis?.canAnswerNow).toBe(false);
    expect(q1.questionAnalysis?.matchedMetrics).toEqual(
      expect.arrayContaining(["total_revenue", "order_count"]),
    );
    expect(q1.questionAnalysis?.matchedDimensions).toContain("dim_customers.segment");
    expect(q1.questionAnalysis?.matchedTables).toEqual(
      expect.arrayContaining(["fct_orders", "dim_customers"]),
    );
    expect(q1.questionAnalysis?.coachingSteps.some((s) => /ratio/i.test(s))).toBe(true);
    expect(q1.questionAnalysis?.coachingSteps.some((s) => /join/i.test(s))).toBe(true);
    expect(q1.questionAnalysis?.suggestedYaml).toContain("type: ratio");
    expect(q1.questionAnalysis?.suggestedYaml).toContain("joins:");

    // 2. Question referencing an unmodelled raw numeric column (discount_amount)
    const q2 = coachSemanticModel(needsCoachingModel, {
      question: "Total discount_amount by status",
    });
    expect(q2.questionAnalysis).toBeDefined();
    expect(q2.questionAnalysis?.canAnswerNow).toBe(false);
    expect(q2.questionAnalysis?.coachingSteps.some((s) => s.includes("SUM(fct_orders.discount_amount)"))).toBe(true);
    expect(q2.questionAnalysis?.suggestedYaml).toContain("SUM(fct_orders.discount_amount)");

    // 3. Question that CAN be answered right now (completed_orders by status on fct_orders)
    const q3 = coachSemanticModel(needsCoachingModel, {
      question: "Completed orders by status",
    });
    expect(q3.questionAnalysis?.canAnswerNow).toBe(true);
    expect(q3.questionAnalysis?.matchedMetrics).toContain("completed_orders");
    expect(q3.questionAnalysis?.matchedDimensions).toContain("fct_orders.status");
  });

  it("scores a fully governed model at 100/100 with zero findings", () => {
    const perfectModel: Model = {
      source: "duckglue",
      name: "governed_saas",
      tables: {
        fct_orders: {
          name: "fct_orders",
          grain: "one row per order_id",
          synonyms: ["orders"],
          partitionKeys: ["order_date"],
          defaultDateColumn: "order_date",
          primaryKey: "order_id",
          reportingLagDays: 2,
          columns: [
            { name: "order_id", type: "string" },
            { name: "customer_id", type: "string" },
            { name: "order_date", type: "date" },
            { name: "amount", type: "double" },
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
        revenue: {
          name: "revenue",
          label: "Revenue",
          description: "Total order revenue in USD.",
          baseTable: "fct_orders",
          expression: "SUM(fct_orders.amount)",
          unit: "currency",
          filter: null,
          synonyms: ["sales", "top line"],
        },
        orders: {
          name: "orders",
          label: "Orders",
          description: "Total order volume.",
          baseTable: "fct_orders",
          expression: "COUNT(fct_orders.order_id)",
          filter: null,
          synonyms: ["volume", "transactions"],
        },
        aov: {
          name: "aov",
          label: "Average Order Value",
          description: "Revenue divided by orders.",
          baseTable: "fct_orders",
          expression: "",
          type: "ratio",
          numerator: "revenue",
          denominator: "orders",
          unit: "currency",
          filter: null,
          synonyms: ["average order value"],
        },
        rolling_revenue: {
          name: "rolling_revenue",
          label: "Rolling 6M Revenue",
          description: "Cumulative 6-period revenue.",
          baseTable: "fct_orders",
          expression: "",
          type: "cumulative",
          metric: "revenue",
          window: 6,
          unit: "currency",
          filter: null,
          synonyms: ["cumulative revenue"],
        },
      },
      joins: [
        {
          left: "fct_orders",
          leftOn: "customer_id",
          right: "dim_customers",
          rightOn: "customer_id",
          type: "left",
        },
      ],
    };

    const report = coachSemanticModel(perfectModel);
    expect(report.overallScore).toBe(100);
    expect(report.findings).toHaveLength(0);
    expect(report.strengths.length).toBeGreaterThanOrEqual(4);
    expect(typeof SemanticCoachPanel).toBe("function");
    expect(typeof SemanticCoachDialog).toBe("function");
    expect(COACH_CATEGORIES).toHaveLength(5);
    expect(COACH_PRESET_QUESTIONS.length).toBeGreaterThan(0);
  });
});

describe("GET and POST /api/model/coach API Integration", () => {
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
    root = await mkdtemp(join(tmpdir(), "sc-semantic-coach-"));
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

  it("serves GET /api/model/coach with optional goal and question query parameters", async () => {
    const resAll = await loopbackRequest(`${url}/api/model/coach`);
    expect(resAll.status).toBe(200);
    const bodyAll: any = await resAll.json();
    expect(bodyAll.modelName).toBe("sample_warehouse");
    expect(typeof bodyAll.overallScore).toBe("number");
    expect(Array.isArray(bodyAll.findings)).toBe(true);
    expect(bodyAll.categoryScores).toHaveProperty("time_series");
    expect(bodyAll.categoryScores).toHaveProperty("driver_attribution");
    expect(bodyAll.categoryScores).toHaveProperty("ratios_and_funnels");
    expect(bodyAll.categoryScores).toHaveProperty("cohorts_and_cumulative");
    expect(bodyAll.categoryScores).toHaveProperty("agent_readiness");

    const resGoal = await loopbackRequest(
      `${url}/api/model/coach?goal=time_series&question=${encodeURIComponent("Active users by country over time")}`,
    );
    expect(resGoal.status).toBe(200);
    const bodyGoal: any = await resGoal.json();
    expect(bodyGoal.findings.every((f: any) => f.category === "time_series")).toBe(true);
    expect(bodyGoal.questionAnalysis).toBeDefined();
    expect(bodyGoal.questionAnalysis.question).toBe("Active users by country over time");
    expect(bodyGoal.questionAnalysis.matchedMetrics).toContain("active_users");
  });

  it("serves POST /api/model/coach with goal and question in JSON body", async () => {
    const resPost = await loopbackRequest(`${url}/api/model/coach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "ratios_and_funnels",
        question: "Events per active user by country",
      }),
    });
    expect(resPost.status).toBe(200);
    const bodyPost: any = await resPost.json();
    expect(bodyPost.modelName).toBe("sample_warehouse");
    expect(bodyPost.findings.every((f: any) => f.category === "ratios_and_funnels")).toBe(true);
    expect(bodyPost.questionAnalysis).toBeDefined();
    expect(bodyPost.questionAnalysis.canAnswerNow).toBe(false);
    expect(bodyPost.questionAnalysis.suggestedYaml).toContain("type: ratio");
  });
});
