import type { ChartKind, TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import type { Model } from "../semantic/model.ts";

/**
 * Chart type is DERIVED, not chosen by a model. An LLM asked for a chart type
 * will eventually put a pie chart on a time series; a rule never will. The
 * agent's job is picking what to measure -- the form follows from the shape of
 * the answer.
 */
export function inferChart(model: Model, tile: TileSpec): ChartKind {
  if (tile.chart) return tile.chart;
  const dims = tile.dimensions ?? [];
  const nMetrics = tile.metrics.length;

  if (dims.length === 0) return nMetrics === 1 ? "stat" : "table";

  const parsed = dims.map((d) => {
    const p = parseDimension(d);
    const owner = p.table ?? model.metrics[tile.metrics[0]].baseTable;
    const col = model.tables[owner]?.columns.find((c) => c.name === p.column);
    return { ...p, temporal: !!p.grain || /date|timestamp/i.test(col?.type ?? "") };
  });

  if (dims.length === 1) {
    const d = parsed[0];
    if (d.temporal) return nMetrics > 1 ? "line" : "area";
    return nMetrics > 1 ? "barStacked" : "bar";
  }
  if (dims.length === 2) {
    return parsed.some((d) => d.temporal) ? "line" : "heatmap";
  }
  return "table";
}
