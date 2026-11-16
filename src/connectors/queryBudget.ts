import type { Response } from "express";
import type { ExecutionOptions } from "./types.ts";

const VARIABLE = "SC_QUERY_TIMEOUT_SECONDS";
/** Time budget for one warehouse-backed request, including time waiting for a
 * connection. Default 120 seconds; 0 disables. Invalid values stop startup. */
export function loadQueryTimeoutMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[VARIABLE];
  if (raw === undefined || raw.trim() === "") return 120_000;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds !== 0 && (seconds < 5 || seconds > 3600)) throw new Error(`${VARIABLE} must be 0 or a whole number from 5 to 3600`);
  return seconds === 0 ? undefined : seconds * 1000;
}

/** Bound a query by the workspace budget and cancel it when its request goes
 * away: a closed tab or removed chart should not keep a warehouse working. */
export function requestBudget(res: Pick<Response, "on" | "writableEnded">, timeoutMs: number | undefined): ExecutionOptions {
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(new DOMException("The request was closed before the query finished", "AbortError")); });
  return { signal: controller.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/** A budget timeout as a response a person can act on; undefined for any other failure. */
export function budgetFailure(error: unknown, timeoutMs: number | undefined): { status: number; error: string } | undefined {
  if ((error as { name?: unknown } | null)?.name !== "TimeoutError") return undefined;
  const budget = timeoutMs === undefined ? "its time budget" : `the workspace limit of ${Math.round(timeoutMs / 1000)} seconds`;
  // 422 rather than 5xx: company mode replaces 5xx bodies with a generic message, and this one is actionable.
  return { status: 422, error: `This query exceeded ${budget} and was cancelled. Narrow the date range or filters and retry. An administrator can change the limit with ${VARIABLE}.` };
}
