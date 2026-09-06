import { DuckDBInstance } from "@duckdb/node-api";
import type { Connector, QueryResult } from "./types.ts";

/**
 * A small connection pool plus a result cache.
 *
 * The single-connection server scaled linearly under load -- 70 queries took
 * 285ms, 350 took 1472ms -- because every request queued behind the last. A
 * pool lets independent queries actually overlap.
 *
 * The cache matters more: a dashboard fires the same handful of queries for
 * every viewer, so under concurrency almost all of the work is duplicated.
 */
export interface PooledOptions { size?: number; cacheTtlMs?: number; cacheMax?: number }

interface Entry { at: number; value: QueryResult }

export async function pooledDuckdb(
  lakeRoot: string, opts: PooledOptions = {},
): Promise<Connector & { stats(): object }> {
  const size = opts.size ?? 4;
  const ttl = opts.cacheTtlMs ?? 15_000;
  const max = opts.cacheMax ?? 500;

  const instance = await DuckDBInstance.create(":memory:");
  const conns = await Promise.all(Array.from({ length: size }, () => instance.connect()));
  const free: any[] = [...conns];
  const waiting: ((c: any) => void)[] = [];
  let hits = 0, misses = 0;

  const acquire = (): Promise<any> =>
    free.length ? Promise.resolve(free.pop()) : new Promise((r) => waiting.push(r));
  const release = (c: any) => {
    const next = waiting.shift();
    if (next) next(c); else free.push(c);
  };

  const cache = new Map<string, Entry>();

  const root = lakeRoot.replace(/\/$/, "");
  return {
    id: "duckdb", label: "DuckDB (pooled)",
    quote: (i) => `"${i.replace(/"/g, '""')}"`,
    dateTrunc: (grain, expr) => `date_trunc('${grain}', ${expr})`,
    dateAdd: (unit, expr, n) => `(${expr} + INTERVAL '${n} ${unit}')`,
    relation: (table) =>
      `read_parquet('${root}/${table}/**/*.parquet', hive_partitioning = true, union_by_name = true)`,

    async execute(sql: string, limit = 5000, cacheKey?: string): Promise<QueryResult> {
      // The key MUST include the caller's scope. Caching on SQL alone is fine
      // here only because row-level security is compiled INTO the SQL -- two
      // principals produce different text. If RLS were ever applied outside the
      // query, this cache would serve one user's rows to another.
      const key = `${cacheKey ?? ""}::${limit}::${sql}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) { hits++; return { ...hit.value, cached: true } as any; }
      misses++;

      const conn = await acquire();
      try {
        const t0 = performance.now();
        const reader = await conn.runAndReadAll(sql);
        const rows = reader.getRows().slice(0, limit);
        const value: QueryResult = {
          columns: reader.columnNames(),
          rows: rows.map((r: any[]) => r.map(normalize)),
          sql, ms: Math.round(performance.now() - t0),
        };
        if (cache.size >= max) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: Date.now(), value });
        return value;
      } finally { release(conn); }
    },

    stats: () => ({ poolSize: size, free: free.length, waiting: waiting.length,
                    cached: cache.size, hits, misses,
                    hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(3) : 0 }),
    async close() { cache.clear(); },
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
