#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChatgptServer, chatgptScopeSchema } from "./chatgpt.ts";

const { values } = parseArgs({ options: { source: { type: "string" }, principal: { type: "string" }, access: { type: "string", default: "explore" } } });
const url = new URL(process.env.SEMANTIC_CANVAS_URL ?? "http://127.0.0.1:5174");
if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  throw new Error("The ChatGPT local connection requires a loopback Canvas API URL without credentials.");
}
const server = createChatgptServer(chatgptScopeSchema.parse(values));
await server.connect(new StdioServerTransport());
