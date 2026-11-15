import { connectionPoolSize, leasePool } from "./leases.ts";
import snowflake from "snowflake-sdk";
import type { Connector, QueryResult, ExecutionOptions } from "./types.ts";
import { executionBudget } from "./execution.ts";

/**
 * Snowflake connector.
 *
 * Authenticates with a dedicated service account -- key-pair by preference,
 * since password auth for service accounts is what security review objects to.
 * All aggregation is pushed down: this issues SQL and returns rows, and never
 * pulls a table into the process to aggregate locally.
 */
export interface SnowflakeConfig {
  account: string;
  username: string;
  /** Either a private key (key-pair auth) or a password. */
  privateKey?: string;
  privateKeyPass?: string;
  password?: string;
  role?: string;
  warehouse: string;
  database: string;
  schema: string;
  poolSize?: number;
}

export function snowflakeConfigFromEnv(): SnowflakeConfig | null {
  const e = process.env;
  if (!e.SNOWFLAKE_ACCOUNT || !e.SNOWFLAKE_USER) return null;
  return {
    account: e.SNOWFLAKE_ACCOUNT,
    username: e.SNOWFLAKE_USER,
    privateKey: e.SNOWFLAKE_PRIVATE_KEY,
    privateKeyPass: e.SNOWFLAKE_PRIVATE_KEY_PASS,
    password: e.SNOWFLAKE_PASSWORD,
    role: e.SNOWFLAKE_ROLE,
    warehouse: e.SNOWFLAKE_WAREHOUSE ?? "COMPUTE_WH",
    database: e.SNOWFLAKE_DATABASE ?? "",
    schema: e.SNOWFLAKE_SCHEMA ?? "PUBLIC",
    poolSize: Number(e.SNOWFLAKE_POOL ?? 6),
  };
}

export async function snowflakeConnector(
  cfg: SnowflakeConfig,
): Promise<Connector & { schema(): Promise<SchemaTable[]>; stats(): object }> {
  const size = connectionPoolSize(cfg.poolSize ?? 6);

  const makeConn = () => snowflake.createConnection({
    account: cfg.account,
    username: cfg.username,
    ...(cfg.privateKey
      ? { authenticator: "SNOWFLAKE_JWT", privateKey: cfg.privateKey,
          privateKeyPass: cfg.privateKeyPass }
      : { password: cfg.password }),
    role: cfg.role,
    warehouse: cfg.warehouse,
    database: cfg.database,
    schema: cfg.schema,
    // fetchAsString otherwise represents SQL NULL as the text "NULL".
    representNullAsStringNull: false,
    clientSessionKeepAlive: true,
  } as any);

  const connect = (c: any) => new Promise<any>((res, rej) =>
    c.connect((err: any) => (err ? rej(err) : res(c))));
  const destroy = (c: any) => new Promise<void>((resolve, reject) =>
    c.destroy((error: Error | null) => error ? reject(error) : resolve()));
  // A failed attempt must not orphan sessions that connect later. Track every
  // allocated handle, including one whose connect callback fails or throws.
  const allocated: any[] = [];
  const attempts = await Promise.allSettled(Array.from({ length: size }, async () => {
    const conn = makeConn();
    allocated.push(conn);
    return connect(conn);
  }));
  const failure = attempts.find(attempt => attempt.status === "rejected");
  if (failure?.status === "rejected") {
    await Promise.allSettled(allocated.map(conn => Promise.resolve().then(() => destroy(conn))));
    throw failure.reason;
  }
  const pool = attempts.flatMap(attempt => attempt.status === "fulfilled" ? [attempt.value] : []);
  const leases = leasePool(pool, destroy);
  const { acquire, release } = leases;

  const exec = (c: any, sqlText: string, signal?: AbortSignal, timeoutMs?: number) => new Promise<any[]>((res, rej) => {
    signal?.throwIfAborted();
    let statement: any, settled = false;
    const cancel = () => {
      // Cancellation is best effort. Do not release the lease until complete;
      // the per-statement warehouse timeout also bounds work if cancel fails.
      if (!settled) { try { statement?.cancel(() => {}); } catch { /* await completion */ } }
    };
    // Ask before SDK decoding: rounding an identifier cannot be undone later.
    statement = c.execute({ sqlText, fetchAsString: ["Number"],
      ...(timeoutMs === undefined ? {} : { parameters: {
        STATEMENT_TIMEOUT_IN_SECONDS: Math.max(1, Math.ceil(timeoutMs / 1000)),
        STATEMENT_QUEUED_TIMEOUT_IN_SECONDS: Math.max(1, Math.ceil(timeoutMs / 1000)),
      } }),
      complete: (err: any, _s: any, rows: any[]) => {
        settled = true;
        signal?.removeEventListener("abort", cancel);
        if (signal?.aborted) rej(signal.reason);
        else if (err) rej(err);
        else res(rows ?? []);
      },
    });
    if (!settled) {
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    }
  });

  const quote = (i: string) => `"${i.replace(/"/g, '""')}"`;
  const qualify = (t: string) =>
    [cfg.database, cfg.schema, t].filter(Boolean).map(quote).join(".");

  const self: Connector & { schema(): Promise<SchemaTable[]>; stats(): object } = {
    id: "snowflake", label: `Snowflake (${cfg.account}/${cfg.database}.${cfg.schema})`,
    quote,
    // Snowflake spells this the same as DuckDB, but the unit must be unquoted.
    dateTrunc: (grain, expr) => `DATE_TRUNC(${grain}, ${expr})`,
    dateAdd: (unit, expr, n) => `DATEADD(${unit}, ${n}, ${expr})`,
    toTimezone: (expr, timezone) => `CONVERT_TIMEZONE('UTC', '${timezone.replace(/'/g, "''")}', ${expr})`,
    relation: (table, physical) => physical ? [physical.database ?? cfg.database, physical.schema ?? cfg.schema, physical.table].filter(Boolean).map(quote).join(".") : qualify(table),

    async execute(sql: string, limit = 5000, _cacheKey?: string, options?: ExecutionOptions): Promise<QueryResult> {
      const budget = executionBudget(options);
      try {
        const conn = await acquire(budget.signal);
        try {
          const t0 = performance.now();
          const rows = await exec(conn, sql, budget.signal, options?.timeoutMs);
          const columns = rows.length ? Object.keys(rows[0]) : [];
          return {
            columns,
            rows: rows.slice(0, limit).map((r) => columns.map((c) => normalize(r[c]))),
            sql, ms: Math.round(performance.now() - t0),
          };
        } finally { release(conn); }
      } finally { budget.dispose(); }
    },

    /** The Modeler's view of the schema: the same listing, in the connector's shared shape. */
    async catalog() { return (await self.schema()).map((t) => ({ name: t.name, columns: t.columns, relation: { table: t.name } })); },

    /** Read the warehouse schema -- step 1's "schema is fully readable". */
    async schema(): Promise<SchemaTable[]> {
      const conn = await acquire();
      try {
        const rows = await exec(conn,
          `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
             FROM ${cfg.database ? `${quote(cfg.database)}.` : ""}INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = '${cfg.schema.replace(/'/g, "''")}'
            ORDER BY TABLE_NAME, ORDINAL_POSITION`);
        const byTable = new Map<string, SchemaTable>();
        for (const r of rows) {
          const t = String(r.TABLE_NAME);
          if (!byTable.has(t)) byTable.set(t, { name: t, columns: [] });
          byTable.get(t)!.columns.push({
            name: String(r.COLUMN_NAME), type: String(r.DATA_TYPE).toLowerCase(),
          });
        }
        return [...byTable.values()];
      } finally { release(conn); }
    },

    stats: leases.stats,
    close: leases.close,
  };
  return self;
}

export interface SchemaTable { name: string; columns: { name: string; type: string }[] }

function normalize(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) {
    const iso = v.toISOString();
    // The SDK returns timestamps as Date objects with an optional nanosecond
    // accessor. Preserve the instant and supplied precision before JSON/export;
    // its custom toJSON uses session-specific display formatting instead.
    const nanos = typeof (v as any).getNanoSeconds === "function" ? (v as any).getNanoSeconds() : undefined;
    return Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9 && nanos % 1e6 !== 0
      ? iso.replace(/\.\d{3}Z$/, `.${String(nanos).padStart(9, "0")}Z`) : iso;
  }
  return v;
}
