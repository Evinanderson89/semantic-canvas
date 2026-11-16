import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { queryObservations } from "../src/suggest/queryObservations.ts";
import type { TileSpec } from "../src/compiler/spec.ts";

const series = (rows: unknown[][], change: Partial<TileSpec> = {}, extra = {}) => queryObservations(model,
  tile({ metrics: ["revenue"], dimensions: ["month:fct_sales.sold_on"], ...change }),
  { columns: ["sold_on_month", "revenue"], rows, ...extra });

it("does not turn a retained partial selected period into a trend conclusion", () => {
  const result = series([["2026-07-01", 100], ["2026-08-01", 30]], {}, { partial: { start: false, end: false, selected: { start: false, end: true } } });
  expect(result.observations).toEqual([]);
  expect(result.note).toContain("partial observed edge periods");
});
it("withholds ratio conclusions when the two inputs have unlike period coverage", () => {
  const result = series([["2026-07-01", 1], ["2026-08-01", 1]], {}, { partial: { start: false, end: false, ratio: [{ period: "2026-08-01", numeratorStart: "2026-08-01", numeratorEnd: "2026-08-31", denominatorStart: "2026-08-01", denominatorEnd: "2026-08-15" }] } });
  expect(result.observations).toEqual([]);
  expect(result.note).toContain("Review both input windows");
});

it("uses the latest calendar bucket regardless of row order and cites the governed metric", () => {
  const result = series([["2026-08-01", 104000], ["2026-07-01", 100000]]).observations[0];
  expect(result.statement).toContain("$104,000"); expect(result.statement).toContain("month bucket starting 2026-08-01");
  expect(result.statement).toContain("Up 4%"); expect(result.previous).toBe(100000);
  expect(result.nextQuestion).toContain("vary by"); expect(result.nextQuestion).toContain("before attributing a cause");
});

it("reports rate movement in points even with a zero basis, without summing the rate", () => {
  const result = series([["2026-07-01", 1.044], ["2026-08-01", 1.028]], { metrics: ["retention"] }, { columns: ["sold_on_month", "retention"] }).observations[0];
  expect(result.statement).toContain("102.8%"); expect(result.statement).toContain("Down 1.6 percentage points");
  const zero = series([["2026-07-01", 0], ["2026-08-01", .02]], { metrics: ["retention"] }, { columns: ["sold_on_month", "retention"] }).observations[0];
  expect(zero.statement).toContain("Up 2 percentage points");
  const small = series([["2026-07-01", 1], ["2026-08-01", 1.00001]], { metrics: ["retention"] }, { columns: ["sold_on_month", "retention"] }).observations[0];
  expect(small.statement).toContain("Up 0.001 percentage points");
});

it("keeps values on the correct side of 100% in observations and their comparison basis", () => {
  const result = series([["2026-07-01", 1.0004], ["2026-08-01", .9996]], { metrics: ["retention"] }, { columns: ["sold_on_month", "retention"] }).observations[0];
  expect(result.statement).toContain("was 99.96%");
  expect(result.statement).toContain("from 100.04%");
  expect(result.latest).toBe(.9996);
  for (const [value, expected] of [[1, "100%"], [.9999999999, "<100%"], [1.0000000001, ">100%"]] as const) {
    const observation = queryObservations(model, tile({ metrics: ["retention"], dimensions: [] }), { columns: ["retention"], rows: [[value]] }).observations[0];
    expect(observation.statement).toContain(`is ${expected} in`);
    expect(observation.latest).toBe(value);
  }
});

it("does not substitute older values or compare adjacent rows across a missing month", () => {
  const missing = series([["2026-07-01", 10], ["2026-08-01", null]]).observations[0];
  expect(missing.latest).toBeUndefined(); expect(missing.statement).toContain("no numeric value");
  expect(series([["2026-06-01", 10], ["2026-08-01", 20]]).observations[0].previous).toBeUndefined();
});

it("uses the query's requested comparison and does not replace a missing comparison with another row", () => {
  const rows = [["2026-07-01", 10, 5], ["2026-08-01", 20, 4]];
  const result = series(rows, { compare: "yoy" }, { columns: ["sold_on_month", "revenue", "revenue__prev"] }).observations[0];
  expect(result.previous).toBe(4); expect(result.statement).toContain("Up 400%"); expect(result.statement).toContain("same period last year");
  const absent = series(rows.map(r => [r[0], r[1], null]), { compare: "prior" }, { columns: ["sold_on_month", "revenue", "revenue__prev"] }).observations[0];
  expect(absent.previous).toBeUndefined(); expect(absent.statement).toContain("comparison value is unavailable");
  expect(series(rows, { compare: "none" }).observations[0].previous).toBeUndefined();
});

it("describes changes from negative or zero bases in original units rather than misleading percentages", () => {
  const negative = series([["2026-07-01", -10], ["2026-08-01", 20]]).observations[0];
  expect(negative.statement).toContain("Up $30"); expect(negative.statement).not.toContain("%");
  expect(series([["2026-07-01", 0], ["2026-08-01", 20]]).observations[0].statement).toContain("Up $20");
});

it("refuses malformed dates, duplicate periods, limited results, transformed comparisons and segmented conclusions", () => {
  for (const rows of [[["2026-02-30", 10]], [["2026-08-01", 10], ["2026-08-01", 20]]]) expect(series(rows).observations).toEqual([]);
  expect(series([["2026-08-01", 10]], {}, { truncated: true }).observations).toEqual([]);
  expect(series([["2026-08-01", 10]], { compare: "prior", compareShow: "percent" }).observations).toEqual([]);
  expect(series([["2026-08-01", 10]], { dimensions: ["month:fct_sales.sold_on", "dim_users.country"] }).observations).toEqual([]);
});

it("describes highest returned category values including ties without inventing population shares", () => {
  const result = queryObservations(model, tile({ dimensions: ["dim_users.country"] }), { columns: ["country", "revenue"], rows: [["US", 50], ["GB", 50], ["FR", null]] }).observations[0];
  expect(result.statement).toContain("US, GB share the highest returned value, $50");
  expect(result.basis).toContain("2 of 3"); expect(result.statement).not.toContain("%");
});

it("preserves zero, rejects non-numeric values, and does not aggregate multiple scalar rows", () => {
  const scalar = tile({ metrics: ["revenue"], dimensions: [] });
  expect(queryObservations(model, scalar, { columns: ["revenue"], rows: [[0]] }).observations[0].latest).toBe(0);
  for (const value of [null, "", true, {}, Infinity]) expect(queryObservations(model, scalar, { columns: ["revenue"], rows: [[value]] }).observations).toEqual([]);
  expect(queryObservations(model, scalar, { columns: ["revenue"], rows: [[1], [2]] }).observations).toEqual([]);
});

it("compares fiscal and Sunday-week bucket labels without shifting them into a different calendar", () => {
  const fiscal = { ...model, calendar: { timezone: "America/New_York", weekStart: "sunday" as const, fiscalYearStartMonth: 4 } };
  const result = queryObservations(fiscal, tile({ dimensions: ["quarter:fct_sales.sold_on"] }), { columns: ["sold_on_quarter", "revenue"], rows: [["2026-01-01", 100], ["2026-04-01", 120]] });
  expect(result.observations[0].statement).toContain("Up 20%");
  const weekly = queryObservations(fiscal, tile({ dimensions: ["week:fct_sales.sold_on"] }), { columns: ["sold_on_week", "revenue"], rows: [["2026-03-01", 100], ["2026-03-08", 90]] });
  expect(weekly.observations[0].statement).toContain("Down 10%");
});

it("discloses inferred units and gives an authored unit priority over a suggestive metric name", () => {
  const spec = tile({ metrics: ["retention"], dimensions: [] }), result = { columns: ["retention"], rows: [[.95]] };
  expect(queryObservations(model, spec, result).observations[0].unitNote).toContain("inferred as percent");
  const declared = { ...model, metrics: { ...model.metrics, retention: { ...model.metrics.retention, unit: "number" as const } } };
  const observation = queryObservations(declared, spec, result).observations[0];
  expect(observation.statement).toContain("0.95"); expect(observation.statement).not.toContain("95%"); expect(observation.unitNote).toBeUndefined();
});
