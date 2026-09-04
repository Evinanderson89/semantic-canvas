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
  /** What to put in FROM for a catalog table. */
  relation(table: string): string;
  execute(sql: string, limit?: number, cacheKey?: string): Promise<QueryResult>;
  close(): Promise<void>;
}
