import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cubeAdapter } from "../src/semantic/cube.ts";
import { sqliteConnector } from "../src/connectors/sqlite.ts";
import { connectConnector, connectOne } from "../src/sources/registry.ts";
import { compileTile } from "../src/compiler/compile.ts";
import { tile } from "./fixtures.ts";

let dir: string;
let seq = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sc-cube-sqlite-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cubeAdapter", () => {
  it("returns null when file or directory does not exist or has no cubes array", async () => {
    expect(await cubeAdapter.load(join(dir, "missing.yml"))).toBeNull();
    const nonCubePath = join(dir, "not-cube.yaml");
    await writeFile(nonCubePath, "tables:\n  orders: {}\n");
    expect(await cubeAdapter.load(nonCubePath)).toBeNull();
  });

  it("loads a Cube YAML file with dimensions, joins, simple measures, ratio, and derived measures", async () => {
    const file = join(dir, `commerce-${++seq}.yml`);
    await writeFile(
      file,
      `
name: commerce_cube
description: Cube commerce semantic model
cubes:
  - name: orders
    sql_table: WAREHOUSE.PUBLIC.orders
    description: One row per order
    joins:
      - name: customers
        relationship: many_to_one
        sql: "{CUBE}.customer_id = {customers}.customer_id"
    dimensions:
      - name: order_id
        type: string
        primary_key: true
      - name: customer_id
        type: string
      - name: ordered_at
        type: time
      - name: status
        type: string
      - name: discount_pct
        type: number
    measures:
      - name: revenue
        title: Total Revenue
        type: sum
        sql: amount
      - name: total_cost
        title: Total Cost
        type: sum
        sql: "{CUBE}.cost_amount"
      - name: order_count
        title: Order Count
        type: count
      - name: unique_buyers
        type: count_distinct
        sql: customer_id
      - name: avg_order_amount
        type: avg
        sql: amount
      - name: min_order_amount
        type: min
        sql: amount
      - name: max_order_amount
        type: max
        sql: amount
      - name: aov
        title: Average Order Value
        type: number
        numerator: revenue
        denominator: order_count
      - name: gross_margin
        title: Gross Margin
        type: number
        sql: "{revenue} - {total_cost}"
  - name: customers
    sql_table: PUBLIC.customers
    description: Customer dimension
    dimensions:
      - name: customer_id
        type: string
        primary_key: true
      - name: region
        type: string
      - name: tier
        type: string
`,
    );

    const model = await cubeAdapter.load(file);
    expect(model).not.toBeNull();
    expect(model!.source).toBe("cube");
    expect(model!.name).toBe("commerce_cube");
    expect(model!.tables.orders.relation).toEqual({
      database: "WAREHOUSE",
      schema: "PUBLIC",
      table: "orders",
    });
    expect(model!.tables.customers.relation).toEqual({
      schema: "PUBLIC",
      table: "customers",
    });
    expect(model!.tables.orders.primaryKey).toBe("order_id");
    expect(model!.tables.orders.defaultDateColumn).toBe("ordered_at");
    expect(model!.tables.orders.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "order_id", type: "string" }),
        expect.objectContaining({ name: "ordered_at", type: "date" }),
        expect.objectContaining({ name: "discount_pct", type: "double" }),
      ]),
    );

    expect(model!.joins).toEqual([
      {
        left: "orders",
        leftOn: "customer_id",
        right: "customers",
        rightOn: "customer_id",
        type: "left",
        cardinality: "many_to_one",
      },
    ]);

    expect(model!.metrics.revenue.expression).toBe("SUM(orders.amount)");
    expect(model!.metrics.total_cost.expression).toBe("SUM(orders.cost_amount)");
    expect(model!.metrics.order_count.expression).toBe("COUNT(*)");
    expect(model!.metrics.unique_buyers.expression).toBe("COUNT(DISTINCT orders.customer_id)");
    expect(model!.metrics.avg_order_amount.expression).toBe("AVG(orders.amount)");
    expect(model!.metrics.min_order_amount.expression).toBe("MIN(orders.amount)");
    expect(model!.metrics.max_order_amount.expression).toBe("MAX(orders.amount)");
    expect(model!.metrics.aov).toMatchObject({
      type: "ratio",
      baseTable: "orders",
      numerator: "revenue",
      denominator: "order_count",
    });
    expect(model!.metrics.gross_margin).toMatchObject({
      type: "derived",
      baseTable: "orders",
      expression: "revenue - total_cost",
    });
  });

  it("loads a directory of YAML/JSON Cube files and disambiguates duplicate measure names with ${cube.name}_${measure.name}", async () => {
    const subDir = join(dir, `multi-${++seq}`);
    await mkdir(subDir);
    await writeFile(
      join(subDir, "01-orders.json"),
      JSON.stringify({
        cubes: [
          {
            name: "orders",
            joins: [
              {
                name: "customers",
                relationship: "one_to_one",
                left_on: "customer_id",
                right_on: "id",
              },
            ],
            dimensions: [{ name: "id", type: "string", primary_key: true }],
            measures: [{ name: "count", type: "count" }],
          },
        ],
      }),
    );
    await writeFile(
      join(subDir, "02-customers.yml"),
      `
cubes:
  - name: customers
    dimensions:
      - name: id
        type: string
        primary_key: true
    measures:
      - name: count
        type: count
`,
    );

    const model = await cubeAdapter.load(subDir);
    expect(model).not.toBeNull();
    expect(model!.metrics.orders_count).toMatchObject({
      baseTable: "orders",
      expression: "COUNT(*)",
    });
    expect(model!.metrics.customers_count).toMatchObject({
      baseTable: "customers",
      expression: "COUNT(*)",
    });
    expect(model!.joins[0]).toMatchObject({
      left: "orders",
      leftOn: "customer_id",
      right: "customers",
      rightOn: "id",
      cardinality: "one_to_one",
    });
  });
});

describe("sqliteConnector & end-to-end governed query execution", () => {
  it("opens a real DuckDB database file, inspects catalog(), and executes compiled governed tiles", async () => {
    const dbPath = join(dir, `warehouse-${++seq}.duckdb`);
    const conn = await sqliteConnector(dbPath, { size: 2 });
    try {
      expect(conn.id).toBe("duckdb-db");
      expect(conn.label).toBe("DuckDB / SQLite Database");
      expect(conn.relation("orders")).toBe('"orders"');

      await conn.execute(`
        CREATE TABLE customers (
          customer_id VARCHAR,
          region VARCHAR
        );
        INSERT INTO customers VALUES
          ('c1', 'NA'),
          ('c2', 'EMEA'),
          ('c3', 'NA');

        CREATE TABLE orders (
          order_id VARCHAR,
          customer_id VARCHAR,
          amount DOUBLE,
          cost_amount DOUBLE,
          ordered_at DATE
        );
        INSERT INTO orders VALUES
          ('o1', 'c1', 120.0, 40.0, DATE '2026-01-01'),
          ('o2', 'c2', 80.0,  30.0, DATE '2026-01-15'),
          ('o3', 'c3', 200.0, 50.0, DATE '2026-01-31');
      `);

      const cat = await conn.catalog!();
      expect(cat).toEqual([
        {
          name: "customers",
          columns: [
            { name: "customer_id", type: "VARCHAR" },
            { name: "region", type: "VARCHAR" },
          ],
        },
        {
          name: "orders",
          columns: [
            { name: "order_id", type: "VARCHAR" },
            { name: "customer_id", type: "VARCHAR" },
            { name: "amount", type: "DOUBLE" },
            { name: "cost_amount", type: "DOUBLE" },
            { name: "ordered_at", type: "DATE" },
          ],
        },
      ]);

      const cubeFile = join(dir, `live-cube-${++seq}.yml`);
      await writeFile(
        cubeFile,
        `
cubes:
  - name: orders
    joins:
      - name: customers
        relationship: many_to_one
        sql: "{CUBE}.customer_id = {customers}.customer_id"
    dimensions:
      - name: order_id
        type: string
        primary_key: true
      - name: customer_id
        type: string
      - name: ordered_at
        type: time
    measures:
      - name: revenue
        type: sum
        sql: amount
      - name: cost
        type: sum
        sql: cost_amount
      - name: order_count
        type: count
      - name: aov
        type: number
        numerator: revenue
        denominator: order_count
      - name: gross_margin
        type: number
        sql: "revenue - cost"
  - name: customers
    dimensions:
      - name: customer_id
        type: string
        primary_key: true
      - name: region
        type: string
`,
      );

      const model = await cubeAdapter.load(cubeFile);
      expect(model).not.toBeNull();

      // Compile and execute a governed query joining orders -> customers and computing simple, ratio, and derived metrics
      const sql = compileTile(
        model!,
        conn,
        tile({
          metrics: ["revenue", "order_count", "aov", "gross_margin"],
          dimensions: ["customers.region"],
        }),
      );
      const res = await conn.execute(sql, 100, "test-scope");
      expect(res.columns).toEqual([
        "region",
        "revenue",
        "order_count",
        "aov",
        "gross_margin",
      ]);
      expect(res.rows).toEqual([
        ["EMEA", 80, 1, 80, 50],
        ["NA", 320, 2, 160, 230],
      ]);

      // Verify caching and stats
      const cachedRes = await conn.execute(sql, 100, "test-scope");
      expect(cachedRes.cached).toBe(true);
      expect((conn.stats() as any).hits).toBeGreaterThanOrEqual(1);
    } finally {
      await conn.close();
    }

    // Verify source registry integration for adapter: "cube" and connector: "sqlite" / "duckdb-db"
    const cubeRegistryFile = join(dir, `reg-cube-${++seq}.yml`);
    await writeFile(
      cubeRegistryFile,
      `
cubes:
  - name: orders
    dimensions:
      - name: order_id
        type: string
        primary_key: true
    measures:
      - name: revenue
        type: sum
        sql: amount
`,
    );
    const source = await connectOne({
      id: "sqlite-cube",
      label: "SQLite Cube Source",
      adapter: "cube",
      model: cubeRegistryFile,
      connector: { type: "sqlite", databasePath: dbPath, poolSize: 2 },
    });
    try {
      expect(source.status).toBe("ready");
      expect(source.conn?.id).toBe("duckdb-db");
      const r = await source.conn!.execute(
        compileTile(source.model!, source.conn!, tile({ metrics: ["revenue"] })),
      );
      expect(r.rows).toEqual([[400]]);
    } finally {
      await source.conn?.close();
    }

    const memConn = await connectConnector({ type: "duckdb-db" });
    await memConn.close();
  });
});
