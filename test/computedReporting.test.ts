import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { prepareNewTile } from "../src/suggest/prepareTile.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { metricGrainIssue } from "../src/semantic/model.ts";
import { conn, tile } from "./fixtures.ts";

let root: string, db: DuckDBConnection;
const tables = {
  orders: { default_date_column: "ordered_at", columns: [{ name: "ordered_at", type: "date" }, { name: "amount", type: "double" }, { name: "buyers", type: "integer" }] },
  refunds: { columns: [{ name: "ordered_at", type: "date" }, { name: "amount", type: "double" }] },
};
const inputs = {
  revenue: { label: "Revenue", base_table: "orders", expression: "SUM(amount)" },
  buyers: { label: "Buyers", base_table: "orders", expression: "SUM(buyers)" },
};
const definitions = {
  derived: { type: "derived", expression: "revenue * 2" },
  ratio: { type: "ratio", numerator: "revenue", denominator: "buyers" },
  cumulative: { type: "cumulative", metric: "revenue" },
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-computed-reporting-"));
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run("CREATE TABLE orders (ordered_at DATE, amount DOUBLE, buyers INTEGER); INSERT INTO orders VALUES ('2026-01-01',10,2),('2026-01-15',20,3),('2026-02-01',40,4)");
});
afterAll(async () => { db?.closeSync(); await rm(root, { recursive: true, force: true }); });
async function load(kind: keyof typeof definitions, overrides: Record<string, unknown> = {}) {
  const path = join(root, `${kind}.yaml`);
  await writeFile(path, YAML.stringify({ tables, metrics: { ...inputs,
    result: { ...definitions[kind], label: "Monthly result", time_grains: ["month"], time_dimension: "orders.ordered_at", ...overrides } } }));
  return (await duckglueAdapter.load(path))!;
}

for (const kind of Object.keys(definitions) as (keyof typeof definitions)[]) {
  it(`${kind}: rejects incomplete or invalid reporting declarations when the model loads`, async () => {
    for (const time_dimension of [undefined, "orders.missing", "orders.amount", "refunds.ordered_at"])
      await expect(load(kind, { time_dimension })).rejects.toThrow(/time_grains requires a date time_dimension on its base table/);
  });
  it(`${kind}: enforces its own reporting grain before compiling SQL`, async () => {
    const model = await load(kind);
    for (const dimensions of [[], ["day:orders.ordered_at"], ["year:orders.ordered_at"]]) {
      const spec = tile({ metrics: ["result"], dimensions });
      expect(validateTile(model, spec).map(i => i.problem)).toContain("Monthly result requires month reporting on orders.ordered_at. Other grains would change the metric's meaning.");
      expect(() => compileTile(model, conn, spec)).toThrow(/requires month reporting/);
    }
  });
  it(`${kind}: prepares a valid chart and executes the declared monthly calculation`, async () => {
    const model = await load(kind);
    const prepared = prepareNewTile(model, tile({ metrics: ["result"], dimensions: [] }));
    expect(prepared.dimensions).toEqual(["month:orders.ordered_at"]);
    expect(validateTile(model, prepared)).toEqual([]);
    const result = await db.runAndReadAll(compileTile(model, { ...conn, relation: t => conn.quote(t) }, prepared));
    expect(result.getRows().map(r => Number(r[1]))).toEqual(kind === "derived" ? [60,80] : kind === "ratio" ? [6,10] : [30,70]);
    const suggested = suggestDashboard(model, { metrics: ["result"] });
    for (const chart of suggested.tiles.filter(t => t.kind === undefined || t.kind === "metric")) expect(validateTile(model, chart)).toEqual([]);
  });
}

it("rejects a cumulative base-table override that contradicts its input", async () => {
  await expect(load("cumulative", { base_table: "refunds", time_dimension: "refunds.ordered_at" })).rejects.toThrow(/cumulative metric's base table is its input's \(orders\)/);
});

it("keeps simple-metric declaration validation and explains incomplete in-memory metadata", async () => {
  await expect(load("derived", { type: "simple", expression: "SUM(amount)", base_table: "orders", time_dimension: undefined })).rejects.toThrow(/time_grains requires a date time_dimension/);
  const model = await load("derived");
  expect(metricGrainIssue({ ...model.metrics.result, timeDimension: undefined }, [])).toBe("Monthly result declares reporting grains but has no time dimension. Update its metric definition before querying.");
});
