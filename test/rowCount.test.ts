import { describe, expect, it } from "vitest";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { isRowCount, metricOf, rowCountMetric, rowCountName } from "../src/semantic/model.ts";
import { conn, model, tile } from "./fixtures.ts";

/**
 * The built-in row count: what a tile measures when someone picks a
 * dimension before a metric. It is synthesized on lookup, never stored, so
 * the catalogue keeps listing only what people declared.
 */
describe("row count", () => {
  it("is a metric of every table without being in the catalogue", () => {
    const m = rowCountMetric(model, "fct_sales")!;
    expect(m).toMatchObject({ name: "rows:fct_sales", baseTable: "fct_sales", expression: "COUNT(*)", timeDimension: "fct_sales.sold_on" });
    expect(m.description).toBe("How many rows: one row per sale.");
    expect(Object.keys(model.metrics)).not.toContain("rows:fct_sales");
    expect(rowCountMetric(model, "fct_nope")).toBeUndefined();
  });

  it("resolves through the same lookup as a declared metric", () => {
    expect(metricOf(model, "revenue")).toBe(model.metrics.revenue);
    expect(metricOf(model, rowCountName("dim_users"))?.baseTable).toBe("dim_users");
    expect(metricOf(model, "rows:fct_nope")).toBeUndefined();
    expect(metricOf(model, "nope")).toBeUndefined();
    expect(isRowCount("rows:fct_sales")).toBe(true);
    expect(isRowCount("revenue")).toBe(false);
  });

  it("validates and compiles like any simple metric, grouped by the dimension picked first", () => {
    const t = tile({ metrics: ["rows:fct_sales"], dimensions: ["dim_users.country"] }) as TileSpec;
    expect(validateTile(model, t)).toEqual([]);
    const sql = compileTile(model, conn, t);
    expect(sql).toMatch(/COUNT\(\*\) AS "rows:fct_sales"/);
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).toMatch(/dim_users/);
  });

  it("counts along a time grain on the table's partition key", () => {
    const t = tile({ metrics: ["rows:fct_sales"], dimensions: ["month:sold_on"] }) as TileSpec;
    expect(validateTile(model, t)).toEqual([]);
    expect(compileTile(model, conn, t)).toMatch(/COUNT\(\*\)/);
  });

  it("still rejects a row count of a table the model does not have", () => {
    const issues = validateTile(model, tile({ metrics: ["rows:fct_nope"] }) as TileSpec);
    expect(issues.map((i) => i.problem)).toContain('unknown metric "rows:fct_nope"');
  });
});
