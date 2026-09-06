#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, asText } from "../agent/tools.ts";

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
  const hasInput = Object.keys(tool.inputSchema).length > 0;
  server.registerTool(
    tool.name,
    hasInput ? { description: tool.description, inputSchema: tool.inputSchema } : { description: tool.description },
    async (input: any) => ({ content: [{ type: "text" as const, text: asText(await tool.handler(input)) }] }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
