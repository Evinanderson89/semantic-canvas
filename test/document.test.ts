import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { expect, it, vi, afterEach } from "vitest";
import { fingerprint, withGrain } from "../src/app/document.ts";
import { readResponse } from "../src/app/http.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { api, runToolInContext, TOOLS } from "../src/agent/tools.ts";
import { tile } from "./fixtures.ts";
afterEach(() => vi.unstubAllGlobals());
it("treats canvas edits as authored work while excluding cross-filter exploration", () => {
  const spec = { title: "Test", tiles: [tile()] };
  expect(fingerprint(spec, DEFAULT_CANVAS)).not.toBe(fingerprint(spec, { ...DEFAULT_CANVAS, width: 1000 }));
  expect(fingerprint(spec, DEFAULT_CANVAS)).toBe(fingerprint({ ...spec, crossFilters: [] }, DEFAULT_CANVAS));
});
it("changes time grain without regenerating notes, IDs, layout or chart choices", () => {
  const spec = { title: "Edited", tiles: [tile({ chart: "line", dimensions: ["month:sold_on"] }), tile({ id: "note", kind: "text", metrics: [], text: "Keep me" })] };
  const next = withGrain(spec, "quarter");
  expect(next.tiles[0].dimensions).toEqual(["quarter:sold_on"]);
  expect(next.tiles[0].layout).toEqual(spec.tiles[0].layout);
  expect(next.tiles[1]).toEqual(spec.tiles[1]);
});
it("rejects error responses so the caller cannot mark a failed write as saved", async () => {
  await expect(readResponse(new Response(JSON.stringify({ error: "Disk full" }), { status: 500 }))).rejects.toThrow("Disk full");
});
it("binds concurrent embedded-agent tools to the server's context despite forged tool arguments", async () => {
  const calls: Headers[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => { calls.push(new Headers(options.headers)); return new Response("{}"); }));
  await Promise.all([runToolInContext({ source: "one", principal: "emea" }, () => api("/api/query", { source: "other", principal: "admin" })),
    runToolInContext({ source: "two", principal: "amer" }, () => api("/api/query", { principal: "admin" }))]);
  expect(calls.map((h) => [h.get("x-sc-source"), h.get("x-sc-principal")])).toEqual([["one","emea"],["two","amer"]]);
});

it("all agent tool contracts can be serialized for the SDK", () => {
  for (const tool of TOOLS) expect(() => betaZodTool({ name: tool.name, description: tool.description, inputSchema: z.object(tool.inputSchema), run: async () => "ok" })).not.toThrow();
});
