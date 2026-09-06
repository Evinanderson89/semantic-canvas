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
export function AgentChat() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    fetch("/api/agent/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: conversationId.current, message }),
    }).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setTurns((t) => [...t, { role: "assistant", text: d.text || "(no response)" }]);
    }).catch((e) => setError(String(e?.message ?? e)))
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
            <span>Agent</span>
            <button className="icon" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </header>
          <div className="agent-chat-log" ref={scrollRef}>
            {turns.length === 0 && !busy && (
              <p className="agent-chat-empty">Ask it to explore the model, propose a dashboard, or curate what's on the canvas.</p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`agent-chat-msg ${t.role}`}>{t.text}</div>
            ))}
            {busy && <div className="agent-chat-msg assistant agent-chat-thinking">…</div>}
            {error && <div className="agent-chat-msg error">{error}</div>}
          </div>
          <div className="agent-chat-input">
            <textarea rows={2} value={input} placeholder="Message the agent…" disabled={busy}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="primary" disabled={busy || !input.trim()} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
