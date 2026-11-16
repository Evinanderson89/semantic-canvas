import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import type { FilterSpec, TileSpec } from "../src/compiler/spec.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, model as base, tile } from "./fixtures.ts";

const model: Model = { ...base, metrics: { ...base.metrics,
  cost: { ...base.metrics.revenue, name: "cost", expression: "SUM(fct_sales.amount) * 0.6" },
  margin: { ...base.metrics.revenue, name: "margin", type: "derived", expression: "revenue - cost" },
  net: { ...base.metrics.revenue, name: "net", type: "derived", expression: "revenue - live_revenue" },
  share: { ...base.metrics.revenue, name: "share", type: "ratio", numerator: "revenue", denominator: "live_revenue", expression: "" },
  self_ratio: { ...base.metrics.revenue, name: "self_ratio", type: "ratio", numerator: "revenue", denominator: "revenue", expression: "" },
  per_user: { ...base.metrics.revenue, name: "per_user", type: "ratio", numerator: "revenue", denominator: "users", expression: "" },
  running: { ...base.metrics.revenue, name: "running", type: "cumulative", metric: "revenue", expression: "" },
  trailing: { ...base.metrics.revenue, name: "trailing", type: "cumulative", metric: "revenue", window: 3, expression: "" },
} };
const connector = { ...conn, relation: (table: string) => conn.quote(table),
  dateTrunc: (grain: string, expr: string) => `CAST(date_trunc('${grain}', ${expr}) AS DATE)` };
let db: DuckDBConnection;
beforeAll(async () => {
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run(`CREATE TABLE fct_sales (user_id VARCHAR, amount DOUBLE, sold_on DATE);
    INSERT INTO fct_sales VALUES
      ('a',100,'2026-01-01'),('b',20,'2026-01-01'),
      ('a',-30,'2026-01-02'),('b',40,'2026-01-02'),
      ('a',50,'2026-01-03'),('b',0,'2026-01-03'),
      ('a',10,'2026-01-04'),('b',-10,'2026-01-04'),
      ('a',0,'2026-01-05');
    CREATE TABLE dim_users (user_id VARCHAR, country VARCHAR);
    INSERT INTO dim_users VALUES ('a','GB'),('b','US'),('c','CA');`);
});
afterAll(() => db.closeSync());

const range = (field: string, min: number, extra: Partial<FilterSpec> = {}): FilterSpec =>
  ({ id: `filter:${field}`, source: "metric", field, mode: "range", min, ...extra });
const discrete = (field: string, values: FilterSpec["values"], exclude = false): FilterSpec =>
  ({ id: `filter:${field}`, source: "metric", field, mode: "discrete", values, exclude });
const run = async (over: Partial<TileSpec>, columns: string[]) => {
  const spec = tile(over);
  expect(validateTile(model, spec)).toEqual([]);
  const result = await db.runAndReadAll(compileTile(model, connector, spec));
  const indices = columns.map(c => {
    const i = result.columnNames().indexOf(c);
    expect(i, `missing column ${c}`).toBeGreaterThanOrEqual(0);
    return i;
  });
  return result.getRows().map(row => indices.map(i => {
    const v = row[i];
    return typeof v === "bigint" ? Number(v) : v !== null && typeof v === "object" ? String(v) : v;
  }));
};
const country = ["dim_users.country"];
const daily = ["day:fct_sales.sold_on"];

describe("metric filters on finished values", () => {
  it("filters a derived metric whose components have different always-on filters", async () => {
    expect(await run({ metrics: ["net"], where: [range("net", 1000)] }, ["net"])).toEqual([]);
    expect(await run({ metrics: ["net"], dimensions: country, where: [range("net", -20)] }, ["country", "net"])).toEqual([["US", -10]]);
    expect(await run({ metrics: ["net"], where: [range("net", -40, { max: -40 })] }, ["net"])).toEqual([[-40]]);
  });

  it("filters a derived value from one aggregate group, including discrete exclusions", async () => {
    expect(await run({ metrics: ["margin"], dimensions: country, where: [range("margin", 30)] }, ["country", "margin"])).toEqual([["GB", 52]]);
    expect(await run({ metrics: ["margin"], dimensions: country, where: [discrete("margin", [52], true)] }, ["country", "margin"])).toEqual([["US", 20]]);
  });

  it("filters recombined simple metrics together without leaving unmatched groups behind", async () => {
    expect(await run({ metrics: ["revenue", "live_revenue"], dimensions: country,
      where: [range("revenue", 100), range("live_revenue", 150)] }, ["country", "revenue", "live_revenue"])).toEqual([["GB", 130, 160]]);
    expect(await run({ metrics: ["revenue", "live_revenue"], dimensions: country,
      where: [range("revenue", 100), range("live_revenue", 0, { max: 100 })] }, ["country"])).toEqual([]);
  });

  it("filters ratios after division, preserving null for zero denominators", async () => {
    const ratio = await run({ metrics: ["share"], dimensions: country, where: [range("share", 0.82)] }, ["country", "share"]);
    expect(ratio).toEqual([["US", 50 / 60]]);
    expect(await run({ metrics: ["self_ratio"], dimensions: daily, where: [discrete("self_ratio", [null])] }, ["sold_on_day", "self_ratio"]))
      .toEqual([["2026-01-04", null], ["2026-01-05", null]]);
    expect(await run({ metrics: ["self_ratio"], dimensions: daily, where: [range("self_ratio", 0)] }, ["self_ratio"])).toEqual([[1], [1], [1]]);
  });

  it("filters a cross-table ratio after both sides are aggregated", async () => {
    expect(await run({ metrics: ["per_user"], dimensions: country, where: [range("per_user", 100)] }, ["country", "per_user"])).toEqual([["GB", 130]]);
    expect(await run({ metrics: ["per_user"], dimensions: country, where: [discrete("per_user", [null])] }, ["country", "per_user"])).toEqual([["CA", null]]);
    const scoped: FilterSpec = { id: "gateway:country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"] };
    expect(await run({ metrics: ["per_user"], where: [scoped, range("per_user", 0)] }, ["per_user"])).toEqual([[50]]);
    expect(() => compileTile(model, connector, tile({ metrics: ["per_user"], where: [range("per_user", 0),
      { ...scoped, field: "fct_sales.user_id", values: ["a"] }] }))).toThrow(/cannot be applied to both/);
  });

  it("retains the running history and actual prior period before filtering visible values", async () => {
    expect(await run({ metrics: ["running", "trailing"], dimensions: daily, compare: "prior", where: [range("running", 150)] },
      ["sold_on_day", "running", "running__prev", "trailing", "trailing__prev"]))
      .toEqual([["2026-01-03", 180, 130, 180, 130], ["2026-01-04", 180, 180, 60, 180], ["2026-01-05", 180, 180, 50, 60]]);
    // A component filter selects displayed periods; it must not remove day 2
    // from day 3's running sum or replace the actual prior day with day 1.
    expect(await run({ metrics: ["running", "revenue"], dimensions: daily, compare: "prior", where: [range("revenue", 40)], limit: 1 },
      ["sold_on_day", "running", "running__prev", "revenue", "revenue__prev"]))
      .toEqual([["2026-01-03", 180, 130, 50, 10]]);
  });

  it("applies date and row restrictions before accumulating and partitions separate cohorts", async () => {
    const window: FilterSpec = { id: "window", source: "dimension", field: "fct_sales.sold_on", mode: "range", min: "2026-01-02", max: "2026-01-04" };
    const scope: FilterSpec = { id: "rls:country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["GB"] };
    expect(await run({ metrics: ["running"], dimensions: daily, where: [window, scope, range("running", 0)] }, ["sold_on_day", "running"]))
      .toEqual([["2026-01-03", 20], ["2026-01-04", 30]]);
    expect(await run({ metrics: ["running"], dimensions: [...daily, ...country], where: [range("running", 100)] }, ["sold_on_day", "country", "running"]))
      .toEqual([["2026-01-01", "GB", 100], ["2026-01-03", "GB", 120], ["2026-01-04", "GB", 130], ["2026-01-05", "GB", 130]]);
  });

  it("filters before the latest-window limit and keeps optional empty lists as a no-op", async () => {
    expect(await run({ metrics: ["revenue"], dimensions: daily, where: [range("revenue", 1, { max: 50, maxExclusive: true })], limit: 1 },
      ["sold_on_day", "revenue"])).toEqual([["2026-01-02", 10]]);
    expect(await run({ metrics: ["net"], where: [discrete("net", [])] }, ["net"])).toEqual([[-40]]);
  });
});
