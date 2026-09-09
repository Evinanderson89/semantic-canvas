import { fingerprint } from "./document.ts";
import { readResponse } from "./http.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { CanvasProposal } from "../canvas/proposals.ts";
import { useEffect, useRef, useState } from "react";

interface Turn { role: "user" | "assistant"; text: string }

/**
 * The embedded in-app agent: the AI itself, not just a port for one. Talks
 * to /api/agent/chat (src/agent/loop.ts), which drives the same tool list
 * as the MCP server -- so a clarifying question it asks mid-task shows up
 * as the exact same AgentQuestions prompt an external MCP agent's ask_user
 * would. Only rendered once /api/agent/status confirms an ANTHROPIC_API_KEY
 * is actually configured; otherwise this port just isn't there, same as a
 * data source that never got credentials.
 */
export function AgentChat({ document, onApply }: {
  document: { spec: DashboardSpec; canvas: CanvasSpec; selected: string[] } | null;
  onApply: (proposal: CanvasProposal, expected: string) => boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ proposal: CanvasProposal; expected: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const current = document ? fingerprint(document.spec, document.canvas) : null;
  const conversationId = useRef(crypto.randomUUID());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Polled, not fetched once -- the key can be added or removed from
  // Connections while this panel is already mounted, and the toggle should
  // track that without a page reload. Same low-frequency-poll idiom as
  // AgentQuestions; this isn't a hot path either.
  useEffect(() => {
    let stopped = false;
    const poll = () => fetch("/api/agent/status").then((r) => r.json())
      .then((d) => { if (!stopped) setAvailable(Boolean(d.configured)); }).catch(() => {});
    poll();
    const id = setInterval(poll, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, busy]);

  if (!available) return null;

  const send = () => {
    const message = input.trim();
    if (!message || busy) return;
    setTurns((t) => [...t, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    setError(null); setPending(null);
    const expected = current;
    const controller = new AbortController(); request.current = controller;
    fetch("/api/agent/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: conversationId.current, message, document }), signal: controller.signal,
    }).then(readResponse).then((d) => {
      if (d.error) { setError(d.error); return; }
      if (controller.signal.aborted) return;
      if (d.proposal && expected) setPending({ proposal: d.proposal, expected });
      setTurns((t) => [...t, { role: "assistant", text: d.text || (d.proposal ? "A proposal is ready to review." : "No changes proposed.") }]);
    }).catch((e) => { if (e.name !== "AbortError") setError(String(e?.message ?? e)); })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button className="agent-chat-toggle" onClick={() => setOpen((v) => !v)}
              title="Ask the agent to build or curate a dashboard" aria-label="Open agent chat">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M10 2v16M10 6l5-2M10 12l-5 2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="agent-chat-panel">
          <header>
            <span>Canvas assistant</span>
            <button className="icon" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </header>
          <div className="agent-chat-log" ref={scrollRef}>
            {turns.length === 0 && !busy && (
              <p className="agent-chat-empty">Ask for a clearer story, a different chart, or a better layout. The assistant sees your current unsaved canvas. You review changes before applying them.</p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`agent-chat-msg ${t.role}`}>{t.text}</div>
            ))}
            {busy && <div className="agent-chat-msg assistant agent-chat-thinking">…</div>}
            {pending && <div className="canvas-proposal">
              <div className="eyebrow">PROPOSED CHANGES</div><h3>{pending.proposal.title}</h3><p>{pending.proposal.reason}</p>
              <ol>{pending.proposal.actions.map((action, i) => <li key={i}>{describeAction(action, document?.spec)}</li>)}</ol>
              {pending.expected !== current ? <p role="status">Your document changed. Ask for a fresh proposal to keep your latest edits.</p> : <p>Applies to your current canvas. One undo restores the previous version.</p>}
              <div className="story-actions"><button className="primary" disabled={pending.expected !== current} onClick={() => { if (onApply(pending.proposal, pending.expected)) setPending(null); }}>Apply changes</button><button onClick={() => setPending(null)}>Dismiss</button></div>
            </div>}
            {error && <div className="agent-chat-msg error">{error}</div>}
          </div>
          <div className="agent-chat-input">
            <textarea rows={2} value={input} placeholder="Message the agent…" disabled={busy}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            {busy ? <button onClick={() => request.current?.abort()}>Stop</button> : <button className="primary" disabled={!input.trim()} onClick={send}>Send</button>}
          </div>
        </div>
      )}
    </>
  );
}

function describeAction(action: CanvasProposal["actions"][number], document?: DashboardSpec) {
  const label = (id: string) => { const tile = document?.tiles.find(t => t.id === id); return tile?.title ?? tile?.text ?? tile?.metrics.join(", ") ?? id; };
  switch (action.type) {
    case "rename": return `Dashboard title: ${action.title}`;
    case "title": return `Rename “${label(action.id)}” to “${action.title}”`;
    case "note": return `Text in “${label(action.id)}”: ${action.text}`;
    case "chart": return `Show “${label(action.id)}” as ${action.chart}`;
    case "arrange": return `Arrange sections using ${action.layout === "exec-summary" ? "headline rows" : "a clean grid"}; keep pinned positions`;
    case "add": return `Add ${action.tile.title ?? action.tile.text ?? action.tile.metrics.join(", ")} (${action.tile.kind ?? action.tile.chart ?? "chart"})`;
    case "remove": return `Remove “${label(action.id)}”`;
  }
}
