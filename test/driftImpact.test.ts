import { expect, it } from "vitest";
import type { Model } from "../src/semantic/model.ts";
import { model, tile } from "./fixtures.ts";
import { driftOf, metricsUsing, dashboardDriftImpact, type DriftFinding } from "../src/modeler/extend.ts";

const computed = (): Model => ({ ...model, metrics: { ...model.metrics,
  ratio: { ...model.metrics.revenue, name: "ratio", type: "ratio" as const, expression: "", numerator: "revenue", denominator: "users" },
  derived: { ...model.metrics.revenue, name: "derived", type: "derived" as const, expression: "revenue * 2" },
  cumulative: { ...model.metrics.revenue, name: "cumulative", type: "cumulative" as const, expression: "", metric: "revenue" },
  literal: { ...model.metrics.revenue, name: "literal", expression: "COUNT(*)", filter: "'amount' = 'amount' /* fct_sales.amount */" },
} });
const finding = (table: string, column: string | null): DriftFinding => ({ table, column, kind: column ? "column_missing" : "table_missing", declared: null, actual: null, metrics: [], text: `${table}.${column} missing` });

it("traces computed inputs, including a cross-table denominator, without treating SQL text as a column", () => {
  const m = computed();
  const amount = metricsUsing(m, "fct_sales", "amount");
  expect(amount).toEqual(expect.arrayContaining(["ratio", "derived", "cumulative", "revenue"]));
  expect(amount).not.toContain("literal");
  expect(metricsUsing(m, "dim_users", null)).toContain("ratio");
  m.metrics.literal.expression = 'SUM("fct_sales" . "amount")';
  expect(metricsUsing(m, "fct_sales", "amount")).toContain("literal");
});

it("finds grouping, authored filters, filter bindings and required join keys without implicating an ungrouped total", () => {
  const spec = { title: "Revenue", tiles: [
    tile({ id: "total", title: "Total revenue" }),
    tile({ id: "country", title: "Revenue by country", dimensions: ["dim_users.country"] }),
    tile({ id: "fixed", where: [{ id: "f", source: "dimension" as const, mode: "discrete" as const, field: "dim_users.country", values: ["US"] }] }),
    tile({ id: "control" }),
    tile({ id: "monthly", dimensions: ["month:sold_on"] }),
  ], filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select" as const, scope: "report" as const, bindings: [{ tileId: "control", field: "dim_users.country" }] }] };
  for (const drift of [finding("dim_users", "country"), finding("dim_users", "user_id"), finding("dim_users", null)]) {
    const impact = dashboardDriftImpact(model, spec, [drift]);
    expect(impact.charts.map(c => c.id)).toEqual(["country", "fixed", "control"]);
    expect(impact.metrics).toEqual(["revenue"]);
    expect(impact.charts.every(c => c.findings.length === 1)).toBe(true);
  }
  expect(dashboardDriftImpact(model, spec, [finding("fct_sales", "sold_on")]).charts.map(c => c.id)).toEqual(["monthly"]);
});

it("lists charts of computed metrics when a required physical input disappears", () => {
  const m = computed();
  const catalog = Object.values(m.tables).map(t => ({ name: t.name, columns: t.columns.filter(c => c.name !== "amount") }));
  const drift = driftOf(m, catalog);
  const impact = dashboardDriftImpact(m, { title: "Computed", tiles: [tile({ metrics: ["ratio"] })] }, drift);
  expect(impact.metrics).toEqual(["ratio"]);
  expect(impact.charts[0].findings).toContain("fct_sales.amount (column_missing)");
});

it("checks the denominator's own reporting date for a cross-table ratio", () => {
  const m = structuredClone(computed());
  m.tables.dim_users.columns.push({ name: "joined_on", type: "date" });
  m.tables.dim_users.defaultDateColumn = "joined_on";
  const impact = dashboardDriftImpact(m, { title: "Ratio trend", tiles: [tile({ metrics: ["ratio"], dimensions: ["month:fct_sales.sold_on"] })] }, [finding("dim_users", "joined_on")]);
  expect(impact.charts).toHaveLength(1);
  m.tables.dim_users.columns.push({ name: "active_on", type: "date" });
  m.metrics.users.timeDimension = "dim_users.active_on";
  const spec = { title: "Ratio trend", tiles: [tile({ metrics: ["ratio"], dimensions: ["month:fct_sales.sold_on"] })] };
  expect(dashboardDriftImpact(m, spec, [finding("dim_users", "active_on")]).charts).toHaveLength(1);
  expect(dashboardDriftImpact(m, spec, [finding("dim_users", "joined_on")]).charts).toHaveLength(0);
});

it("ignores cross-filters that the chart query cannot apply", () => {
  const m = structuredClone(model);
  m.tables.unrelated = { ...m.tables.dim_users, name: "unrelated" };
  const spec = { title: "Scoped", tiles: [tile()], crossFilters: [{ id: "external", source: "dimension" as const, mode: "discrete" as const, field: "unrelated.country", values: ["US"] }] };
  expect(dashboardDriftImpact(m, spec, [finding("unrelated", "country")]).charts).toEqual([]);
});
