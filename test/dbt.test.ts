import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dbtAdapter } from "../src/semantic/dbt.ts";
import { compileTile } from "../src/compiler/compile.ts";
import { loadRls } from "../src/security/rls.ts";
import { conn, tile } from "./fixtures.ts";

let dir: string;
let seq = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "sc-dbt-")); });
afterAll(() => rm(dir, { recursive: true, force: true }));

async function fixture(type: string, extra: Record<string, unknown> = {}) {
  const path = join(dir, `${type}-${++seq}`);
  await mkdir(path);
  await writeFile(join(path, "semantic_manifest.json"), JSON.stringify({
    semantic_models: [{ name: "orders", node_relation: { alias: "orders", database: "WAREHOUSE", schema_name: "PUBLIC" },
      measures: [{ name: "total", agg: "sum", expr: "amount" }], dimensions: [] }],
    metrics: [{ name: "revenue", type, type_params: { measure: { name: "total" } }, ...extra }],
  }));
  return path;
}

it("imports the supported simple measure without losing physical relation metadata", async () => {
  const model = await dbtAdapter.load(await fixture("simple"));
  expect(model?.metrics.revenue.expression).toBe("SUM(orders.amount)");
  expect(model?.tables.orders.relation).toEqual({ database: "WAREHOUSE", schema: "PUBLIC", table: "orders" });
});

it("imports dbt ratio, derived, and cumulative metrics and compiles valid SQL through compileTile", async () => {
  const path = join(dir, `full-${++seq}`);
  await mkdir(path);
  await writeFile(join(path, "manifest.json"), JSON.stringify({
    metadata: { project_name: "commerce_dbt" },
    nodes: {
      "model.commerce.orders": {
        resource_type: "model",
        name: "orders",
        description: "One row per order",
        tags: ["sales"],
        columns: {
          order_id: { name: "order_id", data_type: " string ", description: "Primary key" },
          customer_id: { name: "customer_id", data_type: "string" },
          amount: { name: "amount", data_type: "numeric" },
          cost_amount: { name: "cost_amount", data_type: "numeric" },
        },
      },
      "model.commerce.customers": {
        resource_type: "model",
        name: "customers",
        description: "One row per customer",
        columns: {
          customer_id: { name: "customer_id", data_type: "string" },
          region: { name: "region", data_type: "string" },
        },
      },
    },
  }));
  await writeFile(join(path, "semantic_manifest.json"), JSON.stringify({
    project_configuration: { project_name: "commerce_dbt" },
    semantic_models: [
      {
        name: "orders",
        description: "Order facts",
        node_relation: { alias: "orders", database: "WAREHOUSE", schema_name: "PUBLIC" },
        entities: [
          { name: "order", type: "primary", expr: "order_id" },
          { name: "customer", type: "foreign", expr: "customer_id" },
        ],
        dimensions: [
          { name: "ordered_at", type: "time", type_params: { time_granularity: "day" } },
          { name: "status", type: "categorical" },
        ],
        measures: [
          { name: "total_revenue", agg: "sum", expr: "amount" },
          { name: "total_cost", agg: "sum", expr: "cost_amount" },
          { name: "order_count", agg: "count", expr: "1" },
          { name: "distinct_buyers", agg: "count_distinct", expr: "customer_id" },
        ],
      },
      {
        name: "customers",
        description: "Customer dimension",
        node_relation: { alias: "customers", database: "WAREHOUSE", schema_name: "PUBLIC" },
        entities: [
          { name: "customer", type: "primary", expr: "customer_id" },
        ],
        dimensions: [
          { name: "region", type: "categorical" },
        ],
        measures: [],
      },
    ],
    metrics: [
      {
        name: "revenue",
        label: "Revenue",
        type: "simple",
        type_params: { measure: { name: "total_revenue" } },
      },
      {
        name: "cost",
        label: "Cost",
        type: "simple",
        type_params: { measure: "total_cost" },
      },
      {
        name: "aov",
        label: "Average Order Value",
        type: "ratio",
        type_params: {
          numerator: { name: "revenue" },
          denominator: { name: "order_count" },
        },
      },
      {
        name: "gross_margin",
        label: "Gross Margin",
        type: "derived",
        type_params: {
          expr: "revenue - cost",
          metrics: [{ name: "revenue" }, { name: "cost" }],
        },
      },
      {
        name: "running_revenue",
        label: "Running Revenue",
        type: "cumulative",
        type_params: {
          measure: { name: "total_revenue" },
          cumulative_type_params: {},
        },
      },
      {
        name: "trailing_3m_buyers",
        label: "Trailing 3M Buyers",
        type: "cumulative",
        type_params: {
          measure: { name: "distinct_buyers" },
          window: { count: 3, granularity: "month" },
        },
      },
    ],
  }));

  const model = await dbtAdapter.load(join(path, "semantic_manifest.json"));
  expect(model).not.toBeNull();
  expect(model!.name).toBe("commerce_dbt");
  expect(model!.joins).toEqual([
    { left: "orders", leftOn: "customer_id", right: "customers", rightOn: "customer_id", type: "left" },
  ]);
  expect(model!.metrics.aov).toMatchObject({
    type: "ratio",
    baseTable: "orders",
    numerator: "revenue",
    denominator: "order_count",
  });
  expect(model!.metrics.order_count.expression).toBe("COUNT(1)");
  expect(model!.metrics.gross_margin).toMatchObject({
    type: "derived",
    baseTable: "orders",
    expression: "revenue - cost",
  });
  expect(model!.metrics.running_revenue).toMatchObject({
    type: "cumulative",
    baseTable: "orders",
    metric: "total_revenue",
  });
  expect(model!.metrics.trailing_3m_buyers).toMatchObject({
    type: "cumulative",
    baseTable: "orders",
    metric: "distinct_buyers",
    window: 3,
  });

  const ratioDerivedSql = compileTile(model!, conn, tile({
    metrics: ["aov", "gross_margin"],
    dimensions: ["customers.region"],
  }) as any);
  expect(ratioDerivedSql).toContain('CAST("__m_revenue" AS DOUBLE) / NULLIF("__m_order_count", 0) AS "aov"');
  expect(ratioDerivedSql).toContain('"__m_revenue" - "__m_cost" AS "gross_margin"');

  const cumulativeSql = compileTile(model!, conn, tile({
    metrics: ["running_revenue", "trailing_3m_buyers"],
    dimensions: ["month:ordered_at"],
  }) as any);
  expect(cumulativeSql).toContain('SUM("__m_total_revenue") OVER (ORDER BY "ordered_at_month" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "running_revenue"');
  expect(cumulativeSql).toContain("RANGE BETWEEN INTERVAL '2 month' PRECEDING AND CURRENT ROW) AS \"trailing_3m_buyers\"");
});

it("rejects conversion metrics and incomplete or invalid ratio, derived, and cumulative definitions", async () => {
  await expect(dbtAdapter.load(await fixture("conversion"))).rejects.toThrow('unsupported type "conversion"');
  await expect(dbtAdapter.load(await fixture("ratio"))).rejects.toThrow("dbt import: ratio metric revenue requires numerator and denominator");
  await expect(dbtAdapter.load(await fixture("derived"))).rejects.toThrow("dbt import: derived metric revenue requires type_params.expr");
  await expect(dbtAdapter.load(await fixture("cumulative"))).rejects.toThrow("dbt import: cumulative metric revenue requires measure/metric and window or cumulative_type_params");
  await expect(dbtAdapter.load(await fixture("cumulative", {
    type_params: { measure: { name: "total" }, window: 0 },
  }))).rejects.toThrow("window is a whole number of periods");
  await expect(dbtAdapter.load(await fixture("derived", {
    type_params: { expr: "42" },
  }))).rejects.toThrow("names other metrics");
});

it("does not disable RLS when its configured file is missing or invalid", async () => {
  await expect(loadRls(join(dir, "missing.yaml"))).rejects.toThrow();
  const path = join(dir, "invalid.yaml"); await writeFile(path, "policies: definitely-not-a-list");
  await expect(loadRls(path)).rejects.toThrow();
});
