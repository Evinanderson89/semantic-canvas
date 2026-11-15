import { DuckDBDecimalValue, DuckDBInstance } from "@duckdb/node-api";
import type { Connector, QueryResult, ExecutionOptions } from "./types.ts";
import { executionBudget, interruptibleDuckdb } from "./execution.ts";
import { leasePool } from "./leases.ts";

/**
 * DuckDB over a local Hive-partitioned Parquet lake. No server, no credentials,
 * no cloud -- which is what makes this the right first connector.
 */
export async function duckdbConnector(lakeRoot: string): Promise<Connector> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect().catch(error => {
    try { instance.closeSync(); } catch { /* preserve the connection error */ }
    throw error;
  });
  const leases = leasePool([conn], connection => connection.closeSync());
  let closing: Promise<void> | undefined;

  return {
    id: "duckdb",
    label: "DuckDB (local Parquet)",
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    dateTrunc: (grain, expr) => `CAST(date_trunc('${grain}', ${expr}) AS DATE)`,
    dateAdd: (unit, expr, n) => `(${expr} + INTERVAL '${n} ${unit}')`,
    toTimezone: (expr, timezone) => `timezone('${timezone.replace(/'/g, "''")}', timezone('UTC', CAST(${expr} AS TIMESTAMP)))`,
    relation: (table) => {
      const path = `${lakeRoot.replace(/\/$/, "")}/${table}/**/*.parquet`.replace(/'/g, "''");
      return `read_parquet('${path}', hive_partitioning = true, union_by_name = true)`;
    },

    async execute(sql: string, limit = 5000, _cacheKey?: string, options?: ExecutionOptions): Promise<QueryResult> {
      const budget = executionBudget(options);
      try {
        const connection = await leases.acquire(budget.signal);
        try {
          const t0 = performance.now();
          const reader = await interruptibleDuckdb(connection, budget.signal, () => connection.runAndReadAll(sql));
          const rows = reader.getRows().slice(0, limit);
          const columns = reader.columnNames();
          return {
            columns,
            // DuckDB returns BigInt for integer types and its own DATE/TIMESTAMP
            // wrappers; JSON and the charts want primitives.
            rows: rows.map((r: any[]) => r.map(normalize)),
            sql,
            ms: Math.round(performance.now() - t0),
          };
        } finally { leases.release(connection); }
      } finally { budget.dispose(); }
    },
    close() { return closing ??= leases.close().finally(() => instance.closeSync()); },
  };
}

function normalize(v: any): unknown {
  if (v === null || v === undefined) return null;
  // Decimal wrappers contain BigInt and cannot be sent as JSON. Keep their
  // exact base-10 text; display code handles numeric strings at its boundary.
  if (v instanceof DuckDBDecimalValue) return v.toString();
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "object") {
    if (typeof v.toString === "function" && (v.days !== undefined || v.micros !== undefined))
      return v.toString();
    if (v instanceof Date) return v.toISOString();
  }
  return v;
}
