import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dbtAdapter } from "../src/semantic/dbt.ts";
import { loadRls } from "../src/security/rls.ts";
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "sc-dbt-")); });
afterAll(() => rm(dir, { recursive: true, force: true }));
async function fixture(type: string, extra = {}) {
  const path = join(dir, type);
  const { mkdir } = await import("node:fs/promises"); await mkdir(path);
  await writeFile(join(path, "semantic_manifest.json"), JSON.stringify({
    semantic_models: [{ name: "orders", node_relation: { alias: "orders", database: "WAREHOUSE", schema_name: "PUBLIC" },
      measures: [{ name: "total", agg: "sum", expr: "amount" }], dimensions: [] }],
    metrics: [{ name: "revenue", type, type_params: { measure: { name: "total" } }, ...extra }],
  }));
  return path;
}
it("imports the supported simple measure without losing physical relation metadata", async () => {
  const model = await dbtAdapter.load(await fixture("simple"));
  expect(model?.metrics.revenue.expression).toBe("SUM(orders.amount)");
  expect(model?.tables.orders.relation).toEqual({ database: "WAREHOUSE", schema: "PUBLIC", table: "orders" });
});
it.each(["ratio", "derived", "cumulative", "conversion"])("rejects unsupported %s semantics rather than converting them to a sum", async (type) => {
  await expect(dbtAdapter.load(await fixture(type))).rejects.toThrow(`unsupported type "${type}"`);
});
it("does not disable RLS when its configured file is missing or invalid", async () => {
  await expect(loadRls(join(dir, "missing.yaml"))).rejects.toThrow();
  const path = join(dir, "invalid.yaml"); await writeFile(path, "policies: definitely-not-a-list");
  await expect(loadRls(path)).rejects.toThrow();
});
