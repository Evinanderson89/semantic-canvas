import { expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { joinedTableOptions, type Model } from "../src/semantic/model.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { conn, model as fixture, tile } from "./fixtures.ts";

function snowflake() {
  const model = structuredClone(fixture);
  model.metrics = { revenue: model.metrics.revenue };
  model.tables.dim_users.columns = [{ name: "user_id", type: "string" }, { name: "region_id", type: "string" }];
  model.tables.dim_plans.columns = [{ name: "plan_id", type: "string" }, { name: "region_id", type: "string" }];
  model.tables.dim_regions = { name: "dim_regions", synonyms: [], partitionKeys: [], columns: [{ name: "region_id", type: "string" }, { name: "region", type: "string" }] };
  model.tables.fct_refunds = { name: "fct_refunds", synonyms: [], partitionKeys: [], columns: [{ name: "sale_id", type: "string" }, { name: "reason", type: "string" }] };
  model.joins.push({ left: "dim_users", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" },
    { left: "fct_sales", leftOn: "sale_id", right: "fct_refunds", rightOn: "sale_id", type: "left", cardinality: "one_to_many" });
  return model;
}
const optionsByTable = (model: Model, base = "fct_sales") => Object.fromEntries(joinedTableOptions(model, base).map(o => [o.table.name, o.path]));

it("discovers multi-hop dimensions in breadth-first order, including the exact declared path", () => {
  const options = joinedTableOptions(snowflake(), "fct_sales");
  expect(options.map(o => o.table.name)).toEqual(["dim_users", "dim_plans", "fct_refunds", "dim_regions"]);
  expect(options.at(-1)?.path).toMatchObject({ joins: [{ right: "dim_users" }, { right: "dim_regions" }] });
});

it("retains fan-out and ambiguity as unavailable evidence instead of guessing a join", () => {
  const model = snowflake();
  model.joins.push({ left: "dim_plans", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" });
  expect(optionsByTable(model).fct_refunds).toMatchObject({ error: expect.stringContaining("double count") });
  expect(optionsByTable(model).dim_regions).toMatchObject({ error: expect.stringContaining("two ways") });
  const suggestion = suggestDashboard(model, { table: "fct_sales", metrics: ["revenue"] });
  expect(suggestion.tiles.filter(t => t.chart === "barH")).toEqual([]);
});

it("does not reverse join direction or repeat nodes in a cycle", () => {
  const model = snowflake();
  expect(joinedTableOptions(model, "dim_regions")).toEqual([]);
  model.joins.push({ left: "dim_regions", leftOn: "region_id", right: "dim_users", rightOn: "region_id", type: "left" });
  const options = joinedTableOptions(model, "dim_users");
  expect(options.map(o => o.table.name)).toEqual(["dim_regions"]);
  expect(joinedTableOptions(model, "missing")).toEqual([]);
});

it("suggests a valid multi-hop breakdown and executes its governed aggregation without multiplying revenue", async () => {
  const model = snowflake();
  const dashboard = suggestDashboard(model, { table: "fct_sales", metrics: ["revenue"] });
  const breakdown = dashboard.tiles.find(t => t.chart === "barH");
  expect(breakdown?.dimensions).toEqual(["dim_regions.region"]);
  for (const chart of dashboard.tiles.filter(t => t.metrics.length)) expect(validateTile(model, chart)).toEqual([]);
  const db = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await db.run(`CREATE TABLE fct_sales(sale_id VARCHAR,user_id VARCHAR,amount DOUBLE);
      INSERT INTO fct_sales VALUES ('s1','u1',100),('s2','u1',200),('s3','u2',50),('s4','unknown',25);
      CREATE TABLE dim_users(user_id VARCHAR,region_id VARCHAR);
      INSERT INTO dim_users VALUES ('u1','r1'),('u2','r2');
      CREATE TABLE dim_regions(region_id VARCHAR,region VARCHAR);
      INSERT INTO dim_regions VALUES ('r1','East'),('r2','West');`);
    const sql = compileTile(model, { ...conn, relation: name => conn.quote(name) }, breakdown!);
    const result = await db.runAndReadAll(sql);
    expect(result.getRows()).toEqual(expect.arrayContaining([["East", 300], ["West", 50], [null, 25]]));
    expect(result.getRows().reduce((sum, r) => sum + Number(r[1]), 0)).toBe(375);
    const filtered = compileTile(model, { ...conn, relation: name => conn.quote(name) }, tile({ dimensions: ["dim_regions.region"],
      where: [{ id: "region", source: "dimension", field: "dim_regions.region", mode: "discrete", values: ["East"] }] }));
    expect((await db.runAndReadAll(filtered)).getRows()).toEqual([["East", 300]]);
  } finally { db.closeSync(); }
});
