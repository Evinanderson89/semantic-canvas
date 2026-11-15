import { expect, it, vi } from "vitest";
import { discoverSchema } from "../src/sources/schema.ts";
import type { Model } from "../src/semantic/model.ts";
import { model } from "./fixtures.ts";

function catalog(): Model {
  return { ...model, tables: {
    sales: { ...model.tables.fct_sales, name: "sales", relation: { database: "warehouse", schema: "finance", table: "physical_sales" },
      columns: [{ name: "amount", type: "double", description: "Declared metric input" }] },
    draft: { ...model.tables.fct_sales, name: "draft", connected: { status: "unreviewed", loadedAt: "2026-09-01T00:00:00Z",
      provenance: { source: "Synthetic import", loadedAt: "2026-09-01T00:00:00Z", loadedBy: "test", rows: 1 } } },
  }, metrics: {}, joins: [] };
}
const warehouse = [
  { name: "physical_sales", columns: [{ name: "amount", type: "double" }, { name: "private_note", type: "text" }] },
  { name: "payroll_outside_model", columns: [{ name: "salary", type: "double" }] },
  { name: "draft", columns: [{ name: "import_private", type: "text" }] },
];

it("keeps viewer discovery within the published semantic schema without requesting raw warehouse metadata", async () => {
  const schema = vi.fn(async () => warehouse);
  const result = await discoverSchema(catalog(), "viewer", "Sales", { label: "Physical warehouse", schema });
  expect(result).toEqual({ tables: [{ name: "sales", columns: [{ name: "amount", type: "double" }] }],
    source: "Sales (from the semantic model)", scope: "semantic-model" });
  expect(schema).not.toHaveBeenCalled();
});

it("lets editors discover model drafts without exposing unmodeled warehouse tables or columns", async () => {
  const schema = vi.fn(async () => { throw new Error("Raw discovery must not run for editors"); });
  const result = await discoverSchema(catalog(), "editor", "Sales", { label: "Physical warehouse", schema });
  expect(result.scope).toBe("semantic-model");
  expect(result.tables.map(t => t.name)).toEqual(["sales", "draft"]);
  expect(result.tables[0].columns).toEqual([{ name: "amount", type: "double" }]);
  expect(schema).not.toHaveBeenCalled();
});

it("retains bound warehouse discovery for administrators and reports connector failures", async () => {
  const connector = { label: "Physical warehouse", async schema() {
    expect(this.label).toBe("Physical warehouse"); return warehouse;
  } };
  expect(await discoverSchema(catalog(), "admin", "Sales", connector)).toEqual({ tables: warehouse, source: connector.label, scope: "warehouse" });
  await expect(discoverSchema(catalog(), "admin", "Sales", { label: "Offline", schema: async () => { throw new Error("Warehouse unavailable"); } })).rejects.toThrow("Warehouse unavailable");
});

it("uses the same role-filtered model when a connector has no warehouse discovery", async () => {
  for (const role of ["viewer", "editor", "admin"] as const) {
    const result = await discoverSchema(catalog(), role, "Sales", { label: "Model-only connector" });
    expect(result.scope).toBe("semantic-model");
    expect(result.tables.map(t => t.name)).toEqual(role === "viewer" ? ["sales"] : ["sales", "draft"]);
  }
});
