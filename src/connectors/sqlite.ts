import { connectionPoolSize, leasePool } from "./leases.ts";
import { DuckDBDecimalValue, DuckDBInstance } from "@duckdb/node-api";
import type { CatalogTable, Connector, ExecutionOptions, QueryResult } from "./types.ts";
import { executionBudget, interruptibleDuckdb } from "./execution.ts";

export interface SqliteConnectorOptions {
  size?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
}

interface Entry {
  at: number;
  value: QueryResult;
}

/**
 * Warehouse connector for a DuckDB or SQLite database file (or `:memory:`).
 *
 * Unlike `pooledDuckdb` (which scans Parquet directories via `read_parquet`),
 * `sqliteConnector` opens a database file via `DuckDBInstance.create(dbPath)`
 * and resolves relations directly against tables inside the database.
 */
export async function sqliteConnector(
  dbPath: string,
  opts: SqliteConnectorOptions = {},
): Promise<Connector & { stats(): object }> {
  const size = connectionPoolSize(opts.size ?? 4);
  const ttl = opts.cacheTtlMs ?? 15_000;
  const max = opts.cacheMax ?? 500;

  const target = dbPath?.trim() ? dbPath.trim() : ":memory:";
  const instance = await DuckDBInstance.create(target);
  const attempts = await Promise.allSettled(
    Array.from({ length: size }, () => instance.connect()),
  );
  const conns = attempts.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  const failed = attempts.find((a) => a.status === "rejected");
  if (failed?.status === "rejected") {
    await Promise.allSettled(
      conns.map((conn) => Promise.resolve().then(() => conn.closeSync())),
    );
    try {
      instance.closeSync();
    } catch {
      /* preserve startup error */
    }
    throw failed.reason;
  }

  const leases = leasePool(conns, (c) => c.closeSync());
  const { acquire, release } = leases;
  let closing: Promise<void> | undefined;
  let hits = 0;
  let misses = 0;
  const cache = new Map<string, Entry>();

  const self: Connector & { stats(): object } = {
    id: "duckdb-db",
    label: "DuckDB / SQLite Database",
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    dateTrunc: (grain, expr) => `CAST(date_trunc('${grain}', ${expr}) AS DATE)`,
    dateAdd: (unit, expr, n) => `(${expr} + INTERVAL '${n} ${unit}')`,
    toTimezone: (expr, timezone) =>
      `timezone('${timezone.replace(/'/g, "''")}', timezone('UTC', CAST(${expr} AS TIMESTAMP)))`,
    relation: (table) => self.quote(table),

    async execute(
      sql: string,
      limit = 5000,
      cacheKey?: string,
      options?: ExecutionOptions,
    ): Promise<QueryResult> {
      const budget = executionBudget(options);
      try {
        budget.signal.throwIfAborted();
        if (closing) {
          throw new Error("This connection was replaced. Refresh to use the current source.");
        }
        const key = `${cacheKey ?? ""}::${limit}::${sql}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < ttl) {
          hits++;
          return { ...hit.value, cached: true };
        }
        misses++;

        const conn = await acquire(budget.signal);
        try {
          const t0 = performance.now();
          const reader = await interruptibleDuckdb(conn, budget.signal, () =>
            conn.runAndReadAll(sql),
          );
          const rows = reader.getRows().slice(0, limit);
          const value: QueryResult = {
            columns: reader.columnNames(),
            rows: rows.map((r: any[]) => r.map(normalize)),
            sql,
            ms: Math.round(performance.now() - t0),
          };
          if (cache.size >= max) {
            cache.delete(cache.keys().next().value as string);
          }
          cache.set(key, { at: Date.now(), value });
          return value;
        } finally {
          release(conn);
        }
      } finally {
        budget.dispose();
      }
    },

    async catalog(): Promise<CatalogTable[]> {
      const r = await self.execute(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`,
        5000,
        "catalog",
      );
      const byTable = new Map<string, { name: string; type: string }[]>();
      for (const row of r.rows) {
        const tableName = String(row[0]);
        const colName = String(row[1]);
        const colType = String(row[2]);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || tableName.startsWith("_")) {
          continue;
        }
        const cols = byTable.get(tableName) ?? [];
        cols.push({ name: colName, type: colType });
        byTable.set(tableName, cols);
      }
      return Array.from(byTable.entries()).map(([name, columns]) => ({
        name,
        columns,
      }));
    },

    stats: () => ({
      ...leases.stats(),
      cached: cache.size,
      hits,
      misses,
      hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(3) : 0,
    }),

    close() {
      cache.clear();
      return (closing ??= leases.close().finally(() => {
        cache.clear();
        instance.closeSync();
      }));
    },
  };

  return self;
}

function normalize(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof DuckDBDecimalValue) return v.toString();
  if (typeof v === "bigint") {
    return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  }
  if (typeof v === "object") {
    if (typeof v.toString === "function" && (v.days !== undefined || v.micros !== undefined)) {
      return v.toString();
    }
    if (v instanceof Date) return v.toISOString();
  }
  return v;
}
