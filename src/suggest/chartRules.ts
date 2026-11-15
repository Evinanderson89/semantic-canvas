import type { ChartKind, TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import type { Model } from "../semantic/model.ts";
import { isNumeric, isTemporal, metricOf } from "../semantic/model.ts";
import { chartShapeIssue, type ChartShape } from "../charts/capabilities.ts";

export function tileChartShape(model: Model, tile: TileSpec): ChartShape {
  return { measures: tile.metrics.length, dimensions: (tile.dimensions ?? []).map(d => {
    const p = parseDimension(d);
    const owner = p.table ?? metricOf(model, tile.metrics[0])?.baseTable;
    const column = model.tables[owner]?.columns.find(c => c.name === p.column);
    return { temporal: !!p.grain || !!column && isTemporal(column), numeric: !!column && isNumeric(column) };
  }) };
}

/** KPI/stat documents share one card family. Time determines whether that
 * card has a sparkline; use this for rendering, controls and active choices
 * without rewriting the saved visualization or its reporting scope. */
export function resolvedChartKind(model: Model, tile: TileSpec): ChartKind {
  const requested = inferChart(model, tile);
  if (requested !== "kpi" && requested !== "stat") return requested;
  return tileChartShape(model, tile).dimensions.some(d => d.temporal) ? "kpi" : "stat";
}

/**
 * Choose a supported default from the selected fields. Explicit user choices
 * are retained and checked by the renderer rather than silently replaced.
 */
export function inferChart(model: Model, tile: TileSpec): ChartKind {
  if (tile.chart) return tile.chart;
  const dims = tile.dimensions ?? [];
  const nMetrics = tile.metrics.length;

  if (dims.length === 0) return nMetrics === 1 ? "stat" : "table";

  const parsed = tileChartShape(model, tile).dimensions;

  if (dims.length === 1) {
    const d = parsed[0];
    if (d.temporal) return nMetrics > 1 ? "line" : "area";
    return nMetrics > 1 ? "barStacked" : "bar";
  }
  if (dims.length === 2) {
    const kind = parsed.filter(d => d.temporal).length === 1 ? "line" : "heatmap";
    return chartShapeIssue(kind, { dimensions: parsed, measures: nMetrics }) ? "table" : kind;
  }
  return "table";
}
