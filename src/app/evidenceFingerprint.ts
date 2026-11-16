import type { PresentationBrief } from "../compiler/spec.ts";

/** Stable JSON for change detection, not a signature or an authorization check. */
export function canonicalEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export async function digestEvidence(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEvidence(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Only evidence-affecting fields. Query timing/cache status/refresh counters
 * must not make an unchanged result appear stale. Raw rows stay in memory. */
export function chartEvidence(query: unknown, result: Record<string, unknown>) {
  return { query, columns: result.columns, rows: result.rows, sql: result.sql,
    window: result.window, truncated: result.truncated, partial: result.partial,
    coverage: result.coverage, principal: result.principal,
    rlsApplied: result.rlsApplied, rlsUnenforceable: result.rlsUnenforceable };
}

export type BriefReviewStatus = "unreviewed" | "checking" | "unavailable" | "changed" | "matches";
export function briefReviewStatus(brief: PresentationBrief, current: string | undefined, pending: boolean): BriefReviewStatus {
  if (!brief.review) return "unreviewed";
  if (pending) return "checking";
  if (!current) return "unavailable";
  return brief.review.fingerprint === current ? "matches" : "changed";
}
