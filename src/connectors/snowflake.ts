import { leasePool } from "./leases.ts";
import snowflake from "snowflake-sdk";
import type { Connector, QueryResult } from "./types.ts";

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
  const size = cfg.poolSize ?? 6;

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
    clientSessionKeepAlive: true,
  } as any);

  const connect = (c: any) => new Promise<any>((res, rej) =>
    c.connect((err: any) => (err ? rej(err) : res(c))));

  const pool: any[] = await Promise.all(
    Array.from({ length: size }, () => connect(makeConn())));
  const leases = leasePool(pool, c => new Promise<void>((resolve, reject) => c.destroy((error: Error | null) => error ? reject(error) : resolve())));
  const { acquire, release } = leases;

  const exec = (c: any, sqlText: string) => new Promise<any[]>((res, rej) =>
    c.execute({ sqlText, complete: (err: any, _s: any, rows: any[]) =>
      err ? rej(err) : res(rows ?? []) }));

  const quote = (i: string) => `"${i.replace(/"/g, '""')}"`;
  const qualify = (t: string) =>
    [cfg.database, cfg.schema, t].filter(Boolean).map(quote).join(".");

  return {
    id: "snowflake", label: `Snowflake (${cfg.account}/${cfg.database}.${cfg.schema})`,
    quote,
    // Snowflake spells this the same as DuckDB, but the unit must be unquoted.
    dateTrunc: (grain, expr) => `DATE_TRUNC(${grain}, ${expr})`,
    dateAdd: (unit, expr, n) => `DATEADD(${unit}, ${n}, ${expr})`,
    relation: (table, physical) => physical ? [physical.database ?? cfg.database, physical.schema ?? cfg.schema, physical.table].filter(Boolean).map(quote).join(".") : qualify(table),

    async execute(sql: string, limit = 5000): Promise<QueryResult> {
      const conn = await acquire();
      try {
        const t0 = performance.now();
        const rows = await exec(conn, sql);
        const columns = rows.length ? Object.keys(rows[0]) : [];
        return {
          columns,
          rows: rows.slice(0, limit).map((r) => columns.map((c) => normalize(r[c]))),
          sql, ms: Math.round(performance.now() - t0),
        };
      } finally { release(conn); }
    },

    /** Read the warehouse schema -- step 1's "schema is fully readable". */
    async schema(): Promise<SchemaTable[]> {
      const conn = await acquire();
      try {
        const rows = await exec(conn,
          `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
             FROM ${`"${cfg.database}"`}.INFORMATION_SCHEMA.COLUMNS
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
}

export interface SchemaTable { name: string; columns: { name: string; type: string }[] }

function normalize(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}
