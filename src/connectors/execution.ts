import type { ExecutionOptions } from "./types.ts";

/** Cancel both queueing and execution; always dispose the timer after settling. */
export function executionBudget(options: ExecutionOptions = {}) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error("Query timeout must be a positive number of milliseconds");
  const controller = new AbortController();
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() =>
    controller.abort(new DOMException("The query exceeded its time budget", "TimeoutError")), options.timeoutMs);
  timer?.unref?.();
  return {
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

/** Keep the lease until DuckDB confirms completion/interruption. Returning on
 * Promise.race would let a later query reuse a still-busy connection. */
export async function interruptibleDuckdb<T>(connection: { interrupt(): void }, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const cancel = () => connection.interrupt();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await run();
    signal.throwIfAborted();
    return result;
  } catch (error) { signal.throwIfAborted(); throw error; }
  finally { signal.removeEventListener("abort", cancel); }
}
