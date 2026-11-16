import { beforeEach, afterEach, expect, it } from "vitest";
import { openStore, closeStore, saveDashboard, listDashboardVersions, loadDashboardVersion, updateLibraryItem, deleteDashboard, exportLibrary, restoreLibrary } from "../src/store/store.ts";
import { documentSnapshot, fingerprint } from "../src/app/document.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { tile } from "./fixtures.ts";
const scope = { source: "sample", model: "sample" };
const original = { id: "history", spec: { title: "First design", tiles: [tile()] }, canvas: DEFAULT_CANVAS };
beforeEach(() => openStore(":memory:")); afterEach(closeStore);
it("retains immutable saves, rejects stale writes, and records library renames", async () => {
  await saveDashboard(original, scope);
  await saveDashboard({ ...original, revision: 1, spec: { title: "Second design", tiles: [] } }, scope);
  await expect(saveDashboard({ ...original, revision: 1 }, scope)).rejects.toThrow(/changed/);
  await updateLibraryItem("dashboard", "history", { revision: 2, name: "Board review" }, scope);
  expect((await listDashboardVersions("history", scope)).map(v => [v.revision, v.name, v.current])).toEqual([[3,"Board review",true],[2,"Second design",false],[1,"First design",false]]);
  expect((await loadDashboardVersion("history", 1, scope)).spec).toEqual(original.spec);
  expect((await listDashboardVersions("history", scope))[0].savedAt).toMatch(/Z$/);
  await expect(listDashboardVersions("history", { ...scope, source: "other" })).rejects.toMatchObject({ status: 404 });
  await expect(loadDashboardVersion("history", 1, { ...scope, source: "other" })).rejects.toMatchObject({ status: 404 });
});
it("preserves every version through backup and removes it with its dashboard", async () => {
  await saveDashboard(original, scope);
  await saveDashboard({ ...original, revision: 1, spec: { title: "Second", tiles: [] } }, scope);
  const backup = await exportLibrary(); expect(backup.versions).toHaveLength(2);
  await closeStore(); await openStore(":memory:"); await restoreLibrary(backup);
  expect((await exportLibrary()).versions).toEqual(backup.versions);
  const old = await loadDashboardVersion("history", 1, scope);
  await saveDashboard({ id:old.id, spec:old.spec, canvas:old.canvas, revision: 2 }, scope);
  expect((await listDashboardVersions("history", scope)).map(v => v.revision)).toEqual([3,2,1]);
  await deleteDashboard("history",scope,3);
  expect((await exportLibrary()).versions).toEqual([]);
});
it("exposes an older imported current save without inventing lost history or a timestamp", async () => {
  await saveDashboard(original, scope); const backup = await exportLibrary();
  await closeStore(); await openStore(":memory:");
  const { versions: _, ...legacy } = backup; await restoreLibrary({ ...legacy, version: 1 });
  expect(await listDashboardVersions("history", scope)).toMatchObject([{ revision:1, savedAt:null, current:true }]);
  await saveDashboard({ ...original, revision:1 },scope);
  expect(await listDashboardVersions("history", scope)).toHaveLength(2);
});
it("preview mode is transient and never changes document identity or the saved canvas", () => {
  expect(fingerprint(original.spec, DEFAULT_CANVAS)).toBe(fingerprint(original.spec,{ ...DEFAULT_CANVAS, locked:true }));
  expect(documentSnapshot(original.spec,{ ...DEFAULT_CANVAS, locked:true }).canvas.locked).toBe(false);
});
