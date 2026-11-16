import type { Model, TimeGrain } from "../semantic/model.ts";
import { metricUnit } from "../format/format.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { tileChartShape } from "../suggest/chartRules.ts";

export const dimensionAlias = (dimension: string) => {
  const { column, grain } = parseDimension(dimension);
  return `${column}${grain ? `_${grain}` : ""}`;
};

/** Plot only the requested series. Comparison columns are projected back onto
 * their governed metric names; numeric dimensions never become measures. */
export function chartResult(spec: TileSpec, state: { columns: string[]; rows: unknown[][] }, dimensions = spec.dimensions, model?: Model) {
  const suffix = spec.compare && spec.compare !== "none"
    ? spec.compareShow === "delta" ? "__delta" : spec.compareShow === "percent" ? "__pct" : "" : "";
  const dims = dimensions.map(dimensionAlias);
  const indexes = [...dims, ...spec.metrics.map(m => `${m}${suffix}`)].map(c => state.columns.indexOf(c));
  if (indexes.some(i => i < 0)) throw new Error("The query is missing a requested chart or comparison column. Refresh the chart.");
  const temporalColumns = model ? tileChartShape(model, { ...spec, dimensions }).dimensions
    .flatMap((d, i) => d.temporal ? [dims[i]] : []) : undefined;
  const timeGrains = Object.fromEntries(dimensions.flatMap((d,i) => {
    const {grain} = parseDimension(d);
    return grain && ["day","week","month","quarter","year"].includes(grain) ? [[dims[i],grain as TimeGrain]] : [];
  }));
  return { columns: [...dims, ...spec.metrics], rows: state.rows.map(row => indexes.map(i => row[i])), measureColumns: spec.metrics,
    timeGrains, ...(temporalColumns ? { temporalColumns } : {}) };
}

/** Different units require explicitly separate axes, regardless of magnitude. */
export function chartUnits(spec: TileSpec, model: Model) {
  const units = new Set(spec.metrics.map(m => metricUnit(model, m)));
  const percent = spec.compare && spec.compare !== "none" && spec.compareShow === "percent";
  const mixed = units.size > 1 && !percent;
  const separateAxes = mixed && spec.metrics.length === 2 && ["line", "combo"].includes(spec.chart ?? "");
  const independent = ["table", "heatmap", "scatter"].includes(spec.chart ?? "");
  return { separateAxes, issue: mixed && !separateAxes && !independent
    ? "These measures use different units. Use separate charts, a two-measure line or combo, or a table." : undefined };
}
