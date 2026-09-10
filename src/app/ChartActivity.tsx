import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import type { ActivitySummary, AlertInput, AlertRule, CommentThread, Evaluation } from "../activity/model.ts";
import { makeFormatter, resolveFormat } from "../format/format.ts";
import { readResponse } from "./http.ts";
import { useSession } from "./Session.tsx";
import type { ChartPreferences } from "./ChartPreferences.tsx";

type Panel = "comments" | "alerts";
const Context = createContext<{ summary: ActivitySummary; preferences: ChartPreferences; open: (tileId: string, panel: Panel) => void } | null>(null);
export function ActivityIcon({ kind }: { kind: Panel }) {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {kind === "comments" ? <path d="M16.5 9.5a6.5 6.5 0 0 1-6.5 6.5H3.5l1.1-3A6.5 6.5 0 1 1 16.5 9.5Z" strokeLinejoin="round" />
      : <><path d="M4 13.5h12l-1.6-2.3V8a4.4 4.4 0 0 0-8.8 0v3.2L4 13.5Z" strokeLinejoin="round" /><path d="M8 16a2.1 2.1 0 0 0 4 0M10 2v1.5" strokeLinecap="round" /></>}
  </svg>;
}
export function ChartActivityButtons({ tileId }: { tileId: string }) {
  const ctx = useContext(Context); if (!ctx || !ctx.preferences.comments && !ctx.preferences.alerts) return null;
  const info = ctx.summary[tileId];
  return <span className="chart-activity-buttons" onPointerDown={e => e.stopPropagation()}>
    {ctx.preferences.comments && <button type="button" className={info?.comments ? "has-activity" : ""} title="Chart comments" aria-label={`Chart comments${info?.comments ? `, ${info.comments} open` : ""}`} onClick={() => ctx.open(tileId, "comments")}>
      <ActivityIcon kind="comments" />{Boolean(info?.comments) && <span className="activity-count">{info.comments > 9 ? "9+" : info.comments}</span>}
    </button>}
    {ctx.preferences.alerts && <button type="button" className={info?.alert?.unread ? "has-alert" : info?.alert?.enabled ? "is-watching" : ""} title="Chart alerts" aria-label={`Chart alerts${info?.alert?.unread ? `, ${info.alert.unread} unread` : info?.alert?.enabled ? ", watching" : ""}`} onClick={() => ctx.open(tileId, "alerts")}>
      <ActivityIcon kind="alerts" />{Boolean(info?.alert?.unread) && <span className="activity-dot" />}
    </button>}
  </span>;
}
export function ChartActivityProvider({ dashboardId, document: book, revision, dirty, onSave, model, children, preferences }: {
  dashboardId: string | null; document: DashboardSpec; revision: number; dirty: boolean;
  onSave: () => Promise<void>; model: Model; children: ReactNode; preferences: ChartPreferences;
}) {
  const [summary, setSummary] = useState<ActivitySummary>({});
  const [selection, setSelection] = useState<{ tileId: string; panel: Panel } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const enabled = preferences.comments || preferences.alerts;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!dashboardId || !enabled) return;
    const data = await fetch(`/api/chart-activity/${encodeURIComponent(dashboardId)}`, { signal }).then(readResponse);
    if (!signal?.aborted) setSummary(data.summary);
  }, [dashboardId, enabled]);
  useEffect(() => {
    const ac = new AbortController(); setSummary({});
    if (!enabled) return;
    const run = () => { if (!document.hidden) void refresh(ac.signal).catch(() => {}); };
    run(); const timer = setInterval(run, 30_000); document.addEventListener("visibilitychange", run);
    return () => { ac.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", run); };
  }, [refresh, revision, enabled]);
  const tile = book.tiles.find(t => t.id === selection?.tileId);
  const close = useCallback(() => { const button = trigger.current; setSelection(null); requestAnimationFrame(() => {
    if (button?.isConnected) button.focus(); else document.querySelector<HTMLButtonElement>(".workspace-settings")?.focus();
  }); }, []);
  return <Context.Provider value={{ summary, preferences, open: (tileId, panel) => { if (!preferences[panel]) return; trigger.current = document.activeElement as HTMLElement; setSelection({ tileId, panel }); } }}>
    {children}
    {selection && tile && createPortal(<ActivityDrawer key={tile.id} preferences={preferences} tile={tile} model={model} dashboardId={dashboardId} revision={revision} dirty={dirty} onSave={onSave}
      initialPanel={selection.panel} close={close} refreshSummary={() => refresh().catch(() => {})} />, document.body)}
  </Context.Provider>;
}
const dateLabel = (date: string) => new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function ActivityDrawer({ tile, model, dashboardId, revision, dirty, onSave, initialPanel, close, refreshSummary, preferences }: {
  tile: TileSpec; model: Model; dashboardId: string | null; revision: number; dirty: boolean; onSave: () => Promise<void>;
  initialPanel: Panel; close: () => void; refreshSummary: () => Promise<void>; preferences: ChartPreferences;
}) {
  const session = useSession(), dialog = useRef<HTMLDialogElement>(null);
  const [panel, setPanel] = useState(initialPanel), [threads, setThreads] = useState<CommentThread[]>([]);
  useEffect(() => { if (!preferences[panel]) close(); }, [preferences, panel, close]);
  const [alert, setAlert] = useState<AlertRule | null>(null), [ownerId, setOwnerId] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [body, setBody] = useState(""), [replyTo, setReplyTo] = useState<string | null>(null), [reply, setReply] = useState("");
  const [showResolved, setShowResolved] = useState(false), [editing, setEditing] = useState(false);
  const [metric, setMetric] = useState(tile.metrics[0]), [mode, setMode] = useState<AlertInput["mode"]>(tile.dimensions.some(d => d.includes(":")) ? "anomaly" : "threshold");
  const [operator, setOperator] = useState<AlertInput["operator"]>("above"), [threshold, setThreshold] = useState("");
  const [sensitivity, setSensitivity] = useState<AlertInput["sensitivity"]>("balanced"), [direction, setDirection] = useState<AlertInput["direction"]>("both");
  const [interval, setIntervalMinutes] = useState<15 | 60 | 1440>(60), [preview, setPreview] = useState<Evaluation | null>(null);
  const title = tile.title ?? tile.metrics.map(m => model.metrics[m]?.label ?? m).join(", ");
  const url = dashboardId ? `/api/chart-activity/${encodeURIComponent(dashboardId)}/${encodeURIComponent(tile.id)}` : "";
  const fmt = resolveFormat(model, { ...tile, metrics: [metric] }), format = makeFormatter(fmt), percent = fmt.number === "percent";
  const blocked = !dashboardId || dirty;
  const supported = tile.dimensions.length === 0 || tile.dimensions.length === 1 && tile.dimensions[0].includes(":");
  useEffect(() => { const d = dialog.current!; d.showModal(); return () => d.close(); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!url) return;
    const data = await fetch(url, { signal }).then(readResponse);
    if (signal?.aborted) return;
    setThreads(data.threads); setAlert(data.alert); setOwnerId(data.ownerId);
  }, [url]);
  useEffect(() => {
    const ac = new AbortController(); setLoading(Boolean(url));
    void load(ac.signal).catch(e => { if (!ac.signal.aborted) setError(e.message); }).finally(() => { if (!ac.signal.aborted) setLoading(false); });
    const timer = setInterval(() => { if (!document.hidden) void load(ac.signal).catch(() => {}); }, 15_000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [load, revision]);
  useEffect(() => { setPreview(null); }, [metric, mode, operator, threshold, sensitivity, direction, interval, revision]);
  const action = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError("");
    try { await fn(); await load(); await refreshSummary(); } catch (e: any) { setError(e.message ?? "Could not save. Try again."); }
    finally { setBusy(false); }
  };
  const request = (path: string, method: string, data?: unknown) => fetch(url + path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) }).then(readResponse);
  const rule = (): AlertInput => ({ metric, mode, operator, ...(mode === "threshold" ? { threshold: Number(threshold) / (percent ? 100 : 1) } : {}), sensitivity, direction, intervalMinutes: interval });
  const invalid = mode === "threshold" && (!threshold.trim() || !Number.isFinite(Number(threshold)));
  const edit = () => {
    if (!alert) return;
    setMetric(alert.metric); setMode(alert.mode); setOperator(alert.operator);
    const isPercent = resolveFormat(model, { ...tile, metrics: [alert.metric] }).number === "percent";
    setThreshold(alert.threshold === undefined ? "" : String(alert.threshold * (isPercent ? 100 : 1)));
    setSensitivity(alert.sensitivity); setDirection(alert.direction); setIntervalMinutes(alert.intervalMinutes); setEditing(true); setPreview(null);
  };
  const shown = threads.filter(t => showResolved || !t.resolved);
  const alertFormat = makeFormatter(resolveFormat(model, { ...tile, metrics: [alert?.metric ?? metric] }));
  return <dialog className="activity-drawer" ref={dialog} aria-labelledby="activity-heading" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (e.clientX < r.left) close(); } }}>
    <div className="activity-shell">
      <header className="activity-header"><div><span className="activity-eyebrow">On this chart</span><h2 id="activity-heading">{title}</h2></div><button className="activity-close" aria-label="Close chart activity" onClick={close}>×</button></header>
      <div className="activity-tabs" role="tablist" aria-label="Chart activity" onKeyDown={e => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault(); const panels = (["comments", "alerts"] as const).filter(p => preferences[p]);
        const next = e.key === "Home" ? panels[0] : e.key === "End" ? panels[panels.length - 1] : panels[(panels.indexOf(panel) + 1) % panels.length];
        if (!next) return;
        setPanel(next); dialog.current?.querySelector<HTMLButtonElement>(next === "comments" ? "#discussion-tab" : "#alerts-tab")?.focus();
      }}>
        {preferences.comments && <button role="tab" tabIndex={panel === "comments" ? 0 : -1} aria-selected={panel === "comments"} aria-controls="chart-discussion" id="discussion-tab" onClick={() => setPanel("comments")}><ActivityIcon kind="comments" />Comments <span>{threads.filter(t => !t.resolved).length || ""}</span></button>}
        {preferences.alerts && <button role="tab" tabIndex={panel === "alerts" ? 0 : -1} aria-selected={panel === "alerts"} aria-controls="chart-alerts" id="alerts-tab" onClick={() => setPanel("alerts")}><ActivityIcon kind="alerts" />Alerts {alert?.enabled && <i />}</button>}
      </div>
      <div className="activity-content">
        {error && <div className="activity-error" role="alert">{error}<button onClick={() => { setError(""); void action(() => load()); }}>Retry</button></div>}
        {blocked && <div className="activity-save-note"><strong>{dashboardId ? "Save your latest changes" : "Give this chart a home"}</strong><p>Comments and alerts stay with the saved dashboard.</p>{session.canEdit && <button className="save-button" disabled={busy} onClick={() => void action(onSave)}>{busy ? "Saving…" : "Save dashboard"}</button>}</div>}
        {loading && <p role="status" className="activity-muted">Loading chart activity…</p>}
        {panel === "comments" && <section role="tabpanel" id="chart-discussion" aria-labelledby="discussion-tab">
          <div className="activity-section-intro"><h3>Keep the context close.</h3><p>Ask a question, share an observation, or leave the next person a little context.</p></div>
          {threads.some(t => t.resolved) && <label className="activity-resolved-filter"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />Show resolved conversations</label>}
          {!loading && !shown.length && <div className="activity-empty"><ActivityIcon kind="comments" /><h4>{threads.length ? "All caught up." : "Start the conversation."}</h4><p>{threads.length ? "Every conversation on this chart is resolved." : "What should someone know when they look at this chart?"}</p></div>}
          {shown.map(thread => <article className={`activity-thread${thread.resolved ? " resolved" : ""}`} key={thread.id}>
            <div className="activity-author"><span className="activity-avatar">{thread.authorName.slice(0, 1).toUpperCase()}</span><div><strong>{thread.authorId === ownerId ? "You" : thread.authorName}</strong><time dateTime={thread.createdAt}>{dateLabel(thread.createdAt)}</time></div>
              {(thread.authorId === ownerId || session.canEdit) && <button className="activity-text-button" disabled={busy || blocked} onClick={() => void action(() => request(`/comments/${thread.id}`, "PATCH", { resolved: !thread.resolved }))}>{thread.resolved ? "Reopen" : "Resolve"}</button>}
            </div><p className="activity-message">{thread.body}</p>
            {thread.resolved && <span className="activity-resolved-label">✓ Resolved</span>}
            {thread.replies.map(r => <div className="activity-reply" key={r.id}><div className="activity-reply-meta"><strong>{r.authorId === ownerId ? "You" : r.authorName}</strong><time dateTime={r.createdAt}>{dateLabel(r.createdAt)}</time></div><p className="activity-message">{r.body}</p></div>)}
            {!thread.resolved && (replyTo === thread.id ? <form className="activity-reply-form" onSubmit={e => { e.preventDefault(); void action(async () => { await request(`/comments/${thread.id}/replies`, "POST", { body: reply }); setReply(""); setReplyTo(null); }); }}>
              <textarea autoFocus aria-label="Write a reply" placeholder="Add a little context…" maxLength={4000} value={reply} onChange={e => setReply(e.target.value)} disabled={busy || blocked} />
              <div className="activity-form-actions"><button type="button" className="activity-text-button" onClick={() => { setReplyTo(null); setReply(""); }}>Cancel</button><button className="save-button" disabled={busy || blocked || !reply.trim()}>Reply</button></div>
            </form> : <button className="activity-text-button reply-link" disabled={blocked} onClick={() => { setReplyTo(thread.id); setReply(""); }}>Reply to conversation</button>)}
          </article>)}
          <p className="activity-footnote">Visible to people with the same source and data-access scope. Names come from company sign-in.</p>
        </section>}
        {panel === "alerts" && <section role="tabpanel" id="chart-alerts" aria-labelledby="alerts-tab">
          <div className="activity-section-intro"><h3>A quiet eye on what matters.</h3><p>Watch a threshold or an unusual change. We’ll leave an update on this chart when it needs your attention.</p></div>
          {!supported && <div className="activity-save-note"><strong>This chart needs a single series</strong><p>Remove the category breakdown, or use a total, to watch a metric without mixing different groups.</p></div>}
          {alert && !editing ? <>
            <div className="watch-heading"><span className={`watch-status${alert.enabled ? " enabled" : ""}`}><i />{alert.enabled ? "Watching for you" : "Paused"}</span><button className="activity-text-button" disabled={busy || blocked} onClick={edit}>Edit alert</button></div>
            <h4 className="watch-rule-name">{model.metrics[alert.metric]?.label ?? alert.metric}</h4>
            <p className="activity-muted">{alert.mode === "anomaly" ? `Unusual changes · ${alert.sensitivity} sensitivity` : `${alert.operator === "above" ? "Above" : "Below"} ${alertFormat(alert.threshold!)}`} · {alert.intervalMinutes === 1440 ? "Daily" : alert.intervalMinutes === 60 ? "Hourly" : "Every 15 minutes"}</p>
            {alert.evaluation ? <EvaluationCard evaluation={alert.evaluation} format={alertFormat} /> : <div className="activity-empty compact"><ActivityIcon kind="alerts" /><p>Ready for its first check.</p></div>}
            <div className="watch-actions"><button disabled={busy || blocked || !alert.enabled} onClick={() => void action(() => request("/alerts/check", "POST"))}>{busy ? "Working…" : "Check now"}</button><button disabled={busy || blocked} onClick={() => void action(() => request("/alert", "PATCH", { version: alert.version, enabled: !alert.enabled }))}>{alert.enabled ? "Pause" : "Resume"}</button><button className="activity-text-button" disabled={busy || blocked} onClick={() => void action(() => request("/alert", "DELETE", { version: alert.version }))}>Remove</button></div>
            <div className="watch-history-heading"><h4>Recent updates</h4>{alert.events.some(e => !e.read) && <button className="activity-text-button" disabled={busy} onClick={() => void action(() => request("/alert", "PATCH", { version: alert.version, read: true }))}>Mark all read</button>}</div>
            {!alert.events.length && <p className="activity-muted">No alerts yet. Repeated checks of the same ongoing condition stay quiet.</p>}
            {alert.events.map(event => <article className={`watch-event${event.read ? "" : " unread"}`} key={event.id}><div><strong>{event.value === undefined ? "Unusual change" : alertFormat(event.value)}</strong><time>{dateLabel(event.checkedAt)}</time></div><p>{event.reason}</p><span>{event.period}</span></article>)}
          </> : <form className="watch-form" onSubmit={e => { e.preventDefault(); void action(async () => { await request("/alert", "PUT", { rule: rule(), revision, version: alert?.version ?? 0 }); setEditing(false); setPreview(null); if (alert?.enabled !== false) await request("/alerts/check", "POST"); }); }}>
            <fieldset disabled={busy || blocked || !supported}>
              <label>Metric<select value={metric} onChange={e => { setMetric(e.target.value); setThreshold(""); }}>{tile.metrics.map(m => <option key={m} value={m}>{model.metrics[m]?.label ?? m}</option>)}</select></label>
              <div className="watch-type-options" role="group" aria-label="Alert type">
                <button type="button" aria-pressed={mode === "anomaly"} disabled={!tile.dimensions.some(d => d.includes(":"))} onClick={() => setMode("anomaly")}><span>Unusual change</span><small>Learn the recent pattern</small></button>
                <button type="button" aria-pressed={mode === "threshold"} onClick={() => setMode("threshold")}><span>Threshold</span><small>Choose a clear boundary</small></button>
              </div>
              {mode === "threshold" ? <div className="watch-field-pair"><label>When the value is<select value={operator} onChange={e => setOperator(e.target.value as typeof operator)}><option value="above">Above</option><option value="below">Below</option></select></label><label>{percent ? "Threshold (%)" : "Threshold (metric units)"}<input type="number" step="any" value={threshold} required onChange={e => setThreshold(e.target.value)} placeholder={percent ? "e.g. 100" : "Enter a value"} /></label></div>
                : <><label>Sensitivity<select value={sensitivity} onChange={e => setSensitivity(e.target.value as typeof sensitivity)}><option value="sensitive">Sensitive · smaller changes</option><option value="balanced">Balanced · meaningful changes</option><option value="conservative">Conservative · larger changes</option></select></label><label>Watch for<select value={direction} onChange={e => setDirection(e.target.value as typeof direction)}><option value="both">Spikes and drops</option><option value="above">Spikes only</option><option value="below">Drops only</option></select></label></>}
              <label>Check frequency<select value={interval} onChange={e => setIntervalMinutes(Number(e.target.value) as typeof interval)}><option value={15}>Every 15 minutes</option><option value={60}>Every hour</option><option value={1440}>Once a day</option></select></label>
              <div className="watch-delivery"><ActivityIcon kind="alerts" /><div><strong>Notify me here</strong><p>A dot on the bell, with the details saved on this chart. Only you see your alerts.</p></div></div>
              {preview && <EvaluationCard evaluation={preview} format={format} preview />}
              <div className="activity-form-actions"><button type="button" disabled={invalid} onClick={() => void action(async () => { const data = await request("/alerts/preview", "POST", { rule: rule(), revision }); setPreview(data.evaluation); })}>Preview check</button><button className="save-button" disabled={invalid}>{busy ? "Working…" : alert ? "Update alert" : "Create alert"}</button></div>
            </fieldset>{editing && <button type="button" className="activity-text-button" onClick={() => setEditing(false)}>Cancel editing</button>}
          </form>}
          <details className="watch-details"><summary>How checks work</summary><p>Uses the saved chart, saved filter defaults, and your data permissions. Live filtering and drilling don’t change your watch.</p><p>Time-series checks exclude the current calendar period in UTC and wait for the most recently closed period. Missing values and gaps never count as zero. Source completeness is not verified.</p><p>Anomaly checks need at least 14 closed periods. They use a robust range around recent changes, with weekday matching for daily series once four weeks of history are available. This is a signal to investigate, not proof of a business problem.</p><p>The server must be running. In company workspaces, checks pause when your sign-in expires.</p></details>
        </section>}
      </div>
      {panel === "comments" && <form className="activity-composer" onSubmit={e => { e.preventDefault(); void action(async () => { await request("/comments", "POST", { body }); setBody(""); }); }}><label htmlFor="chart-comment">Add to the conversation</label><textarea id="chart-comment" placeholder="What’s the story behind this number?" rows={3} maxLength={4000} value={body} onChange={e => setBody(e.target.value)} disabled={busy || blocked} /><div><span>{body.length ? `${body.length} / 4,000` : "A little context goes a long way."}</span><button className="save-button" disabled={busy || blocked || !body.trim()}>{busy ? "Posting…" : "Post comment"}</button></div></form>}
    </div>
  </dialog>;
}
function EvaluationCard({ evaluation: e, format, preview }: { evaluation: Evaluation; format: (n: number) => string; preview?: boolean }) {
  const titles = { normal: "Looking steady", triggered: "Worth a closer look", waiting: "Waiting for data", error: "Check needs attention", needs_review: "Review your watch" };
  const low = Math.min(e.lower ?? 0, e.value ?? 0), high = Math.max(e.upper ?? 1, e.value ?? 1), span = Math.max(high - low, 1e-9);
  const x = (v: number) => 16 + (v - low) / span * 268;
  return <div className={`watch-evaluation ${e.state}`} role="status"><span className="activity-eyebrow">{preview ? "Preview · nothing sent" : "Latest check"}</span><h4>{titles[e.state]}</h4><p>{e.reason}</p>
    {e.value !== undefined && <div className="watch-value">{format(e.value)}<span>{e.period === "Current total" ? e.period : `Period ${e.period}`}</span></div>}
    {e.lower !== undefined && e.upper !== undefined && e.value !== undefined && <><svg className="watch-range" viewBox="0 0 300 34" role="img" aria-label={`Expected range ${format(e.lower)} to ${format(e.upper)}; observed ${format(e.value)}`}><path d="M16 17H284" stroke="var(--line)" /><rect x={x(e.lower)} y="9" width={Math.max(2, x(e.upper) - x(e.lower))} height="16" rx="8" fill="var(--accent)" opacity=".15" /><circle cx={x(e.value)} cy="17" r="5" fill={e.state === "triggered" ? "var(--neg)" : "var(--accent)"} /></svg><div className="watch-range-label"><span>Expected range</span><b>{format(e.lower)} – {format(e.upper)}</b></div><small>{e.baselinePoints} prior periods · {e.seasonal ? "weekday-aware" : "trend-aware"} baseline</small></>}
    <time dateTime={e.checkedAt}>Checked {dateLabel(e.checkedAt)}</time>
  </div>;
}
