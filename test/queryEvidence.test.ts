import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { queryEvidence } from "../src/suggest/queryEvidence.ts";

it("gives agents the same threshold-preserving values and explicit bucket-start basis as the report", () => {
  const governed = { ...model, metrics: { ...model.metrics, retention: { ...model.metrics.retention, unit: "percent" as const } } };
  const query = tile({ metrics: ["retention"], dimensions: ["month:fct_sales.sold_on"], compare: "prior" });
  const result = { columns: ["sold_on_month", "retention", "retention__prev"], rows: [["2026-07-01", 1.0004, 1.01], ["2026-08-01", .9996, 1.0004]] };
  const original = structuredClone({ query, result, governed });
  const evidence = queryEvidence(governed, query, result);
  expect(evidence.metrics).toMatchObject([{ name: "retention", label: "Net revenue retention", unit: "percent", unitSource: "declared" }]);
  expect(evidence.timeDimensions).toEqual([{ dimension: "month:fct_sales.sold_on", resultColumn: "sold_on_month", grain: "month", dateMeaning: "Start of the month bucket, not its end." }]);
  expect(evidence.observations[0].statement).toContain("was 99.96%");
  expect(evidence.observations[0].statement).toContain("from 100.04%");
  expect(evidence.observations[0].basis).toBe("month bucket starting 2026-08-01");
  expect(evidence.rowsChecked).toBe(2);
  expect({ query, result, governed }).toEqual(original);
});

it("keeps embedded population filters distinct from standalone filters and shared-table totals", () => {
  const scoped = { ...model, metrics: { ...model.metrics,
    new_buyers: { ...model.metrics.revenue, name: "new_buyers", label: "New buyers",
      description: "Customers making their first purchase.", expression: "COUNT(DISTINCT user_id) FILTER (WHERE first_purchase = true)", filter: null },
    repeat_revenue: { ...model.metrics.revenue, name: "repeat_revenue", label: "Repeat revenue",
      expression: "SUM(CASE WHEN first_purchase = false THEN amount ELSE 0 END)", filter: "amount > 0" },
  } };
  const request = tile({ metrics: ["revenue", "new_buyers", "repeat_revenue"] });
  const result = { columns: request.metrics, rows: [[100, 3, 60]] };
  const before = structuredClone({ scoped, request, result });
  const evidence = queryEvidence(scoped, request, result);
  expect(evidence.metrics.map(m => m.definition)).toMatchObject([
    { name: "revenue", expression: "SUM(fct_sales.amount)", filter: null },
    { name: "new_buyers", expression: "COUNT(DISTINCT user_id) FILTER (WHERE first_purchase = true)", filter: null,
      description: "Customers making their first purchase." },
    { name: "repeat_revenue", expression: "SUM(CASE WHEN first_purchase = false THEN amount ELSE 0 END)", filter: "amount > 0" },
  ]);
  expect(evidence.metrics.every(m => m.definition?.tableGrain === "one row per sale")).toBe(true);
  expect(evidence.populationGuidance).toContain("null filter does not rule out conditions inside the expression");
  // Definitions contextualize the existing observations; no new derived value
  // or relationship (such as all revenue / new buyers) is manufactured.
  expect(evidence.metrics).toHaveLength(3);
  expect(evidence.metrics.every(m => !("components" in m))).toBe(true);
  expect({ scoped, request, result }).toEqual(before);
});

it("carries each computed input's own population, including cross-table ratios and cumulative scope", () => {
  const computed = { ...model, metrics: { ...model.metrics,
    rate: { ...model.metrics.revenue, name: "rate", type: "ratio" as const, expression: "", numerator: "live_revenue", denominator: "users" },
    difference: { ...model.metrics.revenue, name: "difference", type: "derived" as const, expression: "revenue - live_revenue" },
    trailing: { ...model.metrics.revenue, name: "trailing", type: "cumulative" as const, expression: "", metric: "live_revenue", window: 3 },
  } };
  const request = tile({ metrics: ["rate", "difference", "trailing"] });
  const evidence = queryEvidence(computed, request, { columns: request.metrics, rows: [[20, -10, 90]] });
  const [ratio, derived, cumulative] = evidence.metrics;
  expect(ratio.definition).toMatchObject({ type: "ratio", numerator: "live_revenue", denominator: "users" });
  expect(ratio.components).toMatchObject([
    { name: "live_revenue", baseTable: "fct_sales", filter: "fct_sales.amount > 0", tableGrain: "one row per sale" },
    { name: "users", baseTable: "dim_users", expression: "COUNT(*)", filter: null, tableGrain: "one row per user" },
  ]);
  expect(derived.components?.map(c => c.name)).toEqual(["revenue", "live_revenue"]);
  expect(cumulative.definition).toMatchObject({ type: "cumulative", metric: "live_revenue", window: 3 });
  expect(cumulative.components).toMatchObject([{ name: "live_revenue", filter: "fct_sales.amount > 0" }]);
  expect(JSON.stringify(evidence.metrics)).not.toContain("logo_churn_annualized");
});

it("does not invent missing definitions and explains implicit row counts using the table grain", () => {
  const request = tile({ metrics: ["rows:fct_sales"] });
  const evidence = queryEvidence(model, request, { columns: request.metrics, rows: [[7]] });
  expect(evidence.metrics[0].definition).toMatchObject({ type: "simple", expression: "COUNT(*)", tableGrain: "one row per sale" });
  const missing = queryEvidence({ ...model, metrics: {} }, tile(), { columns: ["revenue"], rows: [[10]] });
  expect(missing.metrics[0]).not.toHaveProperty("definition");
});

it("withholds conclusions for limited or incomparable input coverage while retaining findings", () => {
  const query = tile({ dimensions: ["month:fct_sales.sold_on"] });
  const result = { columns: ["sold_on_month", "revenue"], rows: [["2026-08-01", 100]] };
  const limited = queryEvidence(model, query, { ...result, truncated: true });
  expect(limited.observations).toEqual([]);
  expect(limited.observationNote).toContain("limited");
  expect(limited.findings.map(f => f.id)).toContain("limited");
  const ratio = queryEvidence(model, query, { ...result, partial: { start: false, end: false,
    ratio: [{ period: "2026-08-01", numeratorStart: "2026-08-01", numeratorEnd: "2026-08-31", denominatorStart: "2026-08-01", denominatorEnd: "2026-08-15" }] } });
  expect(ratio.observations).toEqual([]);
  expect(ratio.findings.map(f => f.id)).toContain("ratio-coverage");
  const missing = queryEvidence(model, query, { ...result, rows: [["2026-08-01", null]] });
  expect(missing.findings.map(f => f.id)).toContain("null:revenue");
  expect(missing.observations[0].latest).toBeUndefined();
  expect(missing.observations[0].statement).toContain("no numeric value");
});

it("discloses inferred units, respects comparison none, and does not claim whole-period data from a scalar", () => {
  const result = { columns: ["sold_on_month", "retention"], rows: [["2026-07-01", .95], ["2026-08-01", .99]] };
  const evidence = queryEvidence(model, tile({ metrics: ["retention"], dimensions: ["month:fct_sales.sold_on"], compare: "none" }), result);
  expect(evidence.metrics[0].unitSource).toBe("inferred from metric naming");
  expect(evidence.observations[0].previous).toBeUndefined();
  const scalar = queryEvidence(model, tile({ dimensions: [] }), { columns: ["revenue"], rows: [[10]] });
  expect(scalar.timeDimensions).toEqual([]);
  expect(scalar.observations[0].basis).toBe("Aggregate · no time breakdown");
  expect(scalar.basis).toContain("do not establish a cause");
});
