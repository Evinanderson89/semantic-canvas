import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { detectDegenerate, type DegenerateFinding } from "./recommend.ts";
import type { QualityResult } from "./resultQuality.ts";

type ReviewQuery = Pick<TileSpec, "metrics" | "dimensions" | "where" | "limit" | "compare">;
export interface BreakdownReview { finding: DegenerateFinding | null; scopeNote?: string; unavailable?: boolean; limited?: boolean }

/** A permanent axis edit needs evidence from the chart's own scope, not just
 * one selected category. The caller executes the confirmation through the
 * same authenticated query endpoint; semantic filters and row rules remain. */
export async function reviewBreakdown(tile: Pick<TileSpec, "where">, query: ReviewQuery, result: QualityResult,
  read: (query: ReviewQuery) => Promise<QualityResult>): Promise<BreakdownReview> {
  if (query.dimensions.length !== 1 || query.metrics.length !== 1 || query.dimensions[0].includes(":")) return { finding: null };
  if (result.truncated) return { finding: null, limited: true, scopeNote: "The result is limited. Review the full category result before removing its breakdown." };
  const dimension = parseDimension(query.dimensions[0]).column;
  const finding = detectDegenerate(result.rows, result.columns, dimension, query.metrics[0]);
  if (!finding) return { finding: null };
  if (JSON.stringify(query.where ?? []) === JSON.stringify(tile.where ?? [])) return { finding };
  try {
    const full = await read({ ...query, where: tile.where ?? [] });
    if (full.truncated) return { finding: null, limited: true, scopeNote: "The chart's own query is limited. Its full category variation has not been verified, so keep the breakdown for now." };
    const confirmed = detectDegenerate(full.rows, full.columns, dimension, query.metrics[0]);
    if (!confirmed) return { finding: null, scopeNote: "The one-category finding is specific to this selection; it was not confirmed using the chart's own filters. Keep the breakdown to compare categories when the selection changes." };
    return { finding: confirmed, scopeNote: "Also checked without dashboard selections, keeping the chart's own filters, metric definition and access rules. Applying this changes the chart for every selection." };
  } catch {
    return { finding: null, unavailable: true, scopeNote: "Could not verify the chart's own category result. Retry the review before removing its breakdown." };
  }
}

export function breakdownStatement(finding: DegenerateFinding) {
  return finding.basis === "single-category" ? `Only “${finding.dominantValue}” is represented in the checked category result.`
    : `Only “${finding.dominantValue}” has a nonzero value in the checked category result.`;
}
