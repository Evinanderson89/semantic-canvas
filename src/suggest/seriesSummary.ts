import { z } from "zod";
import { parseDimension } from "../compiler/compile.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { dimensionAlias } from "../app/chartResult.ts";
import { numericValue } from "../charts/values.ts";
import { hasPrecisionRisk } from "../charts/precision.ts";
import { isCalendarDate, nextPeriod, periodStart } from "../semantic/calendar.ts";
import { DEFAULT_CALENDAR, type Calendar, type TimeGrain } from "../semantic/model.ts";
import type { QualityResult } from "./resultQuality.ts";

export const seriesSummarySchema = z.object({
  metric: z.string().describe("One of the requested governed metric names"),
  lastPeriods: z.number().int().min(1).max(5000).describe("Calendar periods ending at the latest returned bucket; absent buckets are counted separately"),
  threshold: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
    .describe("Reference in raw metric units, e.g. 1 for 100%. This does not declare a business target."),
});

/** Arithmetic over one authorized result, never a new query, a rollup of rates,
 * or an assertion that absent buckets are zero or missing warehouse data. */
export function summarizeMetricSeries(tile: Pick<TileSpec, "metrics" | "dimensions">, result: QualityResult,
  input: z.infer<typeof seriesSummarySchema>, calendar: Calendar = DEFAULT_CALENDAR) {
  const request = seriesSummarySchema.parse(input);
  const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
  if (!tile.metrics.includes(request.metric)) return unavailable("The summary metric was not selected in this query.");
  if (tile.dimensions.length !== 1) return unavailable("Select exactly one time dimension and no category breakdown for a series summary.");
  const dimension = tile.dimensions[0], grain = parseDimension(dimension).grain;
  if (!grain || !["day", "week", "month", "quarter", "year"].includes(grain)) return unavailable("A supported calendar time grain is required.");
  if (result.truncated) return unavailable("The result is limited; resolve the reporting window before counting periods.");
  if (result.partial?.ratio?.length || result.partial?.selected?.start || result.partial?.selected?.end)
    return unavailable("Partial selected periods or unequal ratio input coverage prevent a comparable series summary.");
  const dateIndex = result.columns.indexOf(dimensionAlias(dimension)), metricIndex = result.columns.indexOf(request.metric);
  if (dateIndex < 0 || metricIndex < 0 || !result.rows.length) return unavailable("The requested dates or metric values are unavailable.");
  const byDate = new Map<string, number | null>();
  for (const row of result.rows) {
    const rawDate = row[dateIndex];
    const label = rawDate instanceof Date && Number.isFinite(+rawDate) ? rawDate.toISOString().slice(0, 10) : rawDate;
    if (!isCalendarDate(label) || byDate.has(label)) return unavailable("Reporting dates are invalid or repeated.");
    const date = new Date(`${label}T00:00:00Z`);
    if (+periodStart(date, grain as TimeGrain, calendar) !== +date) return unavailable("Dates must be reporting-calendar bucket starts.");
    if (hasPrecisionRisk(row[metricIndex])) return unavailable("Metric precision needs review before calculating a summary.");
    byDate.set(label, numericValue(row[metricIndex]));
  }
  const end = [...byDate.keys()].sort().at(-1)!;
  const endDate = new Date(`${end}T00:00:00Z`);
  const dates = Array.from({ length: request.lastPeriods }, (_, i) =>
    nextPeriod(endDate, grain as TimeGrain, i - request.lastPeriods + 1).toISOString().slice(0, 10));
  if (!dates.every(isCalendarDate)) return unavailable("The requested calendar window is outside supported reporting dates.");
  const returned = dates.filter(date => byDate.has(date));
  const values = returned.map(date => byDate.get(date)!).filter((v): v is number => v !== null);
  return {
    status: "computed" as const, metric: request.metric, grain,
    window: { start: dates[0], end }, requestedPeriods: request.lastPeriods,
    returnedPeriods: returned.length, numericPeriods: values.length,
    nullOrNonNumericPeriods: returned.length - values.length,
    unreturnedPeriods: dates.length - returned.length,
    first: byDate.get(dates[0]) ?? null, last: byDate.get(end) ?? null,
    minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null,
    threshold: { value: request.threshold, above: values.filter(v => v > request.threshold).length,
      equal: values.filter(v => v === request.threshold).length, below: values.filter(v => v < request.threshold).length },
    basis: "Computed only from returned values in the stated calendar window. Null and unreturned periods are not zero. The threshold is a requested reference, not a verified target. Counts do not establish a cause or certify source completeness.",
  };
}
