import { z } from "zod";
import { dashboardSchema } from "../compiler/schema.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import { fieldReachable, timeColumnOf, type Model } from "../semantic/model.ts";
import { validateTile } from "../compiler/compile.ts";
import { fieldKind, suggestedBindings, validateDashboard } from "../app/filters.ts";

const label = z.string().max(500);
export const referenceItemSchema = z.object({
  id: z.string().min(1).max(100), kind: z.enum(["metric", "heading", "text", "filter"]), label,
  metrics: z.array(label).max(6), dimensions: z.array(label).max(6),
  grain: z.enum(["none", "day", "week", "month", "quarter", "year"]),
  chart: z.enum(["kpi", "line", "area", "bar", "barH", "donut", "table", "scatter"]),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1),
}).strict();
export const blueprintSchema = z.object({ title: z.string().min(1).max(300), pages: z.array(z.object({
  title: z.string().min(1).max(100), aspectRatio: z.number().min(0.15).max(6), items: z.array(referenceItemSchema).max(60),
}).strict()).min(1).max(6) }).strict().refine(b => {
  const ids = b.pages.flatMap(p => p.items.map(i => i.id)); return new Set(ids).size === ids.length;
}, "Reference item IDs must be unique");
export type Blueprint = z.infer<typeof blueprintSchema>;
export type ReferenceItem = z.infer<typeof referenceItemSchema>;
export type ReferenceMapping = Record<string, string>;
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function metricMatches(model: Model, text: string): string[] {
  if (model.metrics[text]) return [text];
  return Object.values(model.metrics).filter(m => [m.name, m.label, ...m.synonyms].some(s => normalize(s) === normalize(text))).map(m => m.name);
}
export function fieldMatches(model: Model, text: string): string[] {
  const fields = Object.values(model.tables).flatMap(t => t.columns.map(c => `${t.name}.${c.name}`));
  if (fields.includes(text)) return [text];
  return fields.filter(f => normalize(f) === normalize(text) || normalize(f.split(".")[1]) === normalize(text));
}
export function initialMapping(blueprint: Blueprint, model: Model): ReferenceMapping {
  const mapping: ReferenceMapping = {};
  for (const item of blueprint.pages.flatMap(p => p.items)) {
    item.metrics.forEach((m, i) => { const matches = metricMatches(model, m); mapping[`${item.id}:m${i}`] = matches.length === 1 ? matches[0] : ""; });
    item.dimensions.forEach((d, i) => { const matches = fieldMatches(model, d); mapping[`${item.id}:d${i}`] = matches.length === 1 ? matches[0] : ""; });
  }
  return mapping;
}
/** Every rendered chart compiles against the catalogue. Unresolved content stays visibly unresolved. */
export function buildReference(blueprint: Blueprint, mapping: ReferenceMapping, model: Model, width = 1200) {
  const notes: { id: string; status: "ready" | "adjusted" | "unresolved"; message: string }[] = [];
  const spec: DashboardSpec = { title: blueprint.title, tabs: blueprint.pages.map((p, i) => ({ id: `reference-page-${i + 1}`, title: p.title })), tiles: [], filters: [] };
  for (const [pageIndex, page] of blueprint.pages.entries()) {
    const tabId = spec.tabs![pageIndex].id, height = width / page.aspectRatio;
    for (const item of page.items) {
      const layout = { x: Math.round(item.x * (width - 48)) + 24, y: Math.round(item.y * height) + 24,
        w: Math.max(100, Math.min(Math.round(item.w * (width - 48)), Math.round((1 - item.x) * (width - 48)))), h: Math.max(item.kind === "heading" ? 48 : 100, Math.round(item.h * height)) };
      layout.x = Math.min(layout.x, width - layout.w - 24);
      const base: TileSpec = { id: `reference-${item.id}`, tabId, title: item.label, metrics: [], dimensions: [], layout };
      if (item.kind === "heading" || item.kind === "text") {
        spec.tiles.push({ ...base, kind: item.kind, text: item.label, format: { textSize: item.kind === "heading" ? 26 : 14, background: false, border: false } }); continue;
      }
      if (item.kind === "filter") {
        const field = mapping[`${item.id}:d0`], control = fieldKind(model, field ?? "");
        if (control) {
          spec.filters!.push({ id: base.id, label: item.label.slice(0, 100) || "Filter", field, control, scope: "tab", tabId, bindings: [] });
          spec.tiles.push({ ...base, kind: "filter", filterId: base.id, layout: { ...layout, h: Math.max(150, layout.h) } });
          notes.push({ id: item.id, status: "ready", message: "Filter matched. Connections use this field on this tab." }); continue;
        }
      } else {
        const metrics = item.metrics.map((_, i) => mapping[`${item.id}:m${i}`]), fields = item.dimensions.map((_, i) => mapping[`${item.id}:d${i}`]);
        const valid = metrics.length > 0 && metrics.every(m => !!model.metrics[m]) && fields.every(f => !!f && fieldReachable(model, model.metrics[metrics[0]]?.baseTable ?? "", f));
        if (valid) {
          const dimensions = fields.map(f => fieldKind(model, f) === "date" && item.grain !== "none" ? `${item.grain}:${f}` : f);
          const tile: TileSpec = { ...base, metrics, dimensions, chart: item.chart, layout: { ...layout, h: Math.max(item.chart === "kpi" ? 156 : 240, layout.h) } };
          const native = model.metrics[metrics[0]].timeGrains;
          let adjusted = "";
          if (!dimensions.length && native?.length) {
            const time = timeColumnOf(model, model.metrics[metrics[0]].baseTable);
            if (time) { tile.dimensions = [`${native[0]}:${time}`]; adjusted = `Uses the metric’s native ${native[0]} reporting period.`; }
          }
          const issues = validateTile(model, tile);
          if (!issues.length) { spec.tiles.push(tile); notes.push({ id: item.id, status: adjusted ? "adjusted" : "ready", message: adjusted || "Matched to the semantic catalogue." }); continue; }
          notes.push({ id: item.id, status: "unresolved", message: issues[0].problem });
        }
      }
      if (!notes.some(n => n.id === item.id)) notes.push({ id: item.id, status: "unresolved", message: "Choose catalogue matches, or keep this space as a placeholder." });
      spec.tiles.push({ ...base, kind: "text", text: `Needs a catalogue match\n${item.label}`, format: { textSize: 16 } });
    }
  }
  for (const f of spec.filters!) f.bindings = suggestedBindings(spec, model, f.field, f.scope, f.tabId!);
  const parsed = dashboardSchema.parse(spec), issues = validateDashboard(model, parsed);
  if (issues.length) throw new Error(issues[0].problem);
  return { spec: parsed, notes, height: Math.ceil(Math.max(800, ...parsed.tiles.map(t => t.layout.y + t.layout.h + 24))) };
}
