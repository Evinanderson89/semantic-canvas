import { afterAll, beforeAll, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { conn, tile } from "./fixtures.ts";
import type { Model } from "../src/semantic/model.ts";
import type { FilterSpec } from "../src/compiler/spec.ts";

let db: DuckDBConnection, model: Model;
const metrics = ["new_mrr", "expansion_mrr", "reactivation_mrr", "churned_mrr", "contraction_mrr", "gross_new_mrr", "lost_mrr", "net_new_mrr", "quick_ratio"];
const connector = { ...conn, relation: (table: string) => conn.quote(table) };
beforeAll(async () => {
  model = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run(`CREATE TABLE fct_mrr_movements (movement_date DATE, movement_type VARCHAR, mrr_delta_usd DOUBLE, user_id VARCHAR);
    INSERT INTO fct_mrr_movements VALUES
      ('2026-01-01','new',10,'a'),('2026-01-01','reactivation',8,'a'),('2026-01-01','churn',-5,'a'),
      ('2026-01-02','new',20,'b'),('2026-01-02','expansion',5,'b'),('2026-01-02','contraction',-3,'b'),
      ('2026-01-03','reactivation',7,'a'),('2026-01-04','churn',-4,'b'),('2026-01-05','new',0,'a');`);
});
afterAll(() => db.closeSync());
const run = async (where: FilterSpec[] = [], dimensions: string[] = []) => {
  const spec = tile({ metrics, dimensions, where });
  expect(validateTile(model, spec)).toEqual([]);
  const result = await db.runAndReadAll(compileTile(model, connector, spec));
  return result.getRows().map(row => Object.fromEntries(result.columnNames().map((name, i) => [name, row[i]])));
};
const on = (date: string): FilterSpec => ({ id: "date", field: "movement_date", source: "dimension", mode: "discrete", values: [date] });

it("does not offset churn losses with reactivation, and reconciles gross to net change", async () => {
  const [first] = await run([on("2026-01-01")]);
  expect(first).toMatchObject({ new_mrr: 10, expansion_mrr: 0, reactivation_mrr: 8, churned_mrr: 5, contraction_mrr: 0,
    gross_new_mrr: 18, lost_mrr: 5, net_new_mrr: 13, quick_ratio: 3.6 });
  const [all] = await run();
  expect(all).toMatchObject({ new_mrr: 30, expansion_mrr: 5, reactivation_mrr: 15, churned_mrr: 9, contraction_mrr: 3,
    gross_new_mrr: 50, lost_mrr: 12, net_new_mrr: 38 });
  expect(all.quick_ratio).toBeCloseTo(50 / 12);
});

it("keeps zero losses distinct from absent input and never invents a quick ratio denominator", async () => {
  const [returnOnly] = await run([on("2026-01-03")]);
  expect(returnOnly).toMatchObject({ reactivation_mrr: 7, gross_new_mrr: 7, lost_mrr: 0, net_new_mrr: 7, quick_ratio: null });
  const [lossOnly] = await run([on("2026-01-04")]);
  expect(lossOnly).toMatchObject({ gross_new_mrr: 0, lost_mrr: 4, net_new_mrr: -4, quick_ratio: 0 });
  const [zero] = await run([on("2026-01-05")]);
  expect(zero).toMatchObject({ gross_new_mrr: 0, lost_mrr: 0, net_new_mrr: 0, quick_ratio: null });
  const [empty] = await run([on("2026-02-01")]);
  for (const metric of metrics) expect(empty[metric]).toBeNull();
});

it("reconciles each selected period and keeps row-policy scope on all components", async () => {
  const rows = await run([], ["day:movement_date"]);
  expect(rows).toHaveLength(5);
  for (const row of rows) {
    expect(Number(row.lost_mrr)).toBe(Number(row.churned_mrr) + Number(row.contraction_mrr));
    expect(Number(row.gross_new_mrr)).toBe(Number(row.new_mrr) + Number(row.expansion_mrr) + Number(row.reactivation_mrr));
    expect(Number(row.net_new_mrr)).toBe(Number(row.gross_new_mrr) - Number(row.lost_mrr));
  }
  const [scoped] = await run([{ id: "gateway:user", source: "dimension", field: "user_id", mode: "discrete", values: ["a"] }]);
  expect(scoped).toMatchObject({ gross_new_mrr: 25, lost_mrr: 5, net_new_mrr: 20, quick_ratio: 5 });
});
