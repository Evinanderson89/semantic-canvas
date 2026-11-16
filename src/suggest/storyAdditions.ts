import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension, validateTile } from "../compiler/compile.ts";
import { metricOf, metricType, periodRollupAllowed, timeColumnOf, type Model } from "../semantic/model.ts";
import { prepareNewTile } from "./prepareTile.ts";
import { inferChart } from "./chartRules.ts";

export interface StoryAddition { metrics: string[]; title: string; breakdown: "time" | "none" }
export type StoryTile = { kind?: string; chart?: string; metrics: string[]; dimensions: string[]; where?: TileSpec["where"]; compare?: TileSpec["compare"] };

/** Build the effective chart once, before offering it or comparing duplicates. */
export function prepareStoryAddition(model: Model, addition: StoryAddition): TileSpec {
  if (!addition.metrics.length || addition.metrics.some(name => !metricOf(model, name))) throw new Error("Choose metrics from the current governed catalog.");
  let tile = prepareNewTile(model, { id: "story-addition", title: addition.title, kind: "metric", section: null,
    metrics: [...new Set(addition.metrics)], dimensions: [],
    chart: addition.breakdown === "none" ? new Set(addition.metrics).size === 1 ? "stat" : "table" : "line",
    layout: { x: 24, y: 24, w: 480, h: 300 } });
  if (!tile.dimensions.length && (addition.breakdown === "time" || tile.metrics.some(name => metricType(metricOf(model, name)) === "cumulative"))) {
    const metric = metricOf(model, tile.metrics[0]);
    const time = metric?.timeDimension ?? timeColumnOf(model, metric?.baseTable ?? null);
    if (!time) throw new Error("This metric has no declared date for a trend. Choose a headline or define its reporting date.");
    const period = model.tables[metric.baseTable]?.period;
    const grain = period && time === `${metric.baseTable}.${period.column}` && !periodRollupAllowed(period.grain, "month") ? period.grain : "month";
    tile = prepareNewTile(model, { ...tile, dimensions: [`${grain}:${time}`] });
  }
  if (addition.breakdown === "none" && tile.metrics.length === 1 && tile.dimensions.length) tile.chart = "kpi";
  tile.layout.h = tile.chart === "stat" || tile.chart === "kpi" ? 156 : 300;
  const issues = validateTile(model, tile);
  if (issues.length) throw new Error(issues.map(i => i.problem).join("; "));
  return tile;
}

export function equivalentStoryTile(model: Model, tiles: StoryTile[], addition: StoryAddition): boolean {
  const candidate = prepareStoryAddition(model, addition);
  const metrics = [...candidate.metrics].sort().join(",");
  const dimensions = (tile: StoryTile) => tile.dimensions.map(d => {
    const p = parseDimension(d);
    return `${p.grain ?? ""}:${p.table ?? metricOf(model, tile.metrics[0])?.baseTable}.${p.column}`;
  }).sort().join(",");
  const headline = (chart: string) => chart === "kpi" || chart === "stat";
  return tiles.some(tile => {
    if (["text", "heading", "divider", "image", "filter"].includes(tile.kind ?? "metric") || tile.where?.length || tile.compare && tile.compare !== "none") return false;
    const chart = tile.chart ?? (tile.kind && tile.kind !== "metric" ? tile.kind : inferChart(model, { ...candidate, ...tile, kind: "metric", chart: undefined }));
    return [...new Set(tile.metrics)].sort().join(",") === metrics && dimensions(tile) === dimensions(candidate)
      && headline(chart) === headline(candidate.chart!);
  });
}
