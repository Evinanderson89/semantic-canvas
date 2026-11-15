import { afterEach, expect, it, vi } from "vitest";
import { chat } from "../src/agent/loop.ts";
import { model, tile } from "./fixtures.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

const active = { spec: { title: "Synthetic revenue", tiles: [tile({ id: "revenue", chart: "bar", dimensions: ["dim_users.country"] })] }, canvas: DEFAULT_CANVAS, selected: [], model };
const valid = { title: "Revenue over time", reason: "Compare reporting months.", actions: [
  { type: "query", id: "revenue", dimensions: ["month:sold_on"] }, { type: "chart", id: "revenue", chart: "line" },
] };
const invalid = { ...valid, actions: [{ type: "query", id: "revenue", metrics: ["missing_revenue_metric"] }] };

/** The real installed SDK parses inputs, executes tools, and supplies validation
 * feedback. Only HTTP is replaced; no provider traffic or credentials are used. */
function provider(responses: unknown[]) {
  const requests: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("api.anthropic.com");
    const body = await request.json(); requests.push(body);
    const proposal = responses[requests.length - 1];
    if (!proposal) throw new Error("Unexpected extra provider request");
    if (typeof proposal === "object" && "httpError" in proposal) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: proposal.httpError } }), { status: "status" in proposal ? Number(proposal.status) : 400, headers: { "content-type": "application/json" } });
    const ended = typeof proposal === "object" && "endText" in proposal;
    return new Response(JSON.stringify({ id: `synthetic-${requests.length}`, type: "message", role: "assistant", model: "synthetic-model",
      content: ended ? [{ type: "text", text: proposal.endText }] : [{ type: "tool_use", id: `proposal-${requests.length}`, name: "propose_canvas_changes", input: proposal }],
      stop_reason: ended ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return requests;
}
const run = () => chat({ provider: "anthropic", model: "synthetic-model", apiKey: "synthetic-test-key" }, [], "Improve this synthetic dashboard", {}, active, undefined, "redesign");
afterEach(() => vi.restoreAllMocks());

it("names the invalid blank-canvas KPI and teaches a bounded correction without silently selecting a period", async () => {
  const empty = { ...active, spec: { title: "Empty", tiles: [] } };
  const newCard = { kind: "metric", id: "new-revenue-card", title: "Revenue", metrics: ["revenue"], dimensions: [],
    chart: "kpi", compare: "prior", where: [], limit: 500, section: null,
    layout: { x: 24, y: 24, w: 400, h: 200 }, format: { number: "currency", palette: "default" } };
  const rejected = { title: "Revenue summary", reason: "Show revenue by reporting month.", actions: [{ type: "add", tile: newCard }] };
  const corrected = { ...rejected, actions: [{ type: "add", tile: { ...newCard, dimensions: ["month:sold_on"] } }] };
  const requests = provider([rejected, { endText: "Ready." }, corrected]);
  const result = await chat({ provider: "anthropic", model: "synthetic-model", apiKey: "synthetic-test-key" }, [], "Build an executive dashboard", {}, empty, undefined, "redesign");
  const feedback = JSON.stringify(requests[2].messages);
  expect(feedback).toContain("Tile new-revenue-card: period comparison requires a time dimension");
  expect(feedback).toContain("grain:date_field");
  expect(result.proposal).toEqual(corrected);
  expect(empty.spec.tiles).toEqual([]);
  expect(requests).toHaveLength(3);
});

it("accepts a description update together with a real redesign without mutating the active document", async () => {
  const proposal = { ...valid, actions: [...valid.actions, { type: "describe", description: "Revenue by reporting month." }] };
  const original = structuredClone(active.spec);
  const requests = provider([proposal, { endText: "Ready for review." }]);
  expect((await run()).proposal).toEqual(proposal);
  expect(requests).toHaveLength(2);
  expect(active.spec).toEqual(original);
});

it("reserves correction after a rejected edit even if the provider claims it finished", async () => {
  const requests = provider([invalid, { endText: "Your redesign is ready." }, valid]);
  const before = structuredClone(active), result = await run();
  expect(result.proposal).toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[2].tools.map((t: any) => t.name)).toEqual(["propose_canvas_changes"]);
  expect(active).toEqual(before);
});

it("does not present a rejected redesign as ready when correction ends without a proposal", async () => {
  const requests = provider([invalid, { endText: "Your redesign is ready." }, { endText: "Ready for review." }]);
  await expect(run()).rejects.toThrow(/rejected.*missing_revenue_metric.*unchanged/);
  expect(requests).toHaveLength(3);
});

it("the actual SDK can repair a rejected final proposal without changing the original document", async () => {
  const requests = provider([invalid, invalid, invalid, invalid, valid]), before = structuredClone(active);
  const result = await run();
  expect(result.proposal).toEqual(valid);
  expect(active).toEqual(before);
  expect(requests).toHaveLength(5);
  expect(requests[3].tools.map((t: any) => t.name)).toEqual(["propose_canvas_changes"]);
  expect(requests[4].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).some((b: any) => b.type === "tool_result" && b.is_error && b.content.includes("missing_revenue_metric"))).toBe(true);
});

it("recovers once from provider grammar limits while preserving local validation and correction feedback", async () => {
  const requests = provider([{ httpError: "The compiled grammar is too large, which would cause performance issues." }, invalid, invalid, invalid, valid]);
  const before = structuredClone(active), result = await run();
  expect(result.proposal).toEqual(valid);
  expect(result.providerSchemaFallback).toBe(true);
  expect(active).toEqual(before);
  expect(requests).toHaveLength(5);
  expect(requests[0].tools.some((t: any) => t.strict)).toBe(true);
  expect(requests.slice(1).every(r => r.tools.every((t: any) => !t.strict))).toBe(true);
  const proposalSchema = (r: any) => r.tools.find((t: any) => t.name === "propose_canvas_changes").input_schema;
  expect(proposalSchema(requests[1])).toEqual(proposalSchema(requests[0]));
  expect(JSON.stringify(requests[4].messages)).toContain("missing_revenue_metric");
});

for (const error of [
  { httpError: "Authentication failed", status: 401 },
  { httpError: "Invalid request field", status: 400 },
]) it(`does not use schema recovery for ${error.status} ${error.httpError}`, async () => {
  const requests = provider([error]);
  await expect(run()).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

it("does not loop when the compatibility request is also rejected", async () => {
  const error = { httpError: "The compiled grammar is too large" };
  const requests = provider([error, error]);
  await expect(run()).rejects.toThrow();
  expect(requests).toHaveLength(2);
});

it("sends a bounded strict proposal schema in research and finalization, preserving action and chart enums", async () => {
  const requests = provider([invalid, invalid, invalid, valid]);
  await run();
  for (const request of requests) {
    const tool = request.tools.find((t: any) => t.name === "propose_canvas_changes");
    expect(tool.strict).toBe(true);
    expect(request.tools.filter((t: any) => t.strict)).toHaveLength(1);
    const schemas: any[] = [];
    function walk(schema: any) {
      schemas.push(schema);
      for (const group of [schema.properties, schema.$defs]) Object.values(group ?? {}).forEach(walk);
      schema.anyOf?.forEach(walk);
      if (schema.items) walk(schema.items);
    }
    walk(tool.input_schema);
    const optional = schemas.reduce((n, s) => n + Object.keys(s.properties ?? {}).filter(k => !s.required?.includes(k)).length, 0);
    // The provider rejected the previous 23-option shape even below its
    // documented cap. Keep the redesigned grammar substantially smaller.
    expect(optional).toBeLessThanOrEqual(6);
    expect(schemas.filter(s => s.anyOf || Array.isArray(s.type)).length).toBeLessThanOrEqual(16);
    for (const schema of schemas) {
      expect(schema).not.toHaveProperty("$ref"); // Provider rejects Zod's ref + type siblings.
      if (schema.type === "object") expect(schema.additionalProperties).toBe(false);
      for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "oneOf"])
        expect(schema).not.toHaveProperty(key);
      if (schema.minItems !== undefined) expect([0, 1]).toContain(schema.minItems);
    }
    expect(schemas.flatMap(s => s.const ? [s.const] : [])).toEqual(expect.arrayContaining(["query", "note", "add", "place", "chart", "describe"]));
    expect(schemas.some(s => s.enum?.includes("waterfall") && s.enum.includes("heatmap"))).toBe(true);
    const query = schemas.find(s => s.properties?.type?.const === "query");
    expect(query.properties).not.toHaveProperty("limit");
    expect(schemas.some(s => s.description?.includes("maxItems: 30"))).toBe(true);
  }
});

it("still rejects unsupported fields and excessive action counts locally even if a strict provider misbehaves", async () => {
  const unsupported = { ...valid, actions: [{ ...valid.actions[0], limit: 2000 }, valid.actions[1]] };
  const tooMany = { ...valid, actions: Array(31).fill(valid.actions[0]) };
  const oversized = { ...valid, actions: [...valid.actions, { type: "add", tile: {
    id: "oversized", kind: "metric", title: "Revenue", metrics: ["revenue"], dimensions: [], limit: 5001,
    section: null, chart: "kpi", compare: "none", where: [], format: { number: "auto", palette: "default" },
    layout: { x: 0, y: 0, w: 400, h: 200 },
  } }] };
  const requests = provider([unsupported, tooMany, oversized, valid]), before = structuredClone(active);
  expect((await run()).proposal).toEqual(valid);
  expect(active).toEqual(before);
  const errors = requests[3].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
    .filter((b: any) => b.type === "tool_result" && b.is_error).map((b: any) => b.content).join("\n");
  expect(errors).toContain('Unrecognized key: \\"limit\\"');
  expect(errors).toContain("30");
  expect(errors).toContain("5000");
});

it("exhausted redesigns name the local validation problem instead of blaming the user's goal", async () => {
  const requests = provider(Array(5).fill(invalid)), before = structuredClone(active);
  await expect(run()).rejects.toThrow(/Canvas rejected the proposed edits:.*missing_revenue_metric/);
  expect(requests).toHaveLength(5);
  expect(active).toEqual(before);
});

it("SDK input-schema rejections remain bounded and omit the provider's input payload", async () => {
  const malformed = { ...valid, reason: "private-provider-input-marker", actions: [{ type: "unsupported-action", payload: "private-provider-input-marker" }] };
  const requests = provider(Array(5).fill(malformed));
  const error = await run().catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("actions.0.type");
  expect(error.message).toContain("Your dashboard is unchanged");
  expect(error.message).not.toContain("private-provider-input-marker");
  expect(requests).toHaveLength(5);
});

it("explains chart-versus-note targets and repairs the live failure pattern with a separate text tile", async () => {
  const mistaken = { ...valid, actions: [...valid.actions, { type: "note", id: "revenue", text: "Read the trend alongside retention." }] };
  const corrected = { ...valid, actions: [...valid.actions,
    { type: "add", tile: { id: "reading-guide", kind: "text", text: "Read revenue over time.", metrics: [], dimensions: [], section: null, format: { textSize: 16, textAlign: "left" }, layout: { x: 24, y: 400, w: 600, h: 100 } } },
  ] };
  const requests = provider([mistaken, mistaken, mistaken, corrected]), before = structuredClone(active);
  const result = await run();
  expect(result.proposal).toEqual(corrected);
  expect(active).toEqual(before);
  expect(requests).toHaveLength(4);
  const finalizer = requests[3];
  expect(finalizer.system).toContain("never target a metric chart with note");
  expect(JSON.stringify(finalizer.tools[0].input_schema)).toContain("Never a metric/chart tile ID");
  const errors = finalizer.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "tool_result" && b.is_error);
  expect(errors.map((b: any) => b.content).join("\n")).toContain("Tile revenue has kind metric");
  expect(errors.map((b: any) => b.content).join("\n")).toContain("add a separate tile");
});

it("retains governed chart creation, filters and presentation in the compact grammar", async () => {
  const proposal = { ...valid, actions: [...valid.actions, { type: "add", tile: {
    id: "users", kind: "metric", title: "US users", metrics: ["users"], dimensions: [],
    section: null, chart: "kpi", compare: "none", limit: 5000,
    where: [{ id: "country", field: "country", source: "dimension", mode: "discrete", values: ["US"], exclude: false }],
    layout: { x: 24, y: 400, w: 400, h: 200 }, format: { number: "plain", palette: "default" },
  } }] };
  provider([proposal, proposal, proposal]);
  const before = structuredClone(active);
  expect((await run()).proposal).toEqual(proposal);
  expect(active).toEqual(before);
});

it("returns computed substitutions to the actual SDK before the assistant explains the proposal", async () => {
  const replacement = { ...valid, reason: "Nothing is removed.", actions: [
    { type: "query", id: "revenue", metrics: ["arpu"] },
  ] };
  const requests = provider([replacement, { endText: "Revenue is replaced by ARPU in this proposed chart." }]);
  const before = structuredClone(active);
  const result = await run();
  const feedback = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .find((block: any) => block.type === "tool_result" && block.tool_use_id === "proposal-1");
  const content = typeof feedback.content === "string" ? feedback.content : feedback.content.map((block: any) => block.text).join("");
  const facts = JSON.parse(content);
  expect(facts.metricChanges).toMatchObject({ removedMetrics: ["revenue"], substitutions: [{ id: "revenue", before: ["revenue"], after: ["arpu"] }] });
  expect(facts.guidance).toContain("Do not claim all metrics are preserved");
  expect(result.text).toContain("Revenue is replaced by ARPU");
  expect(active).toEqual(before);
});
