import { expect, it, vi } from "vitest";
import { profileCardinality, profileEvidence, PROFILE_QUERY_TIMEOUT_MS } from "../src/suggest/profileEvidence.ts";
import { profileFieldsSchema, profileRequestSchema } from "../src/compiler/schema.ts";

const result = (rows: unknown[][]) => ({ rows, columns: ["value"], sql: "", ms: 0 });

it("distinguishes exact counts, missing evidence, and values unsafe to represent", () => {
  for (const value of [undefined, null, "", " ", false, [], {}, "oops", "1.5", -1, 1.5, Infinity, NaN, "9007199254740993"]) {
    expect(profileCardinality(value), String(value)).toBeNull();
  }
  for (const value of [0, "0", " 0 ", 2, "2", Number.MAX_SAFE_INTEGER]) expect(profileCardinality(value)).toBe(Number(value));
});

it("retains independent sample evidence when counts fail or have no valid aggregate row", async () => {
  for (const count of [null, result([]), result([[null]]), result([["bad"]]), result([[0], [1]])]) {
    const execute = vi.fn().mockImplementationOnce(() => count ? Promise.resolve(count) : Promise.reject(new Error("Count failed")))
      .mockResolvedValueOnce(result([["US"], ["DE"], [null]]));
    expect(await profileEvidence({ execute }, "scoped")).toEqual({ cardinality: null, sample: ["US", "DE"], warning: expect.stringContaining("could not be verified") });
  }
});

it("retains real zero and successful counts when a sample is empty or unavailable", async () => {
  const empty = vi.fn().mockResolvedValueOnce(result([[0]])).mockResolvedValueOnce(result([]));
  expect(await profileEvidence({ execute: empty }, "scoped")).toEqual({ cardinality: 0, sample: [] });
  const failed = vi.fn().mockResolvedValueOnce(result([[12]])).mockRejectedValueOnce(new Error("Sample failed"));
  expect(await profileEvidence({ execute: failed }, "scoped")).toEqual({ cardinality: 12, sample: [], warning: expect.stringContaining("could not be verified") });
  const changed = vi.fn().mockResolvedValueOnce(result([[0]])).mockResolvedValueOnce(result([["new value"]]));
  expect(await profileEvidence({ execute: changed }, "scoped")).toEqual({ cardinality: null, sample: ["new value"], warning: expect.stringContaining("could not be verified") });
});

it("does not start unused warehouse queries after a client disconnects", async () => {
  const controller = new AbortController();
  const execute = vi.fn().mockImplementationOnce(async () => { controller.abort(); return result([[2]]); });
  await profileEvidence({ execute }, "scoped", controller.signal);
  expect(execute).toHaveBeenCalledTimes(1);
  await profileEvidence({ execute }, "other scoped field", controller.signal);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("passes execution deadlines, preserves successful sample evidence, and labels timed-out counts as unknown", async () => {
  const controller = new AbortController();
  const execute = vi.fn().mockRejectedValueOnce(new DOMException("Budget exceeded", "TimeoutError"))
    .mockResolvedValueOnce(result([["US"], ["DE"]]));
  expect(await profileEvidence({ execute }, "scoped", controller.signal))
    .toMatchObject({ cardinality: null, sample: ["US", "DE"], warning: expect.stringContaining("time limit") });
  for (const call of execute.mock.calls) expect(call[3]).toEqual({ signal: controller.signal, timeoutMs: PROFILE_QUERY_TIMEOUT_MS });
  controller.abort(new DOMException("Batch deadline", "TimeoutError"));
  expect(await profileEvidence({ execute }, "another field", controller.signal))
    .toMatchObject({ cardinality: null, sample: [], warning: expect.stringContaining("time limit") });
  expect(execute).toHaveBeenCalledTimes(2);
});

it("shares a 12-field budget between HTTP and agent requests", () => {
  const fields = Array.from({ length: 12 }, (_, i) => `field_${i}`);
  expect(profileFieldsSchema.parse(fields)).toEqual(fields);
  expect(profileRequestSchema.parse({ fields: fields.join(",") }).fields).toEqual(fields);
  expect(() => profileFieldsSchema.parse([...fields, "extra"])).toThrow();
  expect(() => profileRequestSchema.parse({ fields: [...fields, "extra"].join(",") })).toThrow();
  expect(() => profileRequestSchema.parse({ fields: "x".repeat(257) })).toThrow();
});
