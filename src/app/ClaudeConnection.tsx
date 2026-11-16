import { useEffect, useRef, useState } from "react";
import { readResponse } from "./http.ts";
import "./claudeConnection.css";

type Entry = { command: string; args: string[]; env: Record<string, string> };
type Clients = {
  codex: { configToml: string; command: string };
  cursor: { mcpJson: { mcpServers: Record<string, Entry> } };
  antigravity: { mcpConfigJson: { mcpServers: Record<string, Entry> } };
  vscode: { mcpJson: { servers: Record<string, Entry & { type: string }> } };
  gemini: { settingsJson: { mcpServers: Record<string, Entry> } };
  generic: { command: string; mcpJson: { mcpServers: Record<string, Entry> } };
};
type Setup = { available: false; reason: string } | {
  available: true;
  desktop: { mcpServers: Record<string, Entry> };
  code: Entry & { type: string };
  command: string;
  clients?: Clients;
};
type ClientId = "desktop" | "code" | "codex" | "cursor" | "antigravity" | "vscode" | "gemini" | "generic";
type Check = { tools: number; metrics: number; source: string; checkedAt: string };

export function ClaudeConnection({ source, label }: { source: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const [client, setClient] = useState<ClientId>("desktop");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    fetch("/api/setup/claude", { signal: controller.signal }).then(readResponse)
      .then(setSetup).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [expanded]);

  const test = async () => {
    const controller = new AbortController(); pending.current = controller;
    setChecking(true); setCheck(null); setError("");
    try {
      const result = await fetch(`/api/setup/claude/check?source=${encodeURIComponent(source)}`, {
        method: "POST", signal: controller.signal,
      }).then(readResponse);
      if (!controller.signal.aborted) setCheck(result);
    } catch (e: any) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setChecking(false); }
  };
  const copy = async (text: string, what: string) => {
    setCopied("");
    try { await navigator.clipboard.writeText(text); setCopied(`${what} copied`); }
    catch { setError("Could not copy. Select and copy the text below."); }
  };
  const prompt = `Use Semantic Canvas to inspect the governed metrics in ${JSON.stringify(label)} (source ${JSON.stringify(source)}). Propose an executive dashboard with headline metrics, a trend, and useful breakdowns. Check reporting periods, missing data, and comparison scope. Explain your design and ask me before saving a new dashboard. Use a new ID and leave existing dashboards unchanged. After saving, arrange it and give me its name so I can open it in Canvas. Do not invent metrics or causes.`;
  const entry = setup?.available ? setup.desktop.mcpServers["semantic-canvas"] : undefined;
  const codexToml = setup?.available
    ? (setup.clients?.codex.configToml ?? [
      "[mcp_servers.semantic-canvas]",
      `command = ${JSON.stringify(entry?.command ?? "")}`,
      `args = [${(entry?.args ?? []).map(a => JSON.stringify(a)).join(", ")}]`,
      `env = { SEMANTIC_CANVAS_URL = ${JSON.stringify(entry?.env?.SEMANTIC_CANVAS_URL ?? "")} }`,
    ].join("\n"))
    : "";
  const codexCommand = setup?.available
    ? (setup.clients?.codex.command ?? `codex mcp add semantic-canvas --env SEMANTIC_CANVAS_URL=${entry?.env?.SEMANTIC_CANVAS_URL ?? ""} -- ${entry?.command ?? ""} ${(entry?.args ?? []).join(" ")}`)
    : "";
  const cursorJson = setup?.available ? JSON.stringify(setup.clients?.cursor.mcpJson ?? setup.desktop, null, 2) : "";
  const antigravityJson = setup?.available ? JSON.stringify(setup.clients?.antigravity.mcpConfigJson ?? setup.desktop, null, 2) : "";
  const vscodeJson = setup?.available ? JSON.stringify(setup.clients?.vscode.mcpJson ?? { servers: { "semantic-canvas": setup.code } }, null, 2) : "";
  const geminiJson = setup?.available ? JSON.stringify(setup.clients?.gemini.settingsJson ?? setup.desktop, null, 2) : "";
  const genericJson = setup?.available ? JSON.stringify(setup.clients?.generic.mcpJson ?? setup.desktop, null, 2) : "";
  const genericCommand = setup?.available
    ? (setup.clients?.generic.command ?? `env SEMANTIC_CANVAS_URL=${entry?.env?.SEMANTIC_CANVAS_URL ?? ""} ${entry?.command ?? ""} ${(entry?.args ?? []).join(" ")}`)
    : "";

  return <section className="claude-connection" aria-label="Connect Claude">
    <div className="claude-heading"><div><span className="eyebrow">Claude · Codex · Cursor · Antigravity · VS Code · Gemini CLI</span>
      <h2>Build dashboards from your Claude conversation.</h2>
      <p>Explore your semantic layer, query metrics, and create saved dashboards through MCP.</p>
    </div><button className="primary" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setError(""); }}>
      {expanded ? "Close Claude setup" : "Connect Claude"}
    </button></div>
    {expanded && <>
      {!setup && !error && <p role="status">Loading connection setup…</p>}
      {setup && !setup.available && <p>{setup.reason}</p>}
      {setup?.available && <>
        <p>For a local installation on the same computer as Claude. Keep Canvas running. Your Claude client supplies the AI; no Anthropic API key is needed in Canvas.</p>
        <p className="claude-boundary">Claude can read configured sources and save or change dashboards. This uses Canvas’s trusted local access, including selectable simulated principals. It does not edit your unsaved canvas. Ask Claude to explain changes before saving; tool calls can save directly.</p>
        <div className="claude-actions" role="group" aria-label="Claude client">
          <button aria-pressed={client === "desktop"} onClick={() => { setClient("desktop"); setCopied(""); }}>Claude Desktop</button>
          <button aria-pressed={client === "code"} onClick={() => { setClient("code"); setCopied(""); }}>Claude Code</button>
          <button aria-pressed={client === "codex"} onClick={() => { setClient("codex"); setCopied(""); }}>Codex</button>
          <button aria-pressed={client === "cursor"} onClick={() => { setClient("cursor"); setCopied(""); }}>Cursor</button>
          <button aria-pressed={client === "antigravity"} onClick={() => { setClient("antigravity"); setCopied(""); }}>Antigravity</button>
          <button aria-pressed={client === "vscode"} onClick={() => { setClient("vscode"); setCopied(""); }}>VS Code</button>
          <button aria-pressed={client === "gemini"} onClick={() => { setClient("gemini"); setCopied(""); }}>Gemini CLI</button>
          <button aria-pressed={client === "generic"} onClick={() => { setClient("generic"); setCopied(""); }}>Other MCP</button>
        </div>
        {client === "desktop" && <>
          <h3>1. Add Canvas to Claude Desktop</h3>
          <p>Open Claude Desktop’s developer settings and edit its MCP configuration. Merge the entry below into <code>mcpServers</code>, keeping your other servers. Save and restart Claude Desktop.</p>
          <button onClick={() => copy(JSON.stringify(setup.desktop, null, 2), "Desktop configuration")}>Copy Desktop configuration</button>
          <pre aria-label="Claude Desktop configuration">{JSON.stringify(setup.desktop, null, 2)}</pre>
          <a href="https://modelcontextprotocol.io/docs/develop/connect-local-servers" target="_blank" rel="noreferrer">Local MCP setup guide ↗</a>
        </>}
        {client === "code" && <>
          <h3>1. Add Canvas to Claude Code</h3>
          <p>Run this command in a macOS or Linux terminal with Claude Code installed. It adds Canvas for your user account.</p>
          <button onClick={() => copy(setup.command, "Claude Code command")}>Copy Claude Code command</button>
          <pre aria-label="Claude Code command">{setup.command}</pre>
          <details><summary>Project configuration / Windows</summary>
            <p>Merge this entry into your project’s <code>.mcp.json</code>. The paths must point to a Canvas installation on the computer running Claude. Approve the project server in Claude Code.</p>
            <button onClick={() => copy(JSON.stringify({ mcpServers: { "semantic-canvas": setup.code } }, null, 2), "Project configuration")}>Copy project configuration</button>
            <pre>{JSON.stringify({ mcpServers: { "semantic-canvas": setup.code } }, null, 2)}</pre>
          </details>
          <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">Claude Code MCP guide ↗</a>
        </>}
        {client === "codex" && <>
          <h3>1. Add Canvas to Codex</h3>
          <p>Add this section to <code>~/.codex/config.toml</code>, or run the CLI command below in your terminal to register Semantic Canvas with Codex.</p>
          <button onClick={() => copy(codexToml, "Codex TOML")}>Copy Codex TOML</button>
          <pre aria-label="Codex configuration">{codexToml}</pre>
          <button onClick={() => copy(codexCommand, "Codex command")}>Copy Codex command</button>
          <pre aria-label="Codex command">{codexCommand}</pre>
        </>}
        {client === "cursor" && <>
          <h3>1. Add Canvas to Cursor</h3>
          <p>Merge this entry into <code>~/.cursor/mcp.json</code> (global) or <code>.cursor/mcp.json</code> (project), then enable Semantic Canvas in Cursor Settings → MCP.</p>
          <button onClick={() => copy(cursorJson, "Cursor configuration")}>Copy Cursor configuration</button>
          <pre aria-label="Cursor configuration">{cursorJson}</pre>
        </>}
        {client === "antigravity" && <>
          <h3>1. Add Canvas to Antigravity</h3>
          <p>Merge this entry into <code>~/.gemini/config/mcp_config.json</code> (or your Antigravity MCP settings file) and reload MCP servers.</p>
          <button onClick={() => copy(antigravityJson, "Antigravity configuration")}>Copy Antigravity configuration</button>
          <pre aria-label="Antigravity configuration">{antigravityJson}</pre>
        </>}
        {client === "vscode" && <>
          <h3>1. Add Canvas to VS Code</h3>
          <p>Merge this entry into <code>.vscode/mcp.json</code> in your workspace so VS Code agent mode can use Semantic Canvas MCP tools.</p>
          <button onClick={() => copy(vscodeJson, "VS Code configuration")}>Copy VS Code configuration</button>
          <pre aria-label="VS Code configuration">{vscodeJson}</pre>
        </>}
        {client === "gemini" && <>
          <h3>1. Add Canvas to Gemini CLI</h3>
          <p>Merge this <code>mcpServers</code> entry into <code>~/.gemini/settings.json</code> and restart Gemini CLI.</p>
          <button onClick={() => copy(geminiJson, "Gemini CLI configuration")}>Copy Gemini CLI configuration</button>
          <pre aria-label="Gemini CLI configuration">{geminiJson}</pre>
        </>}
        {client === "generic" && <>
          <h3>1. Add Canvas to another MCP client</h3>
          <p>For Windsurf, Zed, Continue, or any other stdio MCP host, merge the JSON configuration below or point the client at the portable stdio command.</p>
          <button onClick={() => copy(genericJson, "Other MCP configuration")}>Copy Other MCP configuration</button>
          <pre aria-label="Other MCP configuration">{genericJson}</pre>
          <button onClick={() => copy(genericCommand, "Stdio command")}>Copy stdio command</button>
          <pre aria-label="Stdio command">{genericCommand}</pre>
        </>}
        <h3>2. Check the connection</h3>
        <p>This checks the local MCP handshake, tool discovery, and metric definitions for {label}. It does not contact Claude or verify your client configuration.</p>
        <button disabled={checking || !source} onClick={test}>{checking ? "Checking local connection…" : "Test local connection"}</button>
        {check && <p role="status">Local MCP check passed at {new Date(check.checkedAt).toLocaleTimeString()}: {check.tools} tools and {check.metrics} metrics available. {client === "code" ? "Run /mcp in Claude Code to confirm the client is connected." : "Confirm Semantic Canvas is connected in Claude Desktop’s connectors or developer settings."}</p>}
        <h3>3. Start a conversation</h3>
        <button onClick={() => copy(prompt, "Starter prompt")}>Copy starter prompt</button>
        <blockquote>{prompt}</blockquote>
        <p>After Claude saves, refresh Canvas and open the dashboard from your saved library. You can refine it there and choose its presentation format.</p>
      </>}
      {copied && <p role="status">{copied}</p>}
      {error && <p className="cform-err" role="alert">{error}</p>}
    </>}
  </section>;
}
