import { expect, it } from "vitest";
import { captureView, insertView } from "../src/library/views.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { filtersForTile, validateDashboard } from "../src/app/filters.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import { model, tile } from "./fixtures.ts";
const book = (): DashboardSpec => ({ title: "Revenue", tabs: [{ id: "one", title: "Overview" }, { id: "two", title: "Detail" }], tiles: [
  tile({ id: "heading", kind: "heading", metrics: [], tabId: "one", text: "At a glance", layout: { x: 24, y: 60, w: 600, h: 60 } }),
  tile({ id: "chart", title: "Revenue", tabId: "one", section: "heading", layout: { x: 24, y: 144, w: 400, h: 250 } }),
  tile({ id: "other", tabId: "two" }),
], filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", bindings: [{ tileId: "chart", field: "dim_users.country" }, { tileId: "other", field: "dim_users.country" }], defaultValue: { values: ["US"] } }],
crossFilters: [{ id: "temporary", field: "dim_users.country", source: "dimension", mode: "discrete", values: ["GB"] }] });

it("captures a selected section with labels and only its own filter bindings", () => {
  const saved = captureView(book(), DEFAULT_CANVAS, "one", ["heading"], "Revenue section");
  expect(saved.spec.tiles.map(t => t.id)).toEqual(["heading", "chart"]);
  expect(saved.spec.crossFilters).toBeUndefined(); expect(saved.spec.tiles[1].section).toBe("heading");
  expect(saved.spec.filters![0].bindings).toHaveLength(1); expect(saved.spec.filters![0].defaultValue).toEqual({ values: ["US"] });
  expect(validateDashboard(model, saved.spec)).toEqual([]);
});
it("inserts independent copies without moving existing tiles or widening filter scope", () => {
  const source = book(), saved = captureView(source, DEFAULT_CANVAS, "one", [], "View");
  const next = insertView(source, DEFAULT_CANVAS, "two", saved.spec, model);
  expect(next.spec.tiles.slice(0, 3)).toEqual(source.tiles);
  const [heading, chart] = next.spec.tiles.slice(3); expect(chart.section).toBe(heading.id); expect(chart.id).not.toBe("chart");
  expect(chart.tabId).toBe("two"); expect(heading.layout.y).toBeGreaterThan(100);
  expect(next.spec.filters![1].id).not.toBe("country"); expect(next.spec.filters![1].bindings[0].tileId).toBe(chart.id);
  expect(filtersForTile(next.spec, chart, {})).toMatchObject([{ values: ["US"] }]);
  expect(validateDashboard(model, next.spec)).toEqual([]);
  chart.title = "Independent"; expect(saved.spec.tiles[1].title).toBe("Revenue");
  const twice = insertView(next.spec, next.canvas, "two", saved.spec, model); expect(new Set(twice.spec.tiles.map(t => t.id)).size).toBe(twice.spec.tiles.length);
});
it("rejects unavailable metrics and fits wide views into a narrower canvas", () => {
  const saved = captureView(book(), DEFAULT_CANVAS, "one", [], "View");
  const narrow = insertView({ title: "Narrow", tiles: [] }, { ...DEFAULT_CANVAS, width: 390 }, "main", saved.spec, model);
  expect(narrow.spec.tiles.every(t => t.layout.x + t.layout.w <= 390)).toBe(true);
  saved.spec.tiles[1].metrics = ["not_in_catalogue"];
  expect(() => insertView({ title: "New", tiles: [] }, DEFAULT_CANVAS, "main", saved.spec, model)).toThrow();
});
