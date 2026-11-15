import { beforeEach, expect, it, vi } from "vitest";
const { toolRunner } = vi.hoisted(() => ({ toolRunner: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { beta = { messages: { toolRunner } }; } }));
import { explainTile, suggestImprovements } from "../src/agent/loop.ts";
const cfg = { provider: "anthropic", model: "synthetic", apiKey: "synthetic" };
const tile = { title: "Revenue", metrics: ["revenue"], dimensions: [], columns: ["revenue"], rows: [[10]] };
const response = { content: [{ type: "text", text: "Measured revenue is 10." }] };
beforeEach(() => { toolRunner.mockReset(); });
for (const [name, run] of [["Explain", explainTile], ["Suggestions", suggestImprovements]] as const) {
  it(`${name} carries input coverage evidence before asking for an interpretation`, async () => {
    toolRunner.mockResolvedValue(response);
    await run(cfg, {}, { ...tile, scopeNotes: ["Ratio inputs cover different dates: numerator ends 2026-08-31; denominator ends 2026-08-15."] });
    expect(toolRunner.mock.calls[0][0].messages[0].content).toContain("denominator ends 2026-08-15");
    expect(toolRunner.mock.calls[0][0].messages[0].content).toContain("do not infer full-period comparability");
  });
  it(`${name} passes cancellation to the provider and preserves a completed answer`, async () => {
    const controller = new AbortController(); toolRunner.mockResolvedValue(response);
    expect(await run(cfg, { signal: controller.signal }, tile)).toBe("Measured revenue is 10.");
    expect(toolRunner.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
  it(`${name} does not start an already-cancelled request`, async () => {
    const controller = new AbortController(); controller.abort(); toolRunner.mockResolvedValue(response);
    await expect(run(cfg, { signal: controller.signal }, tile)).rejects.toThrow(/abort/i);
    expect(toolRunner).not.toHaveBeenCalled();
  });
  it(`${name} rejects a late answer after cancellation`, async () => {
    const controller = new AbortController(); toolRunner.mockImplementation(async () => { controller.abort(); return response; });
    await expect(run(cfg, { signal: controller.signal }, tile)).rejects.toThrow(/abort/i);
  });
}

it("does not start another read-only tool after cancellation", async () => {
  const controller = new AbortController();
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ metrics: {} })));
  toolRunner.mockImplementation(async params => { controller.abort(); await params.tools.find((t: any) => t.name === "describe_model").run({}); return response; });
  try {
    await expect(explainTile(cfg, { signal: controller.signal }, tile)).rejects.toThrow(/abort/i);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
