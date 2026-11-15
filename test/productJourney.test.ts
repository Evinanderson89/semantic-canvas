import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { model, tile } from "./fixtures.ts";
import { requiredDimensions, prepareNewTile } from "../src/suggest/prepareTile.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { resultIssue } from "../src/app/readiness.ts";
import { aiError } from "../src/app/aiError.ts";
import { Stat } from "../src/charts/Chart.tsx";
import { inferNumberStyle } from "../src/format/format.ts";
import { unappliedFilters } from "../src/app/filters.ts";
import { applyProposal } from "../src/canvas/proposals.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

it("prepares a restricted headline with its declared grain, preserving explicit selections", () => {
  const restricted = structuredClone(model);
  Object.assign(restricted.metrics.revenue, { timeGrains: ["month"], timeDimension: "fct_sales.sold_on" });
  expect(requiredDimensions(restricted, ["revenue"], [])).toEqual(["month:fct_sales.sold_on"]);
  expect(requiredDimensions(restricted, ["revenue"], ["week:sold_on"])).toEqual(["week:sold_on"]);
  expect(prepareNewTile(restricted, tile({ chart: "stat" }))).toMatchObject({ chart: "kpi", dimensions: ["month:fct_sales.sold_on"] });
  expect(prepareNewTile(restricted, tile({ kind: "heading", title: "Revenue health", metrics: [] })).text).toBe("Revenue health");
});

it("keeps every explicitly selected executive headline", () => {
  const metrics = ["revenue", "live_revenue", "retention", "arpu"];
  const result = suggestDashboard(model, { metrics, audience: "exec" });
  expect(result.tiles.filter(t => t.chart === "kpi" || t.chart === "stat").map(t => t.metrics[0])).toEqual(metrics);
});

it("distinguishes valid zeros, null-only metrics, missing columns and empty results", () => {
  expect(resultIssue(["revenue"], ["revenue"], [[0]])).toBeUndefined();
  expect(resultIssue(["revenue"], ["revenue"], [[null]])).toMatch(/No numeric/);
  expect(resultIssue(["revenue", "retention"], ["revenue"], [[10]])).toMatch(/retention/);
  expect(resultIssue(["revenue"], ["revenue"], [])).toMatch(/No rows/);
  const empty = renderToStaticMarkup(createElement(Stat, { value: null }));
  expect(empty).toContain("—"); expect(empty).not.toContain('class="v">0');
  expect(renderToStaticMarkup(createElement(Stat, { value: 42, format: n => `$${n}` }))).toContain("$42");
});

it("never treats blank text, booleans or structured values as numeric evidence", () => {
  for (const value of ["", "  ", false, true, [], [12], {}, null, undefined, Infinity, NaN]) {
    expect(resultIssue(["revenue"], ["revenue"], [[value]])).toMatch(/No numeric/);
    expect(renderToStaticMarkup(createElement(Stat, { value }))).toContain("—");
  }
  for (const value of [0, "0", "1.25", "-100", "1e3"]) {
    expect(resultIssue(["revenue"], ["revenue"], [[value]])).toBeUndefined();
    expect(renderToStaticMarkup(createElement(Stat, { value }))).not.toContain("—");
  }
});

it("uses declared units and never interprets payback months as dollars", () => {
  const typed = structuredClone(model);
  typed.metrics.cac_payback_months = { ...typed.metrics.revenue, name: "cac_payback_months", label: "CAC payback (months)", synonyms: [] };
  expect(inferNumberStyle(typed, tile({ metrics: ["cac_payback_months"] }))).toBe("plain");
  typed.metrics.revenue.unit = "months";
  expect(inferNumberStyle(typed, tile())).toBe("plain");
});

it("binds new reachable charts to existing filters and reports unbound active scope", () => {
  const original = { title: "Revenue", tiles: [tile()], filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select" as const, scope: "report" as const, bindings: [{ tileId: "t1", field: "dim_users.country" }], defaultValue: { values: ["US"] } }] };
  const result = applyProposal(original, DEFAULT_CANVAS, { title: "More evidence", reason: "Compare revenue", actions: [{ type: "add", tile: tile({ id: "new", layout: { x: 0, y: 200, w: 400, h: 300 } }) }] }, model);
  expect(result.spec.filters?.[0].bindings).toContainEqual({ tileId: "new", field: "dim_users.country" });
  expect(unappliedFilters(original, tile({ id: "unbound" }), {}, model)).toEqual(["Country"]);
  expect(unappliedFilters(result.spec, result.spec.tiles[1], {}, model)).toEqual([]);
});

it("turns provider credit and authentication failures into recovery guidance", () => {
  const message = aiError('400 {"error":{"message":"Your credit balance is too low"},"request_id":"private-request-123"}');
  expect(message).toMatch(/Check billing/);
  expect(message).not.toMatch(/request_id|private-request-123/);
  expect(aiError('400 {"error":{"message":"Unrecognized provider failure"},"request_id":"private-request-456"}')).not.toMatch(/request_id|private-request-456/);
  expect(aiError("401 authentication failed")).toMatch(/Connections/);
  expect(aiError("429 overloaded")).toMatch(/retry/);
});
