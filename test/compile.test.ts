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
    expect(sql).toContain("FULL OUTER JOIN g1 USING (\"sold_on_month\")");
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

  describe("partial edge periods", () => {
    // Regression: a metric's real date range rarely lines up with a
    // week/month/quarter/year boundary. date_trunc still buckets the first
    // real row with whatever period it falls in even when most of that
    // period predates any data, so the bucket's total reads as a collapse
    // next to a full neighbor -- a chart that looks like it drops to zero
    // at both ends. These check the SQL SHAPE (a stub connector, no real
    // execution); corpus.test.ts checks the actual ROWS against the real
    // warehouse.
    it("wraps a week-grain query with a bounds check", () => {
      const sql = compileTile(model, conn, tile({ dimensions: ["week:sold_on"] }) as TileSpec);
      expect(sql).toContain("__bounds");
      expect(sql).toContain("__periods");
      expect(sql).toContain(`"sold_on_week" >= __bounds.lo`);
      // week = +7 days, then -1 day, for that bucket's own last day.
      expect(sql).toContain("INTERVAL '7 day'");
      expect(sql).toContain("INTERVAL '-1 day'");
    });

    it("expresses quarter as 3 months -- there's no native quarter interval", () => {
      const sql = compileTile(model, conn, tile({ dimensions: ["quarter:sold_on"] }) as TileSpec);
      expect(sql).toContain("INTERVAL '3 month'");
    });

    it("does not wrap a day-grain query -- a day is already one full unit", () => {
      const sql = compileTile(model, conn, tile({ dimensions: ["day:sold_on"] }) as TileSpec);
      expect(sql).not.toContain("__bounds");
    });

    it("does not wrap a tile with no time dimension at all", () => {
      const sql = compileTile(model, conn, tile({ dimensions: ["dim_users.country"] }) as TileSpec);
      expect(sql).not.toContain("__bounds");
    });

    it("still composes with period-over-period comparison", () => {
      // The bounds wrapper must apply BEFORE the LAG-based comparison, not
      // after -- comparing against an already-partial neighbor would report
      // a real-looking but meaningless swing. Asserted here as "produces
      // valid-shaped SQL referencing both", not the exact string -- the
      // ORDER matters more than the surrounding syntax.
      const sql = compileTile(model, conn,
        tile({ dimensions: ["month:sold_on"], compare: "prior" }) as TileSpec);
      expect(sql).toContain("__bounds");
      const boundsAt = sql.indexOf("__bounds");
      const lagAt = sql.indexOf("LAG(");
      expect(boundsAt).toBeGreaterThan(-1);
      expect(lagAt).toBeGreaterThan(boundsAt);
    });

    it("reports a trimmed edge as columns, rather than trimming it silently", () => {
      const sql = compileTile(model, conn, tile({ dimensions: ["week:sold_on"] }) as TileSpec);
      expect(sql).toContain(`AS "__partial_start"`);
      expect(sql).toContain(`AS "__partial_end"`);
      // A second, independent bounds query -- not the same __bounds used to
      // filter -- specifically so the flags survive even when filtering
      // leaves zero rows for the first one to attach to.
      expect(sql).toContain("__report_bounds");
      expect(sql).toContain("LEFT JOIN");
    });

    it("still reports the flags when combined with period-over-period comparison", () => {
      // The flag-reporting wrap is applied LAST in compileTile(), so it's
      // always the OUTERMOST query -- confirmed here by the very first CTE
      // name in the string being __report_bounds, not __bounds (the
      // earlier, filtering one). A nested `WITH` puts its CTEs textually
      // BEFORE their own usage, so index position alone can't distinguish
      // "applied after" from "applied before" -- nesting depth (outermost
      // = applied last) is what actually matters here.
      const sql = compileTile(model, conn,
        tile({ dimensions: ["month:sold_on"], compare: "prior" }) as TileSpec);
      expect(sql.trim().startsWith("WITH __report_bounds")).toBe(true);
      expect(sql).toContain("LAG(");
      expect(sql).toContain(`AS "__partial_start"`);
    });
  });
});

describe("splitPartialPeriods", () => {
  it("is a no-op when compileTile() never added the flag columns", () => {
    const result = { columns: ["month", "revenue"], rows: [["2024-01-01", 100]] };
    expect(splitPartialPeriods(result)).toEqual({ ...result, partial: { start: false, end: false } });
  });

  it("strips the flag columns and reports which edges were seen", () => {
    const result = {
      columns: ["week", "web_sessions", "__partial_start", "__partial_end"],
      rows: [
        ["2024-09-02", 2399, false, false],
        ["2024-09-09", 2227, false, false],
      ],
    };
    const out = splitPartialPeriods(result);
    expect(out.columns).toEqual(["week", "web_sessions"]);
    expect(out.rows).toEqual([["2024-09-02", 2399], ["2024-09-09", 2227]]);
    expect(out.partial).toEqual({ start: false, end: false });
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

  it("keeps every real row regardless of the flag -- the flag describes the WHOLE result, not one row each", () => {
    // compileTile()'s flags are constant across every row in a real
    // response (computed once from bounds, not per-row) -- the partial
    // rows they describe were ALREADY excluded upstream, in compileTile()'s
    // own WHERE clause, before these columns are even attached. This never
    // re-filters a row based on its own flag value; OR-accumulating across
    // rows is defensive robustness (still correct if every row agrees, as
    // they always do in practice), not a per-row inclusion test.
    const result = {
      columns: ["week", "n", "__partial_start", "__partial_end"],
      rows: [
        ["2024-09-02", 2399, true, true],
        ["2024-09-09", 2227, true, true],
      ],
    };
    const out = splitPartialPeriods(result);
    expect(out.rows).toEqual([["2024-09-02", 2399], ["2024-09-09", 2227]]);
    expect(out.partial).toEqual({ start: true, end: true });
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

  it("ignores a field that is not in the model", () => {
    expect(buildPredicate(model, conn, "fct_sales",
      f({ field: "dim_users.ssn", values: ["x"] }))).toBeNull();
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
