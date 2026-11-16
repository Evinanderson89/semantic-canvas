import { expect, it } from "vitest";
import { applyProposal, proposalSchema } from "../src/canvas/proposals.ts";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { validateDashboard, filtersForTile } from "../src/app/filters.ts";
import { tabView, mergeTab } from "../src/app/tabs.ts";
import { dashboardSchema, tileSchema } from "../src/compiler/schema.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { model, tile } from "./fixtures.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import { applyLayout } from "../src/canvas/layouts.ts";

const proposal = (actions: unknown[]) => ({ title: "Useful context", reason: "Keep the remaining evidence in scope", actions });
const document = (): DashboardSpec => ({ title: "Revenue", tabs: [{ id: "one", title: "Overview" }, { id: "two", title: "Detail" }],
  tiles: [tile({ id: "a", tabId: "one" }), tile({ id: "b", tabId: "two" })],
  filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", defaultValue: { values: ["US"] },
    bindings: [{ tileId: "a", field: "dim_users.country" }, { tileId: "b", field: "dim_users.country" }] }] });

it("updates an explicitly proposed dashboard description atomically and leaves it alone otherwise", () => {
  const before = { ...document(), description: "Revenue by country and a separate detail page." }, snapshot = structuredClone(before);
  const view = tabView(before, "one");
  const describe = { type: "describe", description: "Monthly revenue trends with a separate detail page." };
  const edits = [{ type: "query", id: "a", dimensions: ["month:sold_on"] }, { type: "chart", id: "a", chart: "line" }];
  const next = validateRedesign(view, DEFAULT_CANVAS, proposal([...edits, describe]), model, "one");
  const merged = mergeTab(before, next.spec, "one");
  expect(merged.description).toBe(describe.description);
  expect(merged.tiles.find(t => t.id === "b")).toEqual(before.tiles[1]);
  expect(merged.tabs).toEqual(before.tabs);
  expect(before).toEqual(snapshot);
  expect(applyProposal(view, DEFAULT_CANVAS, proposal(edits), model, "one").spec.description).toBe(before.description);
  expect(applyProposal(view, DEFAULT_CANVAS, proposal([{ type: "describe", description: "" }]), model, "one").spec.description).toBe("");
  expect(() => validateRedesign(view, DEFAULT_CANVAS, proposal([describe]), model, "one")).toThrow(/Wording alone/);
  expect(() => applyProposal(view, DEFAULT_CANVAS, proposal([describe, { type: "query", id: "a", metrics: ["not_a_metric"] }]), model, "one")).toThrow();
  expect(before).toEqual(snapshot);
});

it("lets AI edits use every persisted chart type without accepting unknown or missing kinds", () => {
  for (const chart of tileSchema.shape.chart.unwrap().options) {
    expect(proposalSchema.parse(proposal([{ type: "chart", id: "a", chart }])).actions[0]).toEqual({ type: "chart", id: "a", chart });
  }
  for (const chart of [undefined, null, "pie3d", ""]) {
    expect(proposalSchema.safeParse(proposal([{ type: "chart", id: "a", chart }])).success).toBe(false);
  }
});

it.each(["executive", "exec-summary", "story"] as const)("AI %s arrangement uses the same governed headline priority as Smart arrange", layout => {
  const ranked = { ...model, metrics: { ...model.metrics,
    revenue: { ...model.metrics.revenue, importance: 100 }, retention: { ...model.metrics.retention, importance: 90 } } };
  const before: DashboardSpec = { title: "Rough draft", tiles: [
    tile({ id: "retention", metrics: ["retention"], chart: "kpi", dimensions: ["month:sold_on"], layout: { x: 24, y: 24, w: 300, h: 156 } }),
    tile({ id: "revenue", chart: "kpi", dimensions: ["month:sold_on"], layout: { x: 400, y: 100, w: 300, h: 156 } }),
    tile({ id: "trend", chart: "line", dimensions: ["month:sold_on"], layout: { x: 24, y: 360, w: 600, h: 300 } }),
  ] };
  const snapshot = structuredClone(before);
  const next = validateRedesign(before, DEFAULT_CANVAS, proposal([{ type: "arrange", layout }]), ranked).spec;
  const order = [...next.tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map(t => t.id);
  expect(order).toEqual(["revenue", "retention", "trend"]);
  expect(next.tiles.map(t => t.layout)).toEqual(applyLayout(layout, before.tiles, DEFAULT_CANVAS.width, true, ranked).map(t => t.layout));
  expect(before).toEqual(snapshot);
});

it.each(["map", "heatmap", "donut", "waterfall", "funnel", "barStacked", "combo"] as const)("applies a %s redesign without replacing the tile or losing its filter scope", chart => {
  const before = document(), snapshot = structuredClone(before);
  const next = validateRedesign(before, DEFAULT_CANVAS, proposal([
    { type: "query", id: "a", metrics: chart === "combo" ? ["revenue", "live_revenue"] : ["revenue"], dimensions: ["dim_users.country"] },
    { type: "chart", id: "a", chart },
  ]), model).spec;
  expect(next.tiles[0]).toMatchObject({ id: "a", tabId: "one", chart, dimensions: ["dim_users.country"] });
  expect(next.tiles[1]).toEqual(before.tiles[1]);
  expect(next.filters).toEqual(before.filters);
  expect(validateDashboard(model, dashboardSchema.parse(next))).toEqual([]);
  expect(before).toEqual(snapshot);
});

it.each(["scatter", "combo", "smallMultiples"] as const)("rejects a %s edit when the query does not supply its required fields", chart => {
  const before = { title: "Revenue", tiles: [tile({ chart: "bar", dimensions: ["dim_users.country"] })] };
  const snapshot = structuredClone(before);
  expect(() => applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "chart", id: "t1", chart }]), model)).toThrow(/selected breakdown|measure/);
  expect(before).toEqual(snapshot);
});

it("validates the final query and visualization together regardless of action order", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "bar", dimensions: ["dim_users.country"] })] };
  const actions = [{ type: "chart", id: "t1", chart: "kpi" }, { type: "query", id: "t1", dimensions: ["month:sold_on"] }];
  const first = applyProposal(before, DEFAULT_CANVAS, proposal(actions), model);
  const second = applyProposal(before, DEFAULT_CANVAS, proposal([...actions].reverse()), model);
  expect(first).toEqual(second);
  expect(first.spec.tiles[0]).toMatchObject({ chart: "kpi", dimensions: ["month:sold_on"] });
});

it("rejects mixed-unit stacks but permits explicitly separate axes and independent measure displays", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "table", dimensions: ["month:sold_on"], metrics: ["revenue", "new_signups"] })] };
  for (const chart of ["barStacked", "areaStacked", "waterfall"]) {
    expect(() => applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "chart", id: "t1", chart }]), model)).toThrow();
  }
  for (const chart of ["line", "combo", "scatter", "heatmap"]) {
    expect(applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "chart", id: "t1", chart }]), model).spec.tiles[0].chart).toBe(chart);
  }
});

it("allows layout recovery around an unchanged unsupported chart, but validates newly added charts", () => {
  const before = { title: "Revenue", tiles: [tile({ chart: "scatter", dimensions: ["dim_users.country"] })] };
  expect(applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "place", id: "t1", layout: { x: 24, y: 24, w: 500, h: 300 } }]), model).spec.tiles[0].chart).toBe("scatter");
  expect(() => applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "add", tile: tile({ id: "invalid-map", chart: "map", dimensions: [] }) }]), model)).toThrow(/selected breakdown|measure/);
});

it("removes only the deleted chart's bindings, and the resulting proposal passes Save validation", () => {
  const before = document(), snapshot = structuredClone(before);
  const next = applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "remove", id: "a" }]), model).spec;
  expect(validateDashboard(model, dashboardSchema.parse(next))).toEqual([]);
  expect(next.filters![0].bindings).toEqual([{ tileId: "b", field: "dim_users.country" }]);
  expect(filtersForTile(next, next.tiles[0], {})).toHaveLength(1);
  expect(before).toEqual(snapshot);
});

it("rejects invalid tab and cross-tab section references atomically", () => {
  const before = document(), snapshot = structuredClone(before);
  for (const actions of [
    [{ type: "add", tile: tile({ id: "new", tabId: "missing" }) }],
    [{ type: "add", tile: tile({ id: "heading", tabId: "two", kind: "heading", text: "Detail", metrics: [] }) },
      { type: "place", id: "a", section: "heading", layout: before.tiles[0].layout }],
  ]) expect(() => applyProposal(before, DEFAULT_CANVAS, proposal(actions), model)).toThrow(/tab/);
  expect(before).toEqual(snapshot);
});

it("validates an editable tab and restores other tabs' bindings when merging, including an empty destination", () => {
  const before = document();
  before.tiles = before.tiles.filter(t => t.id !== "b");
  before.filters![0].bindings.pop();
  before.filters!.push({ id: "detail", label: "Detail country", field: "dim_users.country", control: "select", scope: "tab", tabId: "two", defaultValue: { values: ["CA"] }, bindings: [] });
  const view = tabView(before, "two");
  expect(validateDashboard(model, view)).toEqual([]);
  const next = applyProposal(view, DEFAULT_CANVAS, proposal([{ type: "add", tile: tile({ id: "added" }) }]), model, "two");
  expect(next.spec.tiles[0].tabId).toBe("two");
  expect(next.spec.filters!.every(f => f.bindings.some(b => b.tileId === "added"))).toBe(true);
  const merged = mergeTab(before, next.spec, "two");
  expect(validateDashboard(model, dashboardSchema.parse(merged))).toEqual([]);
  expect(merged.tiles.find(t => t.id === "a")).toEqual(before.tiles[0]);
  expect(merged.filters![0].bindings.map(b => b.tileId).sort()).toEqual(["a", "added"]);
  expect(filtersForTile(merged, merged.tiles.find(t => t.id === "a")!, {})).toHaveLength(1);
  expect(filtersForTile(merged, merged.tiles.find(t => t.id === "added")!, {})).toHaveLength(2);
  expect(() => applyProposal(view, DEFAULT_CANVAS, proposal([{ type: "add", tile: tile({ id: "foreign", tabId: "one" }) }]), model, "two")).toThrow(/current tab/);
});

it("does not treat two charts on separate tabs as a new layout collision", () => {
  const before = document();
  expect(validateRedesign(before, DEFAULT_CANVAS, proposal([{ type: "query", id: "a", dimensions: ["month:sold_on"] }, { type: "chart", id: "a", chart: "line" }]), model).spec.tiles).toHaveLength(2);
});

it("preserves connected filter controls instead of changing scope as a side effect of removal", () => {
  const before = document();
  before.tiles.push(tile({ id: "control", tabId: "one", kind: "filter", metrics: [], filterId: "country" }));
  expect(() => applyProposal(before, DEFAULT_CANVAS, proposal([{ type: "remove", id: "control" }]), model)).toThrow(/filter designer/);
  expect(before.filters![0].bindings).toHaveLength(2);
});
