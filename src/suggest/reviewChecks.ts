import type { TileSpec } from "../compiler/spec.ts";
import { checkResultQuality, type QualityResult } from "./resultQuality.ts";

/** The heuristic compares neighboring periods of one series. Segmented,
 * duplicated or gapped dates cannot be treated as a single continuous line. */
export function noiseSeriesReady(query: Pick<TileSpec, "metrics" | "dimensions">, result: QualityResult) {
  if (query.dimensions.length !== 1 || !query.dimensions[0].includes(":") || result.truncated) return false;
  return !checkResultQuality(query.metrics, query.dimensions, result)
    .some(f => ["time-column", "invalid-dates", "duplicate-periods", "gaps"].includes(f.id));
}
/** Remember the exact query accepted by the user, not the tile's position or title.
 * Editing its grain/filters, refreshing data, or switching scope makes it reviewable again. */
export function grainReviewKey(query: Pick<TileSpec, "metrics" | "dimensions" | "where" | "limit" | "compare">, scope = "") {
  return JSON.stringify([scope, query.metrics, query.dimensions, query.where ?? [], query.limit, query.compare]);
}

/** Coarsening must visibly improve the signal, not just be the next available grain.
 * Require at least a 15% reduction, with a measured score for every previously
 * noisy metric. Pass all candidate scores, including zero for a flat series;
 * missing scores must never be mistaken for improvement. */
export function worthwhileCoarsening(before: { measure: string; score: number }[], after: { measure: string; score: number }[], points: number) {
  if (points < 14) return false;
  return before.every(b => after.some(a => a.measure === b.measure && Number.isFinite(a.score))) && before.some(b => {
    const next = after.find(a => a.measure === b.measure);
    return next !== undefined && next.score <= b.score * 0.85;
  }) && after.every(a => !before.some(b => b.measure === a.measure && a.score > b.score));
}
