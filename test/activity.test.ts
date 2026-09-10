import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { evaluateAlert, nextPeriod } from "../src/activity/evaluate.ts";
import { alertInputSchema, type ActivityRecord } from "../src/activity/model.ts";
import { openStore, closeStore, saveDashboard, mutateActivity, listActivity, exportLibrary, deleteDashboard, restoreLibrary } from "../src/store/store.ts";
import { tile } from "./fixtures.ts";

const rule = alertInputSchema.parse({ metric: "revenue", mode: "anomaly" });
const now = new Date("2026-09-09T12:00:00Z");
const series = (values: (number | null)[]) => ({ columns: ["date_day", "revenue"], rows: values.map((value, i) => [new Date(+new Date("2026-09-09T00:00:00Z") - (values.length - i) * 86400000).toISOString(), value]) });
it("learns a trend without including the tested value in its baseline", () => {
  const steady = Array.from({ length: 24 }, (_, i) => 100 + 5 * i);
  const normal = evaluateAlert(rule, series(steady), "day:events.date", now);
  expect(normal.state).toBe("normal"); expect(normal.expected).toBe(215);
  const spike = evaluateAlert(rule, series([...steady.slice(0, -1), 900]), "day:events.date", now);
  expect(spike).toMatchObject({ state: "triggered", value: 900, expected: 215, baselinePoints: 23 });
  expect(spike.upper).toBe(normal.upper);
  expect(evaluateAlert({ ...rule, direction: "below" }, series([...steady.slice(0, -1), 900]), "day:events.date", now).state).toBe("normal");
});
it("handles constant baselines, negative values and weekly seasonality", () => {
  expect(evaluateAlert(rule, series(Array(20).fill(0)), "day:events.date", now).state).toBe("normal");
  expect(evaluateAlert(rule, series([...Array(19).fill(0), 3]), "day:events.date", now).state).toBe("triggered");
  expect(evaluateAlert(rule, series([...Array(19).fill(-10), -50]), "day:events.date", now).state).toBe("triggered");
  const weekly = Array.from({ length: 36 }, (_, i) => 100 + i + (i % 7 === 0 ? 300 : 0));
  expect(evaluateAlert(rule, series(weekly), "day:events.date", now)).toMatchObject({ state: "normal", seasonal: true });
});
it("waits for fresh closed periods, sufficient history, finite values and continuous dates", () => {
  expect(evaluateAlert(rule, series([1, 2, 3]), "day:events.date", now).state).toBe("waiting");
  const input = series(Array(20).fill(100));
  input.rows.push([now.toISOString(), 99999]);
  expect(evaluateAlert(rule, input, "day:events.date", now)).toMatchObject({ state: "normal", value: 100, period: "2026-09-08" });
  expect(evaluateAlert(rule, series([...Array(19).fill(1), null]), "day:events.date", now).reason).toMatch(/missing/);
  expect(evaluateAlert(rule, series([...Array(19).fill(1), Infinity]), "day:events.date", now).state).toBe("waiting");
  const timestamps = series(Array(20).fill(100)); timestamps.rows = timestamps.rows.map(([date, value]) => [String(date).replace("T", " ").replace("Z", ""), value]);
  expect(evaluateAlert(rule, timestamps, "day:events.date", now).state).toBe("normal");
  const gap = series(Array(20).fill(100)); gap.rows.splice(10, 1);
  expect(evaluateAlert(rule, gap, "day:events.date", now).reason).toMatch(/gaps/);
  const duplicate = series(Array(20).fill(100)); duplicate.rows.push(duplicate.rows[0]);
  expect(evaluateAlert(rule, duplicate, "day:events.date", now).reason).toMatch(/multiple values/);
  const stale = series(Array(20).fill(100)); stale.rows.pop();
  expect(evaluateAlert(rule, stale, "day:events.date", now).reason).toMatch(/most recently closed/);
  expect(nextPeriod(new Date("2024-02-01Z"), "month").toISOString()).toBe("2024-03-01T00:00:00.000Z");
});
it("thresholds preserve zeros and do not silently aggregate breakdowns", () => {
  const threshold = alertInputSchema.parse({ mode: "threshold", metric: "revenue", operator: "below", threshold: 1 });
  expect(evaluateAlert(threshold, { columns: ["revenue"], rows: [[0]] }, undefined, now).state).toBe("triggered");
  expect(evaluateAlert(threshold, { columns: ["revenue"], rows: [[null]] }, undefined, now).state).toBe("waiting");
  expect(evaluateAlert(threshold, { columns: ["revenue"], rows: [[1], [0]] }, undefined, now).state).toBe("waiting");
  expect(alertInputSchema.safeParse({ mode: "threshold", metric: "revenue" }).success).toBe(false);
});
const scope = { source: "demo", dashboardId: "activity-dashboard", audience: "emea" };
const storeScope = { source: "demo", model: "Demo" };
const chart = tile({ id: "chart" });
const doc = { id: scope.dashboardId, spec: { title: "Activity test", tiles: [chart] } };
const thread: ActivityRecord = { ...scope, id: "thread-one", tileId: "chart", ownerId: "alice", type: "thread", body: { id: "thread-one", authorId: "alice", authorName: "Alice", body: "Please investigate.", createdAt: now.toISOString(), resolved: false, replies: [] } };
let directory = "";
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "sc-activity-")); await openStore(join(directory, "library.duckdb")); });
afterAll(async () => { await closeStore(); await rm(directory, { recursive: true, force: true }); });
it("isolates audiences and private watches, preserves concurrent replies, and backs up activity", async () => {
  await saveDashboard(doc, storeScope);
  await mutateActivity(scope, "chart", () => structuredClone(thread));
  expect(await listActivity({ ...scope, source: "other" }, "alice")).toEqual([]);
  expect(await listActivity({ ...scope, audience: "americas" }, "alice")).toEqual([]);
  expect(await listActivity(scope, "bob")).toHaveLength(1);
  await Promise.all(["one", "two"].map(id => mutateActivity(scope, "chart", rows => { const row = rows[0]; (row.body as any).replies.push({ id, authorId: "bob", authorName: "Bob", body: id, createdAt: now.toISOString() }); return row; })));
  expect(((await listActivity(scope, "bob"))[0].body as any).replies).toHaveLength(2);
  await mutateActivity(scope, "chart", () => ({ ...scope, id: "watch", tileId: "chart", ownerId: "alice", type: "alert", body: { ...rule, id: "watch", version: 1, enabled: true, ownerId: "alice", principalId: "emea", queryFingerprint: "test-hash", createdAt: now.toISOString(), nextCheckAt: now.toISOString(), events: [] } }));
  expect(await listActivity(scope, "bob")).toHaveLength(1); expect(await listActivity(scope, "alice")).toHaveLength(2);
  const backup = await exportLibrary(); expect(backup.activity).toHaveLength(2);
  await saveDashboard({ ...doc, revision: 1, spec: { ...doc.spec, tiles: [] } }, storeScope);
  expect(await listActivity(scope, "alice")).toHaveLength(0);
  await deleteDashboard(doc.id, storeScope, 2);
  await restoreLibrary(backup);
  expect((await listActivity(scope, "alice")).find(r => r.type === "alert")?.body).toMatchObject({ enabled: false });
  await deleteDashboard(doc.id, storeScope, 1);
  await expect(mutateActivity(scope, "chart", () => thread)).rejects.toThrow(/Save this chart/);
});

it("keeps chart activity when the persistent store is closed and reopened", async () => {
  await saveDashboard(doc, storeScope); await mutateActivity(scope, "chart", () => structuredClone(thread));
  await closeStore(); await openStore(join(directory, "library.duckdb"));
  expect((await listActivity(scope, "bob"))[0].body).toMatchObject({ body: "Please investigate.", authorId: "alice" });
});
