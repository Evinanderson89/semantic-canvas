import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { compileTile, splitPartialPeriods } from "../src/compiler/compile.ts";
import type { Model } from "../src/semantic/model.ts";
import type { Connector } from "../src/connectors/types.ts";

// The sample lake's web sessions run 2024-09-01 (a Sunday) through
// 2026-08-31 (a Monday). Weekly buckets start on Monday, so the first and
// last weeks each hold one day: partial at both edges. Months line up.
let model: Model, conn: Connector, metric: string;
beforeAll(async () => {
  model = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  conn = await duckdbConnector("sample-data/lake");
  metric = Object.values(model.metrics).find(m => m.baseTable === "fct_web_sessions")!.name;
});
afterAll(async () => { await conn.close(); });
const tile = (dim: string, extra: object = {}) => ({ id: "t", kind: "metric", metrics: [metric], dimensions: [dim], layout: { x: 0, y: 0, w: 1, h: 1 }, ...extra }) as any;
const run = async (t: any) => splitPartialPeriods(await conn.execute(compileTile(model, conn, t), 5000));

describe("partial edge periods", () => {
  it("flags and excludes a weekly series whose first and last weeks are incomplete", async () => {
    const { rows, partial, columns } = await run(tile("week:fct_web_sessions.session_date"));
    expect(partial).toEqual({ start: true, end: true });
    expect(columns).not.toContain("__partial_start");
    expect(String(rows[0][0])).toBe("2024-09-02");
    expect(String(rows[rows.length - 1][0])).toBe("2026-08-24");
  });
  it("leaves a monthly series alone when the data covers whole months", async () => {
    const { rows, partial } = await run(tile("month:fct_web_sessions.session_date"));
    expect(partial).toEqual({ start: false, end: false });
    expect(String(rows[0][0])).toBe("2024-09-01");
    expect(String(rows[rows.length - 1][0])).toBe("2026-08-01");
  });
  it("keeps period-over-period columns and does not compare against a partial edge", async () => {
    const { columns, partial } = await run(tile("week:fct_web_sessions.session_date", { compare: "prior" }));
    expect(partial).toEqual({ start: true, end: true });
    expect(columns).toEqual(expect.arrayContaining([`${metric}__prev`, `${metric}__pct`]));
  });
  it("never flags a snapshot table at its own grain: one row dated the first is the whole month", async () => {
    const t = { id: "t", kind: "metric", metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"], layout: { x: 0, y: 0, w: 1, h: 1 } } as any;
    const sql = compileTile(model, conn, t);
    expect(sql).not.toContain("__partial_start");
    const { rows, partial } = splitPartialPeriods(await conn.execute(sql, 100));
    expect(partial).toEqual({ start: false, end: false });
    expect(String(rows[rows.length - 1][0])).toBe("2026-08-01");
  });
  it("uses the monthly source declaration for CAC but excludes its unfinished quarter", async () => {
    const t = { id: "cac", metrics: ["cac"], dimensions: ["month:fct_saas_monthly.month"], layout: { x: 0, y: 0, w: 1, h: 1 } };
    const monthly = splitPartialPeriods(await conn.execute(compileTile(model, conn, t), 100));
    expect(monthly.partial).toEqual({ start: false, end: false });
    expect(String(monthly.rows.at(-1)![0])).toBe("2026-08-01");
    const quarterly = splitPartialPeriods(await conn.execute(compileTile(model, conn, { ...t, dimensions: ["quarter:fct_saas_monthly.month"] }), 100));
    expect(quarterly.partial).toEqual({ start: true, end: true });
    expect(quarterly.rows).toHaveLength(7);
    expect(String(quarterly.rows.at(-1)![0])).toBe("2026-04-01");
  });
  it("judges the bucket, not each segment: a quiet segment does not make a complete month partial", async () => {
    // Every site has sessions on the first and last day of the data, except
    // one that is quiet for the first four days and the last three. The
    // months are still whole months of data; only that site's rows are thin.
    const t = tile("month:fct_web_sessions.session_date", { dimensions: ["month:fct_web_sessions.session_date", "fct_web_sessions.source_site"] });
    const sql = compileTile(model, conn, t).replace(/AS fct_web_sessions\n/,
      "AS fct_web_sessions\nWHERE NOT (source_site = (SELECT MIN(source_site) FROM read_parquet('sample-data/lake/fct_web_sessions/**/*.parquet')) AND (session_date < DATE '2024-09-05' OR session_date > DATE '2026-08-28'))\n");
    expect(sql).toContain("OVER (PARTITION BY");
    const { rows, partial } = splitPartialPeriods(await conn.execute(sql, 5000));
    expect(partial).toEqual({ start: false, end: false });
    expect(rows.length).toBe(72);
    // And when the whole bucket is short, every segment's row goes with it.
    const weekly = await run(tile("week:fct_web_sessions.session_date", { dimensions: ["week:fct_web_sessions.session_date", "fct_web_sessions.source_site"] }));
    expect(weekly.partial).toEqual({ start: true, end: true });
    expect(weekly.rows.some((r) => String(r[0]) === "2024-08-26" || String(r[0]) === "2026-08-31")).toBe(false);
  });
  it("skips the start check only for a range filter on the time column itself", () => {
    const time = "month:fct_web_sessions.session_date";
    const onTime = compileTile(model, conn, tile(time, { where: [{ source: "dimension", field: "fct_web_sessions.session_date", mode: "range", min: "2025-01-01" }] }));
    expect(onTime).toContain('FALSE AS "__partial_start"');
    expect(onTime).not.toContain('FALSE AS "__partial_end"');
    const onOther = compileTile(model, conn, tile(time, { where: [{ source: "dimension", field: "fct_web_sessions.pageviews", mode: "range", min: 2 }] }));
    expect(onOther).not.toContain('FALSE AS "__partial_start"');
  });
  it("adds no flags to a daily series or a series without a time grain", async () => {
    expect((await run(tile("day:fct_web_sessions.session_date"))).partial).toEqual({ start: false, end: false });
    expect((await run(tile("dim_users.country"))).partial).toEqual({ start: false, end: false });
  });
  it("keeps a selected partial window but withholds comparisons involving its observed edges", async () => {
    const t = tile("month:fct_web_sessions.session_date", { compare: "prior", where: [{ source: "dimension", field: "fct_web_sessions.session_date", mode: "range", min: "2025-10-15", max: "2025-12-15" }] });
    const result = await run(t);
    expect(result.partial).toEqual({ start: false, end: false, selected: { start: true, end: true } });
    expect(result.rows.map(r => String(r[0]))).toEqual(["2025-10-01", "2025-11-01", "2025-12-01"]);
    const prior = result.columns.indexOf(`${metric}__prev`);
    expect(result.rows.map(r => r[prior])).toEqual([null, null, null]);
    expect(result.rows.every(r => Number(r[1]) > 0)).toBe(true);
    expect(result.columns.some(c => c.startsWith("__"))).toBe(false);
  });
  it("continues comparing complete buckets inside a selected window", async () => {
    const result = await run(tile("month:fct_web_sessions.session_date", { compare: "prior", where: [{ source: "dimension", field: "session_date", mode: "range", min: "2025-09-15", max: "2025-12-31" }] }));
    expect(result.partial).toEqual({ start: false, end: false, selected: { start: true, end: false } });
    const prior = result.columns.indexOf(`${metric}__prev`);
    expect(result.rows[1][prior]).toBeNull();
    expect(result.rows[2][prior]).toBe(result.rows[1][1]);
    expect(result.rows[3][prior]).toBe(result.rows[2][1]);
  });
});
