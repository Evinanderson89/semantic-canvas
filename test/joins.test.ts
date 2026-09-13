import { describe, expect, it } from "vitest";
import { compileFrom, compileTile, validateTile } from "../src/compiler/compile.ts";
import { fieldReachable, joinPath, type Model } from "../src/semantic/model.ts";
import { conn, model as base, tile } from "./fixtures.ts";

// Join paths (docs/joins.md): a snowflake resolves hop by hop; two ways is refused; a join that fans out is refused.
const model: Model = { ...base,
  tables: { ...base.tables,
    dim_regions: { name: "dim_regions", grain: "one row per region", synonyms: [], partitionKeys: [], columns: [{ name: "region_id", type: "string" }, { name: "region", type: "string" }] },
    fct_refunds: { name: "fct_refunds", grain: "one row per refund", synonyms: [], partitionKeys: [], columns: [{ name: "refund_id", type: "string" }, { name: "sale_id", type: "string" }, { name: "reason", type: "string" }] },
  },
  joins: [...base.joins,
    { left: "dim_users", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" },
    { left: "fct_sales", leftOn: "sale_id", right: "fct_refunds", rightOn: "sale_id", type: "left", cardinality: "one_to_many" },
  ],
} as Model;
model.tables.dim_users = { ...model.tables.dim_users, columns: [...model.tables.dim_users.columns, { name: "region_id", type: "string" }] };

describe("join paths", () => {
  it("reaches a dimension two hops away, and joins each hop once, in order", () => {
    const path = joinPath(model, "fct_sales", "dim_regions");
    expect("joins" in path && path.joins.map((j) => j.right)).toEqual(["dim_users", "dim_regions"]);
    expect(fieldReachable(model, "fct_sales", "dim_regions.region")).toBe(true);
    expect(validateTile(model, tile({ dimensions: ["dim_regions.region"] }) as any)).toEqual([]);
    const from = compileFrom(model, conn, "fct_sales", ["dim_regions", "dim_users"]);
    expect(from).toContain('LEFT JOIN read_parquet(\'/lake/dim_users/**/*.parquet\') AS dim_users ON fct_sales."user_id" = dim_users."user_id"');
    expect(from).toContain('LEFT JOIN read_parquet(\'/lake/dim_regions/**/*.parquet\') AS dim_regions ON dim_users."region_id" = dim_regions."region_id"');
    expect(from.match(/JOIN/g)?.length).toBe(2);
    expect(from.indexOf("AS dim_users")).toBeLessThan(from.indexOf("AS dim_regions"));
    const sql = compileTile(model, conn, tile({ dimensions: ["dim_regions.region"] }) as any);
    expect(sql).toContain('dim_regions."region" AS "region"');
  });
  it("refuses a join that multiplies the base table's rows, in words", () => {
    const path = joinPath(model, "fct_sales", "fct_refunds");
    expect("error" in path && path.error).toBe("joining fct_sales to fct_refunds multiplies fct_sales's rows (one_to_many); an aggregate over it would double count");
    expect(validateTile(model, tile({ dimensions: ["fct_refunds.reason"] }) as any).map((i) => i.problem)).toEqual(["joining fct_sales to fct_refunds multiplies fct_sales's rows (one_to_many); an aggregate over it would double count"]);
    expect(fieldReachable(model, "fct_sales", "fct_refunds.reason")).toBe(false);
  });
  it("refuses two ways to the same table and names both", () => {
    const two: Model = { ...model, joins: [...model.joins, { left: "dim_plans", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" }] };
    two.tables.dim_plans = { ...two.tables.dim_plans, columns: [...two.tables.dim_plans.columns, { name: "region_id", type: "string" }] };
    const path = joinPath(two, "fct_sales", "dim_regions");
    expect("error" in path && path.error).toBe("fct_sales reaches dim_regions two ways (dim_users → dim_regions, or dim_plans → dim_regions); the model must say which");
    expect(joinPath(two, "dim_users", "dim_regions")).toHaveProperty("joins");
  });
  it("still says plainly when there is no way at all, and never walks a join backwards", () => {
    expect(joinPath(model, "dim_regions", "fct_sales")).toEqual({ error: "no join from dim_regions to fct_sales" });
    expect(validateTile(model, tile({ metrics: ["users"], dimensions: ["fct_sales.plan_id"] }) as any).map((i) => i.problem)).toEqual(["no join from dim_users to fct_sales"]);
  });
});
