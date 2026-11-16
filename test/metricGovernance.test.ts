import { expect, it } from "vitest";
import { reviewedModel, visibleModel, isUnreviewed, type Model } from "../src/semantic/model.ts";
import { validateTile } from "../src/compiler/compile.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { model as fixture, tile } from "./fixtures.ts";

function model(): Model {
  const value = structuredClone(fixture);
  value.metrics.cost = { ...value.metrics.revenue, name: "cost", label: "Cost", reviewed: false };
  value.metrics.margin = { ...value.metrics.revenue, name: "margin", label: "Margin", type: "derived", expression: "revenue - cost" };
  value.metrics.cost_ratio = { ...value.metrics.revenue, name: "cost_ratio", label: "Cost ratio", type: "ratio", expression: "", numerator: "cost", denominator: "revenue" };
  value.metrics.running_cost = { ...value.metrics.revenue, name: "running_cost", label: "Running cost", type: "cumulative", expression: "", metric: "cost" };
  value.metrics.sales_per_user = { ...value.metrics.revenue, name: "sales_per_user", label: "Sales per user", type: "ratio", expression: "", numerator: "revenue", denominator: "users" };
  return value;
}

it("removes unpublished components and every dependent computed metric from the governed catalogue", () => {
  const full = model(), before = structuredClone(full), governed = reviewedModel(full);
  for (const name of ["cost", "margin", "cost_ratio", "running_cost"]) expect(governed.metrics[name], name).toBeUndefined();
  expect(governed.metrics.revenue).toBeDefined();
  expect(governed.metrics.sales_per_user).toBeDefined();
  expect(full).toEqual(before);
  expect(visibleModel(full, "editor")).toBe(full);
  expect(visibleModel(full, "viewer").metrics.margin).toBeUndefined();
  for (const name of ["margin", "cost_ratio", "running_cost"]) expect(isUnreviewed(full, full.metrics[name]), name).toBe(true);
});

it("checks a cross-table ratio's denominator table and restores availability after publication", () => {
  const full = model();
  full.tables.dim_users.connected = { status: "unreviewed", loadedAt: "2026-01-01T00:00:00Z", provenance: { source: "Synthetic users", loadedAt: "2026-01-01T00:00:00Z", loadedBy: "test", rows: 2 } };
  expect(reviewedModel(full).metrics.sales_per_user).toBeUndefined();
  expect(isUnreviewed(full, full.metrics.sales_per_user)).toBe(true);
  full.tables.dim_users.connected.status = "published";
  full.metrics.cost.reviewed = true;
  for (const name of ["margin", "cost_ratio", "running_cost", "sales_per_user"]) {
    expect(reviewedModel(full).metrics[name]).toBeDefined();
    expect(isUnreviewed(full, full.metrics[name])).toBe(false);
  }
});

it("keeps unpublished dependencies out of generated dashboards even when explicitly requested", () => {
  const full = model(), hidden = ["margin", "cost_ratio", "running_cost"];
  const proposed = suggestDashboard(full, { table: "fct_sales", metrics: hidden });
  expect(proposed.tiles.length).toBeGreaterThan(0);
  expect(proposed.tiles.flatMap(t => t.metrics).some(name => hidden.includes(name))).toBe(false);
});

it("retains the existing viewer query guard and allows editors to inspect draft calculations", () => {
  const full = model();
  for (const name of ["margin", "cost_ratio", "running_cost"]) {
    const query = tile({ metrics: [name], dimensions: ["month:fct_sales.sold_on"] });
    expect(validateTile(full, query, { role: "viewer" }).some(issue => /not yet published/.test(issue.problem))).toBe(true);
    expect(validateTile(full, query, { role: "editor" })).toEqual([]);
  }
});
