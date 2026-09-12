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
  it("adds no flags to a daily series or a series without a time grain", async () => {
    expect((await run(tile("day:fct_web_sessions.session_date"))).partial).toEqual({ start: false, end: false });
    expect((await run(tile("dim_users.country"))).partial).toEqual({ start: false, end: false });
  });
});
