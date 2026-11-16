import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mergeOverlay, type ConnectedEntry } from "../src/sources/connected.ts";
import { extensionSchema, mergeExtension } from "../src/sources/extensions.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { nativePeriod, rowCountMetric, timeColumnOf, type Model } from "../src/semantic/model.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { conn } from "./fixtures.ts";

const base: Model = { source: "test", name: "Imported orders", tables: {}, metrics: {}, joins: [] };
const table = { grain: "one row per order", primary_key: "id", default_date_column: "ordered_at", columns: [
  { name: "id", type: "integer" }, { name: "created_at", type: "date" },
  { name: "ordered_at", type: "timestamp" }, { name: "amount", type: "double" },
] };
const metric = { label: "Order revenue", expression: "SUM(amount)", base_table: "orders" };
let dir: string, db: DuckDBConnection;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sc-time-axis-"));
  db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run(`CREATE TABLE orders (id INTEGER, created_at DATE, ordered_at TIMESTAMP, amount DOUBLE);
    INSERT INTO orders VALUES (1,'2026-01-01','2026-01-15',10),(2,'2026-01-01','2026-02-15',20);`);
});
afterAll(async () => { db?.closeSync(); await rm(dir, { recursive: true, force: true }); });

async function load(kind: string, declared: typeof table): Promise<Model> {
  if (kind === "connected") {
    const entry: ConnectedEntry = { dataset: "orders", status: "published", importId: "synthetic", registeredBy: "test",
      provenance: { source: "test", loadedAt: "2026-03-01T00:00:00Z", loadedBy: "test", rows: 2 },
      table: declared, metrics: { revenue: { label: metric.label, expression: metric.expression, reviewed: true } } };
    return mergeOverlay(base, { tables: { orders: entry } }, "test");
  }
  if (kind === "extension") return mergeExtension(base, extensionSchema.parse({ tables: { orders: declared }, metrics: { revenue: metric } }), "test");
  const file = join(dir, "model.yaml");
  await writeFile(file, YAML.stringify({ name: base.name, tables: { orders: declared }, metrics: { revenue: metric } }));
  return (await duckglueAdapter.load(file))!;
}

for (const kind of ["connected", "extension", "duckglue"]) {
  it(`${kind}: retains the declared date through suggestions and real query execution`, async () => {
    const model = await load(kind, table);
    expect(model.tables.orders.defaultDateColumn).toBe("ordered_at");
    expect(model.tables.orders.partitionKeys).toEqual([]);
    expect(timeColumnOf(model, "orders")).toBe("orders.ordered_at");
    expect(rowCountMetric(model, "orders")?.timeDimension).toBe("orders.ordered_at");
    // Choosing a trend date does not declare that every month is complete.
    expect(nativePeriod(model, "orders", "ordered_at", "month", [model.metrics.revenue])).toBe(false);
    const suggested = suggestDashboard(model, { table: "orders" });
    const trend = suggested.tiles.find(t => t.chart === "line")!;
    expect(trend.dimensions).toEqual(["month:orders.ordered_at"]);
    expect(validateTile(model, trend)).toEqual([]);
    const result = await db.runAndReadAll(compileTile(model, { ...conn, relation: t => conn.quote(t) }, trend));
    expect(result.getRows().map(row => Number(row[1]))).toEqual([10, 20]);
    expect(timeColumnOf(base, "orders")).toBeNull(); // merge did not mutate the base
  });

  it(`${kind}: rejects a missing or non-date default instead of inventing an axis`, async () => {
    for (const default_date_column of ["missing", "amount"])
      await expect(load(kind, { ...table, default_date_column })).rejects.toThrow(/default_date_column.*date/);
    const { default_date_column: _, ...withoutDate } = table;
    const model = await load(kind, withoutDate as typeof table);
    expect(timeColumnOf(model, "orders")).toBeNull();
    expect(suggestDashboard(model, { table: "orders" }).tiles.some(t => t.chart === "line")).toBe(false);
  });
}
