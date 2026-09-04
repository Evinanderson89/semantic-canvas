import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dashboards persist in DuckDB, next to the connection rather than in the
 * browser: localStorage dies with a cache clear and cannot be shared, committed
 * or backed up.
 *
 * Deliberately a SEPARATE database file, not a table inside the user's
 * warehouse. Writing our furniture into someone's Snowflake is presumptuous,
 * and the read-only posture everywhere else in this tool would have to be
 * abandoned to do it. The interface below is small enough that a warehouse-table
 * implementation can be added later for teams that want shared dashboards.
 */
export interface SavedDashboard {
  id: string;
  name: string;
  model: string;
  spec: string;
  updated_at: string;
}

import type { DuckDBConnection } from "@duckdb/node-api";

let connection: DuckDBConnection | null = null;
/** Throws rather than yielding `Cannot read properties of null` inside a handler. */
function conn(): DuckDBConnection {
  if (!connection) throw new Error("dashboard store not opened; call openStore() first");
  return connection;
}

export async function openStore(path?: string) {
  const dir = join(homedir(), ".semantic-canvas");
  await mkdir(dir, { recursive: true });
  const file = path ?? join(dir, "dashboards.duckdb");
  const instance = await DuckDBInstance.create(file);
  connection = await instance.connect();
  await conn().run(`CREATE TABLE IF NOT EXISTS dashboards (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    model VARCHAR NOT NULL,
    spec VARCHAR NOT NULL,
    canvas VARCHAR NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )`);
  return file;
}

/**
 * Everything below is parameterised. Dashboard titles are user text and the spec
 * is a JSON blob; concatenating either into SQL is how the injection in the
 * query compiler happened, and a hand-rolled escaper is not a second chance.
 */
export async function listDashboards(model: string) {
  const r = await conn().runAndReadAll(
    `SELECT id, name, updated_at FROM dashboards WHERE model = ?
      ORDER BY updated_at DESC`, [model]);
  return r.getRows().map((row: any[]) => ({
    id: String(row[0]), name: String(row[1]), updated_at: String(row[2]),
  }));
}

export async function saveDashboard(d: {
  id: string; name: string; model: string; spec: unknown; canvas: unknown;
}) {
  // JSON.stringify(undefined) returns the JS value undefined, not a string --
  // an omitted canvas (or spec) then reaches DuckDB's parameter binder as an
  // untyped value it can't bind ("Cannot create values of type ANY"), not as
  // a clean validation error. Every caller that always sends both (the
  // browser) never hit this; the MCP server's canvas-is-optional tool did.
  await conn().run(
    `INSERT OR REPLACE INTO dashboards VALUES (?, ?, ?, ?, ?, now())`,
    [d.id, d.name, d.model, JSON.stringify(d.spec ?? {}), JSON.stringify(d.canvas ?? {})]);
  return { ok: true };
}

export async function loadDashboard(id: string) {
  const r = await conn().runAndReadAll(
    `SELECT name, spec, canvas FROM dashboards WHERE id = ?`, [id]);
  const row = r.getRows()[0];
  if (!row) return null;
  return { name: String(row[0]), spec: JSON.parse(String(row[1])), canvas: JSON.parse(String(row[2])) };
}

export async function deleteDashboard(id: string) {
  await conn().run(`DELETE FROM dashboards WHERE id = ?`, [id]);
  return { ok: true };
}
