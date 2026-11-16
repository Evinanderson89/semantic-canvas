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

// Older dashboard records stored only customized canvas fields. Read paths and
// archive imports must agree on defaults without accepting malformed values.
const storedCanvasSchema = z.preprocess(value => value !== null && typeof value === "object" && !Array.isArray(value)
  ? { ...DEFAULT_CANVAS, ...value } : value, canvasSchema);
function canvasForBackup(value: unknown) {
  const parsed = storedCanvasSchema.safeParse(value);
  // Keep invalid legacy data available for explicit repair; never erase it or
  // silently replace a corrupt setting with a default during export.
  return parsed.success ? parsed.data : value;
}

export interface DashboardScope {
  source: string;
  model: string;
  actorId?: string;
  actorRole?: "viewer" | "editor" | "admin";
  actorName?: string;
  enforceLock?: boolean;
}
export class StoreConflict extends Error { status = 409; }
const LOCKED_DASHBOARD_MESSAGE = "This dashboard is locked by its owner. Ask the owner or an administrator to unlock it, or save a copy.";
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
  // Legacy TIMESTAMP columns have no zone. New canonical dates below are ISO
  // UTC strings; keep incidental SQL timestamps in UTC as well.
  await conn().run("SET TimeZone = 'UTC'");
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
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS owner_id VARCHAR");
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS owner_name VARCHAR");
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false");
  await conn().run(`CREATE TABLE IF NOT EXISTS audit_events (
    id VARCHAR, ts VARCHAR, event VARCHAR, actor VARCHAR, details VARCHAR
  )`);
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
  await conn().run(`CREATE TABLE IF NOT EXISTS dashboard_versions (
    dashboard_id VARCHAR NOT NULL, source_id VARCHAR NOT NULL, revision INTEGER NOT NULL,
    name VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, saved_at VARCHAR,
    PRIMARY KEY (dashboard_id, source_id, revision)
  )`);
  await conn().run("ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS updated_at_utc VARCHAR");
  await conn().run("ALTER TABLE library_views ADD COLUMN IF NOT EXISTS updated_at_utc VARCHAR");
  // Do not guess the timezone of old local timestamps. Version history was
  // written as ISO UTC and can recover the current save only when it matches.
  await conn().run(`UPDATE dashboards AS d SET updated_at_utc = v.saved_at FROM dashboard_versions AS v
    WHERE d.updated_at_utc IS NULL AND d.id = v.dashboard_id AND d.source_id = v.source_id
    AND d.revision = v.revision AND d.name = v.name AND d.spec = v.spec AND d.canvas = v.canvas
    AND v.saved_at LIKE '%Z' AND try_cast(v.saved_at AS TIMESTAMPTZ) IS NOT NULL`);
  return file;
}
export async function closeStore() { await pending; connection?.closeSync(); storeInstance?.closeSync(); connection = null; storeInstance = null; }
export const recordAuditEvent = (event: string, data: Record<string, unknown> = {}) => serialized(async () => {
  if (!connection) return null;
  const id = randomUUID(), ts = new Date().toISOString();
  const actor = typeof data.actor === "string" && data.actor ? data.actor : null;
  const details = JSON.stringify(data);
  await conn().run("INSERT INTO audit_events (id, ts, event, actor, details) VALUES (?, ?, ?, ?, ?)", [id, ts, event, actor, details]);
  return { id, ts, event, actor, details: data };
});
export const listAuditEvents = (limit = 100) => serialized(async () => {
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  const rows = (await conn().runAndReadAll("SELECT id, ts, event, actor, details FROM audit_events ORDER BY ts DESC, rowid DESC LIMIT ?", [cap])).getRows();
  return rows.map((row) => ({
    id: String(row[0]),
    ts: String(row[1]),
    event: String(row[2]),
    actor: row[3] == null ? null : String(row[3]),
    details: row[4] == null ? {} : JSON.parse(String(row[4])),
  }));
});
/** Legacy saves knew only the model name. Claim them only when that name has one source. */
export const migrateLegacySources = (scopes: DashboardScope[]) => serialized(async () => {
  for (const scope of scopes) {
    if (scopes.filter((s) => s.model === scope.model).length !== 1) continue;
    await conn().run("UPDATE dashboards SET source_id = ? WHERE model = ? AND source_id IS NULL", [scope.source, scope.model]);
  }
});
export const listDashboards = (scope: DashboardScope) => serialized(async () => {
  const r = await conn().runAndReadAll(
    "SELECT id, name, updated_at_utc, revision, folder_id, owner_id, owner_name, locked FROM dashboards WHERE source_id = ? AND NOT coalesce(is_template, false) ORDER BY try_cast(updated_at_utc AS TIMESTAMPTZ) DESC NULLS LAST, updated_at DESC, id", [scope.source]);
  return r.getRows().map((row) => ({
    id: String(row[0]), name: String(row[1]), updated_at: row[2] == null ? null : String(row[2]), revision: Number(row[3]), folderId: row[4] == null ? null : String(row[4]),
    ...(row[5] != null ? { ownerId: String(row[5]) } : {}),
    ...(row[6] != null ? { ownerName: String(row[6]) } : {}),
    ...(row[7] != null && (Boolean(row[7]) || row[5] != null) ? { locked: Boolean(row[7]) } : {}),
  }));
});
export const saveDashboard = (input: unknown, scope: DashboardScope) => serialized(async () => {
  const d = saveSchema.parse(input);
  await conn().run("BEGIN TRANSACTION");
  try {
    const current = (await conn().runAndReadAll("SELECT source_id, revision, folder_id, is_template, owner_id, owner_name, locked FROM dashboards WHERE id = ?", [d.id])).getRows()[0];
    if (current && String(current[0]) === scope.source && scope.enforceLock && Boolean(current[6]) && current[4] != null && scope.actorId !== String(current[4]) && scope.actorRole !== "admin")
      throw Object.assign(new Error(LOCKED_DASHBOARD_MESSAGE), { status: 403 });
    if (current ? String(current[0]) !== scope.source || Number(current[1]) !== d.revision : d.revision !== 0)
      throw new StoreConflict("This dashboard changed or belongs to another source. Reopen the latest version, or save your edits as a copy.");
    if (current?.[3]) throw new StoreConflict("Open this starter as a new dashboard, then save your own copy.");
    const revision = d.revision + 1;
    const folderId = d.folderId === undefined ? current?.[2] == null ? null : String(current[2]) : d.folderId;
    const currentOwnerId = current?.[4] == null ? null : String(current[4]);
    const currentOwnerName = current?.[5] == null ? null : String(current[5]);
    const ownerId = currentOwnerId ?? scope.actorId ?? null;
    const ownerName = currentOwnerId ? currentOwnerName : (scope.actorName ?? currentOwnerName ?? null);
    const locked = d.locked === undefined ? Boolean(current?.[6]) : Boolean(d.locked);
    await requireFolder(folderId, scope.source);
    // Updating a large VARCHAR can trigger DuckDB's indexed UPDATE limitation.
    // Explicit delete + insert in one transaction preserves atomic replacement.
    if (current) await archiveDashboard(d.id, scope.source);
    if (current) await conn().run("DELETE FROM dashboards WHERE id = ?", [d.id]);
    const savedAt = new Date().toISOString();
    await conn().run(`INSERT INTO dashboards
      (id, name, model, spec, canvas, updated_at, source_id, schema_version, revision, folder_id, updated_at_utc, owner_id, owner_name, locked)
      VALUES (?, ?, ?, ?, ?, now(), ?, ?, ?, ?, ?, ?, ?, ?)`, [d.id, d.name || d.spec.title, scope.model,
      JSON.stringify(d.spec), JSON.stringify(d.canvas), scope.source, d.schemaVersion, revision, folderId, savedAt, ownerId, ownerName, locked]);
    await archiveDashboard(d.id, scope.source, savedAt);
    const tileIds = d.spec.tiles.map(t => t.id);
    await conn().run(`DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?${tileIds.length ? ` AND tile_id NOT IN (${tileIds.map(() => "?").join(",")})` : ""}`, [d.id, scope.source, ...tileIds]);
    await conn().run("COMMIT");
    return { ok: true, id: d.id, revision, schemaVersion: d.schemaVersion };
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
export const loadDashboard = (id: string, scope: DashboardScope) => serialized(async () => {
  const r = await conn().runAndReadAll(
    "SELECT name, spec, canvas, revision, schema_version, folder_id, is_template, owner_id, owner_name, locked FROM dashboards WHERE id = ? AND source_id = ?", [id, scope.source]);
  const row = r.getRows()[0];
  if (!row) return null;
  if (Number(row[4]) !== 1) throw new Error("This dashboard requires a newer version of Semantic Canvas");
  const spec = dashboardSchema.safeParse(JSON.parse(String(row[1])));
  if (!spec.success) { const issue = spec.error.issues[0]; throw Object.assign(new Error(`Dashboard "${id}" does not match the current schema (${issue?.path.join(".") || "spec"}: ${issue?.message ?? "invalid"}). Fix or remove it from a library backup, then restore.`), { status: 422 }); }
  return { id, name: String(row[0]), spec: spec.data,
    canvas: storedCanvasSchema.parse(JSON.parse(String(row[2]))), revision: Number(row[3]), schemaVersion: 1, folderId: row[5] == null ? null : String(row[5]), isTemplate: Boolean(row[6]),
    ...(row[7] != null ? { ownerId: String(row[7]) } : {}),
    ...(row[8] != null ? { ownerName: String(row[8]) } : {}),
    ...(row[9] != null && (Boolean(row[9]) || row[7] != null) ? { locked: Boolean(row[9]) } : {}),
  };
});
/** Immutable design/query snapshots. Older current documents have no reliable timezone timestamp. */
async function archiveDashboard(id: string, source: string, savedAt: string | null = null) {
  await conn().run(`INSERT INTO dashboard_versions
    SELECT id, source_id, revision, name, spec, canvas, coalesce(?, updated_at_utc) FROM dashboards
    WHERE id = ? AND source_id = ? AND NOT coalesce(is_template, false)
    ON CONFLICT DO NOTHING`, [savedAt, id, source]);
}
export const listDashboardVersions = (id: string, scope: DashboardScope) => serialized(async () => {
  const current = (await conn().runAndReadAll("SELECT revision, name, spec, updated_at_utc FROM dashboards WHERE id = ? AND source_id = ? AND NOT coalesce(is_template, false)", [id, scope.source])).getRows()[0];
  if (!current) throw missing();
  const rows = (await conn().runAndReadAll("SELECT revision, name, saved_at, spec FROM dashboard_versions WHERE dashboard_id = ? AND source_id = ? ORDER BY revision DESC", [id, scope.source])).getRows();
  if (!rows.some(r => Number(r[0]) === Number(current[0]))) rows.unshift([current[0], current[1], current[3], current[2]]);
  return rows.map(r => ({ revision: Number(r[0]), name: String(r[1]), savedAt: r[2] == null ? null : String(r[2]), tiles: JSON.parse(String(r[3])).tiles.length, current: Number(r[0]) === Number(current[0]) }));
});
export const loadDashboardVersion = (id: string, revision: number, scope: DashboardScope) => serialized(async () => {
  const current = (await conn().runAndReadAll("SELECT revision, name, spec, canvas, updated_at_utc FROM dashboards WHERE id = ? AND source_id = ? AND NOT coalesce(is_template, false)", [id, scope.source])).getRows()[0];
  if (!current) throw missing();
  const row = (await conn().runAndReadAll("SELECT name, spec, canvas, saved_at FROM dashboard_versions WHERE dashboard_id = ? AND source_id = ? AND revision = ?", [id, scope.source, revision])).getRows()[0]
    ?? (Number(current[0]) === revision ? [current[1], current[2], current[3], current[4]] : undefined);
  if (!row) throw missing();
  return { id, revision, name: String(row[0]), spec: dashboardSchema.parse(JSON.parse(String(row[1]))), canvas: storedCanvasSchema.parse(JSON.parse(String(row[2]))), savedAt: row[3] == null ? null : String(row[3]) };
});
export const deleteDashboard = (id: string, scope: DashboardScope, revision: number) => serialized(async () => {
  await conn().run("BEGIN TRANSACTION");
  try {
    const current = (await conn().runAndReadAll("SELECT owner_id, locked FROM dashboards WHERE id = ? AND source_id = ?", [id, scope.source])).getRows()[0];
    if (current && scope.enforceLock && Boolean(current[1]) && current[0] != null && scope.actorId !== String(current[0]) && scope.actorRole !== "admin")
      throw Object.assign(new Error(LOCKED_DASHBOARD_MESSAGE), { status: 403 });
    const r = await conn().runAndReadAll("DELETE FROM dashboards WHERE id = ? AND source_id = ? AND revision = ? RETURNING id", [id, scope.source, revision]);
    if (!r.getRows().length) throw new StoreConflict("Dashboard changed or was not found; reopen it before deleting");
    await conn().run("DELETE FROM chart_activity WHERE dashboard_id = ? AND source_id = ?", [id, scope.source]);
    await conn().run("DELETE FROM dashboard_versions WHERE dashboard_id = ? AND source_id = ?", [id, scope.source]);
    await conn().run("COMMIT"); return { ok: true };
  } catch (e) { await conn().run("ROLLBACK"); throw e; }
});

const backupDates = {
  updatedAt: z.string().datetime().nullable(),
  // Kept as a wall-clock value with explicitly unknown timezone. Never append Z.
  legacyUpdatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/).nullable().default(null),
};
const backupDashboardSchema = z.object({
  id: z.string().min(1), name: z.string(), source: z.string().nullable(), model: z.string(), spec: dashboardSchema, canvas: storedCanvasSchema,
  folderId: z.string().nullable().default(null), isTemplate: z.boolean().default(false),
  revision: z.number().int().min(1), schemaVersion: z.literal(1), ...backupDates,
});
// Documents are validated one by one so a legacy record names itself instead of failing the whole archive with a Zod dump.
const versionBackupSchema = z.object({ dashboardId: z.string().min(1), source: z.string().min(1), revision: z.number().int().positive(), name: z.string(), spec: dashboardSchema, canvas: storedCanvasSchema, savedAt: z.string().datetime().nullable() });
const librarySchema = z.object({ versions: z.array(versionBackupSchema).max(100000).default([]), format: z.literal("semantic-canvas-library"), version: z.union([z.literal(1), z.literal(2)]), createdAt: z.string(), dashboards: z.array(z.unknown()).max(100000), initializedSources: z.array(z.string().min(1)).max(10000).default([]), activity: z.array(activityRecordSchema).max(100000).default([]),
  folders: z.array(folderSchema.extend({ source: z.string().min(1) })).max(10000).default([]),
  views: z.array(viewSaveSchema.safeExtend({ source: z.string().min(1), model: z.string(), ...backupDates })).max(10000).default([]),
}).strict();
function restoreDate(item: { updatedAt: string | null; legacyUpdatedAt: string | null }, version: 1 | 2, savedAt?: string | null) {
  if (version === 1 && item.updatedAt === null) throw new Error("Version-1 backups require an updatedAt date");
  const utc = version === 1 ? savedAt ?? null : item.updatedAt ?? savedAt ?? null;
  const raw = utc ?? (version === 1 ? item.updatedAt!.replace("T", " ").replace(/Z$/, "") : item.legacyUpdatedAt);
  if (raw === null) throw new Error("A backup with an unknown save time must retain legacyUpdatedAt");
  return { utc, raw };
}
/** Serialized with saves; includes discussions and alert observations, never credentials or full query results. */
export const exportLibrary = () => serialized(async () => {
  const rows = (await conn().runAndReadAll("SELECT id, name, source_id, model, spec, canvas, revision, schema_version, updated_at::VARCHAR, folder_id, is_template, updated_at_utc FROM dashboards ORDER BY id")).getRows();
  const folders = (await conn().runAndReadAll("SELECT id, name, parent_id, revision, source_id FROM library_folders ORDER BY id")).getRows().map(r => ({ ...folderFromRow(r), source: String(r[4]) }));
  const views = (await conn().runAndReadAll("SELECT id, name, description, folder_id, spec, canvas, revision, source_id, model, updated_at::VARCHAR, updated_at_utc FROM library_views ORDER BY id")).getRows().map(r => ({ ...viewFromRow(r), source: String(r[7]), model: String(r[8]), updatedAt: r[10] == null ? null : String(r[10]), legacyUpdatedAt: r[10] == null ? String(r[9]) : null }));
  const initializedSources = (await conn().runAndReadAll("SELECT source_id FROM library_initializations ORDER BY source_id")).getRows().map(r => String(r[0]));
  const versions = (await conn().runAndReadAll("SELECT dashboard_id, source_id, revision, name, spec, canvas, saved_at FROM dashboard_versions ORDER BY dashboard_id, revision")).getRows().map(r => ({ dashboardId: String(r[0]), source: String(r[1]), revision: Number(r[2]), name: String(r[3]), spec: JSON.parse(String(r[4])), canvas: canvasForBackup(JSON.parse(String(r[5]))), savedAt: r[6] == null ? null : String(r[6]) }));
  return { format: "semantic-canvas-library", version: 2, versions, initializedSources, createdAt: new Date().toISOString(), folders, views, activity: await readActivityRows(), dashboards: rows.map(r => ({ id: String(r[0]), name: String(r[1]), source: r[2] == null ? null : String(r[2]), model: String(r[3]), spec: JSON.parse(String(r[4])), canvas: canvasForBackup(JSON.parse(String(r[5]))), revision: Number(r[6]), schemaVersion: Number(r[7]), updatedAt: r[11] == null ? null : String(r[11]), legacyUpdatedAt: r[11] == null ? String(r[8]) : null, folderId: r[9] == null ? null : String(r[9]), isTemplate: Boolean(r[10]) })) };
});
/** Restore is offline and only into an empty store. Never silently replaces company work. */
export const restoreLibrary = (input: unknown) => serialized(async () => {
  const shell = librarySchema.parse(input), invalid: string[] = [];
  const dashboards = shell.dashboards.flatMap(d => { const parsed = backupDashboardSchema.safeParse(d); if (parsed.success) return [parsed.data]; invalid.push(String((d as any)?.id ?? "(missing id)")); return []; });
  if (invalid.length) throw Object.assign(new Error(`Backup contains ${invalid.length} document${invalid.length === 1 ? " that does" : "s that do"} not match the current schema: ${invalid.slice(0, 20).join(", ")}. Export again after correcting the listed documents, or remove those documents from the backup.`), { status: 400 });
  const backup = { ...shell, dashboards };
  const versionKeys = new Set<string>();
  for (const v of backup.versions) {
    const d = backup.dashboards.find(d => d.id === v.dashboardId && d.source === v.source && !d.isTemplate);
    const key = JSON.stringify([v.dashboardId, v.source, v.revision]);
    if (!d || v.revision > d.revision || versionKeys.has(key)) throw new Error("Backup contains invalid dashboard version references");
    if (v.revision === d.revision && (JSON.stringify(v.spec) !== JSON.stringify(d.spec) || JSON.stringify(v.canvas) !== JSON.stringify(d.canvas) || v.name !== d.name)) throw new Error("Backup current version does not match its dashboard");
    versionKeys.add(key);
  }
  if (new Set(backup.dashboards.map(d => d.id)).size !== backup.dashboards.length) throw new Error("Backup contains duplicate dashboard IDs");
  if (new Set(backup.folders.map(f => f.id)).size !== backup.folders.length || new Set(backup.views.map(v => v.id)).size !== backup.views.length) throw new Error("Backup contains duplicate library IDs");
  for (const f of backup.folders) validateFolderTree(backup.folders.filter(x => x.source === f.source), f);
  for (const d of [...backup.dashboards, ...backup.views]) if (d.folderId && !backup.folders.some(f => f.id === d.folderId && f.source === d.source)) throw new Error("Backup references a missing library folder");
  if (Number((await conn().runAndReadAll("SELECT (SELECT count(*) FROM dashboards) + (SELECT count(*) FROM library_folders) + (SELECT count(*) FROM library_views) + (SELECT count(*) FROM chart_activity) + (SELECT count(*) FROM library_initializations)")).getRows()[0][0])) throw new Error("Restore requires an empty dashboard database");
  await conn().run("BEGIN TRANSACTION");
  try {
    for (const source of new Set(backup.initializedSources)) await conn().run("INSERT INTO library_initializations VALUES (?)", [source]);
    for (const f of backup.folders) await conn().run("INSERT INTO library_folders VALUES (?, ?, ?, ?, ?)", [f.id, f.source, f.name, f.parentId, f.revision]);
    for (const v of backup.views) {
      const date = restoreDate(v, backup.version);
      await conn().run("INSERT INTO library_views (id, source_id, model, name, description, folder_id, spec, canvas, revision, updated_at, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [v.id, v.source, v.model, v.name, v.description, v.folderId, JSON.stringify(v.spec), JSON.stringify(v.canvas), v.revision, date.raw, date.utc]);
    }
    for (const d of backup.dashboards) {
      const savedAt = backup.versions.find(v => v.dashboardId === d.id && v.source === d.source && v.revision === d.revision)?.savedAt;
      const date = restoreDate(d, backup.version, savedAt);
      await conn().run("INSERT INTO dashboards (id, name, source_id, model, spec, canvas, revision, schema_version, updated_at, folder_id, is_template, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [d.id, d.name, d.source, d.model, JSON.stringify(d.spec), JSON.stringify(d.canvas), d.revision, d.schemaVersion, date.raw, d.folderId, d.isTemplate, date.utc]);
    }
    for (const v of backup.versions) await conn().run("INSERT INTO dashboard_versions VALUES (?, ?, ?, ?, ?, ?, ?)", [v.dashboardId, v.source, v.revision, v.name, JSON.stringify(v.spec), JSON.stringify(v.canvas), v.savedAt]);
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
    const rows = (await conn().runAndReadAll(`SELECT id, name, folder_id, revision, updated_at_utc, json_array_length(spec, '$.tiles'), ${kind === "view" ? "description" : "json_extract_string(spec, '$.description')"}, ${kind === "dashboard" ? "is_template" : "false"} FROM ${table} WHERE source_id = ? ORDER BY lower(name), id`, [scope.source])).getRows();
    items.push(...rows.map(r => ({ id: String(r[0]), kind, name: String(r[1]), folderId: r[2] == null ? null : String(r[2]), revision: Number(r[3]), updatedAt: r[4] == null ? null : String(r[4]), tileCount: Number(r[5]), description: r[6] == null ? "" : String(r[6]), ...(r[7] ? { isTemplate: true } : {}) })));
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
    await conn().run("INSERT INTO library_views (id, source_id, model, name, description, folder_id, spec, canvas, revision, updated_at, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)", [v.id, scope.source, scope.model, v.name, v.description, v.folderId, JSON.stringify(v.spec), JSON.stringify(v.canvas), v.revision + 1, new Date().toISOString()]);
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
    if (kind === "dashboard") await archiveDashboard(id, scope.source);
    await conn().run(`CREATE TEMP TABLE library_item_change AS SELECT * FROM ${table} WHERE id = ?`, [id]);
    const savedAt = new Date().toISOString();
    await conn().run("UPDATE library_item_change SET name = ?, spec = ?, folder_id = ?, revision = ?, updated_at = now(), updated_at_utc = ?", [name, JSON.stringify(spec), folderId, patch.revision + 1, savedAt]);
    await conn().run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    await conn().run(`INSERT INTO ${table} SELECT * FROM library_item_change`);
    await conn().run("DROP TABLE library_item_change");
    if (kind === "dashboard") await archiveDashboard(id, scope.source, savedAt);
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
  if ((await conn().runAndReadAll("SELECT source_id FROM library_initializations WHERE source_id = ?", [scope.source])).getRows().length) {
    // Upgrade only untouched built-in starters. User saves, renames, moves and removals stay intact.
    for (const d of libraryStarters(model)) {
      const rows = (await conn().runAndReadAll("SELECT id, spec, canvas, revision FROM dashboards WHERE source_id = ? AND is_template = true AND name = ?", [scope.source, d.name])).getRows();
      // The prior automatic refresh incremented the revision, so revision=1
      // alone misses installations already upgraded to the curated library.
      // Recognize only exact preceding bundled compositions, not arbitrary
      // revision-2 documents imported or customized by the user.
      const preceding = d.name === "SaaS overview" ? { ...d.spec, tiles: d.spec.tiles.map(tile => {
        if (tile.id !== "retention-trend") return tile;
        return { ...tile, format: { palette: "default", padding: 18 } };
      }) } : ["Subscriptions", "Subscription add-ons", "Events & engagement"].includes(d.name) ? { ...d.spec, tiles: d.spec.tiles.map(tile => {
        if (tile.id === "revenue-share") return { ...tile, title: "Which plans contribute revenue?", dimensions: ["dim_plans.plan_name"] };
        if (tile.id === "addon-share") return { ...tile, title: "Add-on revenue mix by plan", dimensions: ["dim_plans.plan_name"] };
        if (tile.id === "activity-share") return { ...tile, format: { ...tile.format, palette: "cool" } };
        return tile;
      }) } : null;
      const currentSpec = JSON.stringify(dashboardSchema.parse(d.spec)), currentCanvas = JSON.stringify(canvasSchema.parse(d.canvas));
      for (const r of rows) {
        const storedSpec = JSON.stringify(dashboardSchema.parse(JSON.parse(String(r[1])))), storedCanvas = JSON.stringify(canvasSchema.parse(JSON.parse(String(r[2]))));
        const knownPreceding = preceding && storedSpec === JSON.stringify(dashboardSchema.parse(preceding)) && storedCanvas === currentCanvas;
        if (Number(r[3]) !== 1 && !knownPreceding || storedSpec === currentSpec && storedCanvas === currentCanvas) continue;
        await conn().run("BEGIN TRANSACTION");
        try {
          await conn().run("CREATE TEMP TABLE starter_upgrade AS SELECT * FROM dashboards WHERE id = ?", [r[0]]);
          await conn().run("UPDATE starter_upgrade SET spec = ?, canvas = ?, revision = revision + 1, updated_at = now(), updated_at_utc = ?", [JSON.stringify(d.spec), JSON.stringify(d.canvas), new Date().toISOString()]);
          await conn().run("DELETE FROM dashboards WHERE id = ?", [r[0]]);
          await conn().run("INSERT INTO dashboards SELECT * FROM starter_upgrade");
          await conn().run("DROP TABLE starter_upgrade");
          await conn().run("COMMIT");
        } catch (e) { await conn().run("ROLLBACK"); throw e; }
      }
    }
    return skipped;
  }
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
    for (const d of starters) await conn().run(`INSERT INTO dashboards (id, name, model, spec, canvas, updated_at, source_id, schema_version, revision, folder_id, is_template, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, now(), ?, 1, 1, ?, true, ?)`, [randomUUID(), d.name, scope.model, JSON.stringify(d.spec), JSON.stringify(d.canvas), scope.source, ids.get(d.folder)!, new Date().toISOString()]);
    await conn().run("INSERT INTO library_initializations VALUES (?)", [scope.source]);
    await conn().run("COMMIT"); return skipped;
  } catch (error) { await conn().run("ROLLBACK"); throw error; }
});
