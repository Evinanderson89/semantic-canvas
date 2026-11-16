import { numericValue } from "../charts/values.ts";
import { compileTile, parseDimension, splitPartialPeriods, validateTile } from "../compiler/compile.ts";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { Connector } from "../connectors/types.ts";
import {
  dimensionsOf,
  fieldReachable,
  isNumeric,
  isTemporal,
  metricOf,
  timeColumnOf,
  type Model,
} from "../semantic/model.ts";

export interface DriverInput {
  metric: string;
  timeDimension?: string;
  where?: FilterSpec[];
  maxDimensions?: number;
  topN?: number;
}

export interface SegmentDriver {
  segment: string;
  prior: number;
  latest: number;
  delta: number;
  percentChange: number | null;
  shareOfChange: number;
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

  const seriesSql = compileTile(model, conn, seriesTile);
  const rawSeries = await conn.execute(seriesSql);
  const { columns: seriesCols, rows: seriesRows } = splitPartialPeriods(rawSeries);

  const parsedTime = parseDimension(timeDimension);
  const timeAlias = parsedTime.grain ? `${parsedTime.column}_${parsedTime.grain}` : parsedTime.column;
  const timeIdx = seriesCols.indexOf(timeAlias);
  const metricIdx = seriesCols.indexOf(metric.name);
  if (timeIdx < 0 || metricIdx < 0) {
    throw new Error(`Time-series query for "${metric.name}" did not return expected columns.`);
  }

  const closedPeriods = seriesRows
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

  const maxDimensions = input.maxDimensions ?? 4;
  const topN = input.topN ?? 3;

  const orderedTables = [
    model.tables[metric.baseTable],
    ...Object.values(model.tables).filter((t) => t.name !== metric.baseTable),
  ].filter(Boolean);

  const candidates: { field: string; columnName: string }[] = [];
  for (const table of orderedTables) {
    for (const col of dimensionsOf(table)) {
      const field = `${table.name}.${col.name}`;
      if (!isNumeric(col) && !isTemporal(col) && fieldReachable(model, metric.baseTable, field)) {
        candidates.push({ field, columnName: col.name });
      }
    }
  }

  const dimensions: DimensionContribution[] = [];
  for (const candidate of candidates) {
    if (dimensions.length >= maxDimensions) break;
    const breakdownTile: TileSpec = {
      id: `drivers:by:${candidate.field}`,
      metrics: [metric.name],
      dimensions: [timeDimension, candidate.field],
      where: input.where ? structuredClone(input.where) : undefined,
      limit: 5000,
      layout: { x: 0, y: 0, w: 600, h: 300 },
    };
    if (validateTile(model, breakdownTile).length > 0) continue;

    const breakdownSql = compileTile(model, conn, breakdownTile);
    const rawBreakdown = await conn.execute(breakdownSql);
    const { columns: bCols, rows: bRows } = splitPartialPeriods(rawBreakdown);
    const bTimeIdx = bCols.indexOf(timeAlias);
    const bDimIdx = bCols.indexOf(candidate.columnName);
    const bMetricIdx = bCols.indexOf(metric.name);
    if (bTimeIdx < 0 || bDimIdx < 0 || bMetricIdx < 0) continue;

    const bySegment = new Map<string, { prior: number; latest: number }>();
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
      const current = bySegment.get(segKey) ?? { prior: 0, latest: 0 };
      if (period === priorPeriod) current.prior += val;
      if (period === latestPeriod) current.latest += val;
      bySegment.set(segKey, current);
    }

    const segments: SegmentDriver[] = [...bySegment.entries()]
      .map(([segment, { prior, latest }]) => {
        const segmentDelta = latest - prior;
        const shareOfChange = delta === 0 ? 0 : segmentDelta / Math.abs(delta);
        const segPct = prior === 0 ? null : segmentDelta / Math.abs(prior);
        return {
          segment,
          prior,
          latest,
          delta: segmentDelta,
          percentChange: segPct,
          shareOfChange,
        };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.segment.localeCompare(b.segment))
      .slice(0, topN);

    dimensions.push({
      dimension: candidate.field,
      label: candidate.columnName.replace(/_/g, " "),
      segments,
      drivers: segments,
    });
  }

  return {
    metric: metric.name,
    label: metric.label,
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
