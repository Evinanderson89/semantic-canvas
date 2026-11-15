import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";

// Separate processes exercise DuckDB's actual host-timezone behavior, not a
// mocked Date formatter. All stores are synthetic and stay in memory.
function inZone(zone: string, backup?: unknown) {
  const script = `
    import {readFileSync} from 'node:fs';
    import {openStore,closeStore,saveDashboard,saveLibraryView,updateLibraryItem,listDashboards,listCoreLibrary,listDashboardVersions,exportLibrary,restoreLibrary} from './src/store/store.ts';
    import {DEFAULT_CANVAS} from './src/canvas/presets.ts';
    const scope={source:'clock-test',model:'Clock test'};
    await openStore(':memory:');
    try {
      const before=Date.now();
      const input=JSON.parse(readFileSync(0,'utf8'));
      if(input) await restoreLibrary(input);
      else {
        const spec={title:'Revenue',tiles:[{id:'heading',kind:'heading',text:'Revenue',metrics:[],dimensions:[],layout:{x:0,y:0,w:400,h:100}}]};
        await saveDashboard({id:'clock',spec,canvas:DEFAULT_CANVAS},scope);
        await saveLibraryView({id:'clock-view',name:'Revenue view',spec,canvas:DEFAULT_CANVAS},scope);
        await updateLibraryItem('dashboard','clock',{revision:1,name:'Board review'},scope);
        await updateLibraryItem('view','clock-view',{revision:1,name:'Board view'},scope);
      }
      console.log(JSON.stringify({before,after:Date.now(),dashboards:await listDashboards(scope),library:await listCoreLibrary(scope),history:await listDashboardVersions('clock',scope),backup:await exportLibrary()}));
    } finally { await closeStore(); }
  `;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, TZ: zone }, input: JSON.stringify(backup ?? null), encoding: "utf8", timeout: 20000,
  }));
}

for (const zone of ["America/New_York", "Asia/Kolkata"]) it(`keeps saves, renames, library dates and backup dates in the same UTC instant under ${zone}`, () => {
  const result = inZone(zone);
  const saved = result.history[0].savedAt;
  expect(result.dashboards[0].updated_at).toBe(saved);
  expect(result.backup.dashboards[0].updatedAt).toBe(saved);
  for (const item of result.library.items) {
    expect(item.updatedAt).toMatch(/Z$/);
    expect(Date.parse(item.updatedAt)).toBeGreaterThanOrEqual(result.before);
    expect(Date.parse(item.updatedAt)).toBeLessThanOrEqual(result.after);
  }
  const restored = inZone("Pacific/Auckland", result.backup);
  expect(restored.backup.dashboards).toEqual(result.backup.dashboards);
  expect(restored.backup.views).toEqual(result.backup.views);
  expect(restored.history).toEqual(result.history);
});

it("preserves uncertainty when restoring version-1 dates without a recorded timezone", () => {
  const original = inZone("America/New_York").backup;
  const legacy = { ...original, version: 1, versions: [] };
  legacy.dashboards[0].updatedAt = "2020-07-01T09:00:00.000Z";
  legacy.views[0].updatedAt = "2020-07-01T10:00:00.000Z";
  const restored = inZone("Pacific/Auckland", legacy);
  expect(restored.dashboards[0].updated_at).toBeNull();
  expect(restored.history[0].savedAt).toBeNull();
  expect(restored.backup.version).toBe(2);
  expect(restored.backup.dashboards[0]).toMatchObject({ updatedAt: null, legacyUpdatedAt: "2020-07-01 09:00:00" });
  expect(restored.backup.views[0]).toMatchObject({ updatedAt: null, legacyUpdatedAt: "2020-07-01 10:00:00" });
  expect(inZone("UTC", restored.backup).backup.dashboards).toEqual(restored.backup.dashboards);
});

it("recovers version-1 dashboard dates from a matching saved version, not its mislabeled backup date", () => {
  const original = inZone("America/New_York").backup;
  const legacy = { ...original, version: 1 };
  legacy.dashboards[0].updatedAt = "2020-07-01T09:00:00.000Z";
  const restored = inZone("Asia/Kolkata", legacy);
  expect(restored.dashboards[0].updated_at).toBe(original.versions.at(-1).savedAt);
});
