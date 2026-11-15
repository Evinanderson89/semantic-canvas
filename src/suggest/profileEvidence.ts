import type { Connector } from "../connectors/types.ts";

export const PROFILE_QUERY_TIMEOUT_MS = 3000;
export const PROFILE_REQUEST_TIMEOUT_MS = 15000;
const timeoutWarning = "Field profiling reached its time limit. Some evidence is unavailable; retry when the source is less busy.";
const unavailableWarning = "Some field evidence could not be verified. Retry profiling or check the data source.";

/** Missing, lossy or malformed warehouse counts are unknown, never zero. */
export function profileCardinality(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value.trim()))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** The relation must already be model-validated and row-level scoped by the caller.
 * Exact counts may scan the scoped relation, so each query also has a deadline.
 * A timeout is missing evidence, never a zero count or an estimated exact count.
 */
export async function profileEvidence(conn: Pick<Connector, "execute">, relation: string, signal?: AbortSignal) {
  let cardinality: number | null = null;
  let sample: string[] = [];
  let timedOut = signal?.aborted && signal.reason?.name === "TimeoutError";
  let incomplete = false;
  const evidence = () => ({ cardinality, sample, ...(timedOut || incomplete ? { warning: timedOut ? timeoutWarning : unavailableWarning } : {}) });
  const options = { signal, timeoutMs: PROFILE_QUERY_TIMEOUT_MS };
  if (signal?.aborted) return evidence();
  try {
    const result = await conn.execute(`SELECT count(DISTINCT value) FROM ${relation}`, 1, undefined, options);
    if (result.rows.length === 1 && result.rows[0].length === 1) cardinality = profileCardinality(result.rows[0][0]);
    incomplete = cardinality === null;
  } catch (error) { incomplete = true; timedOut ||= error instanceof Error && error.name === "TimeoutError"; }
  if (signal?.aborted) return evidence();
  try {
    const result = await conn.execute(`SELECT DISTINCT value FROM ${relation} WHERE value IS NOT NULL LIMIT 40`, 40, undefined, options);
    sample = [...new Set(result.rows.flatMap(row => row[0] == null ? [] : [String(row[0])]))].slice(0, 40);
  } catch (error) { incomplete = true; timedOut ||= error instanceof Error && error.name === "TimeoutError"; }
  // Separate queries can observe changing data. Do not expose contradictory evidence.
  if (cardinality !== null && cardinality < sample.length) { cardinality = null; incomplete = true; }
  if (cardinality !== null && cardinality > 0 && !sample.length) incomplete = true;
  return evidence();
}
