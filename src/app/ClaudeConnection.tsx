import { useEffect, useRef, useState } from "react";
import { readResponse } from "./http.ts";
import "./claudeConnection.css";

type Entry = { command: string; args: string[]; env: Record<string, string> };
type Setup = { available: false; reason: string } | {
  available: true; desktop: { mcpServers: Record<string, Entry> }; code: Entry & { type: string }; command: string;
};
type Check = { tools: number; metrics: number; source: string; checkedAt: string };

export function ClaudeConnection({ source, label }: { source: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const [client, setClient] = useState<"desktop" | "code">("desktop");
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

  return <section className="claude-connection" aria-label="Connect Claude">
    <div className="claude-heading"><div><span className="eyebrow">Claude Desktop · Claude Code</span>
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
        </div>
        {client === "desktop" ? <>
          <h3>1. Add Canvas to Claude Desktop</h3>
          <p>Open Claude Desktop’s developer settings and edit its MCP configuration. Merge the entry below into <code>mcpServers</code>, keeping your other servers. Save and restart Claude Desktop.</p>
          <button onClick={() => copy(JSON.stringify(setup.desktop, null, 2), "Desktop configuration")}>Copy Desktop configuration</button>
          <pre aria-label="Claude Desktop configuration">{JSON.stringify(setup.desktop, null, 2)}</pre>
          <a href="https://modelcontextprotocol.io/docs/develop/connect-local-servers" target="_blank" rel="noreferrer">Local MCP setup guide ↗</a>
        </> : <>
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
