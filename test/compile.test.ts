import { describe, expect, it } from "vitest";
import { buildPredicate, compileTile, splitPartialPeriods, validateTile } from "../src/compiler/compile.ts";
import type { FilterSpec, TileSpec } from "../src/compiler/spec.ts";
import { conn, model, tile } from "./fixtures.ts";

describe("validateTile", () => {
  it("rejects a metric that is not in the model", () => {
    const issues = validateTile(model, tile({ metrics: ["revenue_per_wizard"] }) as TileSpec);
    expect(issues.map((i) => i.problem)).toContain('unknown metric "revenue_per_wizard"');
  });

  it("rejects metrics that span two base tables", () => {
    const issues = validateTile(model, tile({ metrics: ["revenue", "users"] }) as TileSpec);
    expect(issues[0].problem).toMatch(/one tile is one base table/);
  });

  it("rejects a column the table does not have", () => {
    const issues = validateTile(model, tile({ dimensions: ["nope"] }) as TileSpec);
    expect(issues[0].problem).toMatch(/not a column of fct_sales/);
  });

  it("rejects a dimension on a table with no join", () => {
    const m = { ...model, joins: [] };
    const issues = validateTile(m, tile({ dimensions: ["dim_users.country"] }) as TileSpec);
    expect(issues.map((i) => i.problem)).toContain("no join from fct_sales to dim_users");
  });

  it("rejects an unknown time grain", () => {
    const issues = validateTile(model, tile({ dimensions: ["fortnight:sold_on"] }) as TileSpec);
    expect(issues[0].problem).toMatch(/unknown time grain/);
  });

  it("skips validation for non-data tiles", () => {
    expect(validateTile(model, tile({ kind: "heading", metrics: [] }) as TileSpec)).toEqual([]);
  });

  it("accepts a valid joined tile", () => {
    expect(validateTile(model, tile({ dimensions: ["dim_users.country"] }) as TileSpec)).toEqual([]);
  });
});

describe("compileTile", () => {
  it("adds the join a dimension implies, and only that join", () => {
    const sql = compileTile(model, conn, tile({ dimensions: ["dim_users.country"] }) as TileSpec);
    expect(sql).toContain("LEFT JOIN");
    expect(sql).toContain("dim_users");
    expect(sql).not.toContain("dim_plans");
  });

  it("applies a time grain and groups by the alias", () => {
    const sql = compileTile(model, conn, tile({ dimensions: ["month:sold_on"] }) as TileSpec);
    expect(sql).toContain(`date_trunc('month', fct_sales."sold_on") AS "sold_on_month"`);
    expect(sql).toContain(`GROUP BY "sold_on_month"`);
  });

  it("applies a shared always-on filter as WHERE, never as FILTER", () => {
    // FILTER only attaches to a single aggregate call. Composite expressions
    // like SUM(x)/NULLIF(COUNT(y),0) are a parse error with FILTER appended,
    // which is exactly how this broke in the app.
    const sql = compileTile(model, conn, tile({ metrics: ["live_revenue"] }) as TileSpec);
    expect(sql).toContain("WHERE (fct_sales.amount > 0)");
    expect(sql).not.toContain("FILTER");
  });

  it("does not append FILTER to a composite expression", () => {
    const sql = compileTile(model, conn, tile({ metrics: ["arpu"] }) as TileSpec);
    expect(sql).not.toMatch(/NULLIF\([^)]*\)[^,]*FILTER/);
    expect(sql).toContain("WHERE (fct_sales.amount > 0)");
  });

  it("splits differing always-on filters into CTEs recombined on the dimensions", () => {
    const sql = compileTile(model, conn,
      tile({ metrics: ["revenue", "live_revenue"], dimensions: ["month:sold_on"] }) as TileSpec);
    expect(sql).toContain("WITH g0 AS");
    expect(sql).toContain("FULL OUTER JOIN g1 ON g0.\"sold_on_month\" IS NOT DISTINCT FROM g1.\"sold_on_month\"");
  });

  it("cross joins the groups when there is no dimension to join on", () => {
    const sql = compileTile(model, conn,
      tile({ metrics: ["revenue", "live_revenue"] }) as TileSpec);
    expect(sql).toContain("CROSS JOIN g1");
    expect(sql).not.toContain("USING");
  });

  it("throws rather than emitting SQL for an unvalidated tile", () => {
    expect(() => compileTile(model, conn, tile({ metrics: ["nope"] }) as TileSpec)).toThrow();
  });

  it("checks edge buckets against the dates observed inside them, and skips a side bounded by a range filter", () => {
    const sql = compileTile(model, conn, tile({ dimensions: ["month:sold_on"] }));
    expect(sql).toContain('"__partial_start"');
    expect(sql).toContain('"__partial_end"');
    const bounded = compileTile(model, conn, tile({ dimensions: ["month:sold_on"],
      where: [{ id: "w", field: "sold_on", source: "dimension", mode: "range", min: "2024-01-05", max: "2024-01-20" }] }));
    expect(bounded).toContain('FALSE AS "__partial_start"');
    expect(bounded).toContain('FALSE AS "__partial_end"');
  });

});

describe("splitPartialPeriods", () => {
  it("is a no-op when compileTile() never added the flag columns", () => {
    const result = { columns: ["month", "revenue"], rows: [["2024-01-01", 100]] };
    expect(splitPartialPeriods(result)).toEqual({ ...result, partial: { start: false, end: false } });
  });

  it("strips the flag columns, reports the flagged edges, and leaves flagged rows out", () => {
    const result = {
      columns: ["week", "web_sessions", "__partial_start", "__partial_end"],
      rows: [
        ["2024-08-26", 365, true, false],
        ["2024-09-02", 2399, false, false],
        ["2024-09-09", 2227, false, true],
      ],
    };
    const out = splitPartialPeriods(result);
    expect(out.columns).toEqual(["week", "web_sessions"]);
    expect(out.rows).toEqual([["2024-09-02", 2399]]);
    expect(out.partial).toEqual({ start: true, end: true });
  });

  it("drops the LEFT-JOIN sentinel row (every real column null) but keeps its flags", () => {
    const result = {
      columns: ["month", "web_sessions", "__partial_start", "__partial_end"],
      rows: [[null, null, true, true]],
    };
    const out = splitPartialPeriods(result);
    expect(out.rows).toEqual([]);
    expect(out.partial).toEqual({ start: true, end: true });
  });

  it("treats the flags per row: only the flagged edge buckets are left out", () => {
    // compileTile() marks each row with whether IT is a partial edge bucket.
    // Interior rows are never flagged, so a series keeps every complete
    // period and loses only the incomplete ends the tile's note reports.
    const result = {
      columns: ["week", "n", "__partial_start", "__partial_end"],
      rows: [
        ["2024-09-02", 2399, true, false],
        ["2024-09-09", 2227, false, false],
        ["2024-09-16", 2300, false, false],
      ],
    };
    const out = splitPartialPeriods(result);
    expect(out.rows).toEqual([["2024-09-09", 2227], ["2024-09-16", 2300]]);
    expect(out.partial).toEqual({ start: true, end: false });
  });
});

describe("buildPredicate", () => {
  const f = (o: Partial<FilterSpec>): FilterSpec =>
    ({ id: "f", field: "dim_users.country", source: "dimension", mode: "discrete", ...o } as FilterSpec);

  it("escapes quotes in values", () => {
    const p = buildPredicate(model, conn, "fct_sales", f({ values: ["O'Brien"] }));
    expect(p!.sql).toBe(`dim_users."country" IN ('O''Brien')`);
  });

  it("returns null for an empty value list rather than an always-false predicate", () => {
    expect(buildPredicate(model, conn, "fct_sales", f({ values: [] }))).toBeNull();
  });

  it("handles NULL separately from IN", () => {
    const p = buildPredicate(model, conn, "fct_sales", f({ values: ["US", null] }));
    expect(p!.sql).toContain("IS NULL");
    expect(p!.sql).toContain("IN ('US')");
  });

  it("negates with NOT IN when excluding", () => {
    const p = buildPredicate(model, conn, "fct_sales", f({ values: ["US"], exclude: true }));
    expect(p!.sql).toContain("NOT IN");
  });

  it("routes a metric filter to HAVING, not WHERE", () => {
    const p = buildPredicate(model, conn, "fct_sales",
      f({ field: "revenue", source: "metric", mode: "range", min: 10 }));
    expect(p!.having).toBe(true);
  });

  it("routes a dimension filter to WHERE", () => {
    const p = buildPredicate(model, conn, "fct_sales", f({ values: ["US"] }));
    expect(p!.having).toBe(false);
  });

  it("rejects a field that is not in the model", () => {
    expect(() => buildPredicate(model, conn, "fct_sales",
      f({ field: "dim_users.ssn", values: ["x"] }))).toThrow(/unknown or unreachable/);
  });
});

describe("no raw-SQL escape hatch", () => {
  it("ignores a legacy `filters` array if one is smuggled in", () => {
    const sql = compileTile(model, conn,
      { ...tile(), filters: ["1=1 OR (SELECT 1)"] } as unknown as TileSpec);
    expect(sql).not.toContain("1=1");
    expect(sql).not.toContain("SELECT 1)");
  });
});
