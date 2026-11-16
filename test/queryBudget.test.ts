import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DuckDBConnection } from "@duckdb/node-api";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { budgetFailure, loadQueryTimeoutMs, requestBudget } from "../src/connectors/queryBudget.ts";

const response = () => Object.assign(new EventEmitter(), { writableEnded: false }) as any;
const expensive = "SELECT sum(sqrt(i)) FROM range(10000000000) t(i)";

it("defaults to two minutes, accepts overrides and refuses invalid configuration", () => {
  expect(loadQueryTimeoutMs({})).toBe(120_000);
  expect(loadQueryTimeoutMs({ SC_QUERY_TIMEOUT_SECONDS: " " })).toBe(120_000);
  expect(loadQueryTimeoutMs({ SC_QUERY_TIMEOUT_SECONDS: "30" })).toBe(30_000);
  expect(loadQueryTimeoutMs({ SC_QUERY_TIMEOUT_SECONDS: "0" })).toBeUndefined();
  for (const bad of ["4", "3601", "2.5", "-1", "soon"]) expect(() => loadQueryTimeoutMs({ SC_QUERY_TIMEOUT_SECONDS: bad })).toThrow(/SC_QUERY_TIMEOUT_SECONDS/);
});

it("cancels real warehouse work at the budget and explains it without a server-error status", async () => {
  const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
  const conn = await pooledDuckdb("/unused", { size: 1 });
  try {
    const started = performance.now();
    const error = await conn.execute(expensive, 1, undefined, requestBudget(response(), 150)).catch(e => e);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(budgetFailure(error, 30_000)).toEqual({ status: 422, error: expect.stringMatching(/workspace limit of 30 seconds and was cancelled.*SC_QUERY_TIMEOUT_SECONDS/) });
    // The connection is usable again, and an ordinary failure is not reported as a budget problem.
    expect((await conn.execute("SELECT 42 AS answer", 1, undefined, requestBudget(response(), 30_000))).rows).toEqual([[42]]);
    expect(budgetFailure(await conn.execute("SELECT no_such_column", 1).catch(e => e), 30_000)).toBeUndefined();
  } finally { await conn.close(); interrupt.mockRestore(); }
});

it("cancels the query when its request closes early, and never after a completed response", async () => {
  const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
  const conn = await pooledDuckdb("/unused", { size: 1 });
  try {
    const gone = response();
    const running = conn.execute(expensive, 1, undefined, requestBudget(gone, undefined)).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 100));
    gone.emit("close");
    const error = await running;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(budgetFailure(error, undefined)).toBeUndefined();
    // Disabled budget: no deadline is passed at all.
    expect(requestBudget(response(), undefined)).not.toHaveProperty("timeoutMs");
    const finished = response(), budget = requestBudget(finished, 30_000);
    await conn.execute("SELECT 1", 1, undefined, budget);
    finished.writableEnded = true; finished.emit("close");
    expect(budget.signal!.aborted).toBe(false);
    expect(interrupt).toHaveBeenCalledOnce();
  } finally { await conn.close(); interrupt.mockRestore(); }
});
