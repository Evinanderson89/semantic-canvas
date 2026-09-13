import { describe, expect, it } from "vitest";
import { scopeFor } from "../src/security/rls.ts";
import { requireScope } from "../src/security/queryScope.ts";
import { model } from "./fixtures.ts";

// A policies.yaml policy names a table; it governs the models that have that table and only those.
describe("row-level policies and the model they apply to", () => {
  const cfg = { policies: [{ id: "region", table: "dim_users", column: "country", claim: "regions" }], principals: { emea: { id: "emea", name: "EMEA", regions: ["GB"] } } };
  it("applies to a model that has the table, through the join, and refuses a tile that cannot reach it", () => {
    expect(scopeFor(model, "fct_sales", cfg, cfg.principals.emea).filters).toEqual([{ id: "rls:region", field: "dim_users.country", source: "dimension", mode: "discrete", values: ["GB"] }]);
    expect(() => requireScope(model, "dim_plans", cfg, cfg.principals.emea)).toThrow(/cannot enforce region/);
    expect(() => requireScope(model, "fct_sales", cfg, null)).not.toThrow();
    expect(scopeFor(model, "fct_sales", cfg, null).filters[0].values).toEqual([]); // no principal: nothing
  });
  it("leaves a model that does not have the table alone, instead of refusing everything in it", () => {
    const other = { ...model, tables: { fct_cards: { name: "fct_cards", grain: "one row per card", synonyms: [], partitionKeys: [], columns: [{ name: "card_id", type: "string" }, { name: "price", type: "double" }] } },
      metrics: { cards: { name: "cards", label: "Cards", baseTable: "fct_cards", expression: "COUNT(*)", filter: null, synonyms: [] } }, joins: [] };
    const scope = requireScope(other, "fct_cards", cfg, null);
    expect(scope).toEqual({ filters: [], unenforceable: [] });
  });
});
