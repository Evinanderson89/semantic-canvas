import { afterAll, beforeAll, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile, splitPartialPeriods } from "../src/compiler/compile.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, tile } from "./fixtures.ts";

let db: DuckDBConnection;
beforeAll(async () => { db = await (await DuckDBInstance.create(":memory:")).connect(); });
afterAll(() => db.closeSync());
const model: Model = { source: "test", name: "Ratio coverage", joins: [], tables: Object.fromEntries(["sales", "traffic"].map(name => [name,
  { name, synonyms: [], partitionKeys: [], grain: "event", defaultDateColumn: "day", columns: [{ name: "day", type: "date" }, { name: "value", type: "double" }] },
])), metrics: {
  sales: { name: "sales", label: "Sales", baseTable: "sales", expression: "SUM(value)", synonyms: [] },
  traffic: { name: "traffic", label: "Traffic", baseTable: "traffic", expression: "SUM(value)", synonyms: [] },
  efficiency: { name: "efficiency", label: "Sales per visit", baseTable: "sales", type: "ratio", numerator: "sales", denominator: "traffic", expression: "", synonyms: [] },
} };
async function run(sales: string[], traffic: string[], patch: Record<string, unknown> = {}, m = model) {
  const source = { sales, traffic };
  const connector = { ...conn, toTimezone: (expr: string, zone: string) => `timezone('${zone}', timezone('UTC', CAST(${expr} AS TIMESTAMP)))`,
    relation: (table: string) => `(SELECT CAST(d AS ${m.tables[table].columns[0].type === "timestamp" ? "TIMESTAMP" : "DATE"}) AS day, 10::DOUBLE AS value FROM (VALUES ${source[table as keyof typeof source].map(d => `('${d}')`).join(",")}) AS raw(d))` };
  const sql = compileTile(m, connector, tile({ metrics: ["efficiency"], dimensions: ["month:sales.day"], compare: "prior", ...patch }));
  const result = await db.runAndReadAll(sql);
  return splitPartialPeriods({ columns: result.columnNames(), rows: result.getRows().map(row => row.map(v => v && typeof v === "object" ? String(v) : v)) });
}
it("retains ratio values but identifies unequal input coverage and prevents adjacent comparisons", async () => {
  const sales = ["2025-12-01", "2025-12-31", "2026-01-01", "2026-01-31", "2026-02-01", "2026-02-28"];
  const traffic = sales.map(d => d === "2026-01-31" ? "2026-01-15" : d);
  const r = await run(sales, traffic);
  expect(r.rows.map(row => row[1])).toEqual([1, 1, 1]);
  expect(r.partial.ratio).toEqual([{ period: "2026-01-01", numeratorStart: "2026-01-01", numeratorEnd: "2026-01-31", denominatorStart: "2026-01-01", denominatorEnd: "2026-01-15" }]);
  expect(r.rows.map(row => row[r.columns.indexOf("efficiency__prev")])).toEqual([null, null, null]);
  expect(r.columns.some(c => c.startsWith("__"))).toBe(false);
});
it("recognizes equally partial observations without asserting a full month", async () => {
  const dates = ["2026-01-01", "2026-01-15"];
  expect((await run(dates, dates)).partial.ratio).toHaveLength(1);
});
it("honors whole-month input declarations and keeps ordinary comparisons", async () => {
  const m = structuredClone(model);
  for (const table of Object.values(m.tables)) table.period = { column: "day", grain: "month" };
  const r = await run(["2026-01-01", "2026-02-01"], ["2026-01-01", "2026-02-01"], {}, m);
  expect(r.partial.ratio).toBeUndefined();
  expect(r.rows.map(row => row[r.columns.indexOf("efficiency__prev")])).toEqual([null, 1]);
});
it("reports a missing input period without treating its absent denominator as zero", async () => {
  const r = await run(["2026-01-01", "2026-01-02"], ["2026-01-01"], { dimensions: ["day:sales.day"] });
  expect(r.rows.map(row => row[1])).toEqual([1, null]);
  expect(r.partial.ratio?.[0]).toMatchObject({ period: "2026-01-02", denominatorStart: null, denominatorEnd: null });
});
it("compares fiscal quarters using each input's declared monthly coverage", async () => {
  const m = structuredClone(model); m.calendar = { weekStart: "sunday", fiscalYearStartMonth: 2 };
  for (const table of Object.values(m.tables)) table.period = { column: "day", grain: "month" };
  const r = await run(["2026-02-01", "2026-03-01", "2026-04-01"], ["2026-02-01", "2026-03-01"], { dimensions: ["quarter:sales.day"] }, m);
  expect(r.partial.ratio?.[0]).toMatchObject({ period: "2026-02-01", numeratorEnd: "2026-04-30", denominatorEnd: "2026-03-31" });
});
it("does not invent a reporting date for a ratio with no time axis", async () => {
  const r = await run(["2026-01-01"], ["2026-02-01"], { dimensions: [], compare: "none" });
  expect(r.rows).toEqual([[1]]); expect(r.partial.ratio).toBeUndefined();
});
it("evaluates observed input dates in the reporting timezone", async () => {
  const m = structuredClone(model); m.calendar = { timezone: "America/New_York", weekStart: "monday", fiscalYearStartMonth: 1 };
  for (const table of Object.values(m.tables)) table.columns[0].type = "timestamp";
  const r = await run(["2026-01-01 05:00:00", "2026-02-01 04:00:00"], ["2026-01-01 05:00:00", "2026-01-16 04:00:00"], {}, m);
  expect(r.partial.ratio?.[0]).toMatchObject({ period: "2026-01-01", numeratorEnd: "2026-01-31", denominatorEnd: "2026-01-15" });
});
it("keeps coverage evidence within each categorical group", async () => {
  const m = structuredClone(model);
  m.tables.geo = { name: "geo", grain: "country", synonyms: [], partitionKeys: [], columns: [{ name: "country", type: "string" }] };
  for (const name of ["sales", "traffic"]) {
    m.tables[name].columns.push({ name: "country", type: "string" });
    m.joins.push({ left: name, leftOn: "country", right: "geo", rightOn: "country", type: "left" });
  }
  const connector = { ...conn, relation: (name: string) => name === "geo" ? "(SELECT * FROM (VALUES ('US'), ('DE')) AS c(country))"
    : `(SELECT CAST(d AS DATE) AS day, country, 10::DOUBLE AS value FROM (VALUES ('2026-01-01','US'),('2026-01-31','US'),('2026-01-01','DE'),('${name === "sales" ? "2026-01-31" : "2026-01-15"}','DE')) AS r(d,country))` };
  const result = await db.runAndReadAll(compileTile(m, connector, tile({ metrics: ["efficiency"], dimensions: ["month:sales.day", "geo.country"] })));
  const r = splitPartialPeriods({ columns: result.columnNames(), rows: result.getRows() });
  expect(r.partial.ratio).toHaveLength(1);
  expect(r.partial.ratio?.[0]).toMatchObject({ dimensions: { country: "DE" }, denominatorEnd: "2026-01-15" });
  expect(r.rows).toHaveLength(2);
  // The same-name joined field must also work in separate metric-filter CTEs.
  m.metrics.filtered_sales = { ...m.metrics.sales, name: "filtered_sales", filter: "sales.value > 0" };
  const grouped = await db.runAndReadAll(compileTile(m, connector, tile({ metrics: ["sales", "filtered_sales"], dimensions: ["geo.country"] })));
  expect(grouped.getRows()).toEqual([["DE", 20, 20], ["US", 20, 20]]);
});
