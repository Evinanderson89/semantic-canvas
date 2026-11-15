import { useEffect, useRef, useState } from "react";
import { readResponse } from "./http.ts";
import type { Principal } from "./Connections.tsx";
import "./claudeConnection.css";

type Setup = { available: false; reason: string } | { available: true; needsScope?: boolean; mcpCommand?: string };
type Check = { tools: number; metrics: number; checkedAt: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function ChatgptConnection({ source, label, principals }: { source: string; label: string; principals: Principal[] }) {
  const [open, setOpen] = useState(false), [principal, setPrincipal] = useState("");
  const [access, setAccess] = useState("explore"), [tunnelId, setTunnelId] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null), [error, setError] = useState("");
  const [check, setCheck] = useState<Check | null>(null), [busy, setBusy] = useState(false), [copied, setCopied] = useState("");
  const pending = useRef<AbortController | null>(null);
  const query = new URLSearchParams({ source, principal, access }).toString();
  useEffect(() => {
    pending.current?.abort(); setCheck(null); setBusy(false); setCopied(""); setError("");
    setSetup(previous => previous?.available ? { available: true, needsScope: true } : null);
    if (!open) return;
    const controller = new AbortController();
    fetch(`/api/setup/chatgpt?${query}`, { signal: controller.signal }).then(readResponse<Setup>)
      .then(value => { if (!controller.signal.aborted) setSetup(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [open, query]);
  const copy = async (text: string, name: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(`${name} copied`); }
    catch { setError("Could not copy. Select and copy the text below."); }
  };
  const test = async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setCheck(null); setError("");
    try {
      const result = await fetch(`/api/setup/chatgpt/check?${query}`, { method: "POST", signal: controller.signal }).then(readResponse<Check>);
      if (!controller.signal.aborted) setCheck(result);
    } catch (e: any) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const validTunnel = /^tunnel_[A-Za-z0-9_-]+$/.test(tunnelId.trim());
  const command = setup?.available && setup.mcpCommand && validTunnel
    ? `tunnel-client init --sample sample_mcp_stdio_local --profile semantic-canvas-chatgpt --tunnel-id ${quote(tunnelId.trim())} --mcp-command ${quote(setup.mcpCommand)}\ntunnel-client doctor --profile semantic-canvas-chatgpt --explain\ntunnel-client run --profile semantic-canvas-chatgpt` : "";
  const prompt = `Use Semantic Canvas to explore ${JSON.stringify(label)} with the connection's fixed row-access scope. Read the metric definitions, query evidence, and explain reporting periods and data-quality limitations. Propose an executive dashboard with headline metrics, trends and useful breakdowns. Do not invent metrics or causes.${access === "build" ? " Ask before saving or rearranging. Save a new dashboard with a new ID, keep existing dashboards unchanged, and give me its name to open in Canvas." : " This connection is explore-only; describe the proposed dashboard without saving."}`;
  return <section className="claude-connection chatgpt-connection" aria-label="Connect ChatGPT">
    <div className="claude-heading"><div><span className="eyebrow">ChatGPT · Secure MCP Tunnel</span>
      <h2>Explore and build dashboards from ChatGPT.</h2>
      <p>Use Canvas’s governed metrics and saved dashboards in your ChatGPT conversation.</p>
    </div><button className="primary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close ChatGPT setup" : "Connect ChatGPT"}</button></div>
    {open && <>
      {!setup && !error && <p role="status">Loading connection setup…</p>}
      {setup && !setup.available && <p>{setup.reason}</p>}
      {setup?.available && <>
        <p>This local setup uses OpenAI’s Secure MCP Tunnel. Your OpenAI organization and ChatGPT workspace need tunnel and custom MCP access. Canvas does not need an OpenAI model API key; the tunnel client needs its own runtime credential.</p>
        <h3>1. Choose what ChatGPT can access</h3>
        <p>Source: <strong>{label}</strong>. Change the active source in Canvas to connect a different one.</p>
        <div className="chatgpt-scope"><label><span>Row-access principal</span><select aria-label="ChatGPT row-access principal" value={principal} onChange={e => setPrincipal(e.target.value)}>
          <option value="">Choose a principal…</option>{principals.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label><span>Dashboard access</span><select aria-label="ChatGPT dashboard access" value={access} onChange={e => setAccess(e.target.value)}>
          <option value="explore">Explore only</option><option value="build">Explore and build saved dashboards</option>
        </select></label></div>
        <p className="claude-boundary">Everyone allowed to use this tunnel shares this selected local principal. It is not per-user company sign-in. Metric definitions, query results and saved dashboard contents can enter ChatGPT. {access === "build" ? "Build mode can create, overwrite and rearrange saved dashboards; it cannot edit your unsaved canvas." : "Explore-only mode has no save or arrange tools."}</p>
        {setup.mcpCommand && <>
          <button disabled={busy} onClick={test}>{busy ? "Checking local MCP…" : "Check ChatGPT local tools"}</button>
          {check && <p role="status">Local MCP check passed: {check.tools} tools and {check.metrics} metrics. This verifies Canvas locally; ChatGPT and the tunnel have not been checked.</p>}
          <h3>2. Set up the private tunnel</h3>
          <p>Install the supported tunnel client and create a tunnel associated with your intended ChatGPT workspace. Set its runtime credential locally as <code>CONTROL_PLANE_API_KEY</code>; never paste it into Canvas.</p>
          <p><a href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noreferrer">OpenAI tunnel settings ↗</a> · <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer">Setup and permissions guide ↗</a></p>
          <label className="chatgpt-tunnel"><span>Tunnel ID (not a secret)</span><input aria-label="OpenAI tunnel ID" value={tunnelId} onChange={e => { setTunnelId(e.target.value); setCopied(""); }} placeholder="tunnel_…" /></label>
          {tunnelId && !validTunnel && <p role="status">Enter the tunnel ID beginning with tunnel_ from OpenAI’s tunnel settings.</p>}
          {command && <><p>macOS / Linux commands. Keep Canvas and the tunnel client running. This configures the <code>semantic-canvas-chatgpt</code> profile; stop its running client before changing scope and restarting it.</p>
            <button onClick={() => copy(command, "Tunnel commands")}>Copy tunnel commands</button><details><summary>Show terminal commands</summary><pre aria-label="ChatGPT tunnel commands">{command}</pre></details></>}
          <h3>3. Add Canvas in ChatGPT</h3>
          <p>In ChatGPT Plugins, add a custom MCP server, choose Tunnel, and select this tunnel. This local MCP server has no separate OAuth login. Review its tools and access before connecting.</p>
          <p>Then ask ChatGPT to list this source’s metrics. A successful response there confirms the full connection.</p>
          <button onClick={() => copy(prompt, "ChatGPT starter prompt")}>Copy ChatGPT starter prompt</button><details><summary>Preview your first request</summary><blockquote>{prompt}</blockquote></details>
          <p>After a save, refresh Canvas and open the dashboard by name. To disconnect, stop the tunnel client and remove its ChatGPT connection.</p>
        </>}
      </>}
      {copied && <p role="status">{copied}</p>}{error && <p className="cform-err" role="alert">{error}</p>}
    </>}
  </section>;
}
