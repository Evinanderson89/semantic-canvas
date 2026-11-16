import type { TileSpec } from "../src/compiler/spec.ts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { openStore, closeStore, initializeCoreLibrary, saveDashboard, loadDashboard, listCoreLibrary, updateLibraryItem, saveLibraryFolder, deleteLibraryFolder, deleteDashboard, exportLibrary, restoreLibrary, listDashboards } from "../src/store/store.ts";
import { libraryStarters } from "../src/library/setup.ts";
import { model as otherModel } from "./fixtures.ts";
const scope = { source: "sample", model: "sample" };
beforeEach(() => openStore(":memory:")); afterEach(closeStore);
const sample = async () => (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
it("files existing work without changing content, creates validated starters, and opens copies without overwriting templates", async () => {
  const model = await sample(), starters = libraryStarters(model);
  expect(starters).toHaveLength(10);
  const spec = { ...starters[0].spec, title: "My monthly report" };
  await saveDashboard({ id: "mine", spec }, scope);
  await saveLibraryFolder({ id: "custom", name: "Already organized" }, scope);
  await saveDashboard({ id: "filed", spec, folderId: "custom" }, scope);
  await initializeCoreLibrary(scope, model);
  const library = await listCoreLibrary(scope);
  expect(library.folders.filter(f => !f.parentId).map(f => f.name)).toEqual(["Company overview", "Revenue & retention", "Growth & customers", "Shared views", "Examples", "Already organized"]);
  const mine = (await loadDashboard("mine", scope))!;
  // Filing is metadata: the revision must not move, or every open draft and MCP client conflicts after an upgrade.
  expect(mine.spec).toEqual(spec); expect(mine.revision).toBe(1);
  expect(mine.folderId).toBe(library.folders.find(f => f.name === "Company overview")?.id);
  expect((await loadDashboard("filed", scope))?.folderId).toBe("custom");
  expect((await listDashboards(scope)).map(d => d.id).sort()).toEqual(["filed", "mine"]);
  const starter = library.items.find(i => i.isTemplate)!;
  const source = (await loadDashboard(starter.id, scope))!;
  const { isTemplate: _, ...document } = source;
  await expect(saveDashboard({ ...document, revision: 1 }, scope)).rejects.toThrow(/starter/);
  await saveDashboard({ ...document, id: "copy", revision: 0 }, scope);
  expect((await loadDashboard("copy", scope))?.isTemplate).toBe(false);
  expect((await loadDashboard(starter.id, scope))?.revision).toBe(1);
  expect((await listCoreLibrary({ ...scope, source: "other" })).items).toHaveLength(0);
});
it("preserves organization and removals through initialization, backup, and restore", async () => {
  const model = await sample(); await initializeCoreLibrary(scope, model);
  const library = await listCoreLibrary(scope), example = library.items.find(i => i.name === "Dashboard cleanup demo")!;
  await deleteDashboard(example.id, scope, example.revision);
  await deleteLibraryFolder(example.folderId!, 1, scope);
  const folder = library.folders.find(f => f.name === "Company overview")!;
  await saveLibraryFolder({ ...folder, name: "Leadership" }, scope);
  const starter = library.items.find(i => i.name === "MRR movements")!;
  await updateLibraryItem("dashboard", starter.id, { revision: starter.revision, folderId: folder.id }, scope);
  await initializeCoreLibrary(scope, model);
  const backup = await exportLibrary();
  expect(backup.dashboards.some(d => d.id === example.id || d.name === "Dashboard cleanup demo")).toBe(false);
  expect((await listCoreLibrary(scope)).items.some(d => d.id === example.id || d.name === "Dashboard cleanup demo")).toBe(false);
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  await initializeCoreLibrary(scope, model);
  const restored = await exportLibrary();
  expect(restored.dashboards).toEqual(backup.dashboards); expect(restored.folders).toEqual(backup.folders);
  expect(restored.initializedSources).toEqual([scope.source]);
  expect((await listCoreLibrary(scope)).folders.some(f => f.name === "Examples")).toBe(false);
  expect(restored.dashboards.some(d => d.id === example.id || d.name === "Dashboard cleanup demo")).toBe(false);
  expect((await listCoreLibrary(scope)).items.some(d => d.id === example.id || d.name === "Dashboard cleanup demo")).toBe(false);
});
it("skips legacy documents that no longer parse instead of failing initialization", async () => {
  const model = await sample(), spec = { ...libraryStarters(model)[0].spec, title: "Still valid" };
  await closeStore();
  const dir = await mkdtemp(join(tmpdir(), "sc-library-legacy-")), file = join(dir, "legacy.duckdb");
  try {
    const instance = await DuckDBInstance.create(file), db = await instance.connect();
    await db.run("CREATE TABLE dashboards (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL, source_id VARCHAR)");
    // The previous release stored specs unvalidated; an unknown key fails the strict schema today.
    await db.run("INSERT INTO dashboards VALUES ('legacy','Agent','sample',?,'{}',now(),'sample'), ('valid','Still valid','sample',?,'{}',now(),'sample')", [JSON.stringify({ title: "Agent", tiles: [], notes: "x" }), JSON.stringify(spec)]);
    db.closeSync(); instance.closeSync();
    await openStore(file);
    expect(await initializeCoreLibrary(scope, model)).toEqual(["legacy"]);
    const library = await listCoreLibrary(scope);
    expect(library.items.find(i => i.id === "valid")).toMatchObject({ folderId: library.folders.find(f => f.name === "Company overview")?.id, revision: 1 });
    expect(library.items.find(i => i.id === "legacy")).toMatchObject({ folderId: null, revision: 1 });
    await expect(loadDashboard("legacy", scope)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/"legacy".*notes/) });
    expect(await initializeCoreLibrary(scope, model)).toEqual([]);
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); await openStore(":memory:"); }
});
it("does not fabricate sample dashboards for an unrelated semantic catalogue", async () => {
  await initializeCoreLibrary(scope, otherModel);
  const library = await listCoreLibrary(scope); expect(library.items).toEqual([]); expect(library.folders).toHaveLength(8);
});

it("refreshes only untouched built-in starters while preserving custom work", async () => {
  const model = await sample(); await initializeCoreLibrary(scope, model);
  const backup = await exportLibrary();
  const untouched = backup.dashboards.find(d => d.name === "SaaS overview")!;
  const customized = backup.dashboards.find(d => d.name === "Users")!;
  untouched.spec = { ...untouched.spec, tiles: [] };
  customized.spec = { ...customized.spec, tiles: [] }; customized.revision = 2;
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  await initializeCoreLibrary(scope, model);
  expect((await loadDashboard(untouched.id, scope))!.spec.tiles.length).toBeGreaterThan(4);
  expect((await loadDashboard(untouched.id, scope))!.revision).toBe(2);
  expect((await loadDashboard(customized.id, scope))!.spec.tiles).toEqual([]);
  await initializeCoreLibrary(scope, model);
  expect((await loadDashboard(untouched.id, scope))!.revision).toBe(2);
});

it("upgrades the exact preceding retention starter after an earlier automatic refresh", async () => {
  const model = await sample(); await initializeCoreLibrary(scope, model);
  const backup = await exportLibrary();
  const starter = backup.dashboards.find(d => d.name === "SaaS overview")!;
  starter.revision = 2;
  starter.spec.tiles = starter.spec.tiles.map((t: TileSpec) => t.id === "retention-trend" ? { ...t, format: { palette: "default", padding: 18 } } : t);
  const modified = structuredClone(starter);
  modified.id = "custom-retention-starter";
  modified.spec.tiles[0].title = "My authored headline";
  backup.dashboards.push(modified);
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  await initializeCoreLibrary(scope, model);
  const upgraded = (await loadDashboard(starter.id, scope))!;
  expect(upgraded.revision).toBe(3);
  expect(upgraded.spec.tiles.find(t => t.id === "retention-trend")?.format?.lineScale).toBe("fit");
  expect((await loadDashboard(modified.id, scope))?.spec).toEqual(modified.spec);
  expect((await loadDashboard(modified.id, scope))?.revision).toBe(2);
  await initializeCoreLibrary(scope, model);
  expect((await loadDashboard(starter.id, scope))?.revision).toBe(3);
});

it.each(["Subscriptions", "Subscription add-ons", "Events & engagement"])("refreshes %s only when the whole preceding composition is untouched", async name => {
  const model = await sample(); await initializeCoreLibrary(scope, model);
  const backup = await exportLibrary();
  const starter = backup.dashboards.find(d => d.name === name)!;
  const current = structuredClone(starter.spec);
  starter.revision = 3;
  starter.spec.tiles = starter.spec.tiles.map((t: TileSpec) => {
    if (t.id === "revenue-share") return { ...t, title: "Which plans contribute revenue?", dimensions: ["dim_plans.plan_name"] };
    if (t.id === "addon-share") return { ...t, title: "Add-on revenue mix by plan", dimensions: ["dim_plans.plan_name"] };
    if (t.id === "activity-share") return { ...t, format: { ...t.format, palette: "cool" } };
    return t;
  });
  const modified = structuredClone(starter);
  modified.id = "custom-showcase";
  modified.spec.tiles[0].title = "My authored headline";
  backup.dashboards.push(modified);
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  await initializeCoreLibrary(scope, model);
  expect((await loadDashboard(starter.id, scope))?.spec).toEqual(current);
  expect((await loadDashboard(starter.id, scope))?.revision).toBe(4);
  expect((await loadDashboard(modified.id, scope))?.spec).toEqual(modified.spec);
  expect((await loadDashboard(modified.id, scope))?.revision).toBe(3);
  await initializeCoreLibrary(scope, model);
  expect((await loadDashboard(starter.id, scope))?.revision).toBe(4);
});
