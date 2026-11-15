import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { metricUnit, preservePercentBoundary } from "../format/format.ts";
import { calendarOf, metricOf, type Model, type TimeGrain } from "../semantic/model.ts";
import { nextPeriod, periodStart } from "../semantic/calendar.ts";
import { dimensionAlias } from "../app/chartResult.ts";
import { investigationContext, investigationOptions } from "./investigate.ts";
import { numericValue as numeric } from "../charts/values.ts";
import { hasPrecisionRisk } from "../charts/precision.ts";
import { cardComparison } from "../charts/cardComparison.ts";
import { resolvedChartKind } from "./chartRules.ts";
import type { PartialEdges } from "../compiler/compile.ts";

export interface QueryObservation {
  metric: string;
  label: string;
  statement: string;
  basis: string;
  latest?: number;
  previous?: number;
  nextQuestion?: string;
  unitNote?: string;
}
type Result = { columns: string[]; rows: unknown[][]; truncated?: boolean; partial?: PartialEdges };
const displayNumber = (n: number, decimals = 2) => new Intl.NumberFormat("en-US",
  n !== 0 && Math.abs(n) < 10 ** -decimals ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: decimals }).format(n);
function displayValue(model: Model, metric: string, n: number) {
  const unit = metricUnit(model, metric);
  return unit === "percent" ? preservePercentBoundary(n, `${displayNumber(n * 100, 1)}%`) : unit === "currency" ? `$${displayNumber(n)}`
    : unit === "ratio" ? `${displayNumber(n)}×` : `${displayNumber(n)}${["days", "months", "seconds"].includes(unit) ? ` ${unit}` : ""}`;
}
function reportingDate(value: unknown): Date | null {
  const text = value instanceof Date ? Number.isFinite(+value) ? value.toISOString().slice(0, 10) : "" : String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === text ? date : null;
}

/** Observations only: never sum snapshots/rates, impute missing values, claim
 * causation, or turn a selected subset into an estimate for the population. */
export function queryObservations(model: Model, tile: TileSpec, result: Result): { observations: QueryObservation[]; note?: string } {
  const { columns, rows } = result;
  const isCard = resolvedChartKind(model, tile) === "kpi";
  const compare = isCard ? cardComparison(tile) : tile.compare;
  const none = (note: string) => ({ observations: [] as QueryObservation[], note });
  if (!rows.length) return none("There are no returned values to summarize.");
  if (result.truncated) return none("The result is limited. Resolve its reporting scope before drafting a summary.");
  if (result.partial?.ratio?.length)
    return none("The ratio inputs have missing, different or partial period coverage. Review both input windows before drafting a conclusion.");
  if (result.partial?.selected?.start || result.partial?.selected?.end)
    return none("The selected window includes partial observed edge periods. Use complete periods or a finer grain before drafting a trend conclusion.");
  if (!isCard && tile.compare && tile.compare !== "none" && ["delta", "percent"].includes(tile.compareShow ?? ""))
    return none("This chart displays comparison changes. Switch it to values before drafting an observation about metric levels.");
  if (tile.dimensions.length > 1) return none("This chart has multiple breakdowns. Investigate a specific group before writing a single-series conclusion.");
  const dimension = tile.dimensions[0], dIndex = dimension ? columns.indexOf(dimensionAlias(dimension)) : -1;
  if (dimension && dIndex < 0) return none("The requested breakdown is missing from the query result.");
  const parsed = dimension ? parseDimension(dimension) : null;
  const grain = parsed?.grain;
  if (grain && !["day", "week", "month", "quarter", "year"].includes(grain)) return none("This reporting grain needs a dedicated comparison before drafting observations.");
  let ordered = rows;
  let latestDate: Date | null = null;
  if (grain) {
    const dates = rows.map(row => reportingDate(row[dIndex]));
    if (dates.some(d => !d) || new Set(dates.map(Number)).size !== dates.length)
      return none("Reporting dates are invalid or repeated. Review the chart's data evidence before summarizing its trend.");
    ordered = rows.map((row, i) => ({ row, date: dates[i]! })).sort((a, b) => +a.date - +b.date).map(p => p.row);
    latestDate = reportingDate(ordered.at(-1)![dIndex]);
  } else if (!dimension && rows.length !== 1) return none("An aggregate without a breakdown returned multiple rows. Inspect the query before summarizing it.");

  const observations: QueryObservation[] = [];
  const precisionLimited: string[] = [];
  for (const name of tile.metrics) {
    const metric = metricOf(model, name), index = columns.indexOf(name);
    if (!metric || index < 0) continue;
    const label = metric.label || name, value = (n: number) => displayValue(model, name, n);
    const priorIndex = compare === "prior" || compare === "yoy" ? columns.indexOf(`${name}__prev`) : -1;
    if (rows.some(row => hasPrecisionRisk(row[index]) || priorIndex >= 0 && hasPrecisionRisk(row[priorIndex]))) {
      precisionLimited.push(label);
      continue;
    }
    if (grain && latestDate) {
      const latestRow = ordered.at(-1)!, latest = numeric(latestRow[index]);
      const dateLabel = latestDate.toISOString().slice(0, 10);
      const basis = `${grain} bucket starting ${dateLabel}`;
      if (latest == null) {
        observations.push({ metric: name, label, statement: `${label} has no numeric value for the ${basis}. An earlier value has not been substituted.`, basis });
        continue;
      }
      let statement = `${label} was ${value(latest)} for the ${basis}.`;
      let previous: number | null = null, previousDate: Date | null = null;
      if (compare === "first") {
        if (ordered.length > 1) {
          previous = numeric(ordered[0][index]);
          previousDate = reportingDate(ordered[0][dIndex]);
        }
      } else if (compare && compare !== "none") {
        const previousIndex = columns.indexOf(`${name}__prev`);
        if (previousIndex >= 0) previous = numeric(latestRow[previousIndex]);
        previousDate = compare === "yoy" ? nextPeriod(latestDate, "year", -1) : nextPeriod(latestDate, grain as TimeGrain, -1);
      } else if (!compare && +periodStart(latestDate, grain as TimeGrain, calendarOf(model)) === +latestDate) {
        previousDate = nextPeriod(latestDate, grain as TimeGrain, -1);
        const previousRow = ordered.find(row => +reportingDate(row[dIndex])! === +previousDate!);
        if (previousRow) previous = numeric(previousRow[index]);
      }
      if (previous != null && previousDate) {
        const delta = latest - previous, comparison = compare === "first" ? `first shown period (${previousDate.toISOString().slice(0, 10)})` : compare === "yoy" ? "same period last year" : "previous calendar period";
        const amount = metricUnit(model, name) === "percent" ? `${displayNumber(Math.abs(delta * 100), 1)} percentage points`
          : previous > 0 && latest >= 0 ? `${displayNumber(Math.abs(delta / previous) * 100, 1)}%` : value(Math.abs(delta));
        statement += delta === 0 ? ` Unchanged from ${value(previous)} in the ${comparison}.`
          : ` ${delta > 0 ? "Up" : "Down"} ${amount} from ${value(previous)} in the ${comparison}.`;
      } else if (compare && compare !== "none") statement += " The requested comparison value is unavailable.";
      observations.push({ metric: name, label, statement, basis, latest, ...(previous != null ? { previous } : {}) });
    } else if (!dimension) {
      const latest = numeric(rows[0][index]);
      if (latest != null) observations.push({ metric: name, label, statement: `${label} is ${value(latest)} in this chart's aggregate scope.`, basis: "Aggregate · no time breakdown", latest });
    } else {
      const values = rows.map(row => ({ category: row[dIndex], value: numeric(row[index]) })).filter(r => r.value != null);
      if (!values.length) continue;
      const high = Math.max(...values.map(r => r.value!)), leaders = values.filter(r => r.value === high);
      const names = leaders.slice(0, 3).map(r => r.category == null ? "missing category" : String(r.category));
      const statement = `${label}: ${names.join(", ")}${leaders.length > 3 ? ` and ${leaders.length - 3} other groups` : ""} ${leaders.length === 1 ? "has" : "share"} the highest returned value, ${value(high)}.`;
      observations.push({ metric: name, label, statement, basis: `${dimension} · ${values.length} of ${rows.length} returned rows have numeric values`, latest: high });
    }
  }
  for (const observation of observations) {
    if (!metricOf(model, observation.metric)?.unit) observation.unitNote = `Display unit inferred as ${metricUnit(model, observation.metric)} from the metric's naming; confirm it in the semantic model.`;
    try {
      const source = { ...tile, metrics: [observation.metric] };
      const options = investigationOptions(model, source, investigationContext(model, source, [], [], result));
      const breakdown = options.find(option => option.id.startsWith("by:"));
      observation.nextQuestion = breakdown
        ? `How does ${observation.label} vary ${breakdown.label.replace("Break down ", "")}? Compare groups within this chart's reporting window and filters before attributing a cause.`
        : `Inspect the values and definition of ${observation.label} within this chart's reporting scope before drawing a conclusion.`;
    } catch {
      observation.nextQuestion = `Inspect the original values and calculation history of ${observation.label} before changing its reporting window.`;
    }
  }
  if (precisionLimited.length) return { observations, note: `Numeric precision needs review for ${precisionLimited.join(", ")}. No automatic observation was drafted for these metrics. Inspect the returned values and calculate exact comparisons in the warehouse.` };
  return observations.length ? { observations } : none("No supported numeric observations are available for this result.");
}
