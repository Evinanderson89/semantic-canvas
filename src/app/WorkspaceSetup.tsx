import { useEffect, useState } from "react";
import { readResponse } from "./http.ts";

interface Setup { mode: string; checks: Record<string, boolean>; sessionSeconds: number }
interface Operations { ready: boolean; uptimeSeconds: number; counters: { requests: number; failures: number; queries: number; queryFailures: number } }
const steps = [
  ["sources", "Connect a source", "Add a source below. We’ll test the connection before saving."],
  ["catalogue", "Bring your metrics", "Choose your semantic model and check its metrics in the registry."],
  ["signIn", "Invite your company", "An administrator configures company sign-in and group access on the server."],
  ["monitoring", "Connect monitoring", "Send logs and request traces to your company’s OpenTelemetry collector."],
  ["ai", "Enable the assistant", "Optional. Add an AI provider below for story review and reference imports."],
];
export function WorkspaceSetup({ refreshKey }: { refreshKey: unknown }) {
  const [setup, setSetup] = useState<Setup | null>(null), [ops, setOps] = useState<Operations | null>(null);
  const [expanded, setExpanded] = useState(false), [error, setError] = useState("");
  const refresh = () => Promise.all([fetch("/api/setup").then(readResponse), fetch("/api/operations/status").then(readResponse)])
    .then(([s, o]) => { setSetup(s); setOps(o); setError(""); }).catch(() => setError("Workspace status is unavailable. Try refreshing."));
  useEffect(() => { refresh(); }, [refreshKey]);
  const backup = async () => {
    try {
      const response = await fetch("/api/operations/backup"); if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
      link.href = url; link.download = `semantic-canvas-library-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError("The backup could not be downloaded. Try again."); }
  };
  return <section className="workspace-setup" aria-label="Workspace setup">
    <div className="setup-heading"><div><span className="eyebrow">Workspace</span><h2>{setup?.mode === "team" ? "Your team, connected." : "From first look to your team’s workspace."}</h2>
      <p>{setup?.mode === "team" ? "Company sign-in and server permissions are active." : "Start with the sample data, then connect the tools your company uses."}</p></div>
      <button className="link" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); if (!expanded) refresh(); }}>{expanded ? "Close setup" : "Review setup"}</button>
    </div>
    {expanded && <>
      <ol className="setup-steps">{steps.map(([key, title, detail]) => <li key={key}><span className={"setup-check" + (setup?.checks[key] ? " complete" : "")}>{setup?.checks[key] ? "✓" : "○"}</span><div><b>{title}</b><p>{detail}</p></div><span>{setup?.checks[key] ? key === "monitoring" ? "Configured" : "Ready" : key === "ai" ? "Optional" : "To do"}</span></li>)}</ol>
      {ops && <div className="workspace-health"><b>{ops.ready ? "Service is running" : "Service is starting"}</b><span>{ops.counters.requests} requests · {ops.counters.failures} server errors · {ops.counters.queries} queries since restart</span></div>}
      <div className="setup-actions"><button onClick={backup}>Download dashboard library</button><button className="link" onClick={refresh}>Refresh status</button><a href="/api/setup/guide" target="_blank" rel="noreferrer">Installation guide ↗</a></div>
      <p className="setup-note">The library backup includes dashboards across all sources. Keep server configuration, credentials, and warehouse backups separately. Monitoring shows configuration; verify delivery in your logging tool.</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
