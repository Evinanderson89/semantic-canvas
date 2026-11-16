import type { DataFinding } from "../suggest/resultQuality.ts";
import type { QueryObservation } from "../suggest/queryObservations.ts";
import { numericValue } from "../charts/values.ts";

export type Readiness = { evidenceFingerprint?: string; evidencePending?: boolean; status: "checking" | "ready" | "error"; message?: string; dataFindings?: DataFinding[]; window?: { start: string; end: string }; rowRules?: string[]; observations?: QueryObservation[]; observationNote?: string };

/** Result shape must match the governed metrics, including all-null columns. */
export function resultIssue(metrics: string[], columns: string[], rows: unknown[][]): string | undefined {
  const missing = metrics.filter(m => !columns.includes(m));
  if (missing.length) return `Missing results for ${missing.join(", ")}. Retry the query before applying.`;
  if (!rows.length) return "No rows match this chart's scope. Adjust the filters or reporting period.";
  const empty = metrics.filter(m => !rows.some(r => numericValue(r[columns.indexOf(m)]) !== null));
  if (empty.length) return `No numeric values for ${empty.join(", ")}. Missing values have not been treated as zero.`;
}
