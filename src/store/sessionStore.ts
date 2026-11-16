import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ForwardedAuth, Identity } from "../security/auth.ts";

export interface PersistedSession {
  identity: Identity;
  csrf: string;
  expires: number;
  nextCheck?: number;
  refreshToken?: string;
  encryptedRefreshToken?: string;
  forwarded?: ForwardedAuth;
  claims?: Record<string, unknown>;
}

interface DiskSessionRecord {
  identity: Identity;
  csrf: string;
  expires: number;
  nextCheck?: number;
  encryptedRefreshToken?: string;
  forwarded?: ForwardedAuth;
  claims?: Record<string, unknown>;
}

interface DiskSessionFile {
  version: 1;
  sessions: Record<string, DiskSessionRecord>;
}

export interface PersistentSessionStore {
  load(now?: number): Promise<Map<string, PersistedSession>>;
  save(sessionHash: string, session: PersistedSession): Promise<void>;
  remove(sessionHash: string): Promise<boolean>;
  revokeByIdentityId(identityId: string): Promise<number>;
  prune(now?: number): Promise<number>;
}

export interface SchedulerLease {
  holderId: string;
  expiresAt: number;
}

interface DiskLeaseFile {
  version: 1;
  leases: Record<string, SchedulerLease>;
}

export interface SchedulerLeaseManager {
  acquire(jobName: string, holderId: string, ttlMs: number, now?: number): Promise<boolean>;
  renew(jobName: string, holderId: string, ttlMs: number, now?: number): Promise<boolean>;
  release(jobName: string, holderId: string): Promise<boolean>;
  inspect(jobName: string, now?: number): Promise<SchedulerLease | null>;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Encrypts a sensitive token using AES-256-GCM with a 32-byte SHA-256 key
 * derived from `secret` and a random 96-bit IV.
 */
export function encryptSecret(plaintext: string, secret: string): string {
  if (!secret) {
    throw new Error("Encryption secret must not be empty");
  }
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

/**
 * Decrypts a token produced by `encryptSecret`. Returns `null` if the secret
 * was rotated, the format is invalid, or the GCM authentication tag fails.
 */
export function decryptSecret(ciphertext: string, secret: string): string | null {
  if (!secret || typeof ciphertext !== "string") return null;
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || dataB64 === undefined) return null;
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const key = deriveKey(secret);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

async function writeAtomicJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const content = JSON.stringify(payload, null, 2);
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

function createSerializer() {
  let pending: Promise<unknown> = Promise.resolve();
  return function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  };
}

export function createPersistentSessionStore(options: {
  filePath: string;
  encryptionSecret?: string;
}): PersistentSessionStore {
  const { filePath, encryptionSecret } = options;
  const serialized = createSerializer();

  async function readDiskSessions(): Promise<Record<string, DiskSessionRecord>> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DiskSessionFile>;
      if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
        return {};
      }
      const out: Record<string, DiskSessionRecord> = {};
      for (const [hash, record] of Object.entries(parsed.sessions)) {
        if (
          record &&
          typeof record === "object" &&
          record.identity &&
          typeof record.identity.id === "string" &&
          typeof record.csrf === "string" &&
          typeof record.expires === "number"
        ) {
          out[hash] = {
            identity: record.identity,
            csrf: record.csrf,
            expires: record.expires,
            ...(record.nextCheck !== undefined ? { nextCheck: record.nextCheck } : {}),
            ...(typeof record.encryptedRefreshToken === "string"
              ? { encryptedRefreshToken: record.encryptedRefreshToken }
              : {}),
            ...(record.forwarded !== undefined ? { forwarded: record.forwarded } : {}),
            ...(record.claims !== undefined ? { claims: record.claims } : {}),
          };
        }
      }
      return out;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  }

  async function writeDiskSessions(sessions: Record<string, DiskSessionRecord>): Promise<void> {
    const payload: DiskSessionFile = {
      version: 1,
      sessions,
    };
    await writeAtomicJson(filePath, payload);
  }

  function toPersistedRecord(session: PersistedSession): DiskSessionRecord {
    let encryptedRefreshToken = session.encryptedRefreshToken;
    if (session.refreshToken) {
      encryptedRefreshToken = encryptionSecret
        ? encryptSecret(session.refreshToken, encryptionSecret)
        : undefined;
    }
    return {
      identity: session.identity,
      csrf: session.csrf,
      expires: session.expires,
      ...(session.nextCheck !== undefined ? { nextCheck: session.nextCheck } : {}),
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      ...(session.forwarded !== undefined ? { forwarded: session.forwarded } : {}),
      ...(session.claims !== undefined ? { claims: session.claims } : {}),
    };
  }

  function fromDiskRecord(record: DiskSessionRecord): PersistedSession {
    let refreshToken: string | undefined;
    if (record.encryptedRefreshToken && encryptionSecret) {
      const decrypted = decryptSecret(record.encryptedRefreshToken, encryptionSecret);
      if (decrypted !== null) {
        refreshToken = decrypted;
      }
    }
    return {
      identity: record.identity,
      csrf: record.csrf,
      expires: record.expires,
      ...(record.nextCheck !== undefined ? { nextCheck: record.nextCheck } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(record.encryptedRefreshToken !== undefined
        ? { encryptedRefreshToken: record.encryptedRefreshToken }
        : {}),
      ...(record.forwarded !== undefined ? { forwarded: record.forwarded } : {}),
      ...(record.claims !== undefined ? { claims: record.claims } : {}),
    };
  }

  return {
    load: (now = Date.now()) =>
      serialized(async () => {
        const records = await readDiskSessions();
        const live = new Map<string, PersistedSession>();
        let pruned = false;
        for (const [hash, record] of Object.entries(records)) {
          if (record.expires <= now) {
            delete records[hash];
            pruned = true;
            continue;
          }
          live.set(hash, fromDiskRecord(record));
        }
        if (pruned) {
          await writeDiskSessions(records);
        }
        return live;
      }),

    save: (sessionHash: string, session: PersistedSession) =>
      serialized(async () => {
        if (!sessionHash || typeof sessionHash !== "string") {
          throw new Error("sessionHash is required");
        }
        const records = await readDiskSessions();
        records[sessionHash] = toPersistedRecord(session);
        await writeDiskSessions(records);
      }),

    remove: (sessionHash: string) =>
      serialized(async () => {
        const records = await readDiskSessions();
        if (!(sessionHash in records)) {
          return false;
        }
        delete records[sessionHash];
        await writeDiskSessions(records);
        return true;
      }),

    revokeByIdentityId: (identityId: string) =>
      serialized(async () => {
        const records = await readDiskSessions();
        let removed = 0;
        for (const [hash, record] of Object.entries(records)) {
          if (record.identity.id === identityId) {
            delete records[hash];
            removed += 1;
          }
        }
        if (removed > 0) {
          await writeDiskSessions(records);
        }
        return removed;
      }),

    prune: (now = Date.now()) =>
      serialized(async () => {
        const records = await readDiskSessions();
        let removed = 0;
        for (const [hash, record] of Object.entries(records)) {
          if (record.expires <= now) {
            delete records[hash];
            removed += 1;
          }
        }
        if (removed > 0) {
          await writeDiskSessions(records);
        }
        return removed;
      }),
  };
}

export function createSchedulerLeaseManager(options: { filePath: string }): SchedulerLeaseManager {
  const { filePath } = options;
  const serialized = createSerializer();

  async function readLeases(): Promise<Record<string, SchedulerLease>> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DiskLeaseFile>;
      if (!parsed || typeof parsed !== "object" || !parsed.leases || typeof parsed.leases !== "object") {
        return {};
      }
      const out: Record<string, SchedulerLease> = {};
      for (const [job, lease] of Object.entries(parsed.leases)) {
        if (
          lease &&
          typeof lease === "object" &&
          typeof lease.holderId === "string" &&
          typeof lease.expiresAt === "number"
        ) {
          out[job] = {
            holderId: lease.holderId,
            expiresAt: lease.expiresAt,
          };
        }
      }
      return out;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  }

  async function writeLeases(leases: Record<string, SchedulerLease>): Promise<void> {
    const payload: DiskLeaseFile = {
      version: 1,
      leases,
    };
    await writeAtomicJson(filePath, payload);
  }

  return {
    acquire: (jobName: string, holderId: string, ttlMs: number, now = Date.now()) =>
      serialized(async () => {
        if (!jobName || !holderId || ttlMs <= 0) {
          return false;
        }
        const leases = await readLeases();
        const existing = leases[jobName];
        if (!existing || existing.expiresAt <= now || existing.holderId === holderId) {
          leases[jobName] = {
            holderId,
            expiresAt: now + ttlMs,
          };
          await writeLeases(leases);
          return true;
        }
        return false;
      }),

    renew: (jobName: string, holderId: string, ttlMs: number, now = Date.now()) =>
      serialized(async () => {
        if (!jobName || !holderId || ttlMs <= 0) {
          return false;
        }
        const leases = await readLeases();
        const existing = leases[jobName];
        if (!existing || existing.expiresAt <= now || existing.holderId !== holderId) {
          return false;
        }
        leases[jobName] = {
          holderId,
          expiresAt: now + ttlMs,
        };
        await writeLeases(leases);
        return true;
      }),

    release: (jobName: string, holderId: string) =>
      serialized(async () => {
        const leases = await readLeases();
        const existing = leases[jobName];
        if (!existing || existing.holderId !== holderId) {
          return false;
        }
        delete leases[jobName];
        await writeLeases(leases);
        return true;
      }),

    inspect: (jobName: string, now = Date.now()) =>
      serialized(async () => {
        const leases = await readLeases();
        const existing = leases[jobName];
        if (!existing || existing.expiresAt <= now) {
          return null;
        }
        return {
          holderId: existing.holderId,
          expiresAt: existing.expiresAt,
        };
      }),
  };
}
