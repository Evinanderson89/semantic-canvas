import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistentSessionStore,
  createSchedulerLeaseManager,
  decryptSecret,
  encryptSecret,
  hashSessionToken,
  type PersistedSession,
} from "../src/store/sessionStore.ts";

describe("Persistent Encrypted Session Store & Distributed Scheduler Lease Lock", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sc-ha-sessions-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("encryptSecret & decryptSecret", () => {
    it("encrypts with AES-256-GCM, uses distinct IVs, and rejects wrong keys or tampered auth tags", () => {
      const secret = "server-master-secret-key-2026";
      const plaintext = "oidc-refresh-token-super-sensitive-value";

      const cipherA = encryptSecret(plaintext, secret);
      const cipherB = encryptSecret(plaintext, secret);

      expect(cipherA).not.toBe(cipherB);
      expect(cipherA.startsWith("v1:")).toBe(true);
      expect(cipherA).not.toContain(plaintext);

      expect(decryptSecret(cipherA, secret)).toBe(plaintext);
      expect(decryptSecret(cipherB, secret)).toBe(plaintext);

      // Wrong key must fail authentication
      expect(decryptSecret(cipherA, "wrong-server-secret")).toBeNull();

      // Tampering with ciphertext or auth tag must be rejected
      const parts = cipherA.split(":");
      const flippedTag =
        parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
      const tamperedTagToken = [parts[0], parts[1], flippedTag, parts[3]].join(":");
      expect(decryptSecret(tamperedTagToken, secret)).toBeNull();

      const flippedData =
        parts[3].slice(0, -1) + (parts[3].endsWith("A") ? "B" : "A");
      const tamperedDataToken = [parts[0], parts[1], parts[2], flippedData].join(":");
      expect(decryptSecret(tamperedDataToken, secret)).toBeNull();

      // Malformed tokens return null safely
      expect(decryptSecret("invalid-format", secret)).toBeNull();
      expect(decryptSecret("v2:a:b:c", secret)).toBeNull();
      expect(decryptSecret(cipherA, "")).toBeNull();
    });
  });

  describe("createPersistentSessionStore", () => {
    it("persists hashed sessions across simulated server restarts with 0o600 permissions and never writes plaintext refresh tokens", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "sessions.json");
      const secret = "ha-cluster-session-secret";
      const now = 1_700_000_000_000;

      const rawCookieAlice = "raw-cookie-token-alice-12345";
      const rawCookieBob = "raw-cookie-token-bob-67890";
      const aliceHash = hashSessionToken(rawCookieAlice);
      const bobHash = hashSessionToken(rawCookieBob);

      const storeInstance1 = createPersistentSessionStore({
        filePath,
        encryptionSecret: secret,
      });

      const aliceSession: PersistedSession = {
        identity: {
          id: "ident-alice",
          name: "Alice Executive",
          role: "admin",
          principal: "all_access",
          sources: ["*"],
        },
        csrf: "csrf-alice",
        expires: now + 3600_000,
        nextCheck: now + 300_000,
        refreshToken: "alice-secret-oidc-refresh-token",
      };

      const bobExpiredSession: PersistedSession = {
        identity: {
          id: "ident-bob",
          name: "Bob Viewer",
          role: "viewer",
          principal: "us_only",
          sources: ["warehouse"],
        },
        csrf: "csrf-bob",
        expires: now - 1_000,
        refreshToken: "bob-expired-refresh-token",
      };

      await storeInstance1.save(aliceHash, aliceSession);
      await storeInstance1.save(bobHash, bobExpiredSession);

      // Verify file mode is 0o600 and raw cookie / plaintext refresh token are absent on disk
      const fileStats = await stat(filePath);
      expect(fileStats.mode & 0o777).toBe(0o600);

      const rawDiskJson = await readFile(filePath, "utf8");
      expect(rawDiskJson).not.toContain(rawCookieAlice);
      expect(rawDiskJson).not.toContain("alice-secret-oidc-refresh-token");
      expect(rawDiskJson).not.toContain("bob-expired-refresh-token");
      expect(rawDiskJson).toContain(aliceHash);

      // Simulate server restart with a new store instance reading the same file
      const storeInstance2 = createPersistentSessionStore({
        filePath,
        encryptionSecret: secret,
      });

      const loaded = await storeInstance2.load(now);
      expect(loaded.size).toBe(1);
      expect(loaded.has(bobHash)).toBe(false);

      const reloadedAlice = loaded.get(aliceHash);
      expect(reloadedAlice).toBeDefined();
      expect(reloadedAlice?.identity.id).toBe("ident-alice");
      expect(reloadedAlice?.csrf).toBe("csrf-alice");
      expect(reloadedAlice?.refreshToken).toBe("alice-secret-oidc-refresh-token");
      expect(reloadedAlice?.encryptedRefreshToken).toMatch(/^v1:/);

      // Simulate secret rotation on restart: session loads safely with refreshToken dropped
      const storeRotated = createPersistentSessionStore({
        filePath,
        encryptionSecret: "rotated-new-secret",
      });
      const loadedAfterRotation = await storeRotated.load(now);
      expect(loadedAfterRotation.size).toBe(1);
      expect(loadedAfterRotation.get(aliceHash)?.identity.id).toBe("ident-alice");
      expect(loadedAfterRotation.get(aliceHash)?.refreshToken).toBeUndefined();
    });

    it("supports remove, revokeByIdentityId, and prune", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "sessions-ops.json");
      const now = 1_700_000_000_000;

      const store = createPersistentSessionStore({
        filePath,
        encryptionSecret: "secret-key",
      });

      await store.save("hash-a1", {
        identity: { id: "user-1", name: "User One", role: "editor", principal: "p1", sources: ["*"] },
        csrf: "c1",
        expires: now + 60_000,
      });
      await store.save("hash-a2", {
        identity: { id: "user-1", name: "User One", role: "editor", principal: "p1", sources: ["*"] },
        csrf: "c2",
        expires: now + 60_000,
      });
      await store.save("hash-b1", {
        identity: { id: "user-2", name: "User Two", role: "viewer", principal: "p2", sources: ["*"] },
        csrf: "c3",
        expires: now + 10_000,
      });

      // Revoke all sessions for user-1
      const revokedCount = await store.revokeByIdentityId("user-1");
      expect(revokedCount).toBe(2);

      const afterRevoke = await store.load(now);
      expect(afterRevoke.size).toBe(1);
      expect(afterRevoke.has("hash-b1")).toBe(true);

      // Prune after user-2 expires
      const prunedCount = await store.prune(now + 20_000);
      expect(prunedCount).toBe(1);

      const afterPrune = await store.load(now + 20_000);
      expect(afterPrune.size).toBe(0);

      // Explicit remove
      await store.save("hash-c1", {
        identity: { id: "user-3", name: "User Three", role: "admin", principal: "p3", sources: ["*"] },
        csrf: "c4",
        expires: now + 100_000,
      });
      expect(await store.remove("hash-c1")).toBe(true);
      expect(await store.remove("hash-c1")).toBe(false);
    });
  });

  describe("createSchedulerLeaseManager", () => {
    it("coordinates leases across competing replicas (contention, renewal, release, and TTL expiry takeover)", async () => {
      const dir = await makeTempDir();
      const filePath = join(dir, "scheduler-leases.json");
      const t0 = 1_700_000_000_000;
      const ttlMs = 30_000;

      const replicaA = createSchedulerLeaseManager({ filePath });
      const replicaB = createSchedulerLeaseManager({ filePath });

      // replica-a acquires the alert sweep lease
      expect(await replicaA.acquire("alert-sweep", "replica-a", ttlMs, t0)).toBe(true);
      expect(await replicaA.inspect("alert-sweep", t0)).toEqual({
        holderId: "replica-a",
        expiresAt: t0 + ttlMs,
      });

      // replica-b cannot acquire or renew while replica-a's lease is active
      expect(await replicaB.acquire("alert-sweep", "replica-b", ttlMs, t0 + 5_000)).toBe(false);
      expect(await replicaB.renew("alert-sweep", "replica-b", ttlMs, t0 + 5_000)).toBe(false);
      expect(await replicaB.release("alert-sweep", "replica-b")).toBe(false);

      // replica-a can renew its active lease
      expect(await replicaA.renew("alert-sweep", "replica-a", ttlMs, t0 + 20_000)).toBe(true);
      expect(await replicaB.inspect("alert-sweep", t0 + 25_000)).toEqual({
        holderId: "replica-a",
        expiresAt: t0 + 20_000 + ttlMs,
      });

      // After TTL expires, inspect returns null and replica-b can take over the lease
      const afterExpiry = t0 + 20_000 + ttlMs + 1;
      expect(await replicaB.inspect("alert-sweep", afterExpiry)).toBeNull();
      expect(await replicaB.acquire("alert-sweep", "replica-b", ttlMs, afterExpiry)).toBe(true);
      expect(await replicaA.inspect("alert-sweep", afterExpiry)).toEqual({
        holderId: "replica-b",
        expiresAt: afterExpiry + ttlMs,
      });

      // replica-b releases the lease explicitly, allowing replica-a to acquire immediately
      expect(await replicaB.release("alert-sweep", "replica-b")).toBe(true);
      expect(await replicaB.inspect("alert-sweep", afterExpiry + 1_000)).toBeNull();
      expect(await replicaA.acquire("alert-sweep", "replica-a", ttlMs, afterExpiry + 1_000)).toBe(
        true,
      );
    });
  });
});
