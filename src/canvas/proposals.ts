import { z } from "zod";
import { dashboardSchema, tileSchema, canvasSchema } from "../compiler/schema.ts";
import { validateTile } from "../compiler/compile.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasSpec } from "./presets.ts";
import { applyLayout } from "./layouts.ts";

const text = z.string().min(1).max(1000);
export const proposalSchema = z.object({
  title: text, reason: text,
  actions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("rename"), title: text }).strict(),
    z.object({ type: z.literal("title"), id: text, title: text }).strict(),
    z.object({ type: z.literal("note"), id: text, text: z.string().max(100000) }).strict(),
    z.object({ type: z.literal("chart"), id: text, chart: z.enum(["line", "area", "bar", "barH", "table", "kpi", "stat", "scatter", "smallMultiples"]) }).strict(),
    z.object({ type: z.literal("arrange"), layout: z.enum(["grid", "exec-summary"]) }).strict(),
    z.object({ type: z.literal("add"), tile: tileSchema }).strict(),
    z.object({ type: z.literal("remove"), id: text }).strict(),
  ])).min(1).max(30),
}).strict();
export type CanvasProposal = z.infer<typeof proposalSchema>;

/** All proposed edits validate before anything reaches the live document. */
export function applyProposal(spec: DashboardSpec, canvas: CanvasSpec, raw: unknown, model: Model) {
  const proposal = proposalSchema.parse(raw);
  let next = structuredClone(spec);
  for (const action of proposal.actions) {
    if (action.type === "rename") { next.title = action.title; continue; }
    if (action.type === "arrange") { next.tiles = applyLayout(action.layout, next.tiles, canvas.width); continue; }
    if (action.type === "add") {
      if (action.tile.kind === "filter") throw new Error("Add connected filters with the filter designer");
      if (next.tiles.some(t => t.id === action.tile.id)) throw new Error("A proposed tile ID already exists");
      next.tiles.push(action.tile); continue;
    }
    const tile = next.tiles.find(t => t.id === action.id);
    if (!tile) throw new Error(`The proposed tile ${action.id} no longer exists`);
    if (action.type === "title") tile.title = action.title;
    if (action.type === "note") {
      if (tile.kind !== "text" && tile.kind !== "heading") throw new Error("Text changes require a note or heading");
      tile.text = action.text;
    }
    if (action.type === "chart") {
      if (tile.kind && tile.kind !== "metric") throw new Error("Chart changes require a metric tile");
      if ((action.chart === "kpi" || action.chart === "stat") && (tile.metrics.length !== 1 || tile.dimensions.some(d => !d.includes(":")))) throw new Error("A headline KPI needs one metric with no categorical breakdown");
      tile.chart = action.chart;
    }
    if (action.type === "remove") {
      if (tile.pinned || next.tiles.some(t => t.section === tile.id)) throw new Error("Unpin a tile or move its section's content before removing it");
      next.tiles = next.tiles.filter(t => t.id !== tile.id);
    }
  }
  next = dashboardSchema.parse(next);
  for (const tile of next.tiles) {
    if (tile.section && !next.tiles.some(t => t.id === tile.section && t.kind === "heading")) throw new Error("A proposed section has no heading");
    const issues = validateTile(model, tile);
    if (issues.length) throw new Error(issues.map(i => i.problem).join("; "));
  }
  for (const tile of spec.tiles.filter(t => t.pinned)) {
    const after = next.tiles.find(t => t.id === tile.id);
    if (!after || JSON.stringify(after.layout) !== JSON.stringify(tile.layout)) throw new Error("A proposal cannot move or remove pinned content");
  }
  return { spec: next, canvas: canvasSchema.parse({ ...canvas, height: Math.max(canvas.height, ...next.tiles.map(t => t.layout.y + t.layout.h + 24)) }) };
}
