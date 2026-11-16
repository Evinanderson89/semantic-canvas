#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, asText, runToolInContext } from "../agent/tools.ts";

/**
 * The agentic port: an MCP server any MCP-capable agent (Claude Desktop,
 * Claude Code, or anything else that speaks MCP) can attach to, to read the
 * semantic layer, run governed queries, and build/arrange a dashboard --
 * without needing to know anything about this codebase.
 *
 * Registers the shared tool list from ../agent/tools.ts -- the same tools
 * the embedded in-app agent (src/agent/loop.ts) uses, both calling the same
 * governed HTTP API the browser UI does.
 */
const server = new McpServer({ name: "semantic-canvas", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (input: any, extra) => {
      try {
        const result = await runToolInContext({ signal: extra.signal }, () => tool.handler(input));
        return { content: [{ type: "text" as const, text: asText(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The Canvas tool failed" }] };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
