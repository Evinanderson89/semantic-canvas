import { Pool, type PoolConfig } from "pg";
import type { CatalogTable, Connector, ExecutionOptions, QueryResult } from "./types.ts";
import { executionBudget } from "./execution.ts";

export interface PostgresOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  schema?: string;
  ssl?: boolean | string;
  poolSize?: number;
  /** Injectable pool for deterministic unit tests. */
  pool?: Pick<Pool, "connect" | "end">;
}

const VALID_GRAINS = new Set(["day", "week", "month", "quarter", "year"]);
// PostgreSQL built-in OIDs (pg_type): INT8=20, FLOAT4=700, FLOAT8=701, DATE=1082, NUMERIC=1700.
const PG_OID_DATE = 1082;
const PG_OID_INT8 = 20;
const PG_OID_NUMERIC = 1700;

function normalizeValue(v: unknown, dataTypeID?: number): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return dataTypeID === PG_OID_DATE ? v.toISOString().slice(0, 10) : v.toISOString();
  }
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "string") {
    if (dataTypeID === PG_OID_INT8) {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : v;
    }
    if (dataTypeID === PG_OID_NUMERIC) {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
  }
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return v;
}

/**
 * PostgreSQL warehouse connector (Supabase, RDS, Neon, Cloud SQL, self-hosted).
 * Every query runs inside a READ ONLY transaction with an explicit statement_timeout
 * derived from the request execution budget.
 */
export async function postgresConnector(opts: PostgresOptions): Promise<Connector> {
  const defaultSchema = (opts.schema || "public").trim() || "public";
  const sslEnabled = opts.ssl === true || opts.ssl === "true" || opts.ssl === "require" || opts.ssl === "1";

  const poolConfig: PoolConfig = opts.connectionString
    ? {
        connectionString: opts.connectionString,
        max: opts.poolSize ?? 6,
        ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
      }
    : {
        host: opts.host || "localhost",
        port: opts.port ? Number(opts.port) : 5432,
        database: opts.database,
        user: opts.username,
        password: opts.password,
        max: opts.poolSize ?? 6,
        ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
      };

  const pool = opts.pool ?? new Pool(poolConfig);
  const quote = (i: string) => `"${i.replace(/"/g, '""')}"`;

  const execute = async (sql: string, limit = 5000, _cacheKey?: string, options?: ExecutionOptions): Promise<QueryResult> => {
    const budget = executionBudget(options);
    const client = await pool.connect();
    const t0 = performance.now();
    try {
      if (budget.signal?.aborted) throw budget.signal.reason ?? new Error("Query cancelled");
      const timeoutMs = Math.max(1000, Math.min(300_000, Math.round(options?.timeoutMs ?? 30_000)));
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const res = await client.query({ text: sql, rowMode: "array" });
      await client.query("COMMIT");
      const columns = res.fields.map((f) => f.name);
      const rows = res.rows.slice(0, limit).map((r) => r.map((cell: unknown, idx: number) => normalizeValue(cell, res.fields[idx]?.dataTypeID)));
      return {
        columns,
        rows,
        sql,
        ms: Math.round(performance.now() - t0),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
      budget.dispose();
    }
  };

  return {
    id: "postgres",
    label: "PostgreSQL",
    quote,
    dateTrunc(grain, expr) {
      const g = VALID_GRAINS.has(grain) ? grain : "day";
      return `CAST(date_trunc('${g}', ${expr}) AS DATE)`;
    },
    dateAdd(unit, expr, n) {
      const step = Math.trunc(n);
      return `CAST((${expr} + INTERVAL '${step} ${unit}') AS DATE)`;
    },
    toTimezone(expr, timezone) {
      return `((${expr})::timestamptz AT TIME ZONE '${timezone.replace(/'/g, "''")}')`;
    },
    relation(table, physical) {
      const schema = physical?.schema || defaultSchema;
      const tbl = physical?.table || table;
      return `${quote(schema)}.${quote(tbl)}`;
    },

    execute,

    async catalog(): Promise<CatalogTable[]> {
      const res = await execute(
        `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = '${defaultSchema.replace(/'/g, "''")}'
         ORDER BY table_name, ordinal_position`,
        50_000,
      );
      const byTable = new Map<string, CatalogTable>();
      for (const [tableName, colName, dataType] of res.rows) {
        const name = String(tableName);
        let entry = byTable.get(name);
        if (!entry) {
          entry = { name, columns: [], relation: { schema: defaultSchema, table: name } };
          byTable.set(name, entry);
        }
        entry.columns.push({ name: String(colName), type: String(dataType).toUpperCase() });
      }
      return [...byTable.values()];
    },

    async close() {
      await pool.end();
    },
  };
}
