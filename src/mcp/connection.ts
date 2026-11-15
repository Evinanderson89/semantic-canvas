import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chatgptScopeSchema, type ChatgptScope } from "./chatgpt.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Absolute paths work even when Claude starts in a different directory. No server secrets are exported. */
export function claudeSetup(port: number) {
  const require = createRequire(import.meta.url);
  const entry = {
    command: process.execPath,
    args: ["--import", pathToFileURL(require.resolve("tsx/esm")).href, fileURLToPath(new URL("./server.ts", import.meta.url))],
    env: { SEMANTIC_CANVAS_URL: `http://127.0.0.1:${port}` },
  };
  const code = { type: "stdio", ...entry };
  return {
    available: true as const,
    desktop: { mcpServers: { "semantic-canvas": entry } },
    code,
    // POSIX shell syntax. Windows users can use the project JSON instead.
    command: `claude mcp add-json --scope user semantic-canvas ${quote(JSON.stringify(code))}`,
  };
}

/** A real MCP handshake and catalogue read; never calls an LLM or writes a dashboard. */
export async function checkClaudeConnection(port: number, source: string) {
  return checkMcp(claudeSetup(port).code, source);
}

export function chatgptSetup(port: number, input: ChatgptScope) {
  const scope = chatgptScopeSchema.parse(input);
  const base = claudeSetup(port).code;
  const entry = { ...base, args: [...base.args.slice(0, 2), fileURLToPath(new URL("./chatgptServer.ts", import.meta.url)),
    "--source", scope.source, "--principal", scope.principal, "--access", scope.access] };
  const mcpCommand = ["env", ...Object.entries(entry.env).map(([key, value]) => `${key}=${value}`), entry.command, ...entry.args].map(quote).join(" ");
  return { available: true as const, scope, entry, mcpCommand };
}

export async function checkChatgptConnection(port: number, scope: ChatgptScope) {
  return { ...await checkMcp(chatgptSetup(port, scope).entry, scope.source), principal: scope.principal, access: scope.access };
}

async function checkMcp(entry: ReturnType<typeof claudeSetup>["code"], source: string) {
  const transport = new StdioClientTransport({ ...entry, stderr: "pipe" });
  // Drain diagnostics without returning local process details or credentials to the browser.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "semantic-canvas-connection-check", version: "0.1.0" });
  const options = { signal: AbortSignal.timeout(10_000), timeout: 10_000 };
  try {
    await client.connect(transport, options);
    const { tools } = await client.listTools({}, options);
    const model = await client.callTool({ name: "describe_model", arguments: { source } }, undefined, options);
    if (model.isError) throw new Error("The MCP server could not read this source’s metric definitions. Check the source and try again.");
    const content = model.content as { type: string; text?: string }[];
    const catalog = JSON.parse(content.find(c => c.type === "text")?.text ?? "null");
    if (!catalog || !catalog.metrics) throw new Error("The MCP server returned an invalid metric catalogue.");
    return { tools: tools.length, metrics: Object.keys(catalog.metrics).length, source, checkedAt: new Date().toISOString() };
  } finally {
    await client.close();
    await transport.close();
  }
}
