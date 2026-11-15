import { z } from "zod";
import { dashboardSchema, tileSchema, canvasSchema } from "../compiler/schema.ts";
import { validateDashboard } from "../app/filters.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import { fieldReachable, metricOf } from "../semantic/model.ts";
import { tabOf, tabsOf } from "../app/tabs.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasSpec } from "./presets.ts";
import { applyLayout, LAYOUT_NAMES, pinnedContent, sectionsOf } from "./layouts.ts";

import { prepareNewTile } from "../suggest/prepareTile.ts";
import { resolvedChartKind, tileChartShape } from "../suggest/chartRules.ts";
import { chartShapeIssue } from "../charts/capabilities.ts";
import { chartUnits } from "../app/chartResult.ts";

const text = z.string().min(1).max(1000);
export const proposalSchema = z.object({
  title: text, reason: text,
  actions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("rename"), title: text }).strict(),
    z.object({ type: z.literal("describe"), description: dashboardSchema.shape.description.unwrap() }).strict().describe("Replace the dashboard-wide description explicitly; an empty string clears it. Keep references to other tabs intact. This does not edit any tile's authored commentary."),
    z.object({ type: z.literal("title"), id: text, title: text }).strict().describe("Rename an existing tile, including a metric chart. This does not add commentary."),
    z.object({ type: z.literal("note"), id: text.describe("ID of an existing text or heading tile, or one added earlier in this proposal. Never a metric/chart tile ID."), text: z.string().max(100000) }).strict().describe("Replace a text/heading tile's content. To add commentary about a chart, use add with a separate kind:text tile instead."),
    z.object({ type: z.literal("chart"), id: text, chart: tileSchema.shape.chart.unwrap() }).strict(),
    z.object({ type: z.literal("query"), id: text, metrics: z.array(z.string().min(1).max(256)).min(1).max(50).optional(), dimensions: z.array(z.string().min(1).max(256)).max(12).optional(), compare: z.enum(["none", "prior", "yoy"]).optional() }).strict(),
    z.object({ type: z.literal("place"), id: text, layout: tileSchema.shape.layout, section: text.nullable().optional() }).strict(),
    z.object({ type: z.literal("arrange"), layout: z.enum(LAYOUT_NAMES) }).strict(),
    z.object({ type: z.literal("add"), tile: tileSchema }).strict().describe("Add a new tile with a unique ID. Narrative tiles must explicitly set kind:text or kind:heading, text, empty metrics/dimensions, and layout. Omitting kind means a metric chart."),
    z.object({ type: z.literal("remove"), id: text }).strict(),
  ])).min(1).max(30),
}).strict();
export type CanvasProposal = z.infer<typeof proposalSchema>;

/** All proposed edits validate before anything reaches the live document. */
export function applyProposal(spec: DashboardSpec, canvas: CanvasSpec, raw: unknown, model: Model, activeTabId?: string) {
  const proposal = proposalSchema.parse(raw);
  if (activeTabId && (!tabsOf(spec).some(t => t.id === activeTabId) || spec.tiles.some(t => tabOf(spec, t) !== activeTabId)))
    throw new Error("The proposal must target the current editable tab");
  let next = structuredClone(spec);
  for (const action of proposal.actions) {
    if (action.type === "rename") { next.title = action.title; continue; }
    if (action.type === "describe") { next.description = action.description; continue; }
    if (action.type === "arrange") { next.tiles = applyLayout(action.layout, next.tiles, canvas.width, true, model); continue; }
    if (action.type === "add") {
      if (action.tile.kind === "filter") throw new Error("Add connected filters with the filter designer");
      if (next.tiles.some(t => t.id === action.tile.id)) throw new Error("A proposed tile ID already exists");
      if (activeTabId && action.tile.tabId && action.tile.tabId !== activeTabId)
        throw new Error("Add new content to the current tab");
      next.tiles.push(prepareNewTile(model, { ...action.tile, ...(activeTabId ? { tabId: activeTabId } : {}) })); continue;
    }
    const tile = next.tiles.find(t => t.id === action.id);
    if (!tile) throw new Error(`The proposed tile ${action.id} no longer exists`);
    if (action.type === "title") tile.title = action.title;
    if (action.type === "place") {
      tile.layout = action.layout;
      if (action.section === null) tile.section = null;
      else if (action.section !== undefined) tile.section = action.section;
    }
    if (action.type === "query") {
      if (tile.kind && tile.kind !== "metric") throw new Error("Query changes require a metric tile");
      if (action.metrics !== undefined) tile.metrics = action.metrics;
      if (action.dimensions !== undefined) tile.dimensions = action.dimensions;
      if (action.compare !== undefined) tile.compare = action.compare;
    }
    if (action.type === "note") {
      if (tile.kind !== "text" && tile.kind !== "heading") throw new Error(`Text changes require a note or heading. Tile ${tile.id} has kind ${tile.kind ?? "metric"}. Use title to rename it, or add a separate tile with kind text or heading for commentary; do not use note on a chart.`);
      tile.text = action.text;
    }
    if (action.type === "chart") {
      if (tile.kind && tile.kind !== "metric") throw new Error("Chart changes require a metric tile");
      tile.chart = action.chart;
    }
    if (action.type === "remove") {
      if (tile.kind === "filter") throw new Error("Remove connected filters with the filter designer");
      if (tile.pinned || next.tiles.some(t => t.section === tile.id)) throw new Error("Unpin a tile or move its section's content before removing it");
      next.tiles = next.tiles.filter(t => t.id !== tile.id);
    }
  }
  next = dashboardSchema.parse(next);
  next.filters = next.filters?.map(f => ({ ...f, bindings: [
    ...f.bindings.filter(b => { const t = next.tiles.find(t => t.id === b.tileId); return !!t && fieldReachable(model, metricOf(model, t.metrics[0])?.baseTable ?? "", b.field); }),
    ...next.tiles.filter(t => !spec.tiles.some(before => before.id === t.id) && (t.kind ?? "metric") === "metric"
      && !f.bindings.some(b => b.tileId === t.id)
      && (f.scope === "report" || f.tabId === tabOf(next, t)) && fieldReachable(model, metricOf(model, t.metrics[0])?.baseTable ?? "", f.field))
      .map(t => ({ tileId: t.id, field: f.field })),
  ] }));
  const issues = validateDashboard(model, next);
  if (issues.length) throw new Error(issues.map(i => {
    let correction = i.problem === "period comparison requires a time dimension"
      ? ' Use a governed time dimension (grain:date_field) for a period KPI, or compare:"none" for an aggregate. Do not invent a date field or silently change the reporting scope.' : "";
    if (i.problem.startsWith("metrics span ")) {
      const selected = next.tiles.find(tile => tile.id === i.tile)?.metrics ?? [];
      const groups = Object.fromEntries([...new Set(selected.map(name => metricOf(model, name)?.baseTable).filter(Boolean))]
        .map(table => [table, selected.filter(name => metricOf(model, name)?.baseTable === table)]));
      correction = ` Split this tile into separate charts by base table, preserving the intended metrics. Shared dates do not permit combining base tables. Selected metric groups: ${JSON.stringify(groups)}.`;
    }
    return `Tile ${i.tile}: ${i.problem}.${correction}`;
  }).join("; "));
  // Validate the final combination, not intermediate action order. Leave an
  // unchanged broken chart available for layout recovery; new/changed chart
  // encodings must satisfy the same structural and unit checks as rendering.
  const encoding = (tile: DashboardSpec["tiles"][number]) => JSON.stringify([
    tile.metrics, tile.dimensions, tile.chart, tile.compare ?? "none", tile.compareShow ?? "value",
  ]);
  for (const tile of next.tiles) {
    if ((tile.kind ?? "metric") !== "metric") continue;
    const before = spec.tiles.find(t => t.id === tile.id);
    if (before && encoding(before) === encoding(tile)) continue;
    const kind = resolvedChartKind(model, tile);
    const shapeIssue = chartShapeIssue(kind, tileChartShape(model, tile));
    const issue = shapeIssue && ["kpi", "stat"].includes(kind)
      ? "A headline KPI needs one metric with no categorical breakdown."
      : shapeIssue ?? chartUnits({ ...tile, chart: kind }, model).issue;
    if (issue) throw new Error(`${tile.title || tile.id} (${kind}): ${issue}`);
  }
  const membership = (tiles: DashboardSpec["tiles"]) => new Map(sectionsOf(tiles).flatMap(group =>
    group.map(t => [t.id, group[0].kind === "heading" ? group[0].id : null] as const)));
  const beforeSections = membership(spec.tiles), afterSections = membership(next.tiles);
  for (const tile of pinnedContent(spec.tiles)) {
    const after = next.tiles.find(t => t.id === tile.id);
    if (!after || afterSections.get(tile.id) !== beforeSections.get(tile.id) || JSON.stringify(after.layout) !== JSON.stringify(tile.layout)) throw new Error("A proposal cannot move or remove pinned content or its section");
  }
  const nextCanvas = canvasSchema.parse({ ...canvas, height: Math.max(canvas.height, ...next.tiles.map(t => t.layout.y + t.layout.h + 24)) });
  if (JSON.stringify(next) === JSON.stringify(dashboardSchema.parse(spec)) && JSON.stringify(nextCanvas) === JSON.stringify(canvasSchema.parse(canvas))) {
    throw new Error("This proposal does not change the current canvas. Suggest a different improvement.");
  }
  return { spec: next, canvas: nextCanvas };
}
