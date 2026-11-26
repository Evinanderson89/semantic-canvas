import { numericValue } from "../charts/values.ts";
import { compileTile, parseDimension, splitPartialPeriods, validateTile } from "../compiler/compile.ts";
import { issuesText } from "../compiler/issueText.ts";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { Connector, ExecutionOptions } from "../connectors/types.ts";
import {
  dimensionsOf,
  fieldReachable,
  isAdditiveMetric,
  isNumeric,
  isTemporal,
  joinPath,
  metricComponents,
  metricOf,
  timeColumnOf,
  type Metric,
  type Model,
} from "../semantic/model.ts";

export interface DriverInput {
  metric: string;
  timeDimension?: string;
  where?: FilterSpec[];
  maxDimensions?: number;
  topN?: number;
  role?: string;
  cacheScope?: string;
  execution?: ExecutionOptions;
}

export interface SegmentDriver {
  segment: string;
  prior: number;
  latest: number;
  delta: number;
  percentChange: number | null;
  shareOfChange: number | null;
}

export interface DimensionContribution {
  dimension: string;
  label: string;
  segments: SegmentDriver[];
  drivers: SegmentDriver[];
}

export interface MetricDriverAnalysis {
  metric: string;
  label: string;
  additive: boolean;
  timeDimension: string;
  priorPeriod: string;
  latestPeriod: string;
  priorTotal: number;
  latestTotal: number;
  delta: number;
  percentChange: number | null;
  dimensions: DimensionContribution[];
}

function normalizePeriod(value: unknown): string {
  if (value instanceof Date && Number.isFinite(+value)) {
    return value.toISOString().slice(0, 10);
  }
  return String(value ?? "").slice(0, 10);
}

function advancePeriodEnd(startIso: string, grain: string): string {
  const end = new Date(`${startIso}T00:00:00Z`);
  if (grain === "day" || grain === "week") end.setUTCDate(end.getUTCDate() + (grain === "day" ? 1 : 7));
  else if (grain === "month" || grain === "quarter") end.setUTCMonth(end.getUTCMonth() + (grain === "month" ? 1 : 3));
  else if (grain === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString().slice(0, 10);
}

/** Suppress tautological breakdowns over columns already baked into a metric's SQL filter/CASE condition. */
export function isDimensionReferencedInMetric(model: Model, metric: Metric, field: string): boolean {
  const [table, col] = field.split(".");
  const clauses = [metric, ...metricComponents(model, metric)]
    .flatMap((m) => [m.filter ?? "", m.expression ?? ""])
    .join(" ");
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedCol = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escapedTable}\\.${escapedCol}\\b`, "i").test(clauses)) return true;
  if (table === metric.baseTable && new RegExp(`\\b${escapedCol}\\b`, "i").test(metric.filter ?? "")) return true;
  return false;
}

/** Human-friendly label for schema column names (`is_active` -> `Account status`, `plan_tier` -> `Plan tier`). */
export function humanDimensionName(columnName: string): string {
  const special: Record<string, string> = {
    is_active: "Account status",
    plan_tier: "Plan tier",
    plan_name: "Plan",
    billing_interval: "Billing cycle",
    signup_source: "Signup source",
    device_platform: "Platform",
    movement_type: "Movement type",
    source_site: "Property",
    addon_name: "Add-on",
  };
  if (special[columnName]) return special[columnName];
  const words = columnName.replace(/^is_/, "").replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : columnName;
}

/**
 * Deterministic "Why Did This Move?" dimensional contribution analysis.
 * Evaluates a governed time-series query across the last two closed periods
 * and breaks down the movement across reachable categorical dimensions.
 */
export async function analyzeMetricDrivers(
  model: Model,
  conn: Connector,
  input: DriverInput,
): Promise<MetricDriverAnalysis> {
  const metric = metricOf(model, input.metric);
  if (!metric) {
    throw new Error(`Unknown metric "${input.metric}"`);
  }

  const baseTimeCol = timeColumnOf(model, metric.baseTable);
  const timeDimension =
    input.timeDimension ??
    (metric.timeDimension
      ? `month:${metric.timeDimension}`
      : baseTimeCol
        ? `month:${baseTimeCol}`
        : "");

  if (!timeDimension || !timeDimension.includes(":")) {
    throw new Error(`Metric "${metric.name}" has no default time dimension; supply timeDimension explicitly.`);
  }

  const seriesTile: TileSpec = {
    id: `drivers:series:${metric.name}`,
    metrics: [metric.name],
    dimensions: [timeDimension],
    where: input.where ? structuredClone(input.where) : undefined,
    layout: { x: 0, y: 0, w: 600, h: 300 },
  };
  const seriesIssues = validateTile(model, seriesTile, { role: input.role });
  if (seriesIssues.length > 0) {
    throw new Error(issuesText(seriesIssues));
  }

  const seriesSql = compileTile(model, conn, seriesTile, { role: input.role });
  const rawSeries = await conn.execute(seriesSql, 5000, input.cacheScope, input.execution);
  const { columns: seriesCols, rows: rawRows, partial } = splitPartialPeriods(rawSeries);
  let trimmedRows = rawRows;
  if (partial?.selected?.start && trimmedRows.length > 0) trimmedRows = trimmedRows.slice(1);
  if (partial?.selected?.end && trimmedRows.length > 0) trimmedRows = trimmedRows.slice(0, -1);

  const parsedTime = parseDimension(timeDimension);
  const timeAlias = parsedTime.grain ? `${parsedTime.column}_${parsedTime.grain}` : parsedTime.column;
  const timeIdx = seriesCols.indexOf(timeAlias);
  const metricIdx = seriesCols.indexOf(metric.name);
  if (timeIdx < 0 || metricIdx < 0) {
    throw new Error(`Time-series query for "${metric.name}" did not return expected columns.`);
  }

  const closedPeriods = trimmedRows
    .map((row) => ({
      period: normalizePeriod(row[timeIdx]),
      value: numericValue(row[metricIdx]),
    }))
    .filter((entry): entry is { period: string; value: number } => /^\d{4}-\d{2}-\d{2}$/.test(entry.period) && entry.value !== null)
    .sort((a, b) => a.period.localeCompare(b.period));

  if (closedPeriods.length < 2) {
    throw new Error(
      `Metric "${metric.name}" requires at least two closed periods for driver analysis (found ${closedPeriods.length}).`,
    );
  }

  const priorEntry = closedPeriods.at(-2)!;
  const latestEntry = closedPeriods.at(-1)!;
  const priorPeriod = priorEntry.period;
  const latestPeriod = latestEntry.period;
  const priorTotal = priorEntry.value;
  const latestTotal = latestEntry.value;
  const delta = latestTotal - priorTotal;
  const percentChange = priorTotal === 0 ? null : delta / Math.abs(priorTotal);
  const additive = isAdditiveMetric(model, metric);

  const maxDimensions = Math.min(12, Math.max(1, input.maxDimensions ?? 4));
  const topN = Math.min(10, Math.max(1, input.topN ?? 3));

  const explorationDims = new Set((metric.explorations ?? []).map((e) => e.dimension));
  const rawCandidates: { field: string; columnName: string; rank: number }[] = [];
  for (const table of Object.values(model.tables)) {
    for (const col of dimensionsOf(table)) {
      const field = `${table.name}.${col.name}`;
      if (isNumeric(col) || isTemporal(col) || !fieldReachable(model, metric.baseTable, field)) continue;
      // Keep movement_type on net_new_mrr even though mrr_delta_usd is on the same table,
      // while suppressing filter-locked columns like `status = 'active'` or `converted`.
      if (!explorationDims.has(field) && isDimensionReferencedInMetric(model, metric, field)) continue;
      const path = joinPath(model, metric.baseTable, table.name);
      const hops = "joins" in path ? path.joins.length : 99;
      const isBool = /^bool/i.test(col.type) || col.name.startsWith("is_");
      const rank =
        (explorationDims.has(field) ? 0 : 10) +
        hops * 10 +
        (isBool ? 50 : 0);
      rawCandidates.push({ field, columnName: col.name, rank });
    }
  }
  rawCandidates.sort((a, b) => a.rank - b.rank);

  const timeFieldQualified = parsedTime.table ? `${parsedTime.table}.${parsedTime.column}` : `${metric.baseTable}.${parsedTime.column}`;
  const twoPeriodWindow: FilterSpec = {
    id: "drivers:window",
    field: timeFieldQualified,
    source: "dimension",
    mode: "range",
    min: priorPeriod,
    max: advancePeriodEnd(latestPeriod, parsedTime.grain ?? "month"),
    maxExclusive: true,
  };

  const dimensions: DimensionContribution[] = [];
  for (const candidate of rawCandidates) {
    if (dimensions.length >= maxDimensions) break;
    const breakdownTile: TileSpec = {
      id: `drivers:by:${candidate.field}`,
      metrics: [metric.name],
      dimensions: [timeDimension, candidate.field],
      where: [...(input.where ? structuredClone(input.where) : []), twoPeriodWindow],
      limit: 5000,
      layout: { x: 0, y: 0, w: 600, h: 300 },
    };
    if (validateTile(model, breakdownTile, { role: input.role }).length > 0) continue;

    const breakdownSql = compileTile(model, conn, breakdownTile, { role: input.role });
    const rawBreakdown = await conn.execute(breakdownSql, 5000, input.cacheScope, input.execution);
    const { columns: bCols, rows: bRows } = splitPartialPeriods(rawBreakdown);
    const bTimeIdx = bCols.indexOf(timeAlias);
    const bDimIdx = bCols.indexOf(candidate.columnName);
    const bMetricIdx = bCols.indexOf(metric.name);
    if (bTimeIdx < 0 || bDimIdx < 0 || bMetricIdx < 0) continue;

    const bySegment = new Map<string, { prior: number | null; latest: number | null }>();
    for (const row of bRows) {
      const period = normalizePeriod(row[bTimeIdx]);
      if (period !== priorPeriod && period !== latestPeriod) continue;
      const val = numericValue(row[bMetricIdx]);
      if (val === null) continue;
      const rawSeg = row[bDimIdx];
      const segKey =
        rawSeg === null || rawSeg === undefined || String(rawSeg).trim() === ""
          ? "(unassigned)"
          : String(rawSeg);
      const current = bySegment.get(segKey) ?? { prior: null, latest: null };
      if (period === priorPeriod) {
        current.prior = additive ? (current.prior ?? 0) + val : current.prior ?? val;
      }
      if (period === latestPeriod) {
        current.latest = additive ? (current.latest ?? 0) + val : current.latest ?? val;
      }
      bySegment.set(segKey, current);
    }

    const segments: SegmentDriver[] = [...bySegment.entries()]
      .flatMap(([segment, { prior, latest }]) => {
        // Non-additive ratios/averages cannot treat an absent period as 0.00.
        if (!additive && (prior === null || latest === null)) return [];
        const p = prior ?? 0;
        const l = latest ?? 0;
        const segmentDelta = l - p;
        const rawShare = delta === 0 ? 0 : segmentDelta / Math.abs(delta);
        // Suppress misleading >100% shareOfChange on non-additive ratios/averages
        // or when offsetting segment swings make |share| > 1.
        const shareOfChange = !additive || Math.abs(rawShare) > 1 ? null : rawShare;
        const segPct = p === 0 ? null : segmentDelta / Math.abs(p);
        return [
          {
            segment,
            prior: p,
            latest: l,
            delta: segmentDelta,
            percentChange: segPct,
            shareOfChange,
          },
        ];
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.segment.localeCompare(b.segment))
      .slice(0, topN);

    if (segments.length === 0) continue;

    dimensions.push({
      dimension: candidate.field,
      label: humanDimensionName(candidate.columnName).toLowerCase(),
      segments,
      drivers: segments,
    });
  }

  return {
    metric: metric.name,
    label: metric.label,
    additive,
    timeDimension,
    priorPeriod,
    latestPeriod,
    priorTotal,
    latestTotal,
    delta,
    percentChange,
    dimensions,
  };
}
