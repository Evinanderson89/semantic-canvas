#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LAYOUTS } from "../canvas/layouts.ts";

/**
 * The agentic port: an MCP server any MCP-capable agent (Claude Desktop,
 * Claude Code, or anything else that speaks MCP) can attach to, to read the
 * semantic layer, run governed queries, and build/arrange a dashboard --
 * without needing to know anything about this codebase.
 *
 * Talks to the already-running semantic-canvas API (`npm run server`) over
 * HTTP rather than reaching into its internals: the same governed path
 * (validation, RLS, the compiler) the browser UI uses, so there's no second
 * copy of that logic for an agent to bypass or fall out of sync with.
 */
const API = process.env.SEMANTIC_CANVAS_URL ?? "http://localhost:5174";

async function api(path: string, opts: {
  method?: string; body?: unknown; source?: string; principal?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.source) headers["x-sc-source"] = opts.source;
  if (opts.principal) headers["x-sc-principal"] = opts.principal;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e: any) {
    throw new Error(`semantic-canvas isn't reachable at ${API} -- is "npm run server" running? (${e?.message ?? e})`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "semantic-canvas", version: "0.1.0" });

server.registerTool("list_sources", {
  description: "List every data source configured in sources.yaml: status (ready/error), adapter, connector, table/metric counts.",
}, async () => text(await api("/api/sources")));

server.registerTool("describe_model", {
  description: "The full semantic model for a source: every table (columns, grain, joins) and every governed metric (name, expression, description, synonyms). Read this before proposing anything -- only what's in here can be charted, nothing outside it exists as far as query_metric is concerned.",
  inputSchema: { source: z.string().optional().describe("Source id from list_sources; omit for the active one") },
}, async ({ source }) => text(await api("/api/model", { source })));

server.registerTool("profile_field", {
  description: "Cardinality and sample values for fields on one base table. Check this before choosing a breakdown dimension for curation -- a field with 30,000 distinct values makes a bad bar chart even though the model allows it.",
  inputSchema: {
    base: z.string().describe("The base table these fields belong to"),
    fields: z.array(z.string()).min(1).describe('Column names, or "table.column" for a joined field'),
    source: z.string().optional(),
  },
}, async ({ base, fields, source }) => text(await api(
  `/api/profile?base=${encodeURIComponent(base)}&fields=${encodeURIComponent(fields.join(","))}`, { source })));

const filterSpec = z.object({
  id: z.string(), field: z.string(),
  source: z.enum(["dimension", "metric"]), mode: z.enum(["discrete", "range"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  min: z.number().nullable().optional(), max: z.number().nullable().optional(),
  exclude: z.boolean().optional(),
});

server.registerTool("query_metric", {
  description: 'Run a governed query -- compiled and row-level-secured the same way the UI\'s charts are. Dimensions use "grain:column" for a time bucket (e.g. "month:event_date") or "table.column" for a joined field.',
  inputSchema: {
    metrics: z.array(z.string()).min(1),
    dimensions: z.array(z.string()).optional(),
    where: z.array(filterSpec).optional(),
    compare: z.enum(["none", "prior", "yoy"]).optional(),
    limit: z.number().optional(),
    source: z.string().optional(),
    principal: z.string().optional()
      .describe("Acting principal for row-level security; omit to query as no one (denied if RLS policies exist)"),
  },
}, async ({ source, principal, ...tile }) => text(await api("/api/query", { method: "POST", body: tile, source, principal })));

server.registerTool("list_dashboards", {
  description: "Saved dashboards for the active model.",
  inputSchema: { source: z.string().optional() },
}, async ({ source }) => text(await api("/api/dashboards", { source })));

server.registerTool("get_dashboard", {
  description: "Load one saved dashboard's full spec (tiles) and canvas.",
  inputSchema: { id: z.string() },
}, async ({ id }) => text(await api(`/api/dashboards/${encodeURIComponent(id)}`)));

server.registerTool("save_dashboard", {
  description: "Create or overwrite a dashboard. spec is { title, tiles: [...] } -- each tile names metrics/dimensions from describe_model, never raw SQL. canvas is { width, height, ... }; a reasonable default is used if omitted.",
  inputSchema: {
    id: z.string().describe("A stable id; reuse it to overwrite the same dashboard"),
    name: z.string(),
    spec: z.any().describe("DashboardSpec: { title, tiles: TileSpec[] }"),
    canvas: z.any().optional(),
    source: z.string().optional(),
  },
}, async ({ source, ...body }) => text(await api("/api/dashboards", { method: "POST", body, source })));

server.registerTool("list_layouts", {
  description: "The named layout templates arrange_dashboard can target, and what each is for -- pick one deliberately with this instead of guessing.",
}, async () => text(LAYOUTS));

server.registerTool("arrange_dashboard", {
  description: "Repack a saved dashboard's tiles into a clean layout -- auto-picks the best-fitting named layout (see list_layouts) unless you force one, and grows the canvas if needed. Call this after save_dashboard rather than hand-computing tile positions.",
  inputSchema: {
    id: z.string(),
    layout: z.enum(["grid", "exec-summary"]).optional().describe("Force a specific layout; omit to auto-pick the best fit"),
  },
}, async ({ id, layout }) =>
  text(await api(`/api/dashboards/${encodeURIComponent(id)}/arrange`, { method: "POST", body: { layout } })));

server.registerTool("ask_user", {
  description: "Ask the human a clarifying question when the brief is ambiguous -- which of several plausible metrics they mean, how much detail they want, etc. Appears as a prompt in their semantic-canvas browser tab; this call blocks until they answer there, or up to 10 minutes, after which it times out. Use it instead of guessing when a curation decision would materially change what gets built.",
  inputSchema: {
    question: z.string(),
    options: z.array(z.string()).optional()
      .describe("If the answer is really a pick from a short list, offer it as buttons instead of free text"),
  },
}, async ({ question, options }) => {
  const { id } = await api("/api/agent/questions", { method: "POST", body: { question, options } });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const q = await api(`/api/agent/questions/${id}`);
    if (q.answer !== null) return text(q.answer);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return text("(no answer after 10 minutes -- the human may not have the semantic-canvas tab open)");
});

const transport = new StdioServerTransport();
await server.connect(transport);
