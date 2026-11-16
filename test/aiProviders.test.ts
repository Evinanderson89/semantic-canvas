import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { verifyAiProvider, runCompatToolPhase, createCompatStructuredJson } from "../src/agent/provider.ts";
import { chat, explainTile, suggestImprovements, suggestDashboardStory } from "../src/agent/loop.ts";
import { analyzeReference } from "../src/reference/analyze.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { model, tile } from "./fixtures.ts";
import type { AiConfig } from "../src/sources/ai.ts";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let handler: (req: IncomingMessage, body: any, res: ServerResponse) => void;
const recordedRequests: { method: string; url: string; headers: IncomingMessage["headers"]; body: any }[] = [];

beforeEach(async () => {
  recordedRequests.length = 0;
  handler = (_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({}));
  };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = raw ? JSON.parse(raw) : undefined;
    recordedRequests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: parsed });
    handler(req, parsed, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

it("verifies OpenAI, Gemini, and OpenAI-compatible credentials and models against the provider endpoint", async () => {
  handler = (req, _body, res) => {
    if (req.headers.authorization !== "Bearer valid-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
      return;
    }
    if (req.url === "/v1/models/gpt-5.4" || req.url === "/v1/models/gemini-2.5-pro") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: req.url.split("/").pop() }));
      return;
    }
    if (req.url === "/v1/models/custom-local-model") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Model endpoint not implemented" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "custom-local-model" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  };

  await expect(verifyAiProvider({ provider: "openai", model: "gpt-5.4", apiKey: "valid-key", baseUrl })).resolves.toBeUndefined();
  await expect(verifyAiProvider({ provider: "gemini", model: "models/gemini-2.5-pro", apiKey: "valid-key", baseUrl })).resolves.toBeUndefined();
  await expect(verifyAiProvider({ provider: "openai-compatible", model: "custom-local-model", apiKey: "valid-key", baseUrl })).resolves.toBeUndefined();

  await expect(verifyAiProvider({ provider: "openai", model: "gpt-5.4", apiKey: "wrong-key", baseUrl }))
    .rejects.toMatchObject({ status: 422, message: "that key was rejected as invalid" });
  await expect(verifyAiProvider({ provider: "openai", model: "missing-model", apiKey: "valid-key", baseUrl }))
    .rejects.toMatchObject({ status: 422, message: 'the model "missing-model" isn\'t available on this key' });
});

it("executes multi-turn tool calls in runCompatToolPhase and chat across OpenAI, Gemini, and OpenAI-compatible providers", async () => {
  for (const provider of ["openai", "gemini", "openai-compatible"] as const) {
    recordedRequests.length = 0;
    let callCount = 0;
    handler = (_req, _body, res) => {
      callCount++;
      res.writeHead(200, { "content-type": "application/json" });
      if (callCount === 1) {
        res.end(JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "list_layouts", arguments: "{}" },
              }],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: { role: "assistant", content: `Completed via ${provider}.` },
          }],
        }));
      }
    };

    const cfg: AiConfig = { provider, model: "synthetic-model", apiKey: "synthetic-key", baseUrl };
    const result = await chat(cfg, [], "List the available layouts", {});
    expect(result.text).toBe(`Completed via ${provider}.`);
    expect(recordedRequests).toHaveLength(2);
    expect(recordedRequests[0].headers.authorization).toBe("Bearer synthetic-key");
    const secondMessages = recordedRequests[1].body.messages;
    expect(secondMessages.some((m: any) => m.role === "tool" && m.tool_call_id === "call_1" && m.content.includes("exec-summary"))).toBe(true);
  }
});

it("recovers from schema errors on non-Anthropic providers and flags explanation rationale contradictions in redesign mode", async () => {
  const active = {
    spec: { title: "Revenue", tiles: [tile({ id: "revenue", chart: "bar", dimensions: ["dim_users.country"] })] },
    canvas: DEFAULT_CANVAS,
    selected: [],
    model,
  };
  const validProposal = {
    title: "Revenue over time",
    reason: "Adds a dashboard description; there was none before.",
    actions: [
      { type: "query", id: "revenue", dimensions: ["month:sold_on"] },
      { type: "chart", id: "revenue", chart: "line" },
      { type: "describe", description: "Monthly revenue trend." },
    ],
  };

  let step = 0;
  handler = (_req, _body, res) => {
    step++;
    if (step === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid schema for function 'propose_canvas_changes': schema is too complex" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (step === 2) {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_prop_1",
              type: "function",
              function: { name: "propose_canvas_changes", arguments: JSON.stringify(validProposal) },
            }],
          },
        }],
      }));
      return;
    }
    // Final explanation text contradicts the calculated fact that no prior description existed.
    res.end(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "The dashboard description is replaced because the prior description was too vague.",
        },
      }],
    }));
  };

  const cfg: AiConfig = { provider: "openai", model: "gpt-5.4", apiKey: "synthetic-key", baseUrl };
  const result = await chat(cfg, [], "Redesign this dashboard", {}, active, undefined, "redesign");
  expect(result.providerSchemaFallback).toBe(true);
  expect(result.proposal).toEqual(validProposal);
  expect(result.rationaleWarnings).toEqual([
    expect.objectContaining({ id: "prior-description" }),
  ]);
  // First request had strict: true on propose_canvas_changes; fallback request stripped it.
  const firstPropTool = recordedRequests[0].body.tools.find((t: any) => t.function.name === "propose_canvas_changes");
  const secondPropTool = recordedRequests[1].body.tools.find((t: any) => t.function.name === "propose_canvas_changes");
  expect(firstPropTool.function.strict).toBe(true);
  expect(secondPropTool.function.strict).toBeUndefined();
});

it("supports explainTile, suggestImprovements, and suggestDashboardStory with non-Anthropic providers", async () => {
  handler = (_req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (body.response_format?.type === "json_schema") {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              title: "Executive Revenue Story",
              layout: "exec-summary",
              order: ["revenue"],
              notes: [{ id: "revenue", note: "Consider breaking down by month." }],
              additions: [],
              summary: "Lead with headline revenue.",
            }),
          },
        }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Revenue grew steadily across the sampled period." },
      }],
    }));
  };

  const cfg: AiConfig = { provider: "gemini", model: "gemini-2.5-pro", apiKey: "gemini-key", baseUrl };
  const sampleTile = { title: "Revenue", metrics: ["revenue"], dimensions: [] };
  expect(await explainTile(cfg, {}, sampleTile)).toBe("Revenue grew steadily across the sampled period.");
  expect(await suggestImprovements(cfg, {}, sampleTile)).toBe("Revenue grew steadily across the sampled period.");

  const story = await suggestDashboardStory(
    cfg,
    {},
    [{ id: "revenue", title: "Revenue", kind: "metric", metrics: ["revenue"], dimensions: [] }],
    [{ name: "revenue", label: "Revenue", baseTable: "fct_sales" }],
  );
  expect(story).toEqual({
    title: "Executive Revenue Story",
    layout: "exec-summary",
    order: ["revenue"],
    notes: [{ id: "revenue", note: "Consider breaking down by month." }],
    additions: [],
    summary: "Lead with headline revenue.",
  });
});

it("imports image references on all compat providers and guards PDF references on openai-compatible", async () => {
  const pngFile = {
    mime: "image/png" as const,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=",
  };
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const pdfFile = {
    mime: "application/pdf" as const,
    data: Buffer.from(await pdf.save()).toString("base64"),
  };
  const blueprint = { title: "Imported Layout", pages: [{ title: "Overview", aspectRatio: 1.5, items: [] }] };

  handler = (_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_ref",
            type: "function",
            function: { name: "record_reference", arguments: JSON.stringify(blueprint) },
          }],
        },
      }],
    }));
  };

  const compatCfg: AiConfig = { provider: "openai-compatible", model: "vision-model", apiKey: "compat-key", baseUrl };
  expect(await analyzeReference(pngFile, model, compatCfg)).toEqual(blueprint);
  await expect(analyzeReference(pdfFile, model, compatCfg)).rejects.toMatchObject({
    status: 422,
    message: expect.stringContaining("supports image references (PNG, JPEG, WebP)"),
  });

  const openAiCfg: AiConfig = { provider: "openai", model: "gpt-5.4", apiKey: "openai-key", baseUrl };
  expect(await analyzeReference(pdfFile, model, openAiCfg)).toEqual(blueprint);

  // Direct unit check on helper functions for completeness
  const direct = await createCompatStructuredJson(openAiCfg, {
    model: "gpt-5.4",
    max_tokens: 512,
    system: "Return JSON",
    userText: "Hello",
    jsonSchema: { type: "object", properties: {} },
  });
  expect(direct.stop_reason).toBe("end_turn");

  const toolRun = await runCompatToolPhase(openAiCfg, {
    model: "gpt-5.4",
    max_tokens: 512,
    system: "Test",
    max_iterations: 1,
    tools: [],
    messages: [{ role: "user", content: "Hi" }],
  });
  expect(toolRun.message.stop_reason).toBe("tool_use");
});
