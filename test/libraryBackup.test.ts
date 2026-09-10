import { afterAll, beforeAll, expect, it } from "vitest";
import { openStore, closeStore, saveDashboard, exportLibrary, restoreLibrary, loadDashboard } from "../src/store/store.ts";
beforeAll(() => openStore(":memory:")); afterAll(closeStore);
it("restores revisions and source isolation and refuses destructive or malformed restores", async () => {
  await saveDashboard({ id: "one", spec: { title: "First", tiles: [] } }, { source: "a", model: "Model A" });
  await saveDashboard({ id: "one", revision: 1, spec: { title: "Revised", tiles: [] } }, { source: "a", model: "Model A" });
  await saveDashboard({ id: "two", spec: { title: "Second", tiles: [] } }, { source: "b", model: "Model B" });
  const backup = await exportLibrary(); expect(backup.dashboards).toHaveLength(2);
  await expect(restoreLibrary(backup)).rejects.toThrow(/empty/);
  await closeStore(); await openStore(":memory:");
  await expect(restoreLibrary({ ...backup, dashboards: [...backup.dashboards, { ...backup.dashboards[0], spec: {} }] })).rejects.toThrow(/Backup contains 1 document that do not match the current schema: one\. Export again/);
  await expect(restoreLibrary({ ...backup, dashboards: backup.dashboards.map(d => ({ ...d, spec: { ...d.spec, notes: "legacy" } })) })).rejects.toThrow(/2 documents that do not match the current schema: one, two\./);
  expect((await exportLibrary()).dashboards).toEqual([]);
  expect(await restoreLibrary(backup)).toEqual({ restored: 2 });
  expect((await loadDashboard("one", { source: "a", model: "Model A" }))?.revision).toBe(2);
  expect(await loadDashboard("one", { source: "b", model: "Model B" })).toBeNull();
  expect((await exportLibrary()).dashboards).toEqual(backup.dashboards);
});
