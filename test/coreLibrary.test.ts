import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, closeStore, saveDashboard, loadDashboard, listCoreLibrary, saveLibraryFolder, deleteLibraryFolder, saveLibraryView, loadLibraryView, updateLibraryItem, deleteLibraryView, exportLibrary, restoreLibrary } from "../src/store/store.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { tile } from "./fixtures.ts";
const a = { source: "a", model: "Model" }, b = { source: "b", model: "Model" };
const view = { id: "view", name: "Revenue block", spec: { title: "Revenue block", tiles: [tile()] }, canvas: DEFAULT_CANVAS };
beforeEach(() => openStore(":memory:")); afterEach(closeStore);

it("persists folders and views across a restart and retains dashboard folders on ordinary saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corecanvas-"));
  try {
    await closeStore(); await openStore(join(dir, "library.duckdb"));
    await saveLibraryFolder({ id: "growth", name: "Growth" }, a);
    await saveLibraryFolder({ id: "monthly", name: "Monthly", parentId: "growth" }, a);
    await saveLibraryView({ ...view, folderId: "monthly" }, a);
    await saveDashboard({ id: "dash", spec: view.spec, folderId: "growth" }, a);
    await saveDashboard({ id: "dash", spec: { ...view.spec, title: "Updated" }, revision: 1 }, a);
    await closeStore(); await openStore(join(dir, "library.duckdb"));
    expect((await loadDashboard("dash", a))?.folderId).toBe("growth");
    expect((await loadLibraryView("view", a))?.folderId).toBe("monthly");
    expect((await listCoreLibrary(a)).items.map(i => i.kind)).toEqual(["dashboard", "view"]);
    expect((await listCoreLibrary(a)).folders).toHaveLength(2);
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); }
});

it("isolates sources, rejects cross-source moves, stale edits and folder cycles", async () => {
  await saveLibraryFolder({ id: "root", name: "Root" }, a);
  await saveLibraryFolder({ id: "child", name: "Child", parentId: "root" }, a);
  await expect(saveLibraryFolder({ id: "root", name: "Root", revision: 1, parentId: "child" }, a)).rejects.toThrow(/itself/);
  await expect(saveLibraryFolder({ id: "duplicate", name: "root" }, a)).rejects.toThrow(/already exists/);
  await expect(saveLibraryFolder({ id: "foreign", name: "Foreign", parentId: "root" }, b)).rejects.toThrow();
  await saveLibraryView({ ...view, folderId: "child" }, a);
  expect(await loadLibraryView("view", b)).toBeNull(); expect(await listCoreLibrary(b)).toEqual({ folders: [], items: [] });
  await expect(saveLibraryView({ ...view, revision: 1 }, b)).rejects.toThrow(/changed/);
  await expect(updateLibraryItem("view", "view", { revision: 1, folderId: "root" }, b)).rejects.toThrow(/not found/);
  const updates = await Promise.allSettled([updateLibraryItem("view", "view", { revision: 1, name: "A" }, a), updateLibraryItem("view", "view", { revision: 1, name: "B" }, a)]);
  expect(updates.filter(r => r.status === "fulfilled")).toHaveLength(1);
  await expect(deleteLibraryView("view", 1, a)).rejects.toThrow(/changed/);
  expect((await loadLibraryView("view", a))?.revision).toBe(2);
});

it("moves and renames dashboards atomically and only deletes empty folders", async () => {
  await saveLibraryFolder({ id: "growth", name: "Growth" }, a);
  await saveDashboard({ id: "dash", spec: view.spec }, a);
  await updateLibraryItem("dashboard", "dash", { revision: 1, folderId: "growth", name: "Executive story" }, a);
  expect(await loadDashboard("dash", a)).toMatchObject({ folderId: "growth", revision: 2, name: "Executive story", spec: { title: "Executive story" } });
  await expect(deleteLibraryFolder("growth", 1, a)).rejects.toThrow(/contents/);
  await expect(saveDashboard({ id: "dash", spec: view.spec, revision: 1 }, a)).rejects.toThrow(/changed/);
  await updateLibraryItem("dashboard", "dash", { revision: 2, folderId: null }, a);
  await deleteLibraryFolder("growth", 1, a);
  expect((await listCoreLibrary(a)).folders).toEqual([]);
  expect((await loadDashboard("dash", a))?.spec.tiles).toEqual(view.spec.tiles);
});

it("round-trips the entire library and rolls back invalid folder references", async () => {
  await saveLibraryFolder({ id: "growth", name: "Growth" }, a);
  await saveLibraryView({ ...view, folderId: "growth" }, a);
  await saveDashboard({ id: "dash", spec: view.spec, folderId: "growth" }, a);
  const backup = await exportLibrary();
  await closeStore(); await openStore(":memory:");
  await expect(restoreLibrary({ ...backup, folders: [] })).rejects.toThrow(/folder/);
  expect((await listCoreLibrary(a)).items).toEqual([]);
  await restoreLibrary(backup);
  expect((await exportLibrary()).views).toEqual(backup.views);
  expect((await exportLibrary()).folders).toEqual(backup.folders);
  expect((await loadDashboard("dash", a))?.folderId).toBe("growth");
});
