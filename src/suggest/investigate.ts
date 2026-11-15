import { tileSchema } from "../compiler/schema.ts";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { validateTile } from "../compiler/compile.ts";
import { dimensionsOf, fieldReachable, isNumeric, isTemporal, metricOf, metricType, metricComponents, timeColumnOf, type Model } from "../semantic/model.ts";
import { visibleQuery } from "../app/query.ts";
import type { DrillEntry } from "../app/drill.ts";
import { requiredDimensions } from "./prepareTile.ts";

export type InvestigationResult = { columns: string[]; rows: unknown[][] };
export type InvestigationOption = { id: string; label: string; reason: string; tile: TileSpec };

/** Freeze the displayed time window as well as the filters. Changing a GROUP BY
 * must not turn a limited latest window into a different reporting period. */
export function investigationContext(model: Model, source: TileSpec, filters: FilterSpec[], drill: DrillEntry[], result: InvestigationResult) {
  const needsHistory = source.metrics.some(name => {
    const metric = metricOf(model, name);
    return metric && (metricType(metric) === "cumulative" || [metric, ...metricComponents(model, metric)].some(m => /\bOVER\s*\(/i.test(m.expression)));
  });
  if (needsHistory) throw new Error("This metric depends on earlier periods. A new reporting window could reset its calculation. Inspect or export the original chart’s values instead.");
  const query = visibleQuery(model, source, filters, drill);
  const time = query.dimensions.find(d => d.includes(":"));
  const where = structuredClone(query.where);
  let period = "No time period on the original chart";
  if (time) {
    const [grain, field] = time.split(":");
    const alias = `${field.split(".").at(-1)}_${grain}`;
    const index = result.columns.indexOf(alias);
    const dates = result.rows.map(r => String(r[index] ?? "").slice(0, 10)).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))).sort();
    if (!dates.length) throw new Error("The chart has no readable reporting dates. Refresh it before investigating.");
    const end = new Date(`${dates.at(-1)}T00:00:00Z`);
    if (grain === "day" || grain === "week") end.setUTCDate(end.getUTCDate() + (grain === "day" ? 1 : 7));
    else if (grain === "month" || grain === "quarter") end.setUTCMonth(end.getUTCMonth() + (grain === "month" ? 1 : 3));
    else if (grain === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
    else throw new Error("This reporting period is not supported for investigation.");
    where.push({ id: "investigation:window", field, source: "dimension", mode: "range", min: dates[0], max: end.toISOString().slice(0, 10), maxExclusive: true });
    period = `${grain} reporting · ${dates[0]} through ${dates.at(-1)} (period starts)`;
  }
  return { query, where, period };
}

export function investigationOptions(model: Model, source: TileSpec, context: ReturnType<typeof investigationContext>): InvestigationOption[] {
  const title = source.title ?? source.metrics.map(n => metricOf(model, n)?.label ?? n).join(", ");
  const base = metricOf(model, source.metrics[0])?.baseTable;
  const options: InvestigationOption[] = [];
  const make = (id: string, label: string, reason: string, patch: Partial<TileSpec>) => {
    const tile: TileSpec = { id: `investigation:${id}`, metrics: [...source.metrics], dimensions: [...context.query.dimensions],
      where: structuredClone(context.where), compare: context.query.compare, compareShow: "value", chart: "table",
      title: `${title} — ${label}`.slice(0, 1000), layout: { x: 0, y: 0, w: 850, h: 430 }, ...patch };
    try { tile.dimensions = requiredDimensions(model, tile.metrics, tile.dimensions); } catch { return; }
    if (tileSchema.safeParse(tile).success && !validateTile(model, tile).length) options.push({ id, label, reason, tile });
  };
  const times = context.query.dimensions.filter(d => d.includes(":"));
  const time = times[0] ?? (base && timeColumnOf(model, base) ? `month:${timeColumnOf(model, base)}` : null);
  if (time) {
    make("trend", "Follow the trend", "See how the same metric changes within this scope. Existing breakdowns stay visible in a table.", {
      dimensions: times.length ? context.query.dimensions : [...context.query.dimensions, time],
      chart: context.query.dimensions.some(d => !d.includes(":")) || times.length > 1 ? "table" : "line",
    });
    make("compare", "Compare with the previous period", "Match each period to its calendar predecessor. Missing comparisons stay empty.", {
      dimensions: times.length ? context.query.dimensions : [...context.query.dimensions, time], compare: "prior", chart: "table",
    });
  }
  make("values", "Inspect the values", "See the aggregated values behind the chart; these are not individual customer records.", {});
  if (base) for (const table of Object.values(model.tables)) for (const column of dimensionsOf(table)) {
    const field = `${table.name}.${column.name}`;
    if (isNumeric(column) || isTemporal(column) || !fieldReachable(model, base, field)) continue;
    if (context.query.dimensions.some(d => d === field || `${base}.${d}` === field)) continue;
    const label = column.name.replace(/_/g, " ");
    make(`by:${field}`, `Break down by ${label}`, "Keep the reporting period and filters while comparing groups. A table keeps rates and periods separate.", {
      dimensions: [...context.query.dimensions, field], chart: "table",
    });
  }
  return options;
}

export function describeFilter(filter: FilterSpec): string {
  return `${filter.field} ${filter.exclude ? "excluding " : ""}${filter.mode === "discrete" ? (filter.values ?? []).map(v => v === null ? "missing" : String(v)).join(", ") : `${filter.min ?? "any start"} to ${filter.max ?? "any end"}${filter.maxExclusive ? " (end excluded)" : ""}`}`;
}
