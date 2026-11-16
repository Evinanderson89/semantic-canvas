import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeStore,
  deleteDashboard,
  listAuditEvents,
  listDashboards,
  loadDashboard,
  openStore,
  recordAuditEvent,
  saveDashboard,
  type DashboardScope,
} from "../src/store/store.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { tile } from "./fixtures.ts";

const baseScope: DashboardScope = { source: "public", model: "Sample" };
const aliceScope: DashboardScope = {
  ...baseScope,
  actorId: "user-alice",
  actorName: "Alice Owner",
  actorRole: "editor",
  enforceLock: true,
};
const bobScope: DashboardScope = {
  ...baseScope,
  actorId: "user-bob",
  actorName: "Bob Colleague",
  actorRole: "editor",
  enforceLock: true,
};
const adminScope: DashboardScope = {
  ...baseScope,
  actorId: "user-admin",
  actorName: "Workspace Admin",
  actorRole: "admin",
  enforceLock: true,
};

const spec = { title: "Executive Revenue", tiles: [tile({ id: "mrr" })] };

beforeEach(() => openStore(":memory:"));
afterEach(closeStore);

it("tracks dashboard owner and lock state and prevents non-owner editors from overwriting or deleting locked dashboards in company mode", async () => {
  const created = await saveDashboard(
    { id: "exec-rev", spec, canvas: DEFAULT_CANVAS, locked: true },
    aliceScope,
  );
  expect(created.revision).toBe(1);

  const loaded = await loadDashboard("exec-rev", bobScope);
  expect(loaded).toMatchObject({
    id: "exec-rev",
    ownerId: "user-alice",
    ownerName: "Alice Owner",
    locked: true,
    revision: 1,
  });

  const listed = await listDashboards(bobScope);
  expect(listed).toEqual([
    expect.objectContaining({
      id: "exec-rev",
      ownerId: "user-alice",
      ownerName: "Alice Owner",
      locked: true,
      revision: 1,
    }),
  ]);

  // Another editor cannot overwrite or delete Alice's locked dashboard in company mode.
  await expect(
    saveDashboard({ id: "exec-rev", revision: 1, spec: { ...spec, title: "Bob edit" }, canvas: DEFAULT_CANVAS }, bobScope),
  ).rejects.toMatchObject({
    status: 403,
    message: expect.stringContaining("locked by its owner"),
  });
  await expect(deleteDashboard("exec-rev", bobScope, 1)).rejects.toMatchObject({
    status: 403,
    message: expect.stringContaining("locked by its owner"),
  });

  // Another editor can save a copy under a new id.
  const copy = await saveDashboard(
    { id: "exec-rev-bob-copy", revision: 0, spec: { ...spec, title: "Bob Copy" }, canvas: DEFAULT_CANVAS },
    bobScope,
  );
  expect(copy.revision).toBe(1);
  expect(await loadDashboard("exec-rev-bob-copy", bobScope)).toMatchObject({
    ownerId: "user-bob",
    ownerName: "Bob Colleague",
    locked: false,
  });

  // The owner can update their own locked dashboard and preserves lock when omitted.
  const ownerUpdate = await saveDashboard(
    { id: "exec-rev", revision: 1, spec: { ...spec, title: "Alice Revised" }, canvas: DEFAULT_CANVAS },
    aliceScope,
  );
  expect(ownerUpdate.revision).toBe(2);
  expect(await loadDashboard("exec-rev", aliceScope)).toMatchObject({
    ownerId: "user-alice",
    ownerName: "Alice Owner",
    locked: true,
    revision: 2,
  });

  // An admin can unlock or update a locked dashboard owned by someone else.
  const adminUnlock = await saveDashboard(
    { id: "exec-rev", revision: 2, locked: false, spec: { ...spec, title: "Admin Unlocked" }, canvas: DEFAULT_CANVAS },
    adminScope,
  );
  expect(adminUnlock.revision).toBe(3);
  expect(await loadDashboard("exec-rev", bobScope)).toMatchObject({
    ownerId: "user-alice",
    ownerName: "Alice Owner",
    locked: false,
    revision: 3,
  });

  // Once unlocked, another editor can update it while original ownership stays intact.
  const bobUpdate = await saveDashboard(
    { id: "exec-rev", revision: 3, spec: { ...spec, title: "Bob Collaborative Edit" }, canvas: DEFAULT_CANVAS },
    bobScope,
  );
  expect(bobUpdate.revision).toBe(4);
  expect(await loadDashboard("exec-rev", bobScope)).toMatchObject({
    ownerId: "user-alice",
    ownerName: "Alice Owner",
    locked: false,
    revision: 4,
  });

  // Re-lock as owner, then verify admin can delete a locked dashboard.
  await saveDashboard(
    { id: "exec-rev", revision: 4, locked: true, spec, canvas: DEFAULT_CANVAS },
    aliceScope,
  );
  expect(await deleteDashboard("exec-rev", adminScope, 5)).toEqual({ ok: true });
  expect(await loadDashboard("exec-rev", adminScope)).toBeNull();
});

it("records and lists durable audit events in reverse chronological order", async () => {
  const first = await recordAuditEvent("auth.signed_in", { actor: "user-alice", role: "editor" });
  const second = await recordAuditEvent("audit.dashboard_saved", { actor: "user-alice", id: "exec-rev", revision: 1, locked: true });
  const third = await recordAuditEvent("audit.library_exported", { actor: "user-admin", count: 2 });

  expect(first).toMatchObject({ event: "auth.signed_in", actor: "user-alice", details: { actor: "user-alice", role: "editor" } });
  expect(second?.id).toBeTruthy();
  expect(third?.ts).toMatch(/Z$/);

  const all = await listAuditEvents();
  expect(all.map(e => e.event)).toEqual([
    "audit.library_exported",
    "audit.dashboard_saved",
    "auth.signed_in",
  ]);
  expect(all[0]).toMatchObject({
    event: "audit.library_exported",
    actor: "user-admin",
    details: { actor: "user-admin", count: 2 },
  });

  const limited = await listAuditEvents(2);
  expect(limited).toHaveLength(2);
  expect(limited.map(e => e.event)).toEqual([
    "audit.library_exported",
    "audit.dashboard_saved",
  ]);
});
