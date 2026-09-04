import { useEffect, useState } from "react";

interface PendingQ { id: string; question: string; options?: string[] }

/**
 * The in-app half of "the agent interviews the user when it's unsure": an
 * MCP-connected agent posts a question to /api/agent/questions (see
 * src/mcp/server.ts's ask_user tool), this polls for it and shows it here,
 * and the answer posted back is what the agent's still-waiting tool call
 * (itself polling) picks up to continue. Plain polling in both directions --
 * a human answering a question is not a hot path worth a push channel for.
 */
export function AgentQuestions() {
  const [q, setQ] = useState<PendingQ | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stopped = false;
    const poll = () => {
      fetch("/api/agent/questions").then((r) => r.json()).then((d) => {
        if (stopped) return;
        const next: PendingQ | null = (d.questions ?? [])[0] ?? null;
        setQ((cur) => (cur?.id === next?.id ? cur : next));
      }).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  useEffect(() => { setAnswer(""); }, [q?.id]);

  if (!q) return null;

  const submit = (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    fetch(`/api/agent/questions/${q.id}/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: value }),
    }).then(() => { setQ(null); setBusy(false); }).catch(() => setBusy(false));
  };

  return (
    <div className="iv-scrim">
      <div className="iv agent-ask">
        <div className="iv-head">
          <span className="iv-step">Your agent is asking</span>
        </div>
        <section>
          <h2>{q.question}</h2>
          {q.options?.length ? (
            <div className="pop static">
              {q.options.map((o) => (
                <button key={o} className="pop-item" disabled={busy} onClick={() => submit(o)}>
                  <b>{o}</b>
                </button>
              ))}
            </div>
          ) : (
            <textarea autoFocus rows={3} value={answer} placeholder="Type your answer…"
                      onChange={(e) => setAnswer(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(answer); }} />
          )}
        </section>
        {!q.options?.length && (
          <div className="iv-foot">
            <span className="spacer" />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => submit(answer)}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
