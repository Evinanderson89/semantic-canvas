import { useEffect, useRef, useState } from "react";
import { readResponse } from "./http.ts";

interface PendingQ { id: string; question: string; options?: string[] }

/**
 * The in-app half of "the agent interviews the user when it's unsure": an
 * MCP-connected agent posts a question to /api/agent/questions (see
 * src/mcp/server.ts's ask_user tool), this polls for it and shows it here,
 * and the answer posted back is what the agent's still-waiting tool call
 * (itself polling) picks up to continue. Plain polling in both directions --
 * a human answering a question is not a hot path worth a push channel for.
 */
export function AgentQuestions({ disabled = false }: { disabled?: boolean }) {
  const [q, setQ] = useState<PendingQ | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false), pollEpoch = useRef(0);
  const acknowledged = useRef(new Set<string>());
  const submission = useRef<AbortController | null>(null);

  useEffect(() => {
    if (disabled) {
      setQ(null);
      return;
    }
    let stopped = false, sequence = 0;
    const controller = new AbortController();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const poll = () => {
      if (sending.current || stopped) return;
      const epoch = pollEpoch.current, request = ++sequence;
      fetch("/api/agent/questions", { signal: controller.signal }).then(async (res) => {
        if (res.status === 403) {
          stopped = true;
          if (intervalId) clearInterval(intervalId);
          return null;
        }
        return readResponse<{ questions: PendingQ[] }>(res);
      }).then((d) => {
        if (!d || stopped || request !== sequence || epoch !== pollEpoch.current || sending.current) return;
        if (!Array.isArray(d.questions) || d.questions.some(item => !item || typeof item.id !== "string" || typeof item.question !== "string"
          || item.options !== undefined && (!Array.isArray(item.options) || item.options.some(option => typeof option !== "string")))) return;
        const next = d.questions.find(item => !acknowledged.current.has(item.id)) ?? null;
        setQ((cur) => (cur?.id === next?.id ? cur : next));
      }).catch(() => {});
    };
    poll();
    intervalId = setInterval(poll, 1500);
    return () => { stopped = true; controller.abort(); submission.current?.abort(); if (intervalId) clearInterval(intervalId); };
  }, [disabled]);

  useEffect(() => { setAnswer(""); setError(null); }, [q?.id]);

  if (!q) return null;

  const submit = async (value: string) => {
    if (!value.trim() || sending.current) return;
    const id = q.id, controller = new AbortController(); submission.current = controller;
    sending.current = true; pollEpoch.current++; setBusy(true); setError(null); setAnswer(value);
    try {
      const response = await fetch(`/api/agent/questions/${encodeURIComponent(id)}/answer`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: value }), signal: controller.signal,
      }).then(readResponse<{ ok: boolean }>);
      if (controller.signal.aborted) return;
      if (response.ok !== true) throw new Error("The server did not confirm your answer. Try again.");
      acknowledged.current.add(id);
      setQ(current => current?.id === id ? null : current);
    } catch (e: any) {
      if (!controller.signal.aborted) setError(e?.message ?? "Could not send your answer. Try again.");
    } finally {
      sending.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
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
            <textarea autoFocus rows={3} value={answer} disabled={busy} aria-label="Your answer" placeholder="Type your answer…"
                      onChange={(e) => setAnswer(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(answer); }} />
          )}
          {error && <p className="err" role="alert">{error}</p>}
        </section>
        {(!q.options?.length || error) && (
          <div className="iv-foot">
            <span className="spacer" />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => submit(answer)}>
              {busy ? "Sending…" : error ? "Retry answer" : "Send"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
