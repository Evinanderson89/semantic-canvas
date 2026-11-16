import { componentValue } from "./values.ts";

/** Heatmap colors describe returned values, not missing combinations or
 * business thresholds. Never combine duplicate cells: measures can be rates,
 * snapshots or distinct counts whose aggregation is defined by the model. */
export function prepareHeatmap(data: Record<string, unknown>[], dimensions: string[], measures: string[]) {
  const key = (v: unknown) => v instanceof Date ? `date:${+v}` : JSON.stringify([typeof v, v]);
  const xValues = new Map<string, unknown>(), yValues = new Map<string, unknown>();
  const normalized = dimensions.length === 1 && measures.length > 1;
  const seen = new Set<string>();
  const cells = data.flatMap(row => {
    const x = key(row[dimensions[0]]);
    xValues.set(x, row[dimensions[0]]);
    return (dimensions.length > 1 ? [measures[0]] : measures).map(metric => {
      const y = dimensions.length > 1 ? key(row[dimensions[1]]) : metric;
      yValues.set(y, dimensions.length > 1 ? row[dimensions[1]] : metric);
      const pair = JSON.stringify([x, y]);
      if (seen.has(pair)) throw new Error("More than one value exists for the same heatmap cell. Use a table to inspect the query grouping; values cannot be safely summed or overwritten.");
      seen.add(pair);
      let raw: number | null = null;
      try { raw = componentValue(row[metric]); } catch { /* retain missing/invalid as unknown */ }
      return { x, y, metric, raw, value: raw, invalid: row[metric] != null && raw === null };
    });
  });
  const constant = new Set<string>();
  if (normalized) for (const metric of measures) {
    const values = cells.filter(c => c.metric === metric && c.raw !== null).map(c => c.raw!);
    if (!values.length) continue;
    const lo = Math.min(...values), hi = Math.max(...values);
    const scale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    if (lo === hi) constant.add(metric);
    for (const cell of cells) if (cell.metric === metric && cell.raw !== null)
      cell.value = lo === hi ? .5 : (cell.raw / scale - lo / scale) / (hi / scale - lo / scale);
  }
  const missing = cells.filter(c => c.raw === null).length;
  const absent = xValues.size * yValues.size - cells.length;
  const values = cells.flatMap(c => c.raw === null ? [] : [c.raw]);
  const low = Math.min(...values), high = Math.max(...values);
  const extent = Math.max(Math.abs(low), Math.abs(high));
  const divergingDomain = !normalized && low < 0 && high > 0 ? [-extent, extent] : undefined;
  const caption = [
    normalized ? "Colors are scaled separately within each metric’s returned range. Compare patterns within a row, not amounts between rows."
      : divergingDomain ? "One shared scale: red is negative, blue is positive, and the neutral color marks zero. Colors show sign, not business performance."
      : "Colors show the metric’s returned values on one shared scale.",
    constant.size ? "Constant rows use the middle color." : "",
    missing ? `${missing} gray cell${missing === 1 ? " has" : "s have"} no numeric value, not zero.` : "",
    absent ? `${absent} blank position${absent === 1 ? " has" : "s have"} no returned row.` : "",
  ].filter(Boolean).join(" ");
  return { cells, xValues, yValues, normalized, divergingDomain, caption };
}
