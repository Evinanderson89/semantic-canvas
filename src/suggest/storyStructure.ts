import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { validateTile } from "../compiler/compile.ts";
import { dashboardSchema } from "../compiler/schema.ts";
import { applyLayout } from "../canvas/layouts.ts";
import { inferChart } from "./chartRules.ts";

export interface StoryStructure {
  spec: DashboardSpec;
  sections: { title: string; purpose: string; labels: string[] }[];
  renamed: number;
  guide: string;
}

/** Refresh automatic labels when a chart changes while keeping authored titles. */
export function readableChartTitle(model: Model, tile: TileSpec, next = tile): string {
  const measure = tile.metrics.map(m => model.metrics[m]?.label ?? m).join(", ");
  const automatic = (t: TileSpec) => {
    if (["kpi", "stat"].includes(inferChart(model, t))) return measure;
    const categories = t.dimensions.filter(d => !d.includes(":"));
    const by = categories.length ? ` by ${categories.map(d => d.split(".").at(-1)!.replace(/_/g, " ")).join(" and ")}` : "";
    return `${measure}${t.dimensions.some(d => /^(day|week|month|quarter|year):/.test(d)) ? " over time" : ""}${by}`;
  };
  if (tile.title && ![measure, tile.metrics.join(", "), automatic(tile), `${measure} over time`].includes(tile.title)) return tile.title;
  return automatic(next);
}

/** Presentation advice only. Never changes a query or asserts a business result. */
export function suggestStoryStructure(dash: DashboardSpec, model: Model, width: number): StoryStructure | null {
  // Existing editorial structure and fixed positions belong to the author.
  if (dash.tiles.some(t => t.kind === "heading" || t.pinned)) return null;
  const metricTiles = dash.tiles.filter(t => (t.kind ?? "metric") === "metric");
  if (metricTiles.length < 2 || metricTiles.some(t => validateTile(model, t).length)) return null;
  const available = width - 48;
  if (available < 180) return null;
  const ordered = [...metricTiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const metricLabel = (t: TileSpec) => t.metrics.map(m => model.metrics[m].label).join(", ");
  const isKpi = (t: TileSpec) => ["kpi", "stat"].includes(inferChart(model, t));
  const temporal = (t: TileSpec) => t.dimensions.some(d => /^(day|week|month|quarter|year):/.test(d));
  const label = (t: TileSpec) => readableChartTitle(model, t);
  const priority = (t: TileSpec) => Math.max(...t.metrics.map(m => model.metrics[m].importance ?? 0));
  const kpis = ordered.filter(isKpi).sort((a, b) => priority(b) - priority(a));
  const trends = ordered.filter(t => !isKpi(t) && temporal(t)).sort((a, b) => priority(b) - priority(a));
  const detail = ordered.filter(t => !isKpi(t) && !temporal(t));
  const authored = dash.tiles.filter(t => (t.kind ?? "metric") !== "metric" && t.kind !== "filter");
  const groups = [
    { title: "Explore this view", purpose: "Set the context with connected filters.", tiles: dash.tiles.filter(t => t.kind === "filter") },
    { title: "At a glance", purpose: "Start with the headline metrics.", tiles: kpis },
    { title: "How it's changing", purpose: "Give one trend the room to lead.", tiles: trends.slice(0, 1) },
    { title: "Supporting context", purpose: "Read related trends in their own units.", tiles: trends.slice(1) },
    { title: "A closer look", purpose: "Explore the breakdowns behind the overview.", tiles: detail },
    { title: "Notes & context", purpose: "Keep your existing commentary and reference material.", tiles: authored },
  ].filter(g => g.tiles.length);
  const used = new Set(dash.tiles.map(t => t.id));
  let sequence = 0;
  const id = () => { let next: string; do { next = `story-${++sequence}`; } while (used.has(next)); used.add(next); return next; };
  const guide = [kpis.length ? "Start with the headline metrics." : "",
    trends.length ? `Follow ${metricLabel(trends[0])} over time.` : "",
    detail.length ? "Use the breakdowns to explore where the totals come from." : "",
    "Check each chart's reporting period and filters before comparing."].filter(Boolean).join(" ");
  const tiles: TileSpec[] = [];
  let y = 24, renamed = 0;
  groups.forEach((group, groupIndex) => {
    const section = id();
    tiles.push({ id: section, kind: "heading", title: group.title, text: group.title, metrics: [], dimensions: [],
      format: { textSize: 23, background: false, border: false }, layout: { x: 24, y, w: available, h: 48 } });
    y += 60;
    group.tiles.forEach((t, i) => {
      const title = (t.kind ?? "metric") === "metric" ? label(t) : t.title;
      if (title !== t.title) renamed++;
      const focal = t.id === trends[0]?.id;
      tiles.push({ ...t, title, section, layout: { ...t.layout, x: 24, y: y + i * 400,
        w: focal || group.tiles.length === 1 ? available : Math.min(available, Math.max(360, t.layout.w)),
        h: focal ? Math.max(320, t.layout.h) : t.layout.h } });
    });
    y += group.tiles.length * 400;
    if (groupIndex === 0) {
      tiles.push({ id: id(), section, kind: "text", title: "Reading guide", text: guide, metrics: [], dimensions: [],
        format: { textSize: 13, padding: 8, background: false, border: false },
        layout: { x: 24, y, w: available, h: Math.max(64, Math.ceil(guide.length * 7 / (available - 32)) * 21 + 28) } });
      y += 160;
    }
  });
  const spec = { ...dash, title: dash.title.replace(/\s*\(rough draft\)\s*$/i, "").trim() || dash.title,
    tiles: applyLayout("exec-summary", tiles, width) };
  if (!dashboardSchema.safeParse(spec).success) return null;
  return { spec, renamed, guide, sections: groups.map(g => ({ title: g.title, purpose: g.purpose,
    labels: g.tiles.map(t => (t.kind ?? "metric") === "metric" ? label(t) : t.title ?? t.kind ?? "Note") })) };
}
