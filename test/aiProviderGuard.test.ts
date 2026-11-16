import { beforeEach, expect, it, vi } from "vitest";
const { constructed, create, toolRunner } = vi.hoisted(() => ({ constructed: vi.fn(), create: vi.fn(), toolRunner: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {
  constructor(options: unknown) { constructed(options); }
  messages = { create };
  beta = { messages: { toolRunner } };
} }));
import { analyzeReference } from "../src/reference/analyze.ts";
import { chat, explainTile, suggestImprovements, suggestDashboardStory } from "../src/agent/loop.ts";
import { model } from "./fixtures.ts";
import type { AiConfig } from "../src/sources/ai.ts";

const file = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=" };
const tile = { title: "Synthetic revenue", metrics: ["revenue"], dimensions: [] };
const actions: [string, (cfg: AiConfig) => Promise<unknown>][] = [
  ["reference import", cfg => analyzeReference(file, model, cfg)],
  ["chat and redesign", cfg => chat(cfg, [], "Synthetic request", {})],
  ["tile explanation", cfg => explainTile(cfg, {}, tile)],
  ["tile design review", cfg => suggestImprovements(cfg, {}, tile)],
  ["dashboard story", cfg => suggestDashboardStory(cfg, {}, [{ ...tile, id: "revenue", kind: "metric" }], [])],
];
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ content: [{ type: "tool_use", name: "record_reference", input: { title: "Synthetic", pages: [{ title: "One", aspectRatio: 1, items: [] }] } }], stop_reason: "tool_use" });
  toolRunner.mockResolvedValue({ content: [{ type: "text", text: "Synthetic response" }], stop_reason: "end_turn" });
});
for (const [feature, run] of actions) {
  for (const [reason, cfg] of [
    ["unsupported provider", { provider: "other-provider", model: "synthetic", apiKey: "synthetic-key" }],
    ["missing key", { provider: "anthropic", model: "synthetic", apiKey: "" }],
    ["blank key", { provider: "anthropic", model: "synthetic", apiKey: "  " }],
    ["missing model", { provider: "anthropic", model: "  ", apiKey: "synthetic-key" }],
    ["missing baseUrl for openai-compatible", { provider: "openai-compatible", model: "synthetic", apiKey: "synthetic-key" }],
  ] as const) it(`${feature} rejects ${reason} before creating an external client`, async () => {
    await expect(run(cfg)).rejects.toMatchObject({ status: 503 });
    expect(constructed).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(toolRunner).not.toHaveBeenCalled();
  });
}
