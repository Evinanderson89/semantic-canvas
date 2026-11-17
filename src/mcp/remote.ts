import type { Request, Response } from "express";
import { z } from "zod";
import { api, asText, runToolInContext, TOOLS, type ToolSpec } from "../agent/tools.ts";
import { coachSemanticModel, type AnalysisGoal } from "../semantic/coach.ts";
import { convertSemanticLayer, type SemanticLayerFormat } from "../semantic/convert.ts";
import type { Model } from "../semantic/model.ts";
import type { ForwardedAuth } from "../security/auth.ts";

export type RemoteMcpRole = "viewer" | "editor" | "admin";

export interface RemoteMcpDeps {
  source: string;
  principal: string;
  role: RemoteMcpRole;
  forwarded?: ForwardedAuth;
}

const WRITE_TOOLS = new Set(["save_dashboard", "arrange_dashboard"]);
const EXCLUDED_REMOTE_TOOLS = new Set(["ask_user"]);

const COACH_TOOL: ToolSpec = {
  name: "coach_semantic_model",
  description:
    "Evaluate semantic model readiness across time-series, driver attribution, ratios & funnels, cohorts & cumulative metrics, and AI/MCP readiness, or coach a custom analysis question.",
  inputSchema: {
    goal: z.string().optional(),
    question: z.string().optional(),
  },
  handler: async ({ goal, question }: { goal?: string; question?: string }) => {
    const model = (await api("/api/model")) as Model;
    return coachSemanticModel(model, {
      goal: goal?.trim() ? (goal.trim() as AnalysisGoal) : undefined,
      question: question?.trim() ? question.trim() : undefined,
    });
  },
};

const CONVERT_TOOL: ToolSpec = {
  name: "convert_semantic_model",
  description:
    "Export the active semantic model or convert external semantic layer YAML/JSON between DuckGlue, Snowflake Cortex Analyst, dbt MetricFlow, AWS Glue Data Catalog, and Cube.",
  inputSchema: {
    targetFormat: z.enum(["duckglue", "snowflake", "metricflow", "glue", "cube"]),
    content: z.string().optional(),
    sourceFormat: z.enum(["auto", "duckglue", "snowflake", "metricflow", "glue", "cube"]).optional(),
  },
  handler: async ({
    targetFormat,
    content,
    sourceFormat,
  }: {
    targetFormat: SemanticLayerFormat;
    content?: string;
    sourceFormat?: SemanticLayerFormat | "auto";
  }) => {
    const model = content?.trim() ? undefined : ((await api("/api/model")) as Model);
    return convertSemanticLayer({
      targetFormat,
      content: content?.trim() ? content : undefined,
      sourceFormat: sourceFormat ?? "auto",
      model,
    });
  },
};

export function remoteToolsForRole(role: RemoteMcpRole): ToolSpec[] {
  return [...TOOLS, COACH_TOOL, CONVERT_TOOL].filter((tool) => {
    if (EXCLUDED_REMOTE_TOOLS.has(tool.name)) return false;
    if (role === "viewer" && WRITE_TOOLS.has(tool.name)) return false;
    return true;
  });
}

export async function handleRemoteMcp(req: Request, res: Response, deps: RemoteMcpDeps): Promise<void> {
  const body = req.body;
  const id = body && typeof body === "object" && "id" in body ? body.id ?? null : null;
  if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
    });
    return;
  }

  const { method, params } = body as { method: string; params?: Record<string, any> };

  if (method === "initialize") {
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "semantic-canvas", version: "0.1.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    res.status(200).json({
      jsonrpc: "2.0",
      id,
      ok: true,
      result: { ok: true },
    });
    return;
  }

  if (method === "tools/list") {
    const tools = remoteToolsForRole(deps.role).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(z.object(tool.inputSchema), { reused: "inline" }),
    }));
    res.json({
      jsonrpc: "2.0",
      id,
      result: { tools },
    });
    return;
  }

  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const rawArgs = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    if (name === "coach_semantic_model") {
      const parsedCoach = z.object(COACH_TOOL.inputSchema).safeParse(rawArgs);
      if (!parsedCoach.success) {
        const msg = parsedCoach.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
        res.status(400).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: msg },
          result: { isError: true, content: [{ type: "text", text: msg }] },
        });
        return;
      }
      try {
        const goal = typeof parsedCoach.data.goal === "string" && parsedCoach.data.goal.trim()
          ? (parsedCoach.data.goal.trim() as AnalysisGoal)
          : undefined;
        const question = typeof parsedCoach.data.question === "string" && parsedCoach.data.question.trim()
          ? parsedCoach.data.question.trim()
          : undefined;
        const model = (await runToolInContext(
          { source: deps.source, principal: deps.principal, auth: deps.forwarded },
          () => api("/api/model"),
        )) as Model;
        const report = coachSemanticModel(model, { goal, question });
        res.json({
          jsonrpc: "2.0",
          id,
          result: {
            isError: false,
            content: [{ type: "text" as const, text: JSON.stringify(report) }],
            structuredContent: report,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "The Canvas tool failed";
        res.status(400).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: msg },
          result: { isError: true, content: [{ type: "text" as const, text: msg }] },
        });
      }
      return;
    }
    if (name === "convert_semantic_model") {
      const parsedConvert = z.object(CONVERT_TOOL.inputSchema).safeParse(rawArgs);
      if (!parsedConvert.success) {
        const msg = parsedConvert.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
        res.status(400).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: msg },
          result: { isError: true, content: [{ type: "text", text: msg }] },
        });
        return;
      }
      try {
        const targetFormat = String(parsedConvert.data.targetFormat) as SemanticLayerFormat;
        const content =
          typeof parsedConvert.data.content === "string" && parsedConvert.data.content.trim()
            ? parsedConvert.data.content
            : undefined;
        const sourceFormat =
          typeof parsedConvert.data.sourceFormat === "string" && parsedConvert.data.sourceFormat.trim()
            ? (parsedConvert.data.sourceFormat.trim() as SemanticLayerFormat | "auto")
            : "auto";
        const model = content
          ? undefined
          : ((await runToolInContext(
              { source: deps.source, principal: deps.principal, auth: deps.forwarded },
              () => api("/api/model"),
            )) as Model);
        const converted = convertSemanticLayer({
          targetFormat,
          content,
          sourceFormat,
          model,
        });
        res.json({
          jsonrpc: "2.0",
          id,
          result: {
            isError: false,
            content: [{ type: "text" as const, text: JSON.stringify(converted) }],
            structuredContent: converted,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "The Canvas tool failed";
        res.status(400).json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: msg },
          result: { isError: true, content: [{ type: "text" as const, text: msg }] },
        });
      }
      return;
    }
    const tool = TOOLS.find((t) => t.name === name && !EXCLUDED_REMOTE_TOOLS.has(t.name));
    if (!tool) {
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
        result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] },
      });
      return;
    }

    const permitted = remoteToolsForRole(deps.role).some((t) => t.name === tool.name);
    if (!permitted) {
      const msg = `Role "${deps.role}" is not permitted to call tool "${tool.name}"`;
      res.status(403).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32003, message: msg },
        result: { isError: true, content: [{ type: "text", text: msg }] },
      });
      return;
    }

    const parsed = z.object(tool.inputSchema).safeParse(rawArgs);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
      res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: msg },
        result: { isError: true, content: [{ type: "text", text: msg }] },
      });
      return;
    }

    try {
      const output = await runToolInContext(
        { source: deps.source, principal: deps.principal, auth: deps.forwarded },
        () => tool.handler(parsed.data),
      );
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          isError: false,
          content: [{ type: "text" as const, text: asText(output) }],
          structuredContent: output,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "The Canvas tool failed";
      res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: msg },
        result: { isError: true, content: [{ type: "text" as const, text: msg }] },
      });
    }
    return;
  }

  res.status(404).json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}
