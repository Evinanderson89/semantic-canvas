import { expect, it, vi } from "vitest";
import { assessResponse, digest, redesignCases, type RedesignCase } from "../evaluation/redesign.ts";
import { conn, model, tile } from "./fixtures.ts";
import { narrativeInventory } from "../evaluation/narrative.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

const testCase: RedesignCase = {
  ...redesignCases[0], spec: { title: "Revenue", tiles: [tile({ chart: "stat" })] },
};
const response = { proposal: { title: "Explain revenue", reason: "Make room for context", actions: [
  { type: "place", id: "t1", layout: { x: 24, y: 24, w: 420, h: 180 } },
  { type: "add", tile: { id: "claim", kind: "text", metrics: [], dimensions: [],
    text: "Revenue fell because customers disliked the product.", layout: { x: 24, y: 228, w: 600, h: 100 } } },
] } };

it("never certifies an unsupported narrative just because a proposal and its query succeed", async () => {
  const before = digest({ testCase, model, response });
  const execute = vi.fn(async () => ({ columns: ["revenue"], rows: [[100]], sql: "sample", ms: 1 }));
  const result = await assessResponse(testCase, response, model, { ...conn, execute });
  expect(result).toMatchObject({ mechanicalStatus: "passed", qualityVerdict: "not-assessed",
    rendering: "requires-browser-review", review: { status: "required", decisions: [] } });
  expect("authoredText" in result && result.authoredText).toEqual([
    expect.objectContaining({ text: "Revenue fell because customers disliked the product." }),
  ]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect("beforeEvidence" in result && result.beforeEvidence).toEqual([
    expect.objectContaining({ id: "t1", query: expect.objectContaining({ metrics: ["revenue"] }) }),
  ]);
  expect(digest({ testCase, model, response })).toBe(before);
});

it("rejects invented metrics before executing any warehouse query", async () => {
  const execute = vi.fn(conn.execute);
  const result = await assessResponse(testCase, { proposal: { ...response.proposal,
    actions: [{ type: "query", id: "t1", metrics: ["invented"] }] } }, model, { ...conn, execute });
  expect(result).toMatchObject({ mechanicalStatus: "failed", qualityVerdict: "not-assessed" });
  expect(execute).not.toHaveBeenCalled();
});

it("retains query failure evidence rather than reporting mechanical success", async () => {
  const result = await assessResponse(testCase, response, model, { ...conn,
    execute: async () => { throw new Error("Synthetic warehouse failure"); } });
  expect(result).toMatchObject({ mechanicalStatus: "failed", qualityVerdict: "not-assessed",
    failures: [expect.objectContaining({ id: "t1", error: "Synthetic warehouse failure" })] });
  expect("narrativeInventory" in result && result.narrativeInventory).toEqual(expect.arrayContaining([
    expect.objectContaining({ after: "Revenue fell because customers disliked the product.", reviewStatus: "required" }),
  ]));
});

it("surfaces false period wording and a stale description even when chart queries succeed", async () => {
  const result = await assessResponse({ ...testCase, spec: { ...testCase.spec, description: "Revenue and customer counts" } }, {
    text: "All figures are verified.",
    proposal: { title: "Monthly results", reason: "Explain performance", actions: [
      { type: "place", id: "t1", layout: { x: 24, y: 24, w: 420, h: 180 } },
      { type: "title", id: "t1", title: "Revenue for month ending August 1, 2026" },
    ] },
  }, model, { ...conn, execute: async () => ({ columns: ["revenue"], rows: [[100]], sql: "sample", ms: 1 }) });
  expect(result).toMatchObject({ mechanicalStatus: "passed", qualityVerdict: "not-assessed" });
  expect("narrativeInventory" in result && result.narrativeInventory).toEqual(expect.arrayContaining([
    expect.objectContaining({ location: "dashboard / description", change: "retained", after: "Revenue and customer counts", reviewStatus: "required" }),
    expect.objectContaining({ location: "tile / t1 / title", after: "Revenue for month ending August 1, 2026", candidateEvidenceIds: ["t1"], reviewStatus: "required" }),
    expect.objectContaining({ location: "assistant / explanation", after: "All figures are verified.", reviewStatus: "required" }),
    expect.objectContaining({ location: "assistant / reason", after: "Explain performance" }),
  ]));
});

it("keeps removed copy and tab-specific brief evidence available without treating inherited text as AI-authored", () => {
  const before: DashboardSpec = { title: "Two questions", description: "Original scope", tabs: [
    { id: "main", title: "Revenue", brief: { question: "How much?", takeaway: "Revenue doubled", nextStep: "Investigate", evidenceIds: ["t1"] } },
    { id: "people", title: "Customers" },
  ], tiles: [tile({ title: "Revenue", tabId: "main" }), tile({ id: "people", title: "Customers", metrics: ["users"], tabId: "people" }),
    tile({ id: "note", kind: "text", metrics: [], text: "Revenue doubled", tabId: "main" })] };
  const after = structuredClone(before);
  after.description = "";
  after.tiles = after.tiles.filter(t => t.id !== "people");
  after.tiles[0].metrics = ["live_revenue"];
  const beforeHash = digest({ before, after });
  const inventory = narrativeInventory(before, after, { title: "Focus revenue", reason: "Remove customer analysis", actions: [{ type: "remove", id: "people" }] });
  expect(inventory).toEqual(expect.arrayContaining([
    expect.objectContaining({ location: "dashboard / description", change: "removed", before: "Original scope", after: null }),
    expect.objectContaining({ location: "tile / people / title", change: "removed", beforeCandidateEvidenceIds: ["people"], candidateEvidenceIds: [] }),
    expect.objectContaining({ location: "tab / main / brief / takeaway", source: "document", change: "retained", candidateEvidenceIds: ["t1"], reviewStatus: "required" }),
    expect.objectContaining({ location: "tile / note / text", candidateEvidenceIds: ["t1"] }),
  ]));
  expect(inventory.every(entry => entry.reviewStatus === "required")).toBe(true);
  expect(digest({ before, after })).toBe(beforeHash);
});
