import type { KpiPoint } from "./kpiSummary.ts";
import { bucketEnd, toUtcDay } from "../suggest/dataHonesty.ts";

export type SparkPoint = KpiPoint & { position: number };
export type SparkGap = { from: number; to: number };

/** Keep dates and missing observations. Split known runs without generating a
 * dense date spine: a decade-long gap should cost no more than a single gap. */
export function sparklineTimeline(series: KpiPoint[], grain?: string | null) {
  const dates = series.map(p => toUtcDay(p.x));
  const temporal = series.length > 0 && dates.every(d => d && Number.isFinite(+d));
  const points: SparkPoint[] = series.map((p, i) => ({ ...p, position: temporal ? +dates[i]! : i }));
  if (temporal) points.sort((a, b) => a.position - b.position);
  const valid = points.filter(p => Number.isFinite(p.y));
  const knownGrain = temporal && ["day", "week", "month", "quarter", "year"].includes(grain ?? "");
  const end = (p: SparkPoint) => knownGrain ? +bucketEnd(new Date(p.position), grain!) : p.position + 1;
  const segments: SparkPoint[][] = [];
  const gaps: SparkGap[] = [];
  let missingPeriods = false;
  let missingValues = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], before = points[i - 1];
    const skipped = before && knownGrain && p.position > end(before);
    if (skipped) { missingPeriods = true; gaps.push({ from: end(before), to: p.position }); }
    if (!Number.isFinite(p.y)) {
      missingValues++;
      gaps.push({ from: p.position, to: knownGrain ? end(p) : points[i + 1]?.position ?? p.position });
      continue;
    }
    if (!before || !Number.isFinite(before.y) || skipped) segments.push([]);
    segments.at(-1)!.push(p);
  }
  const merged: SparkGap[] = [];
  for (const gap of gaps.sort((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous && gap.from <= previous.to) previous.to = Math.max(previous.to, gap.to);
    else merged.push({ ...gap });
  }
  // Bar widths describe one period even when neighboring rows are years apart.
  const intervals = knownGrain ? points.map(p => end(p) - p.position)
    : points.slice(1).map((p, i) => p.position - points[i].position).filter(n => n > 0);
  const step = intervals.length ? Math.min(...intervals) : 1;
  return { points, valid, segments, gaps: merged, temporal, step, missingPeriods, missingValues,
    domain: [points[0]?.position ?? 0, points.at(-1)?.position ?? 1] as [number, number] };
}

/** Hovering an absent period must not borrow a value from a distant month. */
export function sparklineHover(timeline: ReturnType<typeof sparklineTimeline>, position: number) {
  const gap = timeline.gaps.find(g => position >= g.from && (position < g.to || g.from === g.to));
  if (gap) return { position, gap, point: undefined };
  const point = timeline.points.reduce<SparkPoint | undefined>((closest, p) => !closest || Math.abs(p.position - position) < Math.abs(closest.position - position) ? p : closest, undefined);
  return { position: point?.position ?? position, point, gap: undefined };
}
