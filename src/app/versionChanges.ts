import type { ChartKind, TileSpec } from "../compiler/spec.ts";
import { documentSnapshot, type DocumentSnapshot } from "./document.ts";

export type VersionChangeGroup = "Data and scope" | "Story and content" | "Layout and appearance";
export type VersionChange = { group: VersionChangeGroup; subject: string; field: string; current: string; saved: string };

// Object insertion order is not a design change; array order can be (metric
// series, narrative order, tabs). Compare authored state only, as Save does.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const display = (value: unknown): string => value === undefined ? "Not set" : typeof value === "string" ? value || "Empty" : JSON.stringify(value, null, 2);
const tileName = (tile: TileSpec) => tile.title || tile.text?.slice(0, 100) || tile.metrics.join(", ") || tile.kind || "Untitled tile";
const chartNames: Record<ChartKind, string> = { line: "Line", area: "Area", areaStacked: "Stacked area", bar: "Bar", barGrouped: "Grouped bar", barStacked: "Stacked bar", barH: "Horizontal bar", barHorizontal: "Horizontal bar", scatter: "Scatterplot", heatmap: "Heatmap", map: "Map", donut: "Donut", waterfall: "Waterfall", funnel: "Funnel", smallMultiples: "Small multiples", combo: "Combination chart", stat: "KPI", kpi: "KPI", table: "Table" };
function fieldDisplay(field: string, value: unknown): string {
  if (field === "Visualization") return value === undefined ? "Automatic chart" : chartNames[value as ChartKind] ?? display(value);
  if ((field === "Metrics" || field === "Dimensions and time grain") && Array.isArray(value)) return value.length ? value.join("\n") : "None";
  if (field === "Position and size" && value) {
    const layout = value as TileSpec["layout"];
    return `${layout.w} × ${layout.h} px\nPosition: ${layout.x}, ${layout.y}${layout.z === undefined ? "" : `\nLayer: ${layout.z}`}`;
  }
  return display(value);
}

const tileFields: Record<Exclude<keyof TileSpec, "id" | "spark">, [VersionChangeGroup, string]> = {
  metrics: ["Data and scope", "Metrics"], dimensions: ["Data and scope", "Dimensions and time grain"],
  where: ["Data and scope", "Chart filters"], limit: ["Data and scope", "Row limit"],
  compare: ["Data and scope", "Comparison period"], compareShow: ["Data and scope", "Comparison display"],
  filterId: ["Data and scope", "Filter control binding"],
  kind: ["Story and content", "Tile type"], title: ["Story and content", "Title"], text: ["Story and content", "Authored text"],
  imageData: ["Story and content", "Image"], evidence: ["Story and content", "Investigation context"],
  tabId: ["Layout and appearance", "Tab"], section: ["Layout and appearance", "Section"], pinned: ["Layout and appearance", "Pinned placement"],
  chart: ["Layout and appearance", "Visualization"], format: ["Layout and appearance", "Formatting"], layout: ["Layout and appearance", "Position and size"],
};

/** Direction is always current work -> selected saved version, i.e. restoration. */
export function versionChanges(current: DocumentSnapshot, saved: DocumentSnapshot): VersionChange[] {
  const before = documentSnapshot(current.spec, current.canvas), after = documentSnapshot(saved.spec, saved.canvas);
  const changes: VersionChange[] = [];
  const add = (group: VersionChangeGroup, subject: string, field: string, a: unknown, b: unknown) => {
    if (!equal(a, b)) changes.push({ group, subject, field, current: fieldDisplay(field, a), saved: fieldDisplay(field, b) });
  };
  add("Story and content", "Dashboard", "Title", before.spec.title, after.spec.title);
  add("Story and content", "Dashboard", "Description", before.spec.description, after.spec.description);
  add("Story and content", "Dashboard", "Tabs and presentation briefs", before.spec.tabs, after.spec.tabs);
  add("Data and scope", "Dashboard", "Shared filters and default selections", before.spec.filters, after.spec.filters);
  add("Layout and appearance", "Dashboard", "Canvas settings", before.canvas, after.canvas);

  const previous = new Map(before.spec.tiles.map(t => [t.id, t]));
  const selected = new Map(after.spec.tiles.map(t => [t.id, t]));
  for (const tile of after.spec.tiles) {
    const old = previous.get(tile.id), subject = tileName(old ?? tile);
    if (!old) {
      add("Story and content", subject, "Add tile", "Absent", "Included in selected version");
      if (tile.metrics.length) add("Data and scope", subject, "Add chart query", undefined, { metrics: tile.metrics, dimensions: tile.dimensions, filters: tile.where ?? [], limit: tile.limit, comparison: tile.compare });
      continue;
    }
    for (const [key, [group, field]] of Object.entries(tileFields) as [keyof typeof tileFields, [VersionChangeGroup, string]][]) {
      if (key === "imageData") {
        // Never print base64 image payloads in a history comparison.
        if (!equal(old.imageData, tile.imageData)) changes.push({ group, subject, field, current: old.imageData ? "Current image" : "No image", saved: tile.imageData ? "Saved image" : "No image" });
      } else add(group, subject, field, old[key], tile[key]);
    }
    add("Data and scope", subject, "KPI comparison baseline", old.spark?.compare, tile.spark?.compare);
    const { compare: _oldCompare, ...oldSpark } = old.spark ?? {};
    const { compare: _newCompare, ...newSpark } = tile.spark ?? {};
    add("Layout and appearance", subject, "Sparkline appearance", oldSpark, newSpark);
  }
  for (const tile of before.spec.tiles) if (!selected.has(tile.id)) {
    add("Story and content", tileName(tile), "Remove tile", "Included in current work", "Absent from selected version");
    if (tile.metrics.length) add("Data and scope", tileName(tile), "Remove chart query", { metrics: tile.metrics, dimensions: tile.dimensions, filters: tile.where ?? [], limit: tile.limit, comparison: tile.compare }, undefined);
  }
  const oldOrder = before.spec.tiles.filter(t => selected.has(t.id)), newOrder = after.spec.tiles.filter(t => previous.has(t.id));
  if (!equal(oldOrder.map(t => t.id), newOrder.map(t => t.id))) add("Layout and appearance", "Dashboard", "Tile reading order", oldOrder.map(t => `${tileName(t)} (${t.id})`), newOrder.map(t => `${tileName(t)} (${t.id})`));
  return changes;
}
