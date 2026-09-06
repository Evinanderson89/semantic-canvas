import { DuckDBInstance } from "@duckdb/node-api";
import type { Connector, QueryResult } from "./types.ts";

/**
 * DuckDB over a local Hive-partitioned Parquet lake. No server, no credentials,
 * no cloud -- which is what makes this the right first connector.
 */
export async function duckdbConnector(lakeRoot: string): Promise<Connector> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  return {
    id: "duckdb",
    label: "DuckDB (local Parquet)",
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    dateTrunc: (grain, expr) => `date_trunc('${grain}', ${expr})`,
    dateAdd: (unit, expr, n) => `(${expr} + INTERVAL '${n} ${unit}')`,
    relation: (table) =>
      `read_parquet('${lakeRoot.replace(/\/$/, "")}/${table}/**/*.parquet', ` +
      `hive_partitioning = true, union_by_name = true)`,

    async execute(sql: string, limit = 5000): Promise<QueryResult> {
      const t0 = performance.now();
      const reader = await conn.runAndReadAll(sql);
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
    },
    async close() { /* pooled connection; nothing to release */ },
  };
}

function normalize(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") {
    if (typeof v.toString === "function" && (v.days !== undefined || v.micros !== undefined))
      return v.toString();
    if (v instanceof Date) return v.toISOString();
  }
  return v;
}
