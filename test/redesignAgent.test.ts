import { beforeEach, expect, it, vi } from "vitest";
const { toolRunner } = vi.hoisted(() => ({ toolRunner: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { beta = { messages: { toolRunner } }; } }));
import { chat } from "../src/agent/loop.ts";
import { model, tile } from "./fixtures.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { REDESIGN_INSTRUCTIONS, REDESIGN_FINALIZE_INSTRUCTIONS } from "../src/suggest/redesign.ts";
import { TOOLS } from "../src/agent/tools.ts";

beforeEach(() => toolRunner.mockReset());
const active = { spec: { title: "Revenue", tiles: [tile({ id: "revenue", chart: "bar", dimensions: ["dim_users.country"] })] }, canvas: DEFAULT_CANVAS, selected: [], model };
const proposal = { title: "Revenue through time", reason: "Follow the trend.", actions: [{ type: "query", id: "revenue", dimensions: ["month:sold_on"] }, { type: "chart", id: "revenue", chart: "line" }] };
const run = (signal?: AbortSignal) => chat({ provider: "anthropic", model: "test", apiKey: "test" }, [], "Improve this dashboard", { signal }, active, undefined, "redesign");
const response = { stop_reason: "tool_use", content: [] };
const runner = (params: any, completion: Promise<unknown> = Promise.resolve(response)) => Object.assign(completion, { params });

it("reserves a proposal step when research uses its budget and stops after a valid proposal", async () => {
  toolRunner.mockImplementationOnce(params => runner(params));
  toolRunner.mockImplementationOnce(params => runner(params, params.tools[0].run(proposal).then(() => response)));
  expect((await run()).proposal).toEqual(proposal);
  expect(toolRunner).toHaveBeenCalledTimes(2);
  expect(toolRunner.mock.calls[0][0].max_iterations).toBe(3);
  // API clients must receive the same grounding rules as the UI, including recovery.
  expect(toolRunner.mock.calls[0][0].system).toContain(REDESIGN_INSTRUCTIONS);
  expect(toolRunner.mock.calls[1][0].system).toContain(REDESIGN_FINALIZE_INSTRUCTIONS);
  expect(toolRunner.mock.calls[1][0].tools.map((t: any) => t.name)).toEqual(["propose_canvas_changes"]);
  expect(toolRunner.mock.calls[1][0].tool_choice).toEqual({ type: "tool", name: "propose_canvas_changes" });
});

it("names only available tools in each phase and keeps active edits in proposals", async () => {
  toolRunner.mockImplementationOnce(params => runner(params));
  toolRunner.mockImplementationOnce(params => runner(params, params.tools[0].run(proposal).then(() => response)));
  await run();
  for (const [params] of toolRunner.mock.calls) {
    const available = new Set(params.tools.map((tool: any) => tool.name));
    for (const tool of TOOLS) if (!available.has(tool.name)) expect(params.system).not.toContain(tool.name);
    expect(params.system).toContain("ask a concise question in your text response");
    expect(params.system).toContain("does not apply or save");
  }
  toolRunner.mockReset().mockImplementation(params => runner(params, Promise.resolve({ stop_reason: "end_turn", content: [] })));
  await chat({ provider: "anthropic", model: "test", apiKey: "test" }, [], "Help me", {}, undefined);
  expect(toolRunner.mock.calls[0][0].system).toContain("call ask_user");
  expect(toolRunner.mock.calls[0][0].tools.map((tool: any) => tool.name)).toContain("arrange_dashboard");
});

it("bounds failed finalization rather than reporting that no improvement exists", async () => {
  toolRunner.mockImplementation(params => runner(params));
  await expect(run()).rejects.toThrow(/could not produce a valid redesign/);
  expect(toolRunner).toHaveBeenCalledTimes(3);
});

it("does not start proposal recovery after cancellation or a provider refusal", async () => {
  const controller = new AbortController();
  toolRunner.mockImplementationOnce(params => { controller.abort(); return runner(params); });
  await expect(run(controller.signal)).rejects.toThrow(/abort/i);
  expect(toolRunner).toHaveBeenCalledTimes(1);
  toolRunner.mockReset().mockImplementationOnce(params => runner(params, Promise.resolve({ stop_reason: "refusal", content: [{ type: "text", text: "Unable to assist." }] })));
  expect((await run()).proposal).toBeUndefined();
  expect(toolRunner).toHaveBeenCalledTimes(1);
});
