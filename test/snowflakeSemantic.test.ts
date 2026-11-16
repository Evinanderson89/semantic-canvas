import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { DuckDBInstance } from "@duckdb/node-api";
import { snowflakeSemanticAdapter } from "../src/semantic/snowflakeSemantic.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import type { Connector, QueryResult } from "../src/connectors/types.ts";
import { fieldKind } from "../src/app/filters.ts";
import { tileChartShape } from "../src/suggest/chartRules.ts";

/**
 * Fixture built from Snowflake's published YAML field names (name, base_table,
 * dimensions, time_dimensions, facts, table-level metrics, relationships) --
 * see docs.snowflake.com/en/user-guide/views-semantic/semantic-view-yaml-spec.
 * `computed_flag` is deliberately a CASE expression, not a bare column, to
 * exercise the "skip what can't be faithfully represented" path.
 */
const YAML_FIXTURE = `
name: revenue_model
description: Analyst-facing revenue semantic model
tables:
  - name: orders
    description: One row per order
    base_table:
      database: ANALYTICS
      schema: MARTS
      table: FCT_ORDERS
    primary_key:
      columns:
        - order_id
    dimensions:
      - name: order_id
        expr: order_id
        data_type: NUMBER
        description: Order identifier
      - name: status
        expr: status
        data_type: VARCHAR
        description: Order status
        synonyms: [state]
    time_dimensions:
      - name: ordered_at
        expr: ordered_at
        data_type: TIMESTAMP_NTZ
    facts:
      - name: order_amount
        expr: amount
        data_type: NUMBER
        description: Order amount
    metrics:
      - name: revenue
        expr: SUM(order_amount)
        description: Total revenue
      - name: order_count
        expr: COUNT(*)
        description: Number of orders
  - name: users
    base_table:
      database: ANALYTICS
      schema: MARTS
      table: DIM_USERS
    primary_key:
      columns:
        - user_id
    dimensions:
      - name: user_id
        expr: user_id
        data_type: NUMBER
      - name: country
        expr: country
        data_type: VARCHAR
relationships:
  - name: orders_to_users
    left_table: orders
    right_table: users
    relationship_columns:
      - left_column: user_id
        right_column: user_id
`;

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-snowflake-semantic-"));
  file = join(dir, "semantic_model.yaml");
  writeFileSync(file, YAML_FIXTURE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stubConn: Connector = {
  id: "test", label: "test",
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  dateTrunc: (g, e) => `date_trunc('${g}', ${e})`,
  dateAdd: (u, e, n) => `(${e} + INTERVAL '${n} ${u}')`,
  relation: (t) => `"ANALYTICS"."MARTS"."${t}"`,
  async execute(): Promise<QueryResult> { return { columns: [], rows: [], sql: "", ms: 0 }; },
  async close() {},
};

describe("snowflake semantic model adapter", () => {
  it("carries NUMBER fields through numeric filter controls and chart-shape checks", async () => {
    const model = (await snowflakeSemanticAdapter.load(file))!;
    expect(model.tables.FCT_ORDERS.columns.find(c => c.name === "amount")?.type).toBe("number");
    expect(fieldKind(model, "FCT_ORDERS.amount")).toBe("number");
    expect(fieldKind(model, "FCT_ORDERS.status")).toBe("select");
    expect(tileChartShape(model, { id: "revenue", metrics: ["revenue"], dimensions: ["FCT_ORDERS.amount"],
      layout: { x: 0, y: 0, w: 400, h: 300 } }).dimensions).toEqual([{ temporal: false, numeric: true }]);
  });
  it("retains every fact alias when dimensions and facts share a physical column", async () => {
    const fixture = YAML.parse(YAML_FIXTURE);
    fixture.tables[0].dimensions.push({ name: "amount_dimension", expr: "amount", data_type: "NUMBER" });
    fixture.tables[0].facts.push({ name: "another_amount", expr: "amount", data_type: "NUMBER" });
    fixture.tables[0].facts.push({ name: "amount", expr: "amount", data_type: "NUMBER" });
    fixture.tables[0].metrics.push({ name: "revenue_again", expr: "SUM(another_amount)" });
    fixture.tables[0].metrics.push({ name: "revenue_literal", expr: "SUM(CASE WHEN 'order_amount' = 'order_amount' THEN amount ELSE 0 END) /* order_amount */" });
    const shared = join(dir, "shared.yaml");
    writeFileSync(shared, YAML.stringify(fixture));
    const model = (await snowflakeSemanticAdapter.load(shared))!;
    expect(model.tables.FCT_ORDERS.columns.filter(c => c.name === "amount")).toHaveLength(1);
    expect(model.metrics.revenue.expression).toBe("SUM(FCT_ORDERS.amount)");
    expect(model.metrics.revenue_again.expression).toBe("SUM(FCT_ORDERS.amount)");
    expect(model.metrics.revenue_literal.expression).toBe("SUM(CASE WHEN 'order_amount' = 'order_amount' THEN FCT_ORDERS.amount ELSE 0 END) /* order_amount */");
    const db = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      await db.run("CREATE TABLE FCT_ORDERS(amount DOUBLE); INSERT INTO FCT_ORDERS VALUES (10),(20),(NULL)");
      const tile = { id: "shared", metrics: ["revenue", "revenue_again", "revenue_literal"], dimensions: [], layout: { x: 0, y: 0, w: 400, h: 300 } };
      expect(validateTile(model, tile)).toEqual([]);
      const result = await db.runAndReadAll(compileTile(model, { ...stubConn, relation: t => stubConn.quote(t) }, tile));
      expect(result.getRows()).toEqual([[30, 30, 30]]);
    } finally { db.closeSync(); }
  });

  for (const tableIndex of [0, 1]) it(`rejects duplicate metric identities ${tableIndex === 0 ? "within a table" : "across tables"}`, async () => {
    const fixture = YAML.parse(YAML_FIXTURE);
    (fixture.tables[tableIndex].metrics ??= []).push({ name: "revenue", expr: "COUNT(*)" });
    const duplicate = join(dir, `duplicate-${tableIndex}.yaml`);
    writeFileSync(duplicate, YAML.stringify(fixture));
    await expect(snowflakeSemanticAdapter.load(duplicate)).rejects.toThrow(/duplicate metric name revenue.*unique across all tables/);
  });

  it("returns null for a file it can't read or parse", async () => {
    expect(await snowflakeSemanticAdapter.load("/does/not/exist.yaml")).toBeNull();
  });

  it("keys tables by the physical (base_table) name, not the semantic name", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.tables["FCT_ORDERS"]).toBeDefined();
    expect(model?.tables["DIM_USERS"]).toBeDefined();
    expect(model?.tables["orders"]).toBeUndefined();
    expect(model?.tables.FCT_ORDERS.relation).toEqual({ database: "ANALYTICS", schema: "MARTS", table: "FCT_ORDERS" });
  });

  it("rejects computed fields explicitly rather than silently omitting them", async () => {
    const computedFile = join(dir, "computed.yaml");
    writeFileSync(computedFile, YAML_FIXTURE.replace("expr: status", "expr: UPPER(status)"));
    await expect(snowflakeSemanticAdapter.load(computedFile)).rejects.toThrow(/computed field orders.status/);
  });

  it("derives grain from the primary key", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.tables["FCT_ORDERS"].grain).toBe("one row per order_id");
  });

  it("resolves a metric expr's fact reference to physical_table.column", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.metrics.revenue.expression).toBe("SUM(FCT_ORDERS.amount)");
    expect(model?.metrics.revenue.baseTable).toBe("FCT_ORDERS");
  });

  it("leaves a metric expr with nothing to resolve untouched", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.metrics.order_count.expression).toBe("COUNT(*)");
  });

  it("resolves a relationship's semantic table names to physical ones", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.joins).toEqual([
      { left: "FCT_ORDERS", leftOn: "user_id", right: "DIM_USERS", rightOn: "user_id", type: "left" },
    ]);
  });

  it("produces a metric expression the real compiler accepts and runs", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    const tile = { id: "t1", metrics: ["revenue"], dimensions: [] as string[],
                   layout: { x: 0, y: 0, w: 100, h: 100 } };
    expect(validateTile(model!, tile as any)).toEqual([]);
    const sql = compileTile(model!, stubConn, tile as any);
    expect(sql).toContain("SUM(FCT_ORDERS.amount)");
  });
});

it("preserves every column and the join type of a composite relationship", async () => {
  const compositeFile = join(dir, "composite.yaml");
  writeFileSync(compositeFile, YAML_FIXTURE.replace("right_table: users", "right_table: users\n    join_type: inner").replace("        right_column: user_id", "        right_column: user_id\n      - left_column: tenant_id\n        right_column: tenant_id"));
  const model = (await snowflakeSemanticAdapter.load(compositeFile))!;
  expect(model.joins).toHaveLength(1);
  const sql = compileTile(model, stubConn, { id: "joined", metrics: ["revenue"], dimensions: ["DIM_USERS.country"], layout: { x: 0, y: 0, w: 100, h: 100 } });
  expect(sql).toContain("INNER JOIN");
  expect(sql).toContain('FCT_ORDERS."tenant_id" = DIM_USERS."tenant_id"');
});
