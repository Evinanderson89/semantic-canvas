import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canvasSchema, dashboardSchema, saveSchema } from "../compiler/schema.ts";
import { DEFAULT_CANVAS } from "../canvas/presets.ts";

export interface DashboardScope { source: string; model: string }
export class StoreConflict extends Error { status = 409; }
let connection: DuckDBConnection | null = null;
let storeInstance: DuckDBInstance | null = null;
// DuckDB connections execute one transaction at a time. Serialize reads too,
// so no request sees the temporary delete inside a replacement transaction.
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
}
function conn(): DuckDBConnection {
  if (!connection) throw new Error("dashboard store is not open");
  return connection;
}
export async function openStore(path?: string) {
  const file = path ?? join(process.env.SC_DATA_DIR ?? join(homedir(), ".semantic-canvas"), "dashboards.duckdb");
  if (file !== ":memory:") await mkdir(dirname(file), { recursive: true });
  storeInstance = await DuckDBInstance.create(file);
  connection = await storeInstance.connect();
  await conn().run(`CREATE TABLE IF NOT EXISTS dashboards (
    id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL,
    spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL
  )`);
  // Additive migration: existing dashboard JSON is never rewritten or deleted.
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS source_id VARCHAR");
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1");
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS revision INTEGER DEFAULT 1");
  return file;
}
export async function closeStore() { await pending; connection?.closeSync(); storeInstance?.closeSync(); connection = null; storeInstance = null; }
/** Legacy saves knew only the model name. Claim them only when that name has one source. */
export const migrateLegacySources = (scopes: DashboardScope[]) => serialized(async () => {
  for (const scope of scopes) {
    if (scopes.filter((s) => s.model === scope.model).length !== 1) continue;
    await conn().run("UPDATE dashboards SET source_id = ? WHERE model = ? AND source_id IS NULL", [scope.source, scope.model]);
  }
});
export const listDashboards = (scope: DashboardScope) => serialized(async () => {
  const r = await conn().runAndReadAll(
    "SELECT id, name, updated_at, revision FROM dashboards WHERE source_id = ? ORDER BY updated_at DESC", [scope.source]);
  return r.getRows().map((row) => ({ id: String(row[0]), name: String(row[1]), updated_at: String(row[2]), revision: Number(row[3]) }));
});
export const saveDashboard = (input: unknown, scope: DashboardScope) => serialized(async () => {
  const d = saveSchema.parse(input);
  await conn().run("BEGIN TRANSACTION");
  try {
    const current = (await conn().runAndReadAll("SELECT source_id, revision FROM dashboards WHERE id = ?", [d.id])).getRows()[0];
    if (current ? String(current[0]) !== scope.source || Number(current[1]) !== d.revision : d.revision !== 0)
      throw new StoreConflict("This dashboard changed or belongs to another source. Reopen the latest version, or save your edits as a copy.");
    const revision = d.revision + 1;
    // Updating a large VARCHAR can trigger DuckDB's indexed UPDATE limitation.
    // Explicit delete + insert in one transaction preserves atomic replacement.
    if (current) await conn().run("DELETE FROM dashboards WHERE id = ?", [d.id]);
    await conn().run(`INSERT INTO dashboards
      (id, name, model, spec, canvas, updated_at, source_id, schema_version, revision)
      VALUES (?, ?, ?, ?, ?, now(), ?, ?, ?)`, [d.id, d.name || d.spec.title, scope.model,
      JSON.stringify(d.spec), JSON.stringify(d.canvas), scope.source, d.schemaVersion, revision]);
    await conn().run("COMMIT");
    return { ok: true, id: d.id, revision, schemaVersion: d.schemaVersion };
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
export const loadDashboard = (id: string, scope: DashboardScope) => serialized(async () => {
  const r = await conn().runAndReadAll(
    "SELECT name, spec, canvas, revision, schema_version FROM dashboards WHERE id = ? AND source_id = ?", [id, scope.source]);
  const row = r.getRows()[0];
  if (!row) return null;
  if (Number(row[4]) !== 1) throw new Error("This dashboard requires a newer version of Semantic Canvas");
  return { id, name: String(row[0]), spec: dashboardSchema.parse(JSON.parse(String(row[1]))),
    canvas: canvasSchema.parse({ ...DEFAULT_CANVAS, ...JSON.parse(String(row[2])) }), revision: Number(row[3]), schemaVersion: 1 };
});
export const deleteDashboard = (id: string, scope: DashboardScope, revision: number) => serialized(async () => {
  const r = await conn().runAndReadAll("DELETE FROM dashboards WHERE id = ? AND source_id = ? AND revision = ? RETURNING id", [id, scope.source, revision]);
  if (!r.getRows().length) throw new StoreConflict("Dashboard changed or was not found; reopen it before deleting");
  return { ok: true };
});
