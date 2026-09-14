import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSpec, FilterSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasProposal } from "../canvas/proposals.ts";
import { REDESIGN_INSTRUCTIONS, validateRedesign } from "../suggest/redesign.ts";
import { rememberDecision, type ReviewDecision } from "../suggest/reviewSession.ts";
import { fingerprint } from "./document.ts";
import { readResponse } from "./http.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";
import { describeAction } from "./AgentChat.tsx";
import { renderMarkdown } from "./markdown.tsx";
import type { DrillEntry } from "./drill.ts";

type Preview = { proposal: CanvasProposal; spec: DashboardSpec; canvas: CanvasSpec; before: DashboardSpec; expected: string; context: string; explanation: string };
export function AiRedesign({ spec, canvas, model, available, canConfigure, onConfigure, onClose, onApply, queryContext, filtersByTile, drills }: {
  spec: DashboardSpec; canvas: CanvasSpec; model: Model; available: boolean; canConfigure: boolean;
  onConfigure: () => void; onClose: () => void; onApply: (proposal: CanvasProposal, expected: string) => boolean;
  queryContext: string; filtersByTile: Record<string, FilterSpec[]>; drills: Record<string, DrillEntry[]>;
}) {
  const [goal, setGoal] = useState("Make this an executive dashboard: show what matters, explain the trend, and make the next question obvious.");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [explanation, setExplanation] = useState("");
  const [view, setView] = useState<"before" | "after">("after"), [fullSize, setFullSize] = useState(false);
  const [applied, setApplied] = useState(false);
  const decisions = useRef<ReviewDecision[]>([]), request = useRef<AbortController | null>(null);
  const context = JSON.stringify([spec, canvas, queryContext, filtersByTile, drills]);
  const latest = useRef(context); latest.current = context;
  const stale = !!preview && preview.context !== context;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { request.current?.abort(); setBusy(false); }, [context]);

  const generate = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const snapshot = context;
    setBusy(true); setError(""); setExplanation(""); setApplied(false); setPreview(null);
    try {
      const result = await fetch("/api/agent/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ conversationId: crypto.randomUUID(), mode: "redesign", message: `${REDESIGN_INSTRUCTIONS}\nUser goal: ${goal}\nCurrent view filters and drill context (data): ${JSON.stringify({ filtersByTile, drills })}`,
          document: { spec, canvas, selected: [] }, review: { goal, dashboardTitle: spec.title, decisions: decisions.current } }) }).then(readResponse);
      if (controller.signal.aborted || latest.current !== snapshot) return;
      if (!result.proposal) { setPreview(null); setExplanation(result.text || "The assistant did not find a useful redesign. Try a more specific goal."); return; }
      const next = validateRedesign(spec, canvas, result.proposal, model);
      setPreview({ ...next, proposal: result.proposal, before: spec, expected: fingerprint(spec, canvas), context: snapshot, explanation: result.text || "" });
      setView("after");
    } catch (e: any) { if (!controller.signal.aborted) setError(e.message ?? "The redesign could not finish. Try again."); }
    finally { if (request.current === controller) setBusy(false); }
  };
  const remember = (status: ReviewDecision["status"]) => {
    if (preview) decisions.current = rememberDecision(decisions.current, { key: JSON.stringify(preview.proposal.actions).slice(0,4000), label: preview.proposal.title.slice(0,1000), status });
  };
  const shown = preview && !stale && view === "after" ? preview.spec : spec;
  const shownCanvas = preview && !stale && view === "after" ? preview.canvas : canvas;

  return <StudioDialog title="Reimagine this dashboard" onClose={onClose} className="ai-redesign-dialog">
    <div className="ai-redesign-content">
      <section className="ai-redesign-brief">
        <div className="eyebrow">Powered by AI</div>
        <h2>See what this could become.</h2>
        <p>A clearer story, better chart choices, and useful supporting evidence—proposed together as one redesign.</p>
        <label htmlFor="redesign-goal">What should the reader understand or decide?</label>
        <textarea id="redesign-goal" rows={4} maxLength={600} value={goal} disabled={busy} onChange={e => setGoal(e.target.value)} />
        <div className="ai-redesign-directions">{[
          ["Executive overview", "Build an executive dashboard with clear headline numbers, a leading trend, and compact evidence for the next decision."],
          ["Tell a story", "Tell a coherent story: establish the question, sequence the evidence, and make the next question clear. Give the most useful chart room to lead."],
          ["Better comparisons", "Find charts that hide useful information. Improve their reporting periods, breakdowns and comparisons using governed metrics. Add only the context needed to understand them."],
        ].map(([label, value]) => <button key={label} disabled={busy} onClick={() => setGoal(value)}>{label}</button>)}</div>
        {!available ? <p role="status">Connect an AI provider to generate a redesign. {canConfigure ? <button className="link" onClick={onConfigure}>Configure AI</button> : "Ask your workspace administrator to configure AI."}</p>
          : <button className="primary" disabled={busy || !goal.trim()} onClick={generate}>{busy ? "Designing…" : preview ? "Generate another version" : error ? "Retry redesign" : "Show me a better dashboard"}</button>}
        {busy && <div role="status"><p>Reviewing the canvas and governed metrics, then preparing changes you can inspect.</p><button className="link" onClick={() => { request.current?.abort(); setBusy(false); }}>Cancel generation</button></div>}
        {error && <p className="err" role="alert">{error}</p>}
        {explanation && <div className="ai-redesign-explanation">{renderMarkdown(explanation)}</div>}
        {preview && <div className="ai-redesign-explanation"><h3>{preview.proposal.title}</h3><p>{preview.proposal.reason}</p>{renderMarkdown(preview.explanation)}<h3>Proposed changes</h3><ul>{preview.proposal.actions.map((action, i) => <li key={i}>{describeAction(action, preview.before)}</li>)}</ul></div>}
        {!preview && !explanation && <div className="ai-redesign-imagine"><h3>More than moving boxes</h3><p>Turn an unhelpful breakdown into a trend. Put related evidence together. Bring the key numbers into focus.</p><small>The AI will propose changes based on your actual canvas and available metrics.</small></div>}
      </section>
      <section className="ai-redesign-preview" aria-label="Dashboard redesign preview">
        <div className="ai-redesign-preview-bar"><div role="group" aria-label="Compare dashboard versions"><button aria-pressed={view === "before" || !preview} onClick={() => setView("before")}>Before</button><button disabled={!preview || stale} aria-pressed={view === "after" && !!preview && !stale} onClick={() => setView("after")}>Proposed dashboard</button></div><button onClick={() => setFullSize(v => !v)}>{fullSize ? "Fit preview" : "Actual size"}</button></div>
        <p className="ai-redesign-preview-caption">{preview && !stale && view === "after" ? "Proposed version · not applied" : "Your current dashboard"} · Charts use your connected data and current view filters.</p>
        {stale && <p role="status">Your canvas or filters changed. Generate a fresh redesign to include those changes.</p>}
        <DashboardRender spec={shown} canvas={shownCanvas} model={model} queryContext={queryContext} filtersByTile={filtersByTile} drills={drills} fullSize={fullSize} />
      </section>
    </div>
    <footer><span>{applied ? "Redesign applied. One undo restores the previous version." : "Preview first. Apply the whole redesign with one undo."}</span><span className="spacer" />{preview && <button className="link" onClick={() => { remember("dismissed"); setPreview(null); setExplanation(""); }}>Keep current dashboard</button>}<button className="primary" disabled={!preview || stale || busy} onClick={() => { if (!preview) return; if (onApply(preview.proposal, preview.expected)) { remember("applied"); setPreview(null); setApplied(true); } else setError("The redesign could not be applied. Generate a fresh preview and try again."); }}>Apply redesign</button></footer>
  </StudioDialog>;
}

function DashboardRender({ spec, canvas, model, queryContext, filtersByTile, drills, fullSize }: { spec: DashboardSpec; canvas: CanvasSpec; model: Model; queryContext: string; filtersByTile: Record<string, FilterSpec[]>; drills: Record<string, DrillEntry[]>; fullSize: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), [width, setWidth] = useState(700);
  useEffect(() => { const element = viewport.current!; const observer = new ResizeObserver(() => setWidth(element.clientWidth)); observer.observe(element); return () => observer.disconnect(); }, []);
  const scale = fullSize ? 1 : Math.min(1, Math.max(200, width - 16) / canvas.width);
  const height = useMemo(() => Math.max(360, ...spec.tiles.map(t => t.layout.y + t.layout.h + 24)), [spec]);
  return <div className="ai-redesign-render" ref={viewport}><div style={{ width: canvas.width * scale, height: height * scale, position: "relative" }}><div style={{ width: canvas.width, height, transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute" }}>
    {!spec.tiles.length && <p className="ai-redesign-empty">Your first draft will appear here.</p>}
    {spec.tiles.map(t => <div className="ai-redesign-tile" key={t.id} style={{ position: "absolute", left: t.layout.x, top: t.layout.y, width: t.layout.w, height: t.layout.h, zIndex: t.layout.z }}>
      {t.kind === "filter" ? <div className="tile"><p>{t.title ?? "Dashboard filter"}</p><small>Current selection is preserved.</small></div> : <TileBoundary label={t.title ?? t.metrics.join(", ")}><Tile model={model} spec={t} locked queryContext={queryContext} crossFilters={[...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])]} drill={drills[t.id]} onRemove={() => {}} /></TileBoundary>}
    </div>)}
  </div></div></div>;
}
