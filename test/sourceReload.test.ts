import { expect, it, vi } from "vitest";
import { sourceReloader } from "../src/sources/reload.ts";
import type { Source } from "../src/sources/registry.ts";

const source = (id: string) => ({ id, label: id, adapter: "test", status: "ready", conn: { close: vi.fn(async () => {}) } }) as unknown as Source;
it("keeps the current source live while preparation is pending, and closes only the rejected candidate on failure", async () => {
  const old = source("old"), candidate = source("new"); let current = [old];
  let reject!: (error: Error) => void;
  const preparing = new Promise<void>((_, fail) => { reject = fail; });
  const prepare = vi.fn(() => preparing), commit = vi.fn((loaded: { sources: Source[] }) => { const retired = current; current = loaded.sources; return retired; });
  const reload = sourceReloader(async () => ({ sources: [candidate] }), prepare, commit);
  const result = reload(); const failed = expect(result).rejects.toThrow("Library failed");
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(current).toEqual([old]); expect(old.conn!.close).not.toHaveBeenCalled();
  reject(new Error("Library failed")); await failed;
  expect(commit).not.toHaveBeenCalled(); expect(candidate.conn!.close).toHaveBeenCalledOnce();
  expect(current).toEqual([old]); expect(old.conn!.close).not.toHaveBeenCalled();
});
it("serializes overlapping replacements and retires each superseded pool once", async () => {
  const old = source("old"), first = source("first"), second = source("second"); let current = [old];
  let release!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  const load = vi.fn().mockResolvedValueOnce({ sources: [first] }).mockResolvedValueOnce({ sources: [second] });
  const prepare = vi.fn(async (sources: Source[]) => { if (sources[0] === first) await pause; });
  const reload = sourceReloader(load, prepare, loaded => { const retired = current; current = loaded.sources; return retired; });
  const a = reload(), b = reload();
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledOnce(); expect(current).toEqual([old]);
  release(); await Promise.all([a, b]);
  await vi.waitFor(() => expect(first.conn!.close).toHaveBeenCalledOnce());
  expect(old.conn!.close).toHaveBeenCalledOnce(); expect(second.conn!.close).not.toHaveBeenCalled();
  expect(current).toEqual([second]);
});
it("recovers after a load failure, and retirement errors do not undo a successful replacement", async () => {
  const old = source("old"), candidate = source("new"); let current = [old];
  vi.mocked(old.conn!.close).mockImplementation(() => { throw new Error("Close failed"); });
  const load = vi.fn().mockRejectedValueOnce(new Error("Load failed")).mockResolvedValueOnce({ sources: [candidate] });
  const reload = sourceReloader(load, async () => {}, loaded => { const retired = current; current = loaded.sources; return retired; });
  await expect(reload()).rejects.toThrow("Load failed"); expect(current).toEqual([old]);
  await expect(reload()).resolves.toEqual({ sources: [candidate] });
  expect(current).toEqual([candidate]); expect(candidate.conn!.close).not.toHaveBeenCalled();
});
