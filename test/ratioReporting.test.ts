import { afterAll, beforeAll, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { prepareNewTile } from "../src/suggest/prepareTile.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, tile } from "./fixtures.ts";

const model: Model = { source: "test", name: "Acquisition efficiency", joins: [], tables: {
  orders: { name: "orders", grain: "one order", synonyms: [], partitionKeys: [], defaultDateColumn: "ordered_at", columns: [{ name: "ordered_at", type: "date" }, { name: "amount", type: "double" }] },
  sessions: { name: "sessions", grain: "one observation", synonyms: [], partitionKeys: [], defaultDateColumn: "recorded_at", columns: [{ name: "session_date", type: "date" }, { name: "recorded_at", type: "date" }, { name: "hits", type: "double" }] },
}, metrics: {
  revenue: { name: "revenue", label: "Revenue", baseTable: "orders", expression: "SUM(amount)", synonyms: [], timeGrains: ["month"], timeDimension: "orders.ordered_at" },
  sessions: { name: "sessions", label: "Sessions", baseTable: "sessions", expression: "SUM(hits)", synonyms: [], timeGrains: ["month"], timeDimension: "sessions.session_date" },
  ratio: { name: "ratio", label: "Revenue per session", baseTable: "orders", type: "ratio", numerator: "revenue", denominator: "sessions", expression: "", synonyms: [] },
} };
let db: DuckDBConnection;
beforeAll(async () => {
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run("CREATE TABLE orders (ordered_at DATE, amount DOUBLE); INSERT INTO orders VALUES ('2026-01-15',30),('2026-02-15',40); CREATE TABLE sessions (session_date DATE, recorded_at DATE, hits DOUBLE); INSERT INTO sessions VALUES ('2026-01-15','2026-02-15',5),('2026-02-15','2026-03-15',8)");
});
afterAll(() => db?.closeSync());
const spec = (dimensions = ["month:orders.ordered_at"]) => tile({ metrics: ["ratio"], dimensions });
const run = async (m: Model, dimensions?: string[]) => {
  const rows = (await db.runAndReadAll(compileTile(m, { ...conn, relation: t => conn.quote(t) }, spec(dimensions)))).getRows();
  return rows.map(r => r[1] === null ? null : Number(r[1]));
};

it.each(["month:orders.ordered_at", "month:ordered_at"])("validates and executes each input's monthly date with %s", async axis => {
  expect(validateTile(model, spec([axis]))).toEqual([]);
  expect(await run(model, [axis])).toEqual([6, 5]);
});
it("uses a denominator's declared date even without grain restrictions", async () => {
  const m = structuredClone(model); m.metrics.sessions.timeGrains = undefined;
  expect(await run(m)).toEqual([6, 5]);
});
it("uses the denominator table default when no metric date is declared", async () => {
  const m = structuredClone(model); m.metrics.sessions.timeGrains = undefined; m.metrics.sessions.timeDimension = undefined;
  expect(await run(m)).toEqual([null, 8, null]);
});
it("prepares one aligned axis and preserves explicit choices for validation", () => {
  const prepared = prepareNewTile(model, spec([]));
  expect(prepared.dimensions).toEqual(["month:orders.ordered_at"]);
  expect(validateTile(model, prepared)).toEqual([]);
  const explicit = prepareNewTile(model, spec(["day:orders.ordered_at"]));
  expect(explicit.dimensions).toEqual(["day:orders.ordered_at"]);
  expect(validateTile(model, explicit).map(i => i.problem).join(" ")).toContain("Sessions requires month reporting");
});
it("does not invent compatibility between disjoint reporting grains", () => {
  const m = structuredClone(model); m.metrics.sessions.timeGrains = ["quarter"];
  expect(() => prepareNewTile(m, spec([]))).toThrow(/do not share a supported reporting period/);
  expect(validateTile(m, spec()).map(i => i.problem).join(" ")).toContain("Sessions requires quarter reporting");
});
it("suggests valid charts for a ratio whose inputs have reporting restrictions", () => {
  const proposed = suggestDashboard(model, { metrics: ["ratio"], grain: "day" });
  const charts = proposed.tiles.filter(t => !t.kind || t.kind === "metric");
  expect(charts.length).toBeGreaterThan(0);
  for (const chart of charts) {
    expect(chart.dimensions).toEqual(["month:orders.ordered_at"]);
    expect(validateTile(model, chart)).toEqual([]);
  }
});
it("can use a declared denominator date without a table default", async () => {
  const m = structuredClone(model); m.tables.sessions.defaultDateColumn = undefined;
  expect(validateTile(m, spec())).toEqual([]);
  expect(await run(m)).toEqual([6, 5]);
});
it("rejects a missing denominator date rather than guessing from available columns", () => {
  const m = structuredClone(model); m.tables.sessions.defaultDateColumn = undefined; m.metrics.sessions.timeDimension = undefined; m.metrics.sessions.timeGrains = undefined;
  expect(() => compileTile(m, conn, spec())).toThrow(/sessions has no date column/);
});

it("uses the numerator metric date in automatic trends even when grains are unrestricted", () => {
  const m = structuredClone(model);
  m.tables.orders.columns.push({ name: "paid_at", type: "date" });
  m.metrics.revenue.timeGrains = undefined; m.metrics.revenue.timeDimension = "orders.paid_at";
  m.metrics.sessions.timeGrains = undefined;
  const charts = suggestDashboard(m, { metrics: ["ratio"], includeBreakdowns: false }).tiles.filter(t => !t.kind || t.kind === "metric");
  expect(charts.length).toBeGreaterThan(0);
  for (const chart of charts) {
    expect(chart.dimensions).toEqual(["month:orders.paid_at"]);
    expect(validateTile(m, chart)).toEqual([]);
  }
});

it("rejects incompatible ratio-level restrictions as well as its input restrictions", () => {
  const m = structuredClone(model); m.metrics.ratio.timeGrains = ["quarter"]; m.metrics.ratio.timeDimension = "orders.ordered_at";
  expect(() => prepareNewTile(m, spec([]))).toThrow(/do not share a supported reporting period/);
  expect(validateTile(m, spec()).map(i => i.problem).join(" ")).toContain("Revenue per session requires quarter reporting");
});
it("checks the denominator's native period on the aligned date", () => {
  const m = structuredClone(model); m.metrics.sessions.timeGrains = undefined; m.metrics.revenue.timeGrains = undefined;
  m.tables.sessions.period = { column: "session_date", grain: "month" };
  expect(() => compileTile(m, conn, spec(["week:orders.ordered_at"]))).toThrow(/sessions.session_date represents whole month periods/);
});
it("rejects an invalid denominator date and a time axis on the wrong table", () => {
  const m = structuredClone(model); m.metrics.sessions.timeGrains = undefined; m.metrics.sessions.timeDimension = "sessions.hits";
  expect(() => compileTile(m, conn, spec())).toThrow(/sessions.hits is not a date column/);
  expect(() => compileTile(model, conn, spec(["month:sessions.session_date"]))).toThrow(/needs its time axis on orders/);
});
it("rejects a zero denominator as undefined and preserves period alignment for prior comparisons", async () => {
  const m = structuredClone(model); m.metrics.sessions.expression = "SUM(hits) - 5";
  expect(await run(m)).toEqual([null, 40 / 3]);
  const query = { ...spec(), compare: "prior" as const };
  const result = await db.runAndReadAll(compileTile(model, { ...conn, relation: t => conn.quote(t) }, query));
  const rows = result.getRows();
  expect(rows.map(row => row[1])).toEqual([6, 5]);
  const prior = result.columnNames().indexOf("ratio__prev");
  expect(prior).toBeGreaterThan(0);
  expect(rows.map(row => row[prior])).toEqual([null, 6]);
});
