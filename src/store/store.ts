import { z } from "zod";
import type { DashboardSpec } from "../compiler/spec.ts";
import { activityRecordSchema, type ActivityRecord, type ActivityScope } from "../activity/model.ts";
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
  await conn().run(`CREATE TABLE IF NOT EXISTS chart_activity (
    id VARCHAR PRIMARY KEY, type VARCHAR NOT NULL, source_id VARCHAR NOT NULL,
    dashboard_id VARCHAR NOT NULL, tile_id VARCHAR NOT NULL, audience VARCHAR NOT NULL,
    owner_id VARCHAR NOT NULL, body VARCHAR NOT NULL
  )`);
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
    const tileIds = d.spec.tiles.map(t => t.id);
    await conn().run(`DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?${tileIds.length ? ` AND tile_id NOT IN (${tileIds.map(() => "?").join(",")})` : ""}`, [d.id, scope.source, ...tileIds]);
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
  await conn().run("DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?", [id, scope.source]);
  return { ok: true };
});

const librarySchema = z.object({ format: z.literal("semantic-canvas-library"), version: z.literal(1), createdAt: z.string(), dashboards: z.array(z.object({
  id: z.string().min(1), name: z.string(), source: z.string().nullable(), model: z.string(), spec: dashboardSchema, canvas: canvasSchema,
  revision: z.number().int().min(1), schemaVersion: z.literal(1), updatedAt: z.string().datetime(),
})), activity: z.array(activityRecordSchema).max(100000).default([]) }).strict();
/** Serialized with saves; includes discussions and alert observations, never credentials or full query results. */
export const exportLibrary = () => serialized(async () => {
  const rows = (await conn().runAndReadAll("SELECT id, name, source_id, model, spec, canvas, revision, schema_version, updated_at::VARCHAR FROM dashboards ORDER BY id")).getRows();
  return { format: "semantic-canvas-library", version: 1, createdAt: new Date().toISOString(), activity: await readActivityRows(), dashboards: rows.map(r => ({ id: String(r[0]), name: String(r[1]), source: r[2] == null ? null : String(r[2]), model: String(r[3]), spec: JSON.parse(String(r[4])), canvas: JSON.parse(String(r[5])), revision: Number(r[6]), schemaVersion: Number(r[7]), updatedAt: new Date(String(r[8]) + "Z").toISOString() })) };
});
/** Restore is offline and only into an empty store. Never silently replaces company work. */
export const restoreLibrary = (input: unknown) => serialized(async () => {
  const backup = librarySchema.parse(input);
  if (new Set(backup.dashboards.map(d => d.id)).size !== backup.dashboards.length) throw new Error("Backup contains duplicate dashboard IDs");
  if (Number((await conn().runAndReadAll("SELECT count(*) FROM dashboards")).getRows()[0][0])) throw new Error("Restore requires an empty dashboard database");
  await conn().run("BEGIN TRANSACTION");
  try {
    for (const d of backup.dashboards) await conn().run("INSERT INTO dashboards (id, name, source_id, model, spec, canvas, revision, schema_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [d.id, d.name, d.source, d.model, JSON.stringify(d.spec), JSON.stringify(d.canvas), d.revision, d.schemaVersion, d.updatedAt]);
    for (const r of backup.activity) {
      const d = backup.dashboards.find(d => d.id === r.dashboardId && d.source === r.source);
      if (!d || !d.spec.tiles.some(t => t.id === r.tileId)) throw new Error("Activity references a missing chart");
      // Restored watches require explicit review before querying a possibly different deployment.
      if (r.type === "alert") (r.body as any).enabled = false;
      await writeActivityRow(r as ActivityRecord);
    }
    await conn().run("COMMIT"); return { restored: backup.dashboards.length };
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});


function activityFromRow(r: unknown[]): ActivityRecord {
  return { id: String(r[0]), type: String(r[1]) as ActivityRecord["type"], source: String(r[2]), dashboardId: String(r[3]), tileId: String(r[4]), audience: String(r[5]), ownerId: String(r[6]), body: JSON.parse(String(r[7])) };
}
async function readActivityRows() {
  return (await conn().runAndReadAll("SELECT id, type, source_id, dashboard_id, tile_id, audience, owner_id, body FROM chart_activity")).getRows().map(activityFromRow);
}
async function writeActivityRow(r: ActivityRecord) {
  await conn().run("DELETE FROM chart_activity WHERE id = ?", [r.id]);
  await conn().run("INSERT INTO chart_activity VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [r.id, r.type, r.source, r.dashboardId, r.tileId, r.audience, r.ownerId, JSON.stringify(r.body)]);
}
export const listActivity = (scope: ActivityScope, ownerId: string) => serialized(async () =>
  (await conn().runAndReadAll("SELECT id, type, source_id, dashboard_id, tile_id, audience, owner_id, body FROM chart_activity WHERE source_id = ? AND dashboard_id = ? AND audience = ? AND (type = 'thread' OR owner_id = ?)", [scope.source, scope.dashboardId, scope.audience, ownerId])).getRows().map(activityFromRow));
export const dueAlerts = (now: string) => serialized(async () => (await readActivityRows()).filter(r => r.type === "alert" && (r.body as any).enabled && (r.body as any).nextCheckAt <= now));
/** Every read-modify-write is atomic and serialized with dashboard saves/deletes. */
export const mutateActivity = (scope: ActivityScope, tileId: string, change: (rows: ActivityRecord[], document: DashboardSpec) => ActivityRecord | { deleteId: string } | null) => serialized(async () => {
  const dashboard = (await conn().runAndReadAll("SELECT spec FROM dashboards WHERE id = ? AND source_id = ?", [scope.dashboardId, scope.source])).getRows()[0];
  if (!dashboard || !JSON.parse(String(dashboard[0])).tiles.some((t: any) => t.id === tileId)) throw Object.assign(new Error("Save this chart before adding activity"), { status: 404 });
  const rows = (await conn().runAndReadAll("SELECT id, type, source_id, dashboard_id, tile_id, audience, owner_id, body FROM chart_activity WHERE source_id = ? AND dashboard_id = ? AND tile_id = ? AND audience = ?", [scope.source, scope.dashboardId, tileId, scope.audience])).getRows().map(activityFromRow);
  const next = change(rows, JSON.parse(String(dashboard[0])));
  if (!next) return null;
  if (!("deleteId" in next)) {
    activityRecordSchema.parse(next);
    if (next.source !== scope.source || next.dashboardId !== scope.dashboardId || next.tileId !== tileId || next.audience !== scope.audience) throw new Error("Activity scope mismatch");
    if (!rows.some(r => r.id === next.id) && rows.filter(r => r.type === next.type).length >= (next.type === "thread" ? 100 : 1000)) throw Object.assign(new Error("This chart has reached its activity limit"), { status: 409 });
  } else if (!rows.some(r => r.id === next.deleteId)) throw Object.assign(new Error("Activity not found"), { status: 404 });
  await conn().run("BEGIN TRANSACTION");
  try {
    if ("deleteId" in next) await conn().run("DELETE FROM chart_activity WHERE id = ?", [next.deleteId]);
    else await writeActivityRow(next);
    await conn().run("COMMIT"); return next;
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
