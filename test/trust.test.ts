import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { requireScope, scopedField } from "../src/security/queryScope.ts";
import { conn, model, tile } from "./fixtures.ts";

let db: DuckDBConnection;
const live = { ...conn, relation: (t: string) => t };
beforeAll(async () => {
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run(`CREATE TABLE fct_sales (sold_on DATE, amount DOUBLE, user_id VARCHAR, plan_id VARCHAR);
    INSERT INTO fct_sales VALUES ('2024-01-01',100,'a','one'), ('2024-03-01',300,'a','one'),
      ('2024-04-01',400,'a','one'), ('2024-04-01',900,'b','two'), ('2024-02-29',29,'c','one'), ('2023-02-28',28,'c','one');
    CREATE TABLE dim_users (user_id VARCHAR, country VARCHAR, plan_id VARCHAR);
    INSERT INTO dim_users VALUES ('a','GB','one'),('b','US','two'),('c',NULL,'one');`);
});
afterAll(() => db.closeSync());
async function run(t: any, m = model) {
  const r = await db.runAndReadAll(compileTile(m, live, t));
  return r.getRows().map((row) => Object.fromEntries(r.columnNames().map((name, i) => [name, row[i] == null ? null : typeof row[i] === "object" ? String(row[i]) : row[i]])));
}
it("preserves first-of-month snapshots and does not invent a previous month across a gap", async () => {
  const rows = await run(tile({ dimensions: ["month:sold_on", "dim_users.country"], compare: "prior" }));
  const gb = rows.filter((r) => r.country === "GB");
  expect(gb).toHaveLength(3);
  expect(gb.find((r) => String(r.sold_on_month).startsWith("2024-03"))?.revenue__prev).toBeNull();
  const april = gb.find((r) => String(r.sold_on_month).startsWith("2024-04"))!;
  expect(april.revenue__prev).toBe(300);
  expect(april.revenue__delta).toBe(100);
  expect(rows.find((r) => r.country === "US")?.revenue__prev).toBeNull();
});
it("compares a leap day to the prior calendar year's February 28 with null-safe cohorts", async () => {
  const rows = await run(tile({ dimensions: ["day:sold_on", "dim_users.country"], compare: "yoy" }));
  expect(rows.find((r) => String(r.sold_on_day).startsWith("2024-02-29"))?.revenue__prev).toBe(28);
});
it("executes every key of a composite join so duplicate IDs in different tenants cannot fan out", async () => {
  await db.run("INSERT INTO dim_users VALUES ('a','DE','two')");
  const composite = { ...model, joins: [{ ...model.joins[0], type: "inner" as const,
    columns: [{ left: "user_id", right: "user_id" }, { left: "plan_id", right: "plan_id" }] }] };
  const rows = await run(tile({ dimensions: ["dim_users.country"] }), composite);
  expect(rows.find((r) => r.country === "GB")?.revenue).toBe(800);
  expect(rows.some((r) => r.country === "DE")).toBe(false);
});
const cfg = { policies: [{ id: "region", table: "dim_users", column: "country", claim: "regions" }], principals: {} };
const principal = { id: "gb", name: "GB", regions: ["GB"] };
it("uses the same row scope for discovery counts, samples and ranges", async () => {
  const relation = scopedField(model, live, "fct_sales", "dim_users.country", cfg, principal);
  const result = await db.runAndReadAll(`SELECT value, count(*) FROM ${relation} GROUP BY value`);
  expect(result.getRows()).toEqual([["GB", 3n]]);
  const amounts = scopedField(model, live, "fct_sales", "amount", cfg, principal);
  expect((await db.runAndReadAll(`SELECT min(value),max(value) FROM ${amounts}`)).getRows()).toEqual([[100,400]]);
});
it("denies a policy that cannot be enforced instead of exposing an aggregate", () => {
  expect(() => requireScope({ ...model, joins: [] }, "fct_sales", cfg, principal)).toThrow(/Access denied/);
  expect(() => requireScope(model, "dim_plans", cfg, principal)).toThrow(/Access denied/);
});
describe("semantic validation", () => {
  it.each(["missing", "dim_plans.missing"])("rejects filter %s before execution", (field) => {
    const t = tile({ where: [{ id: "f", source: "dimension", mode: "discrete", field, values: ["x"] }] });
    expect(validateTile(model, t).length).toBeGreaterThan(0);
    expect(() => compileTile(model, live, t)).toThrow(/filter field/);
  });
  it("rejects an aggregate filter from another table", () => {
    expect(validateTile(model, tile({ where: [{ id: "f", source: "metric", field: "users", mode: "range", min: 1 }] }))[0].problem).toMatch(/selected metric/);
  });
  it("rejects ambiguous relationships", () => {
    expect(validateTile({ ...model, joins: [...model.joins, model.joins[0]] }, tile({ dimensions: ["dim_users.country"] }))).not.toEqual([]);
  });
});
it("merges a null cohort across differently filtered metrics without duplicating it", async () => {
  const rows = await run(tile({ metrics: ["revenue", "live_revenue"], dimensions: ["dim_users.country"] }));
  const unknown = rows.filter((r) => r.country === null);
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toMatchObject({ revenue: 57, live_revenue: 57 });
});
