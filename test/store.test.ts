import { afterAll, beforeAll, expect, it } from "vitest";
import { openStore, closeStore, saveDashboard, loadDashboard, listDashboards, deleteDashboard } from "../src/store/store.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { dashboardSchema, querySchema } from "../src/compiler/schema.ts";
import { tile } from "./fixtures.ts";
const a = { source: "a", model: "Same model" }, b = { source: "b", model: "Same model" };
const document = { id: "one", spec: { title: "Revenue", tiles: [tile()] }, canvas: DEFAULT_CANVAS };
beforeAll(() => openStore(":memory:"));
afterAll(closeStore);
it("isolates sources even when their model names match", async () => {
  expect(await saveDashboard(document, a)).toMatchObject({ revision: 1 });
  expect(await loadDashboard("one", b)).toBeNull();
  expect(await listDashboards(b)).toEqual([]);
  await expect(saveDashboard({ ...document, revision: 1 }, b)).rejects.toThrow(/another source/);
  await expect(deleteDashboard("one", b, 1)).rejects.toThrow();
  expect((await loadDashboard("one", a))?.spec.title).toBe("Revenue");
});
it("accepts only one of two simultaneous writes to the same revision", async () => {
  const writes = await Promise.allSettled([saveDashboard({ ...document, revision: 1, spec: { ...document.spec, title: "First" } }, a),
    saveDashboard({ ...document, revision: 1, spec: { ...document.spec, title: "Second" } }, a)]);
  expect(writes.filter((w) => w.status === "fulfilled"), JSON.stringify(writes, (_k,v) => v instanceof Error ? v.message : v)).toHaveLength(1);
  expect((await loadDashboard("one", a))?.revision).toBe(2);
});
it("does not treat malformed documents as saved work", async () => {
  await expect(saveDashboard({ ...document, id: "bad", spec: { title: "Bad", tiles: [tile({ layout: { x: 0, y: 0, w: -1, h: 10 } })] } }, a)).rejects.toThrow();
  expect(await loadDashboard("bad", a)).toBeNull();
  expect(dashboardSchema.safeParse({ title: "Duplicate", tiles: [tile(), tile()] }).success).toBe(false);
  expect(querySchema.safeParse({ metrics: ["revenue"], limit: -1 }).success).toBe(false);
  expect(querySchema.safeParse({ metrics: ["revenue"], filters: ["raw SQL"] }).success).toBe(false);
});
it("migrates legacy text size presets on read without losing the authored format", async () => {
  await saveDashboard({ ...document, id: "legacy-format", spec: { title: "Legacy", tiles: [tile({ kind: "text", metrics: [], format: { textSize: "xl" } })] } }, a);
  expect((await loadDashboard("legacy-format", a))?.spec.tiles[0].format?.textSize).toBe(34);
});
