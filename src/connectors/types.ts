export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  sql: string;
  ms: number;
  cached?: boolean;
}

/**
 * A connector is a SQL endpoint plus the dialect differences that actually
 * bite: how you truncate a date, how you quote an identifier, and how a table
 * name resolves to something scannable.
 */
export interface Connector {
  id: string;
  label: string;
  quote(ident: string): string;
  dateTrunc(grain: string, expr: string): string;
  /** Calendar-correct date arithmetic -- `n` full `unit`s added to `expr`
   *  (negative `n` subtracts). Used to find a coarsened bucket's own END
   *  (e.g. a "month" bucket's last day), which `dateTrunc` alone can't give:
   *  it only rounds an existing date DOWN to a period's start. */
  dateAdd(unit: "day" | "month" | "year", expr: string, n: number): string;
  /** A UTC timestamp expression read in an IANA time zone, as a naive local timestamp; dates pass through unchanged. */
  toTimezone?(expr: string, timezone: string): string;
  /** What to put in FROM for a catalog table. */
  relation(table: string, physical?: { database?: string; schema?: string; table: string }): string;
  execute(sql: string, limit?: number, cacheKey?: string): Promise<QueryResult>;
  /** The warehouse's own catalogue, for the Modeler: every scannable table with its columns and their native types. */
  catalog?(): Promise<CatalogTable[]>;
  close(): Promise<void>;
}

export interface CatalogTable { name: string; columns: { name: string; type: string }[]; relation?: { database?: string; schema?: string; table: string } }
