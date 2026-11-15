import { loopbackRequest } from "../security/loopback.ts";
import type { ForwardedAuth } from "../security/auth.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { dashboardSchema, canvasSchema, filterSchema, profileFieldsSchema } from "../compiler/schema.ts";
import { z } from "zod";
import { LAYOUTS, LAYOUT_NAMES } from "../canvas/layouts.ts";
import { reviewedModel } from "../semantic/model.ts";
import { seriesSummarySchema, summarizeMetricSeries } from "../suggest/seriesSummary.ts";

/**
 * The tool surface any agent gets -- an MCP client attached over stdio
 * (src/mcp/server.ts), or the embedded in-app agent (src/agent/loop.ts).
 * One definition, two consumers: both call through the same running
 * semantic-canvas API over HTTP rather than each other's internals, so
 * there's no second copy of validation/RLS/compiler logic to fall out of
 * sync, and no "the MCP agent is governed but the in-app one isn't" gap.
 */
const API = process.env.SEMANTIC_CANVAS_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5174}`;
export interface ToolContext { source?: string; principal?: string; signal?: AbortSignal; auth?: ForwardedAuth }
const context = new AsyncLocalStorage<ToolContext>();
export function runToolInContext<T>(ctx: ToolContext, run: () => Promise<T>): Promise<T> { return context.run(ctx, run); }

export async function api(path: string, opts: {
  method?: string; body?: unknown; source?: string; principal?: string;
} = {}) {
  const bound = context.getStore();
  for (const key of ["source", "principal"] as const) {
    if (bound?.[key] !== undefined && opts[key] !== undefined && bound[key] !== opts[key]) {
      throw new Error(`This session is restricted to ${key} ${JSON.stringify(bound[key] || "(none selected)")}. Switch the ${key} in Canvas or change the connection setup before requesting another scope.`);
    }
  }
  const source = bound?.source ?? opts.source, principal = bound?.principal ?? opts.principal;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (source) headers["x-sc-source"] = source;
  if (principal) headers["x-sc-principal"] = principal;
  const session = bound?.auth;
  if (session) {
    if (!Number.isFinite(session.expires) || session.expires <= Date.now()) throw new Error("Your verified session or data policy expired. Refresh before running another tool.");
    if (session.cookie) headers.cookie = session.cookie;
    if (session.authorization) headers.authorization = session.authorization;
    if (session.gatewayPolicy) {
      headers["x-gateway-policy"] = session.gatewayPolicy.body;
      headers["x-gateway-policy-sig"] = session.gatewayPolicy.signature;
    }
    headers["x-sc-csrf"] = session.csrf; headers.host = session.host; headers.origin = session.origin;
  }
  let res: Response;
  try {
    const target = session ? `http://127.0.0.1:${process.env.PORT ?? 5174}` : API;
    res = await (session ? loopbackRequest : fetch)(`${target}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers, signal: bound?.signal, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e: any) {
    throw new Error(`semantic-canvas isn't reachable at ${API} -- is "npm run server" running? (${e?.message ?? e})`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** How a tool result is rendered as text, for consumers that need a string
 *  (an MCP content block, a tool_result block) rather than the raw value. */
export const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const filterSpec = filterSchema;
const sourceSpec = z.string().optional().describe("Source ID from list_sources. Omit for the active source. In a scoped session it must match the bound source; mismatches are rejected.");
const principalSpec = z.string().optional().describe("Acting principal for row-level security. Omit to retain the session's bound principal; an unbound call without a principal is denied when row policies require one. Mismatched bound principals are rejected.");

export interface ToolSpec<I = any> {
  name: string;
  description: string;
  /** A zod shape (object of fields), never wrapped in z.object -- each
   *  consumer wraps it the way its own SDK surface expects. */
  inputSchema: z.ZodRawShape;
  handler: (input: I) => Promise<unknown>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "list_principals",
    description: "List available acting principals and row-level policies. Local installations use selectable simulated principals; company mode exposes only the authenticated caller’s principal. Use a returned principal ID for governed queries, asking the user which scope they intend if unclear.",
    inputSchema: {},
    handler: async () => api("/api/principals"),
  },
  {
    name: "list_sources",
    description: "List every data source configured in sources.yaml: status (ready/error), adapter, connector, table/metric counts.",
    inputSchema: {},
    handler: async () => api("/api/sources"),
  },
  {
    name: "describe_model",
    description: "The full semantic model for a source: every table (columns, grain, joins) and every governed metric (name, expression, description, synonyms). Read this before proposing anything -- only what's in here can be charted, nothing outside it exists as far as query_metric is concerned.",
    inputSchema: { source: sourceSpec },
    // Ingested-but-unreviewed tables are not part of the governed catalogue an agent may draw on, whoever the caller is.
    handler: async ({ source }) => reviewedModel(await api("/api/model", { source })),
  },
  {
    name: "profile_field",
    description: "Cardinality and sample values for fields on one base table. Check this before choosing a breakdown dimension for curation -- a field with 30,000 distinct values makes a bad bar chart even though the model allows it. Queries have time budgets; a warning or null cardinality means evidence is unavailable, never that the field has zero distinct values. Do not claim a complete chart-type check from incomplete profiles.",
    inputSchema: {
      base: z.string().describe("The base table these fields belong to"),
      principal: principalSpec,
      fields: profileFieldsSchema.describe('Up to 12 column names, or "table.column" for a joined field'),
      source: sourceSpec,
    },
    handler: async ({ base, fields, source, principal }) => api(
      `/api/profile?base=${encodeURIComponent(base)}&fields=${encodeURIComponent(fields.join(","))}`, { source, principal }),
  },
  {
    name: "query_metric",
    description: 'Run a governed query -- compiled and row-level-secured the same way the UI\'s charts are. Dimensions use "grain:column" for a time bucket (e.g. "month:event_date") or "table.column" for a joined field. The evidence object supplies metric units, bucket-start meanings, calculated observations and returned-row quality findings. Use it alongside the raw values, warnings and partial coverage metadata before writing a conclusion; a ratio can have unequal input dates even when its displayed value looks stable. A withheld observation is not evidence of no change.',
    inputSchema: {
      metrics: z.array(z.string()).min(1),
      dimensions: z.array(z.string()).optional(),
      where: z.array(filterSpec).optional(),
      compare: z.enum(["none", "prior", "yoy"]).optional(),
      limit: z.number().optional(),
      source: sourceSpec,
      principal: principalSpec,
      summarize: seriesSummarySchema.optional().describe("Request calculated threshold counts and range for one metric over a stated calendar window. Use this before writing 'X of Y periods above/below a reference'; do not count a series by eye."),
    },
    handler: async ({ source, principal, summarize, ...tile }) => {
      const result = await api("/api/query?evidence=1", { method: "POST", body: tile, source, principal });
      return summarize ? { ...result, seriesSummary: summarizeMetricSeries({ ...tile, dimensions: tile.dimensions ?? [] }, result, summarize, result.evidence?.reportingCalendar) } : result;
    },
  },
  {
    name: "list_dashboards",
    description: "Saved dashboards for the active model.",
    inputSchema: { source: sourceSpec },
    handler: async ({ source }) => api("/api/dashboards", { source }),
  },
  {
    name: "get_dashboard",
    description: "Load one saved dashboard's full spec (tiles) and canvas.",
    inputSchema: { id: z.string(), source: sourceSpec },
    handler: async ({ id, source }) => api(`/api/dashboards/${encodeURIComponent(id)}`, { source }),
  },
  {
    name: "save_dashboard",
    description: "Create or overwrite a dashboard. spec is { title, tiles: [...] } -- each tile names metrics/dimensions from describe_model, never raw SQL. canvas is { width, height, ... }; a reasonable default is used if omitted.",
    inputSchema: {
      id: z.string().describe("A stable id; reuse it to overwrite the same dashboard"),
      name: z.string(),
      spec: dashboardSchema,
      canvas: canvasSchema.optional(),
      revision: z.number().int().nonnegative().default(0).describe("0 creates a new dashboard; updates require the revision returned by get_dashboard"),
      source: sourceSpec,
    },
    handler: async ({ source, ...body }) => api("/api/dashboards", { method: "POST", body, source }),
  },
  {
    name: "list_layouts",
    description: "The named layout templates arrange_dashboard can target, and what each is for -- pick one deliberately with this instead of guessing.",
    inputSchema: {},
    handler: async () => LAYOUTS,
  },
  {
    name: "arrange_dashboard",
    description: "Repack a saved dashboard's tiles into a clean layout -- auto-picks the best-fitting named layout (see list_layouts) unless you force one, and grows the canvas if needed. Call this after save_dashboard rather than hand-computing tile positions.",
    inputSchema: {
      id: z.string(), source: sourceSpec, revision: z.number().int().positive().optional(),
      layout: z.enum(LAYOUT_NAMES).optional().describe("Choose story for a vertical walkthrough, executive for headline numbers with compact support, or omit to tidy automatically"),
    },
    handler: async ({ id, layout, source, revision }) =>
      api(`/api/dashboards/${encodeURIComponent(id)}/arrange`, { method: "POST", body: { layout, revision }, source }),
  },
  {
    name: "ask_user",
    description: "Ask the human a clarifying question when the brief is ambiguous -- which of several plausible metrics they mean, how much detail they want, etc. Appears as a prompt in their semantic-canvas browser tab; this call blocks until they answer there, or up to 10 minutes, after which it times out. Use it instead of guessing when a curation decision would materially change what gets built.",
    inputSchema: {
      question: z.string(),
      options: z.array(z.string()).optional()
        .describe("If the answer is really a pick from a short list, offer it as buttons instead of free text"),
    },
    handler: async ({ question, options }) => {
      const { id } = await api("/api/agent/questions", { method: "POST", body: { question, options } });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const q = await api(`/api/agent/questions/${id}`);
        if (q.answer !== null) return q.answer;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return "(no answer after 10 minutes -- the human may not have the semantic-canvas tab open)";
    },
  },
];
