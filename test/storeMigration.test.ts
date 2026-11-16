import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { openStore, closeStore, migrateLegacySources, loadDashboard, loadDashboardVersion, saveDashboard, listDashboards, listDashboardVersions, exportLibrary, restoreLibrary } from "../src/store/store.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
it("migrates old store schemas without losing documents or guessing ambiguous source ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-store-migration-"));
  const file = join(dir, "legacy.duckdb");
  const instance = await DuckDBInstance.create(file);
  const db = await instance.connect();
  const ambiguousSpec = { title: "Ambiguous", tiles: [{ id: "authored-note", kind: "text", text: "Keep this explanation through an upgrade", metrics: [], dimensions: [], layout: { x: 24, y: 36, w: 420, h: 180 } }] };
  await db.run("CREATE TABLE dashboards (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL)");
  await db.run("INSERT INTO dashboards VALUES ('old','Old','unique',?, '{}',now()), ('ambiguous','Ambiguous','shared',?, '{}',now())",
    [JSON.stringify({ title: "Old", tiles: [] }), JSON.stringify(ambiguousSpec)]);
  db.closeSync(); instance.closeSync();
  try {
    await openStore(file);
    await migrateLegacySources([{ source: "one", model: "unique" }, { source: "two", model: "shared" }, { source: "three", model: "shared" }]);
    const restored = await loadDashboard("old", { source: "one", model: "unique" });
    expect(restored).toMatchObject({ revision: 1, spec: { title: "Old" }, canvas: { width: 1440 } });
    expect(await listDashboards({ source: "two", model: "shared" })).toEqual([]);
    expect(await listDashboards({ source: "three", model: "shared" })).toEqual([]);
    const backup = await exportLibrary();
    expect(backup.dashboards.map(d => d.id)).toEqual(["ambiguous", "old"]);
    expect(backup.dashboards.find(d => d.id === "ambiguous")).toMatchObject({ source: null, model: "shared", revision: 1, spec: ambiguousSpec });
    // Absence from both source lists must mean unassigned, not deleted. Prove
    // that the authored content remains recoverable through an offline backup.
    await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
    await migrateLegacySources([{ source: "one", model: "unique" }, { source: "two", model: "shared" }, { source: "three", model: "shared" }]);
    const recovered = await exportLibrary();
    expect(recovered.dashboards.map(d => d.id)).toEqual(["ambiguous", "old"]);
    expect(recovered.dashboards.find(d => d.id === "ambiguous")).toMatchObject({ source: null, model: "shared", revision: 1, spec: ambiguousSpec });
    expect(await listDashboards({ source: "two", model: "shared" })).toEqual([]);
    expect(await listDashboards({ source: "three", model: "shared" })).toEqual([]);
    expect((await loadDashboard("old", { source: "one", model: "unique" }))?.spec).toEqual({ title: "Old", tiles: [] });
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); }
});

it("uses the same legacy canvas defaults for opening, archived versions, export and restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-legacy-canvas-")), file = join(dir, "legacy.duckdb");
  const instance = await DuckDBInstance.create(file), db = await instance.connect();
  const scope = { source: "sample", model: "sample" }, spec = { title: "Legacy layout", tiles: [] };
  const partialCanvas = { width: 1120, grid: 16, snap: false, background: "#f0f4f2" };
  const expected = { ...DEFAULT_CANVAS, ...partialCanvas };
  await db.run("CREATE TABLE dashboards (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL)");
  await db.run("INSERT INTO dashboards VALUES ('legacy','Legacy layout','sample',?,?,now())", [JSON.stringify(spec), JSON.stringify(partialCanvas)]);
  db.closeSync(); instance.closeSync();
  try {
    await openStore(file); await migrateLegacySources([scope]);
    expect((await loadDashboard("legacy", scope))?.canvas).toEqual(expected);
    expect((await loadDashboardVersion("legacy", 1, scope)).canvas).toEqual(expected);
    await saveDashboard({ id: "legacy", revision: 1, spec: { ...spec, title: "Second design" }, canvas: { ...expected, width: 1600 } }, scope);
    expect((await loadDashboardVersion("legacy", 1, scope)).canvas).toEqual(expected);
    const backup = await exportLibrary();
    expect(backup.versions.find(v => v.revision === 1)?.canvas).toEqual(expected);
    await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
    expect((await listDashboardVersions("legacy", scope)).map(v => v.revision)).toEqual([2, 1]);
    expect((await loadDashboardVersion("legacy", 1, scope)).canvas).toEqual(expected);
    expect((await loadDashboard("legacy", scope))?.canvas).toEqual({ ...expected, width: 1600 });
    // Previously exported archives may still contain partial canvases.
    const olderBackup = structuredClone(backup);
    olderBackup.versions.find(v => v.revision === 1)!.canvas = partialCanvas;
    await closeStore(); await openStore(":memory:"); await restoreLibrary(olderBackup);
    expect((await loadDashboardVersion("legacy", 1, scope)).canvas).toEqual(expected);
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); }
});

it("does not replace malformed canvas settings with defaults during backup restore", async () => {
  const scope = { source: "sample", model: "sample" };
  await openStore(":memory:");
  try {
    await saveDashboard({ id: "current", spec: { title: "Current", tiles: [] } }, scope);
    const backup = await exportLibrary();
    for (const canvas of [null, [], { width: 0 }, { snap: "false" }, { width: 1120, unknownSetting: true }]) {
      await closeStore(); await openStore(":memory:");
      const invalid = { ...backup, versions: [], dashboards: backup.dashboards.map(d => ({ ...d, canvas })) };
      await expect(restoreLibrary(invalid)).rejects.toThrow(/current schema/);
      expect((await exportLibrary()).dashboards).toEqual([]);
    }
  } finally { await closeStore(); }
});

it("recovers only corroborated UTC dates from older on-disk stores and preserves unknown wall-clock values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-store-date-migration-")), file = join(dir, "legacy.duckdb");
  const instance = await DuckDBInstance.create(file), db = await instance.connect();
  const spec = JSON.stringify({ title: "Revenue", tiles: [] }), canvas = JSON.stringify(DEFAULT_CANVAS);
  await db.run("CREATE TABLE dashboards (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL, source_id VARCHAR, revision INTEGER)");
  await db.run("INSERT INTO dashboards VALUES ('known','Revenue','sample',?,?,'2026-09-15 10:00:00','sample',1),('unknown','Revenue','sample',?,?,'2020-07-01 09:00:00','sample',1)", [spec, canvas, spec, canvas]);
  await db.run("CREATE TABLE dashboard_versions (dashboard_id VARCHAR, source_id VARCHAR, revision INTEGER, name VARCHAR, spec VARCHAR, canvas VARCHAR, saved_at VARCHAR, PRIMARY KEY(dashboard_id,source_id,revision))");
  await db.run("INSERT INTO dashboard_versions VALUES ('known','sample',1,'Revenue',?,?,'2026-09-15T14:00:00.000Z')", [spec, canvas]);
  db.closeSync(); instance.closeSync();
  const scope = { source: "sample", model: "sample" };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await openStore(file);
      const items = await listDashboards(scope);
      expect(items.find(x => x.id === "known")?.updated_at).toBe("2026-09-15T14:00:00.000Z");
      expect(items.find(x => x.id === "unknown")?.updated_at).toBeNull();
      expect((await listDashboardVersions("unknown", scope))[0].savedAt).toBeNull();
      expect((await exportLibrary()).dashboards.find(x => x.id === "unknown")).toMatchObject({ updatedAt: null, legacyUpdatedAt: "2020-07-01 09:00:00" });
      expect((await loadDashboard("known", scope))?.spec).toEqual(JSON.parse(spec));
      await closeStore();
    }
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); }
});
