import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
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
const MODEL_PATH = process.env.MODEL_PATH ??
  join(homedir(), "Github/duckglue/semantic/warehouse.yaml");
const LAKE_ROOT = process.env.LAKE_ROOT ?? join(homedir(), "Github/duckglue/lake");
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
    for (const name of Object.keys(model.metrics))
      await mustRun(tile({ metrics: [name] }), `metric ${name}`);
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
