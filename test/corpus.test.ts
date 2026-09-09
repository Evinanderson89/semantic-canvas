import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { compileTile, splitPartialPeriods, validateTile } from "../src/compiler/compile.ts";
import { demoDashboard, demoDashboardAvailable } from "../src/suggest/demo.ts";
import { metricsByTable, isTemporal, type Model } from "../src/semantic/model.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { TileSpec } from "../src/compiler/spec.ts";

/**
 * The corpus test.
 *
 * Hand-written fixtures only ever contain the cases their author thought of,
 * which is why a suite written alongside the compiler asserted a bug as correct:
 * every fixture metric was a single aggregate, so `expr FILTER (WHERE ...)` --
 * illegal on a composite expression -- looked fine.
 *
 * This instead drives the REAL semantic model through the compiler and hands the
 * result to a real database. Any metric the model can express and the engine
 * cannot compile is a failure here, by construction, with no imagination
 * required from whoever wrote the test.
 */
// Defaults to the sample warehouse bundled in this repo (sample-data/), so
// this runs out of the box on a fresh clone and in CI. MODEL_PATH/LAKE_ROOT
// still override it for testing against a real, larger warehouse instead.
const MODEL_PATH = process.env.MODEL_PATH ??
  join(import.meta.dirname, "../sample-data/warehouse.yaml");
const LAKE_ROOT = process.env.LAKE_ROOT ?? join(import.meta.dirname, "../sample-data/lake");
const available = existsSync(MODEL_PATH) && existsSync(LAKE_ROOT);

let model: Model;
let conn: Connector;

beforeAll(async () => {
  if (!available) return;
  model = (await duckglueAdapter.load(MODEL_PATH))!;
  conn = await duckdbConnector(LAKE_ROOT);
}, 60_000);
afterAll(async () => { await conn?.close(); });

const tile = (over: Partial<TileSpec>): TileSpec => ({
  id: "t", metrics: [], dimensions: [], layout: { x: 0, y: 0, w: 1, h: 1 }, ...over,
} as TileSpec);

/** Compile, then make the database prove it parses and runs. */
async function mustRun(t: TileSpec, label: string) {
  expect(validateTile(model, t), `${label}: failed validation`).toEqual([]);
  const sql = compileTile(model, conn, t);
  try {
    await conn.execute(sql, 5);
  } catch (e: any) {
    throw new Error(`${label} did not execute\n${e?.message}\n--- sql ---\n${sql}`);
  }
}

const timeColumn = (t: any) =>
  t.partitionKeys.find((k: string) => t.columns.find((c: any) => c.name === k && isTemporal(c)))
  ?? t.columns.find(isTemporal)?.name ?? null;

describe.skipIf(!available)("every metric in the real model compiles and runs", () => {
  it("has a corpus worth testing", () => {
    expect(Object.keys(model.metrics).length).toBeGreaterThan(20);
  });

  it("each metric, on its own", async () => {
    for (const [name, m] of Object.entries(model.metrics)) {
      if (m.timeGrains) expect(validateTile(model, tile({ metrics: [name] }))).not.toEqual([]);
      await mustRun(tile({ metrics: [name], dimensions: m.timeGrains ? [`${m.timeGrains[0]}:${m.timeDimension}`] : [] }), `metric ${name}`);
    }
  }, 120_000);

  it("each metric, broken down by its table's time column", async () => {
    for (const [name, m] of Object.entries(model.metrics)) {
      const tcol = timeColumn(model.tables[m.baseTable]);
      if (!tcol) continue;
      await mustRun(tile({ metrics: [name], dimensions: [`month:${tcol}`] }),
                    `metric ${name} by month`);
    }
  }, 180_000);

  it("every PAIR of metrics that shares a base table", async () => {
    // This is the case that broke in production: two metrics on one table whose
    // always-on filters and expression shapes have to coexist in one query.
    for (const [table, ms] of Object.entries(metricsByTable(model))) {
      const tcol = timeColumn(model.tables[table]);
      for (let i = 0; i < ms.length; i++)
        for (let j = i + 1; j < ms.length; j++)
          await mustRun(
            tile({ metrics: [ms[i].name, ms[j].name],
                   dimensions: tcol ? [`month:${tcol}`] : [] }),
            `pair ${ms[i].name} + ${ms[j].name}`);
    }
  }, 600_000);

  it("each metric, cut by every dimension its join graph reaches", async () => {
    for (const [table, ms] of Object.entries(metricsByTable(model))) {
      const local = (model.tables[table]?.columns ?? [])
        .filter((c) => /^(string|varchar|bool)/i.test(c.type) && !/_id$/.test(c.name))
        .map((c) => c.name);
      const joined = model.joins.filter((j) => j.left === table).flatMap((j) =>
        (model.tables[j.right]?.columns ?? [])
          .filter((c) => /^(string|varchar|bool)/i.test(c.type) && !/_id$/.test(c.name))
          .map((c) => `${j.right}.${c.name}`));
      for (const dim of [...local, ...joined])
        await mustRun(tile({ metrics: [ms[0].name], dimensions: [dim] }),
                      `${ms[0].name} by ${dim}`);
    }
  }, 300_000);
});

describe.skipIf(!available)("demoDashboard (the checked-in Beautify/Smart-Arrange demo)", () => {
  it("is available against the bundled sample warehouse", () => {
    expect(demoDashboardAvailable(model)).toBe(true);
  });

  it("every tile validates and actually runs against the real model", async () => {
    for (const t of demoDashboard().tiles) await mustRun(t, `demo tile ${t.id}`);
  }, 60_000);

  it("d2's noisy chart survives being genuinely noisy in the real data", async () => {
    // Guards the DEMO's premise, not detectNoisy() itself (already covered
    // in recommend.test.ts) -- if the sample data generator ever changes,
    // this is what would silently turn d2 from "a real bug to find" into
    // "just a smooth line", quietly breaking the demo without a code change
    // anywhere near it.
    const t = demoDashboard().tiles.find((x) => x.id === "d2")!;
    const sql = compileTile(model, conn, t);
    const r = await conn.execute(sql, 500);
    const idx = r.columns.indexOf("web_sessions");
    const vals = r.rows.map((row) => Number(row[idx])).filter(Number.isFinite);
    const range = Math.max(...vals) - Math.min(...vals);
    const meanAbsStep = vals.slice(1)
      .reduce((sum, v, i) => sum + Math.abs(v - vals[i]), 0) / (vals.length - 1);
    expect(meanAbsStep / range).toBeGreaterThan(0.08);
  });

  it("d3's breakdown survives actually being degenerate in the real data", async () => {
    const t = demoDashboard().tiles.find((x) => x.id === "d3")!;
    const sql = compileTile(model, conn, t);
    const r = await conn.execute(sql, 500);
    const idx = r.columns.indexOf("new_mrr");
    const nonZero = r.rows.filter((row) => Number(row[idx]) !== 0);
    expect(nonZero.length).toBe(1);
  });
});

describe.skipIf(!available)("observed periods remain visible without completeness metadata", () => {
  it("keeps both edge weeks and preserves their actual counts", async () => {
    const t = tile({ metrics: ["web_sessions"], dimensions: ["week:fct_web_sessions.session_date"] });
    const result = splitPartialPeriods(await conn.execute(compileTile(model, conn, t), 2000));
    expect(result.rows).toHaveLength(106);
    expect(result.rows[0]).toEqual(["2024-08-26", 365]);
    expect(result.rows.at(-1)).toEqual(["2026-08-31", 602]);
    expect(result.rows.find((r) => r[0] === "2024-09-02")).toEqual(["2024-09-02", 2399]);
  });
  it("keeps a filtered window within one month instead of discarding all its rows", async () => {
    const t = tile({ metrics: ["web_sessions"], dimensions: ["month:fct_web_sessions.session_date"],
      where: [{ id: "w", field: "fct_web_sessions.session_date", source: "dimension", mode: "range", min: "2024-09-10", max: "2024-09-15" }] });
    const result = splitPartialPeriods(await conn.execute(compileTile(model, conn, t), 10));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe("2024-09-01");
    expect(Number(result.rows[0][1])).toBeGreaterThan(0);
  });
});
