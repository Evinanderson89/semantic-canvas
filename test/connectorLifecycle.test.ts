import { afterEach, expect, it, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";

vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const connection = () => ({ closeSync: vi.fn(), run: vi.fn(async () => {}), runAndReadAll: vi.fn(async () => ({ getRows: () => [[1]], columnNames: () => ["value"] })) });
function instance(connect: () => Promise<any>) {
  const db = { connect: vi.fn(connect), closeSync: vi.fn() };
  vi.spyOn(DuckDBInstance, "create").mockResolvedValue(db as any);
  return db;
}

for (const size of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it(`rejects invalid DuckDB pool size ${size} before opening the database`, async () => {
  const create = vi.spyOn(DuckDBInstance, "create");
  await expect(pooledDuckdb("/synthetic", { size })).rejects.toThrow("Connection pool size must be a positive integer");
  expect(create).not.toHaveBeenCalled();
});

it("waits for late connection attempts and releases every successful handle when pool startup fails", async () => {
  const early = connection(), late = connection(), failure = new Error("Connection allocation failed");
  let complete!: (value: any) => void;
  const delayed = new Promise(resolve => { complete = resolve; });
  const db = instance(vi.fn().mockResolvedValueOnce(early).mockRejectedValueOnce(failure).mockReturnValueOnce(delayed));
  const pending = pooledDuckdb("/synthetic", { size: 3 });
  const outcome = pending.catch(error => error);
  await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(3));
  expect(db.closeSync).not.toHaveBeenCalled();
  complete(late);
  expect(await outcome).toBe(failure);
  expect(early.closeSync).toHaveBeenCalledOnce();
  expect(late.closeSync).toHaveBeenCalledOnce();
  expect(db.closeSync).toHaveBeenCalledOnce();
});

for (const stage of ["extension", "credentials"] as const) it(`releases the pool after an S3 ${stage} setup failure`, async () => {
  const a = connection(), b = connection(), failure = new Error(`Synthetic ${stage} failure`);
  if (stage === "extension") a.run.mockRejectedValueOnce(failure);
  else vi.mocked(fromNodeProviderChain).mockReturnValue((async () => { throw failure; }) as any);
  const db = instance(vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b));
  await expect(pooledDuckdb("s3://synthetic-lake", { size: 2, awsProfile: "synthetic-test" })).rejects.toBe(failure);
  expect(a.closeSync).toHaveBeenCalledOnce(); expect(b.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

it("releases the single-connection database if connecting fails", async () => {
  const failure = new Error("Connection failed"), db = instance(async () => { throw failure; });
  await expect(duckdbConnector("/synthetic")).rejects.toBe(failure);
  expect(db.closeSync).toHaveBeenCalledOnce();
});

it("closes a single-connection adapter once and refuses later work", async () => {
  const c = connection(), db = instance(async () => c), adapter = await duckdbConnector("/synthetic");
  expect((await adapter.execute("SELECT 1")).rows).toEqual([[1]]);
  await Promise.all([adapter.close(), adapter.close()]);
  expect(c.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
  await expect(adapter.execute("SELECT 2")).rejects.toThrow("connection was replaced");
  expect(c.runAndReadAll).toHaveBeenCalledTimes(1);
});

it("drains a running single-connection query before closing and rejects queued work", async () => {
  const c = connection(), db = instance(async () => c);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  c.runAndReadAll.mockImplementationOnce(async () => { await held; return { getRows: () => [[1]], columnNames: () => ["value"] }; });
  const adapter = await duckdbConnector("/synthetic");
  const running = adapter.execute("SELECT 1");
  await vi.waitFor(() => expect(c.runAndReadAll).toHaveBeenCalledOnce());
  const queued = adapter.execute("SELECT 2").catch(error => error);
  const closing = adapter.close();
  expect(c.closeSync).not.toHaveBeenCalled(); expect(db.closeSync).not.toHaveBeenCalled();
  finish();
  expect((await running).rows).toEqual([[1]]);
  await closing;
  expect(await queued).toBeInstanceOf(Error);
  expect(c.runAndReadAll).toHaveBeenCalledTimes(1);
  expect(c.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

it("still disposes remaining connections when one synchronous close fails", async () => {
  const a = connection(), b = connection(), cleanupFailure = new Error("Synthetic close failure");
  a.closeSync.mockImplementationOnce(() => { throw cleanupFailure; });
  const db = instance(vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b));
  const adapter = await pooledDuckdb("/synthetic", { size: 2 });
  await expect(adapter.close()).rejects.toBe(cleanupFailure);
  expect(b.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

const syntheticCredential = { accessKeyId: "synthetic-test-id", secretAccessKey: "synthetic-test-secret", sessionToken: "synthetic-test-token" };
const refreshInterval = 20 * 60_000;
const reader = { getRows: () => [[1]], columnNames: () => ["value"] };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function s3Pool() {
  vi.useFakeTimers();
  const c = connection(), db = instance(async () => c);
  const credentials = vi.fn().mockResolvedValue(syntheticCredential);
  vi.mocked(fromNodeProviderChain).mockReturnValue(credentials);
  const adapter = await pooledDuckdb("s3://synthetic-lake", { size: 1, awsProfile: "synthetic-test", awsRegion: "us-east-2" });
  return { c, db, credentials, adapter };
}

it("queues S3 secret refresh behind a query instead of using the busy connection", async () => {
  const { c, adapter } = await s3Pool(), query = gate<void>();
  c.runAndReadAll.mockImplementationOnce(async () => { await query.promise; return reader; });
  const running = adapter.execute("SELECT 1");
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(c.runAndReadAll).toHaveBeenCalledOnce();
  expect(c.run).toHaveBeenCalledTimes(2); // extension setup and initial secret only
  query.resolve(); await running;
  await vi.advanceTimersByTimeAsync(0);
  expect(c.run).toHaveBeenCalledTimes(3);
  await adapter.close();
});

it("does not install credentials that resolve after the pool is closed", async () => {
  const { c, db, credentials, adapter } = await s3Pool(), next = gate<typeof syntheticCredential>();
  credentials.mockReturnValueOnce(next.promise);
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(credentials).toHaveBeenCalledTimes(2);
  await adapter.close();
  next.resolve(syntheticCredential);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(c.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

it("drains an active secret update before closing its connection", async () => {
  const { c, db, credentials, adapter } = await s3Pool(), update = gate<void>();
  c.run.mockImplementationOnce(async () => { await update.promise; });
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(c.run).toHaveBeenCalledTimes(3);
  const closing = adapter.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.closeSync).not.toHaveBeenCalled(); expect(db.closeSync).not.toHaveBeenCalled();
  update.resolve(); await closing;
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(credentials).toHaveBeenCalledTimes(2);
  expect(c.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

it("cancels a queued secret update when retiring a pool with an active query", async () => {
  const { c, db, adapter } = await s3Pool(), query = gate<void>();
  c.runAndReadAll.mockImplementationOnce(async () => { await query.promise; return reader; });
  const running = adapter.execute("SELECT 1");
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(adapter.stats()).toMatchObject({ free: 0, waiting: 1 });
  const closing = adapter.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(adapter.stats()).toMatchObject({ waiting: 0 });
  expect(db.closeSync).not.toHaveBeenCalled();
  query.resolve(); await running; await closing;
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(c.closeSync).toHaveBeenCalledOnce(); expect(db.closeSync).toHaveBeenCalledOnce();
});

it("does not lease a connection for a failed credential lookup and retries on the next interval", async () => {
  const { c, credentials, adapter } = await s3Pool();
  credentials.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(adapter.stats()).toMatchObject({ free: 1, waiting: 0 });
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(c.run).toHaveBeenCalledTimes(3);
  expect(credentials).toHaveBeenCalledTimes(3);
  await adapter.close();
});

it("coalesces slow refreshes and permits the next scheduled refresh after failure", async () => {
  const { c, credentials, adapter } = await s3Pool(), next = gate<typeof syntheticCredential>();
  credentials.mockReturnValueOnce(next.promise);
  await vi.advanceTimersByTimeAsync(refreshInterval * 3);
  expect(credentials).toHaveBeenCalledTimes(2);
  next.resolve(syntheticCredential); await vi.advanceTimersByTimeAsync(0);
  c.run.mockRejectedValueOnce(new Error("Synthetic credential install failure"));
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(adapter.stats()).toMatchObject({ free: 1, waiting: 0 });
  expect((await adapter.execute("SELECT 1")).rows).toEqual([[1]]);
  await vi.advanceTimersByTimeAsync(refreshInterval);
  expect(credentials).toHaveBeenCalledTimes(4);
  expect(c.run).toHaveBeenCalledTimes(5);
  await adapter.close();
});
