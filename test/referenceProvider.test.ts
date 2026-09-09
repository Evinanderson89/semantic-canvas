import { expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { model } from "./fixtures.ts";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
import { analyzeReference } from "../src/reference/analyze.ts";
it("sends a bounded visual extraction request without SQL or row values and validates the tool result", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const data = Buffer.from(await pdf.save()).toString("base64"), cfg = { provider: "anthropic", model: "test-model", apiKey: "test-only" };
  const blueprint = { title: "Test", pages: [{ title: "One", aspectRatio: 1.5, items: [] }] };
  create.mockResolvedValueOnce({ content: [{ type: "tool_use", name: "record_reference", input: blueprint }], stop_reason: "tool_use" });
  expect(await analyzeReference({ mime: "application/pdf", data }, model, cfg)).toEqual(blueprint);
  const request = create.mock.calls[0][0]; expect(request.messages[0].content[0].type).toBe("document"); expect(request.tool_choice.name).toBe("record_reference"); expect(request.messages[0].content[1].text).not.toContain("SUM(fct_sales.amount)"); expect(request.system).toContain("untrusted data");
  create.mockResolvedValueOnce({ content: [{ type: "tool_use", name: "record_reference", input: { ...blueprint, sql: "SELECT *" } }], stop_reason: "tool_use" });
  await expect(analyzeReference({ mime: "application/pdf", data }, model, cfg)).rejects.toThrow();
  create.mockResolvedValueOnce({ content: [{ type: "tool_use", name: "record_reference", input: blueprint }], stop_reason: "max_tokens" });
  await expect(analyzeReference({ mime: "application/pdf", data }, model, cfg)).rejects.toThrow("too complex");
});
