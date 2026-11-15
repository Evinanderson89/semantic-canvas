import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { snowflakeSemanticAdapter } from "../src/semantic/snowflakeSemantic.ts";
import { connectOne } from "../src/sources/registry.ts";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "canvas-semantic-contract-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const fixture = (): any => ({ name: "Revenue", tables: [{ name: "orders", base_table: { table: "ORDERS" },
  dimensions: [{ name: "region", expr: "region", data_type: "VARCHAR" }],
  facts: [{ name: "order_amount", expr: "amount", data_type: "NUMBER" }],
  metrics: [{ name: "revenue", expr: "SUM(order_amount)" }],
}] });
async function load(model: any) {
  const file = join(directory, `${crypto.randomUUID()}.yaml`);
  await writeFile(file, YAML.stringify(model));
  return snowflakeSemanticAdapter.load(file);
}

const restrictions: [string, (model: any) => void, RegExp][] = [
  ["non-additive dimensions", m => { m.tables[0].metrics[0].non_additive_dimensions = [{ table: "orders", dimension: "region" }]; }, /non_additive_dimensions/],
  ["explicit metric join paths", m => { m.tables[0].metrics[0].using_relationships = ["orders_to_customer"]; }, /using_relationships/],
  ["private metrics", m => { m.tables[0].metrics[0].access_modifier = "private_access"; }, /private_access/],
  ["private facts", m => { m.tables[0].facts[0].access_modifier = "private_access"; }, /private_access/],
  ["entity filters", m => { m.tables[0].dimensions[0].labels = ["filter"]; }, /filter/],
  ["SQL-defined tables", m => { m.tables[0].base_table = { definition: "SELECT * FROM ORDERS WHERE approved" }; }, /definition/],
  ["variables", m => { m.variables = [{ name: "threshold", data_type: "NUMBER", default_value: "100" }]; }, /variables/],
  ["range relationships", m => { m.relationships = [{ name: "self", left_table: "orders", right_table: "orders", relationship_columns: [{ left_column: "region", right_column: "region", type: "range", right_range: { start_column: "region", end_column: "region" } }] }]; }, /range/],
  ["asof relationships", m => { m.relationships = [{ name: "self", left_table: "orders", right_table: "orders", relationship_columns: [{ left_column: "region", right_column: "region", type: "asof" }] }]; }, /asof/],
];
for (const [name, change, message] of restrictions) it(`refuses ${name} rather than dropping their semantics`, async () => {
  const model = fixture(); change(model);
  await expect(load(model)).rejects.toThrow(message);
});

for (const name of [undefined, "", 42, "order.amount", "__proto__"]) it(`rejects an unsupported metric identity ${String(name)}`, async () => {
  const model = fixture(); model.tables[0].metrics[0].name = name;
  await expect(load(model)).rejects.toThrow(/metric.*name|metric.*identifier/);
});

it("rejects a second fact alias instead of silently rebinding the metric to a different column", async () => {
  const model = fixture(); model.tables[0].facts.push({ name: "order_amount", expr: "refund", data_type: "NUMBER" });
  await expect(load(model)).rejects.toThrow(/duplicate.*order_amount/);
});

it("rejects ambiguous logical table names before resolving relationships", async () => {
  const model = fixture(); model.tables.push({ name: "orders", base_table: { table: "REFUNDS" }, dimensions: [], metrics: [] });
  await expect(load(model)).rejects.toThrow(/duplicate logical table.*orders/);
});

it("rejects physical table names the query compiler cannot address", async () => {
  const model = fixture(); model.tables[0].base_table.table = "ORDERS$ARCHIVE";
  await expect(load(model)).rejects.toThrow(/physical table name.*compiler identifier/);
});

it("rejects relationships to nonexistent tables rather than producing a partial join graph", async () => {
  const model = fixture(); model.relationships = [{ name: "missing", left_table: "orders", right_table: "absent", relationship_columns: [{ left_column: "region", right_column: "region" }] }];
  await expect(load(model)).rejects.toThrow(/unknown.*absent/);
});

it("accepts ordinary public metrics with descriptive metadata", async () => {
  const model = fixture(); model.tables[0].metrics[0].access_modifier = "public_access";
  model.tables[0].metrics[0].description = "Governed sales revenue";
  model.tables[0].metrics[0].synonyms = ["sales"];
  const imported = await load(model);
  expect(imported?.metrics.revenue).toMatchObject({ expression: "SUM(ORDERS.amount)", description: "Governed sales revenue", synonyms: ["sales"] });
});

it("resolves unquoted fact references without case-sensitive misses or changes to SQL literals", async () => {
  const model = fixture();
  model.tables[0].facts[0].name = "Order_Amount";
  model.tables[0].metrics[0].expr = "SUM(ORDER_AMOUNT) + SUM(order_amount) /* ORDER_AMOUNT */ + CASE WHEN 'Order_Amount' = 'Order_Amount' THEN 0 ELSE 1 END";
  expect((await load(model))?.metrics.revenue.expression).toBe("SUM(ORDERS.amount) + SUM(ORDERS.amount) /* ORDER_AMOUNT */ + CASE WHEN 'Order_Amount' = 'Order_Amount' THEN 0 ELSE 1 END");
});

it("rejects case-only collisions in metric, field, logical and physical table identities", async () => {
  for (const kind of ["metric", "field", "logical", "physical"]) {
    const model = fixture();
    if (kind === "metric") model.tables[0].metrics.push({ name: "REVENUE", expr: "COUNT(*)" });
    if (kind === "field") model.tables[0].facts.push({ name: "ORDER_AMOUNT", expr: "refund", data_type: "NUMBER" });
    if (kind === "logical") model.tables.push({ name: "ORDERS", base_table: { table: "REFUNDS" } });
    if (kind === "physical") model.tables.push({ name: "other_orders", base_table: { table: "orders" } });
    await expect(load(model)).rejects.toThrow(/duplicate/);
  }
});

it("reports an actionable source error before opening a connector for unsupported semantics", async () => {
  const model = fixture(); model.tables[0].metrics[0].non_additive_dimensions = [{ table: "orders", dimension: "region" }];
  const file = join(directory, "source-error.yaml"); await writeFile(file, YAML.stringify(model));
  const source = await connectOne({ id: "synthetic-import-contract", adapter: "snowflake-semantic", model: file,
    connector: { type: "unsupported-test-connector" } });
  expect(source).toMatchObject({ status: "error", error: expect.stringMatching(/non_additive_dimensions.*orders.revenue/) });
  expect(source.conn).toBeUndefined();
  expect(source.model).toBeUndefined();
});
