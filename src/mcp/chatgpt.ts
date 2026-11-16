import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, asText, runToolInContext, TOOLS } from "../agent/tools.ts";

export const chatgptScopeSchema = z.object({
  source: z.string().min(1).max(200), principal: z.string().min(1).max(200),
  access: z.enum(["explore", "build"]).default("explore"),
}).strict();
export type ChatgptScope = z.infer<typeof chatgptScopeSchema>;
const reads = new Set(["list_sources", "list_principals", "describe_model", "profile_field", "query_metric", "list_dashboards", "get_dashboard", "list_layouts"]);
const writes = new Set(["save_dashboard", "arrange_dashboard"]);

/** A tunnel delegates this one local scope, not a company login or arbitrary principals. */
export function createChatgptServer(input: ChatgptScope) {
  const scope = chatgptScopeSchema.parse(input);
  const server = new McpServer({ name: "semantic-canvas", version: "0.1.0" }, {
    instructions: "Read the governed metric definitions before querying or building. Explain periods, filters and data limitations. Do not invent metrics or causes. Ask clarifying questions in this conversation. Ask for confirmation before saving or rearranging a dashboard. Tools operate on saved dashboards, not the user's unsaved canvas. Use a new dashboard ID for a new design, and current revisions for changes.",
  });
  for (const tool of TOOLS) {
    const write = writes.has(tool.name);
    if (!reads.has(tool.name) && !(write && scope.access === "build")) continue;
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: false },
    }, async (args: any, extra) => {
      try {
        for (const key of ["source", "principal"] as const) {
          if (args[key] !== undefined && args[key] !== scope[key]) throw new Error(`This connection is restricted to ${key} ${JSON.stringify(scope[key])}. Change the connection setup to use a different scope.`);
        }
        const result = await runToolInContext({ source: scope.source, principal: scope.principal,
          signal: AbortSignal.any([extra.signal, AbortSignal.timeout(90_000)]) }, async () => {
          // Recheck on every call: deleting a principal must never silently become unrestricted local access.
          const session = await api("/api/auth/session");
          if (session.mode !== "local") throw new Error("This connection supports local Canvas installations only. Company authentication is not supported by this local tunnel setup.");
          const principals = await api("/api/principals");
          const principal = principals.principals?.find((p: { id: string }) => p.id === scope.principal);
          if (!principal) throw new Error("The connection's row-access principal is no longer available. Reconfigure the connection before continuing.");
          const catalog = await api("/api/sources");
          const source = catalog.sources?.find((s: { id: string; status: string }) => s.id === scope.source && s.status === "ready");
          if (!source) throw new Error("The connection's source is unavailable. Reconnect the source in Canvas.");
          if (tool.name === "list_sources") return { sources: [source], active: scope.source };
          if (tool.name === "list_principals") return { principals: [principal], active: scope.principal };
          return tool.handler(args);
        });
        return { content: [{ type: "text" as const, text: asText(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The Canvas tool failed" }] };
      }
    });
  }
  return server;
}
