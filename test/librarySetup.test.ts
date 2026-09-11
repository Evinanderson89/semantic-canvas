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
  expect(starters).toHaveLength(9);
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
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  await initializeCoreLibrary(scope, model);
  const restored = await exportLibrary();
  expect(restored.dashboards).toEqual(backup.dashboards); expect(restored.folders).toEqual(backup.folders);
  expect(restored.initializedSources).toEqual([scope.source]);
  expect((await listCoreLibrary(scope)).folders.some(f => f.name === "Examples")).toBe(false);
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
