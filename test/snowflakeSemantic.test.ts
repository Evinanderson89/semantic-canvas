import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snowflakeSemanticAdapter } from "../src/semantic/snowflakeSemantic.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import type { Connector, QueryResult } from "../src/connectors/types.ts";

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
      - name: computed_flag
        expr: "CASE WHEN status = 'paid' THEN 1 ELSE 0 END"
        data_type: NUMBER
        description: A computed dimension that should be skipped
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
  it("returns null for a file it can't read or parse", async () => {
    expect(await snowflakeSemanticAdapter.load("/does/not/exist.yaml")).toBeNull();
  });

  it("keys tables by the physical (base_table) name, not the semantic name", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    expect(model?.tables["FCT_ORDERS"]).toBeDefined();
    expect(model?.tables["DIM_USERS"]).toBeDefined();
    expect(model?.tables["orders"]).toBeUndefined();
  });

  it("skips a dimension whose expr is not a bare column reference", async () => {
    const model = await snowflakeSemanticAdapter.load(file);
    const cols = model!.tables["FCT_ORDERS"].columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["order_id", "status", "ordered_at", "amount"]));
    expect(cols).not.toContain("computed_flag");
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
