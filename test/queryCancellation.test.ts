import { expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { leasePool } from "../src/connectors/leases.ts";
import { executionBudget } from "../src/connectors/execution.ts";
import { profileEvidence } from "../src/suggest/profileEvidence.ts";

it("removes canceled waiters without consuming a connection or interrupting its owner", async () => {
  const dispose = vi.fn(), pool = leasePool(["connection"], dispose);
  const owner = await pool.acquire(), controller = new AbortController();
  const canceled = expect(pool.acquire(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  const next = pool.acquire();
  expect(pool.stats()).toMatchObject({ free: 0, waiting: 2 });
  controller.abort(); await canceled;
  expect(pool.stats()).toMatchObject({ free: 0, waiting: 1 });
  pool.release(owner);
  expect(await next).toBe(owner);
  pool.release(owner); await pool.close();
  expect(dispose).toHaveBeenCalledOnce();
});

for (const kind of ["single", "pooled"] as const) it(`${kind} DuckDB interrupts actual expensive work and safely reuses the connection`, async () => {
  const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
  const conn = kind === "single" ? await duckdbConnector("/unused") : await pooledDuckdb("/unused", { size: 1 });
  try {
    const started = performance.now();
    await expect(conn.execute("SELECT sum(sqrt(i)) FROM range(10000000000) t(i)", 1, undefined, { timeoutMs: 100 }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(interrupt).toHaveBeenCalledOnce();
    expect((await conn.execute("SELECT 42 AS answer")).rows).toEqual([[42]]);
    const controller = new AbortController();
    await conn.execute("SELECT 7", 1, undefined, { signal: controller.signal });
    controller.abort(); // A completed request cannot interrupt a subsequent query.
    expect(interrupt).toHaveBeenCalledOnce();
    expect((await conn.execute("SELECT 8")).rows).toEqual([[8]]);
    await expect(conn.execute("SELECT 7", 1, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  } finally { await conn.close(); interrupt.mockRestore(); }
});

it("a request canceled while queued never executes and does not cancel the active query", async () => {
  const conn = await pooledDuckdb("/unused", { size: 1 });
  const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
  try {
    const active = expect(conn.execute("SELECT sum(sqrt(i)) FROM range(10000000000) t(i)", 1, undefined, { timeoutMs: 150 }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    const canceled = expect(conn.execute("SELECT 99", 1, undefined, { timeoutMs: 25 })).rejects.toMatchObject({ name: "TimeoutError" });
    await canceled;
    expect(interrupt).not.toHaveBeenCalled();
    expect(conn.stats()).toMatchObject({ free: 0, waiting: 0 });
    await active;
    expect((await conn.execute("SELECT 1")).rows).toEqual([[1]]);
    expect(conn.stats()).toMatchObject({ free: 1, waiting: 0 });
  } finally { await conn.close(); interrupt.mockRestore(); }
});

it("an expired profiling request cancels its real count query and reports unknown evidence", async () => {
  const conn = await duckdbConnector("/unused"), budget = executionBudget({ timeoutMs: 100 });
  try {
    const result = await profileEvidence(conn, "(SELECT i % 1000 AS value FROM range(10000000000) t(i)) AS scoped", budget.signal);
    expect(result).toMatchObject({ cardinality: null, sample: [], warning: expect.stringContaining("time limit") });
    expect((await conn.execute("SELECT 42")).rows).toEqual([[42]]);
  } finally { budget.dispose(); await conn.close(); }
});
