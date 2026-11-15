import { expect, it } from "vitest";
import { versionChanges } from "../src/app/versionChanges.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DocumentSnapshot } from "../src/app/document.ts";

const original = (): DocumentSnapshot => ({ canvas: { ...DEFAULT_CANVAS }, spec: { title: "Revenue", tiles: [
  { id: "mrr", title: "MRR", metrics: ["ending_mrr"], dimensions: ["month:month"], chart: "line", layout: { x: 24, y: 24, w: 500, h: 300 } },
] } });

it("separates reporting-scope changes from visual changes with restoration direction", () => {
  const current = original(), saved = original();
  current.spec.tiles[0].metrics = ["net_new_mrr"];
  current.spec.tiles[0].where = [{ id: "country", source: "dimension", field: "country", mode: "discrete", values: ["US"] }];
  saved.spec.tiles[0].chart = "waterfall";
  saved.spec.tiles[0].layout.w = 700;
  const changes = versionChanges(current, saved);
  expect(changes.find(c => c.field === "Metrics")).toMatchObject({ group: "Data and scope", current: "net_new_mrr", saved: "ending_mrr" });
  expect(changes.find(c => c.field === "Chart filters")).toMatchObject({ group: "Data and scope", saved: "Not set" });
  expect(changes.find(c => c.field === "Visualization")).toMatchObject({ group: "Layout and appearance", current: "Line", saved: "Waterfall" });
  expect(changes.find(c => c.field === "Position and size")?.group).toBe("Layout and appearance");
});

it("ignores preview/cross-filter state and object insertion order but retains authored ordering", () => {
  const current = original(), saved = original();
  current.canvas.locked = true;
  current.spec.crossFilters = [{ id: "explore", source: "dimension", field: "country", mode: "discrete", values: ["US"] }];
  current.spec.tiles[0].layout = { h: 300, w: 500, y: 24, x: 24 };
  expect(versionChanges(current, saved)).toEqual([]);
  current.spec.tiles[0].metrics = ["ending_mrr", "nrr"];
  saved.spec.tiles[0].metrics = ["nrr", "ending_mrr"];
  expect(versionChanges(current, saved)).toHaveLength(1);
});

it("includes canvas, shared filter defaults, briefs and charts on other tabs", () => {
  const current = original(), saved = original();
  saved.canvas.width = 1000;
  saved.spec.tabs = [{ id: "first", title: "Overview" }, { id: "second", title: "Details", brief: { question: "Why?", takeaway: "Check retention", nextStep: "Investigate" } }];
  saved.spec.tiles[0].tabId = "second";
  saved.spec.tiles[0].spark = { compare: "first", color: "neutral" };
  saved.spec.filters = [{ id: "region", label: "Region", field: "country", control: "select", scope: "report", bindings: [{ tileId: "mrr", field: "country" }], defaultValue: { values: ["DE"] } }];
  const changes = versionChanges(current, saved);
  expect(changes.map(c => c.field)).toEqual(expect.arrayContaining(["Tabs and presentation briefs", "Shared filters and default selections", "Canvas settings", "Tab", "KPI comparison baseline", "Sparkline appearance"]));
  expect(changes.find(c => c.field === "KPI comparison baseline")?.group).toBe("Data and scope");
});

it("distinguishes added and removed tiles, narrative edits and changed images", () => {
  const current = original(), saved = original();
  current.spec.tiles.push({ id: "retired", kind: "text", text: "Old note", metrics: [], dimensions: [], layout: { x: 0, y: 400, w: 500, h: 100 } });
  saved.spec.tiles.push({ id: "new", kind: "text", text: "New note", metrics: [], dimensions: [], layout: { x: 0, y: 400, w: 500, h: 100 } });
  current.spec.tiles[0].imageData = "data:image/png;base64,current";
  saved.spec.tiles[0].imageData = "data:image/png;base64,saved";
  const changes = versionChanges(current, saved);
  expect(changes.find(c => c.field === "Add tile")?.subject).toBe("New note");
  expect(changes.find(c => c.field === "Remove tile")?.subject).toBe("Old note");
  expect(changes.find(c => c.field === "Image")).toMatchObject({ current: "Current image", saved: "Saved image" });
  expect(JSON.stringify(changes)).not.toContain("base64");
});

it("reports changed chart inventory as data scope and detects reordered same-title tiles", () => {
  const current = original(), saved = original();
  current.spec.tiles.push({ ...current.spec.tiles[0], id: "second" });
  saved.spec.tiles = [...current.spec.tiles].reverse();
  expect(versionChanges(current, saved).map(c => c.field)).toEqual(["Tile reading order"]);
  saved.spec.tiles = [{ ...saved.spec.tiles[0], id: "replacement", metrics: ["nrr"] }];
  const changes = versionChanges(current, saved);
  expect(changes.filter(c => c.field === "Remove chart query")).toHaveLength(2);
  expect(changes.find(c => c.field === "Add chart query")).toMatchObject({ group: "Data and scope", current: "Not set" });
});
