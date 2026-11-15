import { afterAll, beforeAll, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileTile, splitPartialPeriods, validateTile } from "../src/compiler/compile.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import type { Model, Table } from "../src/semantic/model.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { conn, model as base, tile } from "./fixtures.ts";

let db: DuckDBConnection, dir: string;
beforeAll(async () => {
  db = await (await DuckDBInstance.create(":memory:")).connect();
  dir = await mkdtemp(join(tmpdir(), "sc-period-"));
});
afterAll(async () => { db.closeSync(); await rm(dir, { recursive: true, force: true }); });
const modelFor = (period?: Table["period"]): Model => ({ ...base, tables: { ...base.tables,
  fct_sales: { ...base.tables.fct_sales, primaryKey: "sold_on", ...(period ? { period } : {}) },
} });
const run = async (model: Model, dates: string[], patch: Partial<TileSpec> = {}) => {
  const connector = { ...conn,
    dateTrunc: (grain: string, expr: string) => `CAST(date_trunc('${grain}', ${expr}) AS DATE)`,
    relation: () => `(SELECT CAST(label AS DATE) AS sold_on, 1.0::DOUBLE AS amount FROM (VALUES ${dates.map(d => `('${d}')`).join(",")}) AS v(label))`,
  };
  const sql = compileTile(model, connector, tile({ dimensions: ["month:fct_sales.sold_on"], ...patch }));
  const result = await db.runAndReadAll(sql);
  return splitPartialPeriods({ columns: result.columnNames(), rows: result.getRows().map(r => r.map(v =>
    typeof v === "bigint" ? Number(v) : v !== null && typeof v === "object" ? String(v).slice(0, 10) : v)) });
};

it("keeps daily-keyed edge checks when grouping to month, regardless of the primary key declaration", async () => {
  const daily = modelFor();
  const dates = ["2026-07-01", "2026-07-31", "2026-08-01", "2026-08-15"];
  const withKey = await run(daily, dates);
  expect(withKey.partial).toEqual({ start: false, end: true });
  expect(withKey.rows).toEqual([["2026-07-01", 2]]);
  delete daily.tables.fct_sales.primaryKey;
  expect(await run(daily, dates)).toEqual(withKey);
  expect(await run(modelFor({ column: "sold_on", grain: "day" }), dates)).toEqual(withKey);
});

it("retains native monthly summaries while flagging a quarter that is missing its last month", async () => {
  const monthly = modelFor({ column: "sold_on", grain: "month" });
  const dates = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const months = await run(monthly, dates);
  expect(months.partial).toEqual({ start: false, end: false });
  expect(months.rows).toEqual(dates.map(d => [d, 1]));
  const quarters = await run(monthly, dates, { dimensions: ["quarter:sold_on"], compare: "prior" });
  expect(quarters.partial).toEqual({ start: false, end: true });
  expect(quarters.rows).toEqual([["2026-04-01", 3, null, null, null]]);
  const complete = await run(monthly, [...dates, "2026-09-01"], { dimensions: ["quarter:sold_on"], compare: "prior" });
  expect(complete.partial).toEqual({ start: false, end: false });
  expect(complete.rows).toEqual([["2026-04-01", 3, null, null, null], ["2026-07-01", 3, 3, 0, 0]]);
});

it("does not manufacture a comparison against an excluded first partial period", async () => {
  const dates = ["2026-06-15", "2026-06-30", "2026-07-01", "2026-07-31", "2026-08-01", "2026-08-31"];
  const r = await run(modelFor(), dates, { compare: "prior" });
  expect(r.partial).toEqual({ start: true, end: false });
  expect(r.rows).toEqual([["2026-07-01", 2, null, null, null], ["2026-08-01", 2, 2, 0, 0]]);
  const yoy = await run(modelFor(), ["2025-08-15", "2025-08-31", "2026-08-01", "2026-08-31"], { compare: "yoy" });
  expect(yoy.rows).toEqual([["2026-08-01", 2, null, null, null]]);
});

it("recognizes complete fiscal quarters from monthly summaries, including year rollover", async () => {
  const model = { ...modelFor({ column: "sold_on", grain: "month" }), calendar: { weekStart: "sunday" as const, fiscalYearStartMonth: 2 } };
  const r = await run(model, ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"], { dimensions: ["quarter:sold_on"] });
  expect(r.partial).toEqual({ start: false, end: true });
  expect(r.rows).toEqual([["2025-11-01", 3]]);
});

it("only exempts the exact native metric axis and requires every component to agree", async () => {
  const model = modelFor();
  model.metrics = { ...model.metrics, revenue: { ...model.metrics.revenue, timeGrains: ["month"], timeDimension: "fct_sales.sold_on" } };
  const dates = ["2026-07-01", "2026-08-01"];
  expect((await run(model, dates)).rows).toEqual([["2026-07-01", 1], ["2026-08-01", 1]]);
  // The unrestricted second metric has no native-month declaration.
  const mixed = await run(model, dates, { metrics: ["revenue", "live_revenue"] });
  expect(mixed.partial.end).toBe(true);
  expect(mixed.rows).toEqual([["2026-07-01", 1, 1]]);
});

it("rejects finer grains and periods that would split a summary row", () => {
  for (const grain of ["day", "week"]) {
    const model = modelFor({ column: "sold_on", grain: "month" });
    expect(validateTile(model, tile({ dimensions: [`${grain}:sold_on`] })).map(i => i.problem).join(" ")).toContain("would split those periods");
  }
  const weekly = modelFor({ column: "sold_on", grain: "week" });
  expect(validateTile(weekly, tile({ dimensions: ["month:sold_on"] })).map(i => i.problem).join(" ")).toContain("would split those periods");
  expect(validateTile(weekly, tile({ dimensions: ["week:sold_on"] }))).toEqual([]);
  const ratio: Model = { ...base, tables: { ...base.tables, dim_users: { ...base.tables.dim_users,
    period: { column: "month", grain: "month" }, columns: [...base.tables.dim_users.columns, { name: "month", type: "date" }] } },
    metrics: { ...base.metrics, per_user: { ...base.metrics.revenue, name: "per_user", type: "ratio", numerator: "revenue", denominator: "users", expression: "" } } };
  expect(validateTile(ratio, tile({ metrics: ["per_user"], dimensions: ["day:fct_sales.sold_on"] })).map(i => i.problem).join(" "))
    .toContain("dim_users.month represents whole month periods");
});

it("generates a supported initial dashboard from explicit source-period metadata", () => {
  for (const grain of ["week", "month", "quarter", "year"] as const) {
    const model = modelFor({ column: "sold_on", grain });
    const dashboard = suggestDashboard(model, { table: "fct_sales", metrics: ["revenue"], grain: "day", includeBreakdowns: false });
    for (const t of dashboard.tiles.filter(t => t.metrics.length)) {
      expect(t.dimensions).toEqual([`${grain}:fct_sales.sold_on`]);
      expect(validateTile(model, t)).toEqual([]);
    }
  }
});

it("does not let an excluded date range disable checks on the remaining edge", async () => {
  const result = await run(modelFor(), ["2026-07-01", "2026-07-31", "2026-08-01", "2026-08-15"], { where: [
    { id: "exclude", field: "sold_on", source: "dimension", mode: "range", min: "2026-06-01", max: "2026-06-30", exclude: true },
  ] });
  expect(result.partial).toEqual({ start: false, end: true });
  expect(result.rows).toEqual([["2026-07-01", 2]]);
});

it("honors an explicit reporting window without turning it into a whole-month assertion", async () => {
  const r = await run(modelFor(), ["2026-08-01", "2026-08-15"], { where: [
    { id: "window", field: "fct_sales.sold_on", source: "dimension", mode: "range", min: "2026-08-01", max: "2026-08-16", maxExclusive: true },
  ] });
  // Existing contract: an explicitly bounded window stays visible. Its
  // dates remain in query scope; this is not a certification of coverage.
  expect(r.rows).toEqual([["2026-08-01", 2]]);
  expect(r.partial).toEqual({ start: false, end: false, selected: { start: false, end: true } });
});

it("loads explicit period metadata and rejects unknown grains and non-date fields", async () => {
  const yaml = (period: string) => `tables:\n  summary:\n    period: ${period}\n    columns:\n      - { name: month, type: date }\n      - { name: amount, type: double }\nmetrics:\n  total:\n    base_table: summary\n    expression: SUM(summary.amount)\n`;
  const path = join(dir, "period.yaml");
  await writeFile(path, yaml("{column: month, grain: month}"));
  expect((await duckglueAdapter.load(path))!.tables.summary.period).toEqual({ column: "month", grain: "month" });
  for (const period of ["{column: missing, grain: month}", "{column: amount, grain: month}"]) {
    await writeFile(path, yaml(period));
    await expect(duckglueAdapter.load(path)).rejects.toThrow("period.column must name a date or timestamp column");
  }
  await writeFile(path, yaml("{column: month, grain: fortnight}"));
  await expect(duckglueAdapter.load(path)).rejects.toThrow();
});
