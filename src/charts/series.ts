import { nextPeriod } from "../semantic/calendar.ts";
import type { TimeGrain } from "../semantic/model.ts";

/** Rendering-only discontinuities: one null marker per missing interval,
 * never an imputed value or a dense date spine. The grain comes from the
 * query contract, not from observed spacing or a date-like column name. */
export function breakTemporalGaps(data: Record<string, unknown>[], time: string, measures: string[], grain?: TimeGrain, breakdowns: string[] = []) {
  if (!grain || !data.length || data.some(row => !(row[time] instanceof Date) || !Number.isFinite(+(row[time] as Date)))) return data;
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of data) {
    const key = JSON.stringify(breakdowns.map(d => [typeof row[d], row[d]]));
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const markers: Record<string, unknown>[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a,b) => +(a[time] as Date) - +(b[time] as Date));
    for (let i = 1; i < ordered.length; i++) {
      const before = ordered[i-1], next = nextPeriod(before[time] as Date, grain);
      if (+next < +(ordered[i][time] as Date)) markers.push({ ...before, [time]: next,
        ...Object.fromEntries(measures.map(m => [m, null])) });
    }
  }
  return markers.length ? [...data, ...markers].sort((a,b) => +(a[time] as Date) - +(b[time] as Date)) : data;
}

export interface SeriesPoint { x: unknown; series: string; value: unknown }

/** Preserve category identity (including null vs the string 'null') and every
 * observed bucket. Missing category/bucket pairs stay unknown, never zero.
 * A duplicate pair is ambiguous: a renderer must not choose its aggregation. */
export function categorySeries(data: Record<string, unknown>[], x: string, category: string, measure: string, completeGrid = false) {
  const labels = new Map<string, string>();
  const sourceValues = new Map<string, unknown>();
  const buckets = new Map<string, unknown>();
  const bySeries = new Map<string, Map<string, unknown>>();
  const key = (v: unknown) => v instanceof Date ? `date:${+v}` : JSON.stringify([typeof v, v]);
  const points: SeriesPoint[] = [];
  for (const row of data) {
    const series = key(row[category]), bucket = key(row[x]);
    labels.set(series, row[category] == null ? "Missing category" : String(row[category]));
    sourceValues.set(series, row[category]);
    buckets.set(bucket, row[x]);
    let values = bySeries.get(series);
    if (!values) { values = new Map(); bySeries.set(series, values); }
    if (values.has(bucket)) throw new Error("More than one value exists for the same breakdown combination. Use a table to inspect the duplicate rows.");
    values.set(bucket, row[measure]);
    points.push({ x: row[x], series, value: row[measure] });
  }
  if (!completeGrid) return { points, labels, sourceValues };
  const ordered = [...buckets].sort((a, b) => a[1] instanceof Date && b[1] instanceof Date ? +a[1] - +b[1] : 0);
  return { labels, sourceValues, points: [...bySeries].flatMap(([series, values]) =>
    ordered.map(([bucket, x]) => ({ x, series, value: values.get(bucket) ?? null }))) };
}

/** Grid coordinates are presentation only; retain the source value used by a filter. */
export function categoryPanels(series: ReturnType<typeof categorySeries>) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(series.labels.size)));
  const names = new Map<string, number>();
  for (const label of series.labels.values()) names.set(label || "Empty text", (names.get(label || "Empty text") ?? 0) + 1);
  return [...series.labels].map(([key, rawLabel], index) => {
    const value = series.sourceValues.get(key), name = rawLabel || "Empty text";
    const type = value === null ? "null" : typeof value === "string" ? "text" : typeof value;
    return { key, value, label: names.get(name)! > 1 ? `${typeof value === "string" ? JSON.stringify(value) : name} (${type})` : name,
      col: index % columns, row: Math.floor(index / columns) };
  });
}
