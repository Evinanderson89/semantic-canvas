import Anthropic from "@anthropic-ai/sdk";
import type { AiConfig } from "../sources/ai.ts";
import { requireAiConfiguration } from "./configuration.ts";

export class AiProviderError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.status = status;
  }
}

export function resolveProviderBaseUrl(cfg: AiConfig): string {
  if (cfg.baseUrl?.trim()) return cfg.baseUrl.trim().replace(/\/+$/, "");
  if (cfg.provider === "openai") return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (cfg.provider === "gemini") return (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
  if (cfg.provider === "openai-compatible") {
    const url = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim();
    if (!url) throw Object.assign(new Error("The OpenAI-compatible baseUrl is not configured. Set ai.baseUrl in the server configuration or Connections."), { status: 503 });
    return url.replace(/\/+$/, "");
  }
  return (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
}

async function compatFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error: any) {
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    throw new AiProviderError(undefined, "Connection error");
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    const msg = body?.error?.message ?? body?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch { /* ignore non-JSON body */ }
  return `Provider HTTP ${res.status}`;
}

/** Validate that a provider credential and model are usable before saving to .env. */
export async function verifyAiProvider(cfg: AiConfig, signal?: AbortSignal): Promise<void> {
  requireAiConfiguration(cfg);
  if (cfg.provider === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
    try {
      await client.models.retrieve(cfg.model, {}, signal ? { signal } : undefined);
      return;
    } catch (e: any) {
      const msg = e instanceof Anthropic.AuthenticationError ? "that key was rejected as invalid"
        : e instanceof Anthropic.NotFoundError ? `the model "${cfg.model}" isn't available on this key`
        : String(e?.message ?? e);
      throw Object.assign(new Error(msg), { status: 422 });
    }
  }

  const baseUrl = resolveProviderBaseUrl(cfg);
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` };
  const modelId = cfg.provider === "gemini" ? cfg.model.replace(/^models\//, "") : cfg.model;
  const res = await compatFetch(`${baseUrl}/models/${encodeURIComponent(modelId)}`, { method: "GET", headers, signal });
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("that key was rejected as invalid"), { status: 422 });
  }
  if (cfg.provider === "openai-compatible" && (res.status === 404 || res.status === 405)) {
    const listRes = await compatFetch(`${baseUrl}/models`, { method: "GET", headers, signal });
    if (listRes.ok) {
      const body: any = await listRes.json().catch(() => ({}));
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      if (!list.length || list.some((m: any) => (m?.id ?? m?.name) === cfg.model)) return;
    } else if (listRes.status === 401 || listRes.status === 403) {
      throw Object.assign(new Error("that key was rejected as invalid"), { status: 422 });
    }
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`the model "${cfg.model}" isn't available on this key`), { status: 422 });
  }
  const detail = await parseErrorMessage(res);
  throw Object.assign(new Error(detail), { status: 422 });
}

export interface CompatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
  parse: (input: unknown) => unknown;
  run: (input: any) => Promise<string>;
}

export interface CompatPhaseParams {
  model: string;
  max_tokens: number;
  system: string;
  max_iterations?: number;
  tools: CompatTool[];
  tool_choice?: { type: "tool"; name: string };
  messages: any[];
}

export function isCompatSchemaError(error: unknown): boolean {
  return error instanceof AiProviderError && error.status === 400 &&
    /compiled grammar is too large|schema is too complex|invalid_function_parameters|additionalproperties|strict|schema keyword/i.test(error.message);
}

function toOpenAiMessages(system: string, messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      const textParts = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
      const toolUses = m.content.filter((b: any) => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: textParts || null,
        ...(toolUses.length ? {
          tool_calls: toolUses.map((u: any) => ({
            id: u.id,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
          })),
        } : {}),
      });
    } else if (m.role === "user") {
      const toolResults = m.content.filter((b: any) => b.type === "tool_result");
      const textParts = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
      if (textParts) out.push({ role: "user", content: textParts });
    }
  }
  return out;
}

export async function runCompatToolPhase(
  cfg: AiConfig,
  params: CompatPhaseParams,
  signal?: AbortSignal,
): Promise<{ runner: { params: CompatPhaseParams }; message: { content: any[]; stop_reason: string } }> {
  const baseUrl = resolveProviderBaseUrl(cfg);
  const maxIterations = params.max_iterations ?? 6;
  const currentMessages = [...params.messages];
  let lastMessage: { content: any[]; stop_reason: string } = { content: [], stop_reason: "end_turn" };

  for (let step = 0; step < maxIterations; step++) {
    signal?.throwIfAborted();
    const openAiTools = params.tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        ...(t.strict ? { strict: true } : {}),
      },
    }));
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: params.max_tokens,
      messages: toOpenAiMessages(params.system, currentMessages),
      ...(openAiTools.length ? {
        tools: openAiTools,
        tool_choice: params.tool_choice ? { type: "function", function: { name: params.tool_choice.name } } : "auto",
      } : {}),
    };
    const res = await compatFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new AiProviderError(res.status, await parseErrorMessage(res));
    }
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message ?? {};
    const finishReason = choice?.finish_reason;
    if (msg.refusal) {
      lastMessage = { content: [{ type: "text", text: String(msg.refusal) }], stop_reason: "refusal" };
      break;
    }
    const contentBlocks: any[] = [];
    if (typeof msg.content === "string" && msg.content.trim()) {
      contentBlocks.push({ type: "text", text: msg.content });
    }
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try { parsedArgs = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { parsedArgs = {}; }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id ?? `call_${step}_${contentBlocks.length}`,
        name: tc?.function?.name ?? "",
        input: parsedArgs,
      });
    }
    const stopReason = finishReason === "length" ? "max_tokens"
      : toolCalls.length > 0 ? "tool_use"
      : "end_turn";
    lastMessage = { content: contentBlocks, stop_reason: stopReason };
    currentMessages.push({ role: "assistant", content: contentBlocks });

    if (stopReason !== "tool_use") break;

    const toolResults: any[] = [];
    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      const spec = params.tools.find(t => t.name === block.name);
      if (!spec) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
        continue;
      }
      try {
        const validated = spec.parse(block.input);
        const output = await spec.run(validated);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
      } catch (err: any) {
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: String(err?.message ?? err), is_error: true });
      }
    }
    currentMessages.push({ role: "user", content: toolResults });
  }

  return {
    runner: { params: { ...params, messages: currentMessages } },
    message: lastMessage,
  };
}

export async function createCompatStructuredJson(
  cfg: AiConfig,
  params: { model: string; max_tokens: number; system: string; userText: string; jsonSchema: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<{ stop_reason: "end_turn" | "max_tokens" | "refusal"; text: string }> {
  const baseUrl = resolveProviderBaseUrl(cfg);
  const res = await compatFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.max_tokens,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.userText },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "dashboard_story", strict: true, schema: params.jsonSchema },
      },
    }),
    signal,
  });
  if (!res.ok) throw new AiProviderError(res.status, await parseErrorMessage(res));
  const data: any = await res.json();
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal) return { stop_reason: "refusal", text: "" };
  if (choice?.finish_reason === "length") return { stop_reason: "max_tokens", text: "" };
  return { stop_reason: "end_turn", text: String(choice?.message?.content ?? "").trim() };
}

export async function analyzeReferenceWithCompatProvider(
  cfg: AiConfig,
  file: { mime: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; data: string; pages: number },
  system: string,
  userText: string,
  toolSchema: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ input: unknown; stop_reason: string }> {
  if (file.mime === "application/pdf" && cfg.provider === "openai-compatible") {
    throw Object.assign(new Error("This OpenAI-compatible endpoint supports image references (PNG, JPEG, WebP). For PDF references, use an image export or configure Anthropic, OpenAI, or Gemini."), { status: 422 });
  }
  const baseUrl = resolveProviderBaseUrl(cfg);
  const mediaPart = file.mime === "application/pdf"
    ? { type: "file", file: { filename: "reference.pdf", file_data: `data:application/pdf;base64,${file.data}` } }
    : { type: "image_url", image_url: { url: `data:${file.mime};base64,${file.data}` } };
  const res = await compatFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 12000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [mediaPart, { type: "text", text: userText }] },
      ],
      tools: [{
        type: "function",
        function: {
          name: "record_reference",
          description: "Describe the reference layout for review; this does not create or query a dashboard.",
          parameters: toolSchema,
        },
      }],
      tool_choice: { type: "function", function: { name: "record_reference" } },
    }),
    signal,
  });
  if (!res.ok) throw new AiProviderError(res.status, await parseErrorMessage(res));
  const data: any = await res.json();
  const choice = data?.choices?.[0];
  const tc = choice?.message?.tool_calls?.find((c: any) => c?.function?.name === "record_reference");
  if (!tc) return { input: undefined, stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "end_turn" };
  let parsed: unknown;
  try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = undefined; }
  return { input: parsed, stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "tool_use" };
}
