import { randomUUID } from "node:crypto";
import type { Model } from "../semantic/model.ts";
import { LIBRARY_FOLDERS, folderForDashboard, libraryStarters, orderLibraryFolders } from "../library/setup.ts";
import { z } from "zod";
import type { DashboardSpec } from "../compiler/spec.ts";
import { activityRecordSchema, type ActivityRecord, type ActivityScope } from "../activity/model.ts";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canvasSchema, dashboardSchema, saveSchema } from "../compiler/schema.ts";
import { DEFAULT_CANVAS } from "../canvas/presets.ts";
import { folderSchema, viewSaveSchema, itemKindSchema, itemUpdateSchema, type LibraryFolder, type LibraryItem } from "../library/model.ts";

export interface DashboardScope { source: string; model: string }
export class StoreConflict extends Error { status = 409; }
const missing = () => Object.assign(new Error("Library item not found in this source"), { status: 404 });
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
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS folder_id VARCHAR");
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS is_template BOOLEAN DEFAULT false");
  await conn().run("CREATE TABLE IF NOT EXISTS library_initializations (source_id VARCHAR PRIMARY KEY)");
  await conn().run(`CREATE TABLE IF NOT EXISTS library_folders (
    id VARCHAR PRIMARY KEY, source_id VARCHAR NOT NULL, name VARCHAR NOT NULL, parent_id VARCHAR, revision INTEGER NOT NULL
  )`);
  await conn().run(`CREATE TABLE IF NOT EXISTS library_views (
    id VARCHAR PRIMARY KEY, source_id VARCHAR NOT NULL, model VARCHAR NOT NULL, name VARCHAR NOT NULL, description VARCHAR NOT NULL,
    folder_id VARCHAR, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, revision INTEGER NOT NULL, updated_at TIMESTAMP NOT NULL
  )`);
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
    "SELECT id, name, updated_at, revision, folder_id FROM dashboards WHERE source_id = ? AND NOT coalesce(is_template, false) ORDER BY updated_at DESC", [scope.source]);
  return r.getRows().map((row) => ({ id: String(row[0]), name: String(row[1]), updated_at: String(row[2]), revision: Number(row[3]), folderId: row[4] == null ? null : String(row[4]) }));
});
export const saveDashboard = (input: unknown, scope: DashboardScope) => serialized(async () => {
  const d = saveSchema.parse(input);
  await conn().run("BEGIN TRANSACTION");
  try {
    const current = (await conn().runAndReadAll("SELECT source_id, revision, folder_id, is_template FROM dashboards WHERE id = ?", [d.id])).getRows()[0];
    if (current ? String(current[0]) !== scope.source || Number(current[1]) !== d.revision : d.revision !== 0)
      throw new StoreConflict("This dashboard changed or belongs to another source. Reopen the latest version, or save your edits as a copy.");
    if (current?.[3]) throw new StoreConflict("Open this starter as a new dashboard, then save your own copy.");
    const revision = d.revision + 1;
    const folderId = d.folderId === undefined ? current?.[2] == null ? null : String(current[2]) : d.folderId;
    await requireFolder(folderId, scope.source);
    // Updating a large VARCHAR can trigger DuckDB's indexed UPDATE limitation.
    // Explicit delete + insert in one transaction preserves atomic replacement.
    if (current) await conn().run("DELETE FROM dashboards WHERE id = ?", [d.id]);
    await conn().run(`INSERT INTO dashboards
      (id, name, model, spec, canvas, updated_at, source_id, schema_version, revision, folder_id)
      VALUES (?, ?, ?, ?, ?, now(), ?, ?, ?, ?)`, [d.id, d.name || d.spec.title, scope.model,
      JSON.stringify(d.spec), JSON.stringify(d.canvas), scope.source, d.schemaVersion, revision, folderId]);
    const tileIds = d.spec.tiles.map(t => t.id);
    await conn().run(`DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?${tileIds.length ? ` AND tile_id NOT IN (${tileIds.map(() => "?").join(",")})` : ""}`, [d.id, scope.source, ...tileIds]);
    await conn().run("COMMIT");
    return { ok: true, id: d.id, revision, schemaVersion: d.schemaVersion };
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
export const loadDashboard = (id: string, scope: DashboardScope) => serialized(async () => {
  const r = await conn().runAndReadAll(
    "SELECT name, spec, canvas, revision, schema_version, folder_id, is_template FROM dashboards WHERE id = ? AND source_id = ?", [id, scope.source]);
  const row = r.getRows()[0];
  if (!row) return null;
  if (Number(row[4]) !== 1) throw new Error("This dashboard requires a newer version of Semantic Canvas");
  const spec = dashboardSchema.safeParse(JSON.parse(String(row[1])));
  if (!spec.success) { const issue = spec.error.issues[0]; throw Object.assign(new Error(`Dashboard "${id}" does not match the current schema (${issue?.path.join(".") || "spec"}: ${issue?.message ?? "invalid"}). Fix or remove it from a library backup, then restore.`), { status: 422 }); }
  return { id, name: String(row[0]), spec: spec.data,
    canvas: canvasSchema.parse({ ...DEFAULT_CANVAS, ...JSON.parse(String(row[2])) }), revision: Number(row[3]), schemaVersion: 1, folderId: row[5] == null ? null : String(row[5]), isTemplate: Boolean(row[6]) };
});
export const deleteDashboard = (id: string, scope: DashboardScope, revision: number) => serialized(async () => {
  const r = await conn().runAndReadAll("DELETE FROM dashboards WHERE id = ? AND source_id = ? AND revision = ? RETURNING id", [id, scope.source, revision]);
  if (!r.getRows().length) throw new StoreConflict("Dashboard changed or was not found; reopen it before deleting");
  await conn().run("DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?", [id, scope.source]);
  return { ok: true };
});

const backupDashboardSchema = z.object({
  id: z.string().min(1), name: z.string(), source: z.string().nullable(), model: z.string(), spec: dashboardSchema, canvas: canvasSchema,
  folderId: z.string().nullable().default(null), isTemplate: z.boolean().default(false),
  revision: z.number().int().min(1), schemaVersion: z.literal(1), updatedAt: z.string().datetime(),
});
// Documents are validated one by one so a legacy record names itself instead of failing the whole archive with a Zod dump.
const librarySchema = z.object({ format: z.literal("semantic-canvas-library"), version: z.literal(1), createdAt: z.string(), dashboards: z.array(z.unknown()).max(100000), initializedSources: z.array(z.string().min(1)).max(10000).default([]), activity: z.array(activityRecordSchema).max(100000).default([]),
  folders: z.array(folderSchema.extend({ source: z.string().min(1) })).max(10000).default([]),
  views: z.array(viewSaveSchema.safeExtend({ source: z.string().min(1), model: z.string(), updatedAt: z.string().datetime() })).max(10000).default([]),
}).strict();
/** Serialized with saves; includes discussions and alert observations, never credentials or full query results. */
export const exportLibrary = () => serialized(async () => {
  const rows = (await conn().runAndReadAll("SELECT id, name, source_id, model, spec, canvas, revision, schema_version, updated_at::VARCHAR, folder_id, is_template FROM dashboards ORDER BY id")).getRows();
  const folders = (await conn().runAndReadAll("SELECT id, name, parent_id, revision, source_id FROM library_folders ORDER BY id")).getRows().map(r => ({ ...folderFromRow(r), source: String(r[4]) }));
  const views = (await conn().runAndReadAll("SELECT id, name, description, folder_id, spec, canvas, revision, source_id, model, updated_at::VARCHAR FROM library_views ORDER BY id")).getRows().map(r => ({ ...viewFromRow(r), source: String(r[7]), model: String(r[8]), updatedAt: new Date(String(r[9]) + "Z").toISOString() }));
  const initializedSources = (await conn().runAndReadAll("SELECT source_id FROM library_initializations ORDER BY source_id")).getRows().map(r => String(r[0]));
  return { format: "semantic-canvas-library", version: 1, initializedSources, createdAt: new Date().toISOString(), folders, views, activity: await readActivityRows(), dashboards: rows.map(r => ({ id: String(r[0]), name: String(r[1]), source: r[2] == null ? null : String(r[2]), model: String(r[3]), spec: JSON.parse(String(r[4])), canvas: JSON.parse(String(r[5])), revision: Number(r[6]), schemaVersion: Number(r[7]), updatedAt: new Date(String(r[8]) + "Z").toISOString(), folderId: r[9] == null ? null : String(r[9]), isTemplate: Boolean(r[10]) })) };
});
/** Restore is offline and only into an empty store. Never silently replaces company work. */
export const restoreLibrary = (input: unknown) => serialized(async () => {
  const shell = librarySchema.parse(input), invalid: string[] = [];
  const dashboards = shell.dashboards.flatMap(d => { const parsed = backupDashboardSchema.safeParse(d); if (parsed.success) return [parsed.data]; invalid.push(String((d as any)?.id ?? "(missing id)")); return []; });
  if (invalid.length) throw Object.assign(new Error(`Backup contains ${invalid.length} document${invalid.length === 1 ? "" : "s"} that do not match the current schema: ${invalid.slice(0, 20).join(", ")}. Export again after fixing them, or remove them from the backup.`), { status: 400 });
  const backup = { ...shell, dashboards };
  if (new Set(backup.dashboards.map(d => d.id)).size !== backup.dashboards.length) throw new Error("Backup contains duplicate dashboard IDs");
  if (new Set(backup.folders.map(f => f.id)).size !== backup.folders.length || new Set(backup.views.map(v => v.id)).size !== backup.views.length) throw new Error("Backup contains duplicate library IDs");
  for (const f of backup.folders) validateFolderTree(backup.folders.filter(x => x.source === f.source), f);
  for (const d of [...backup.dashboards, ...backup.views]) if (d.folderId && !backup.folders.some(f => f.id === d.folderId && f.source === d.source)) throw new Error("Backup references a missing library folder");
  if (Number((await conn().runAndReadAll("SELECT (SELECT count(*) FROM dashboards) + (SELECT count(*) FROM library_folders) + (SELECT count(*) FROM library_views) + (SELECT count(*) FROM chart_activity) + (SELECT count(*) FROM library_initializations)")).getRows()[0][0])) throw new Error("Restore requires an empty dashboard database");
  await conn().run("BEGIN TRANSACTION");
  try {
    for (const source of new Set(backup.initializedSources)) await conn().run("INSERT INTO library_initializations VALUES (?)", [source]);
    for (const f of backup.folders) await conn().run("INSERT INTO library_folders VALUES (?, ?, ?, ?, ?)", [f.id, f.source, f.name, f.parentId, f.revision]);
    for (const v of backup.views) await conn().run("INSERT INTO library_views VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [v.id, v.source, v.model, v.name, v.description, v.folderId, JSON.stringify(v.spec), JSON.stringify(v.canvas), v.revision, v.updatedAt]);
    for (const d of backup.dashboards) await conn().run("INSERT INTO dashboards (id, name, source_id, model, spec, canvas, revision, schema_version, updated_at, folder_id, is_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [d.id, d.name, d.source, d.model, JSON.stringify(d.spec), JSON.stringify(d.canvas), d.revision, d.schemaVersion, d.updatedAt, d.folderId, d.isTemplate]);
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


function folderFromRow(r: unknown[]): LibraryFolder {
  return { id: String(r[0]), name: String(r[1]), parentId: r[2] == null ? null : String(r[2]), revision: Number(r[3]) };
}
async function readFolders(source: string) {
  return (await conn().runAndReadAll("SELECT id, name, parent_id, revision FROM library_folders WHERE source_id = ? ORDER BY lower(name), id", [source])).getRows().map(folderFromRow);
}
async function requireFolder(id: string | null, source: string) {
  if (id && !(await conn().runAndReadAll("SELECT id FROM library_folders WHERE id = ? AND source_id = ?", [id, source])).getRows().length) throw missing();
}
function validateFolderTree(folders: LibraryFolder[], changed: LibraryFolder) {
  const all = [...folders.filter(f => f.id !== changed.id), changed];
  if (all.some(f => f.id !== changed.id && f.parentId === changed.parentId && f.name.toLocaleLowerCase() === changed.name.toLocaleLowerCase())) throw new StoreConflict("A folder with this name already exists here");
  for (const folder of all) {
    const seen = new Set([folder.id]); let parent = folder.parentId;
    while (parent) {
      if (seen.has(parent)) throw new StoreConflict("A folder cannot be moved inside itself");
      seen.add(parent); const next = all.find(f => f.id === parent);
      if (!next) throw new StoreConflict("Choose an existing parent folder");
      if (seen.size > 8) throw new StoreConflict("Folders can be nested up to eight levels");
      parent = next.parentId;
    }
  }
}
function viewFromRow(r: unknown[]) {
  return viewSaveSchema.parse({ id: String(r[0]), name: String(r[1]), description: String(r[2]), folderId: r[3] == null ? null : String(r[3]), spec: JSON.parse(String(r[4])), canvas: JSON.parse(String(r[5])), revision: Number(r[6]) });
}
export const listCoreLibrary = (scope: DashboardScope) => serialized(async () => {
  const folders = orderLibraryFolders(await readFolders(scope.source));
  const items: LibraryItem[] = [];
  for (const kind of ["dashboard", "view"] as const) {
    const table = kind === "dashboard" ? "dashboards" : "library_views";
    const rows = (await conn().runAndReadAll(`SELECT id, name, folder_id, revision, updated_at::VARCHAR, json_array_length(spec, '$.tiles'), ${kind === "view" ? "description" : "json_extract_string(spec, '$.description')"}, ${kind === "dashboard" ? "is_template" : "false"} FROM ${table} WHERE source_id = ? ORDER BY lower(name), id`, [scope.source])).getRows();
    items.push(...rows.map(r => ({ id: String(r[0]), kind, name: String(r[1]), folderId: r[2] == null ? null : String(r[2]), revision: Number(r[3]), updatedAt: new Date(String(r[4]) + "Z").toISOString(), tileCount: Number(r[5]), description: r[6] == null ? "" : String(r[6]), ...(r[7] ? { isTemplate: true } : {}) })));
  }
  return { folders, items };
});
export const saveLibraryFolder = (input: unknown, scope: DashboardScope) => serialized(async () => {
  const f = folderSchema.parse(input), folders = await readFolders(scope.source);
  const current = (await conn().runAndReadAll("SELECT source_id, revision FROM library_folders WHERE id = ?", [f.id])).getRows()[0];
  if (current ? String(current[0]) !== scope.source || Number(current[1]) !== f.revision : f.revision !== 0) throw new StoreConflict("This folder changed. Refresh the library and try again.");
  validateFolderTree(folders, f);
  await conn().run("BEGIN TRANSACTION");
  try {
    if (current) await conn().run("DELETE FROM library_folders WHERE id = ?", [f.id]);
    await conn().run("INSERT INTO library_folders VALUES (?, ?, ?, ?, ?)", [f.id, scope.source, f.name, f.parentId, f.revision + 1]);
    await conn().run("COMMIT"); return { ...f, revision: f.revision + 1 };
  } catch (e) { await conn().run("ROLLBACK"); throw e; }
});
export const deleteLibraryFolder = (id: string, revision: number, scope: DashboardScope) => serialized(async () => {
  if (!(await readFolders(scope.source)).some(f => f.id === id && f.revision === revision)) throw new StoreConflict("This folder changed. Refresh the library and try again.");
  for (const [table, field] of [["library_folders", "parent_id"], ["dashboards", "folder_id"], ["library_views", "folder_id"]]) {
    if ((await conn().runAndReadAll(`SELECT id FROM ${table} WHERE source_id = ? AND ${field} = ? LIMIT 1`, [scope.source, id])).getRows().length) throw new StoreConflict("Move this folder’s contents elsewhere before deleting it");
  }
  await conn().run("DELETE FROM library_folders WHERE id = ? AND source_id = ?", [id, scope.source]); return { ok: true };
});
export const loadLibraryView = (id: string, scope: DashboardScope) => serialized(async () => {
  const row = (await conn().runAndReadAll("SELECT id, name, description, folder_id, spec, canvas, revision FROM library_views WHERE id = ? AND source_id = ?", [id, scope.source])).getRows()[0];
  return row ? viewFromRow(row) : null;
});
export const saveLibraryView = (input: unknown, scope: DashboardScope) => serialized(async () => {
  const v = viewSaveSchema.parse(input);
  const current = (await conn().runAndReadAll("SELECT source_id, revision FROM library_views WHERE id = ?", [v.id])).getRows()[0];
  if (current ? String(current[0]) !== scope.source || Number(current[1]) !== v.revision : v.revision !== 0) throw new StoreConflict("This view changed. Reopen it or save a new view.");
  await requireFolder(v.folderId, scope.source);
  await conn().run("BEGIN TRANSACTION");
  try {
    if (current) await conn().run("DELETE FROM library_views WHERE id = ?", [v.id]);
    await conn().run("INSERT INTO library_views VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())", [v.id, scope.source, scope.model, v.name, v.description, v.folderId, JSON.stringify(v.spec), JSON.stringify(v.canvas), v.revision + 1]);
    await conn().run("COMMIT"); return { ok: true, id: v.id, revision: v.revision + 1 };
  } catch (e) { await conn().run("ROLLBACK"); throw e; }
});
export const updateLibraryItem = (kindInput: unknown, id: string, input: unknown, scope: DashboardScope) => serialized(async () => {
  const kind = itemKindSchema.parse(kindInput), patch = itemUpdateSchema.parse(input);
  const table = kind === "dashboard" ? "dashboards" : "library_views";
  const row = (await conn().runAndReadAll(`SELECT name, spec, folder_id, revision FROM ${table} WHERE id = ? AND source_id = ?`, [id, scope.source])).getRows()[0];
  if (!row) throw missing();
  if (Number(row[3]) !== patch.revision) throw new StoreConflict("This item changed. Refresh the library and try again.");
  const folderId = patch.folderId === undefined ? row[2] == null ? null : String(row[2]) : patch.folderId;
  await requireFolder(folderId, scope.source);
  const name = patch.name ?? String(row[0]), spec = { ...JSON.parse(String(row[1])), title: name };
  // A replacement transaction avoids DuckDB indexed VARCHAR update limits and preserves all columns.
  await conn().run("BEGIN TRANSACTION");
  try {
    await conn().run(`CREATE TEMP TABLE library_item_change AS SELECT * FROM ${table} WHERE id = ?`, [id]);
    await conn().run("UPDATE library_item_change SET name = ?, spec = ?, folder_id = ?, revision = ?, updated_at = now()", [name, JSON.stringify(spec), folderId, patch.revision + 1]);
    await conn().run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    await conn().run(`INSERT INTO ${table} SELECT * FROM library_item_change`);
    await conn().run("DROP TABLE library_item_change");
    await conn().run("COMMIT"); return { ok: true, revision: patch.revision + 1 };
  } catch (e) { await conn().run("ROLLBACK"); throw e; }
});
export const deleteLibraryView = (id: string, revision: number, scope: DashboardScope) => serialized(async () => {
  const rows = (await conn().runAndReadAll("DELETE FROM library_views WHERE id = ? AND source_id = ? AND revision = ? RETURNING id", [id, scope.source, revision])).getRows();
  if (!rows.length) throw new StoreConflict("This view changed or was removed. Refresh the library.");
  return { ok: true };
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

/** One transaction per source. Renames, moves and deletions survive future boots and backups. */
export const initializeCoreLibrary = (scope: DashboardScope, model: Model) => serialized(async () => {
  const skipped: string[] = [];
  if ((await conn().runAndReadAll("SELECT source_id FROM library_initializations WHERE source_id = ?", [scope.source])).getRows().length) return skipped;
  const starters = libraryStarters(model), folders = await readFolders(scope.source);
  const ids = new Map<string, string>();
  await conn().run("BEGIN TRANSACTION");
  try {
    for (const definition of LIBRARY_FOLDERS) {
      const parentId = definition.parent ? ids.get(definition.parent)! : null;
      const existing = folders.find(f => f.parentId === parentId && f.name.toLocaleLowerCase() === definition.name.toLocaleLowerCase());
      const id = existing?.id ?? randomUUID(); ids.set(definition.key, id);
      if (!existing) await conn().run("INSERT INTO library_folders VALUES (?, ?, ?, ?, ?)", [id, scope.source, definition.name, parentId, 1]);
    }
    // Move unfiled dashboards only; preserve titles, tiles, activity, revisions, and any deliberate folder choices.
    // A legacy document that no longer parses stays unfiled; boot must never fail because of it.
    const unfiled = (await conn().runAndReadAll("SELECT id, spec FROM dashboards WHERE source_id = ? AND folder_id IS NULL", [scope.source])).getRows();
    for (const row of unfiled) {
      const spec = dashboardSchema.safeParse(JSON.parse(String(row[1])));
      if (!spec.success) { skipped.push(String(row[0])); continue; }
      const key = folderForDashboard(model, spec.data);
      if (key) await conn().run("UPDATE dashboards SET folder_id = ? WHERE id = ? AND source_id = ?", [ids.get(key)!, String(row[0]), scope.source]);
    }
    for (const d of starters) await conn().run(`INSERT INTO dashboards (id, name, model, spec, canvas, updated_at, source_id, schema_version, revision, folder_id, is_template)
      VALUES (?, ?, ?, ?, ?, now(), ?, 1, 1, ?, true)`, [randomUUID(), d.name, scope.model, JSON.stringify(d.spec), JSON.stringify(d.canvas), scope.source, ids.get(d.folder)!]);
    await conn().run("INSERT INTO library_initializations VALUES (?)", [scope.source]);
    await conn().run("COMMIT"); return skipped;
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
