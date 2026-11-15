import { useCallback, useMemo, useState } from "react";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { describeFilter, investigationContext, investigationOptions, type InvestigationResult } from "../suggest/investigate.ts";
import type { DrillEntry } from "./drill.ts";
import type { Readiness } from "./readiness.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";

export function Investigation({ source, result, model, filters, drill, queryContext, scopeWarnings, canKeep, onKeep, onClose }: {
  source: TileSpec; result: InvestigationResult; model: Model; filters: FilterSpec[]; drill: DrillEntry[]; queryContext: string;
  scopeWarnings: string[]; canKeep: boolean; onKeep: (tile: TileSpec) => void; onClose: () => void;
}) {
  const plan = useMemo(() => {
    try { const context = investigationContext(model, source, filters, drill, result); return { context, options: investigationOptions(model, source, context), error: "" }; }
    catch (e: any) { return { context: null, options: [], error: e.message }; }
  }, [model, source, filters, drill, result]);
  const [selected, setSelected] = useState(plan.options[0]?.id ?? "values");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Readiness>({ status: "checking" });
  const record = useCallback((_id: string, value: Readiness) => setStatus(before => JSON.stringify(before) === JSON.stringify(value) ? before : value), []);
  const option = plan.options.find(o => o.id === selected) ?? plan.options[0];
  const title = source.title ?? source.metrics.join(", ");
  return <StudioDialog title="Investigate this" onClose={onClose} className="ai-redesign-dialog investigation-dialog">
    <div className="ai-redesign-content">
      <section className="ai-redesign-brief">
        <span className="eyebrow">Start with the evidence</span><h2>{title}</h2>
        <p>Choose a question to explore. These views use the metric definitions published in your model.</p>
        {plan.error && <p role="alert" className="err">{plan.error}</p>}
        <div className="investigation-options" aria-label="Investigation questions">{plan.options.map(o => <button key={o.id} aria-pressed={option?.id === o.id} onClick={() => { if (selected !== o.id) { setStatus({ status: "checking" }); setSelected(o.id); } }}><b>{o.label}</b><small>{o.reason}</small></button>)}</div>
        {plan.context && !plan.options.some(o => o.id.startsWith("by:")) && <p>This metric has no additional supported categorical breakdowns in the model. A segment-level cause cannot be inferred from this view.</p>}
        <details open><summary>Period and scope</summary><p>{plan.context?.period}</p>
          {plan.context?.where.map((f, i) => <p key={`${f.id}:${i}`}>{describeFilter(f)}</p>)}
          {!!scopeWarnings.length && <p className="err">The original chart was not filtered by {scopeWarnings.join(", ")}. This investigation keeps that same scope.</p>}
        </details>
        <p>A breakdown is evidence to investigate, not proof of what caused a change.</p>
      </section>
      <section className="ai-redesign-preview" aria-label="Investigation preview">
        <h3>{option?.label ?? "No supported view"}</h3><p>{option?.reason}</p>
        {option && <div className="investigation-chart" key={`${option.id}:${attempt}`}>
          <TileBoundary onError={message => record(option.id, { status: "error", message })}>
            <Tile spec={option.tile} model={model} locked onRemove={() => {}} queryContext={`${queryContext}:investigate:${attempt}`} onReadiness={record} />
          </TileBoundary>
        </div>}
        {option && <p role="status">{status.status === "ready" ? "Query and view ready. Review the evidence before drawing a conclusion." : status.status === "error" ? status.message : "Checking this view…"}</p>}
        {status.status === "error" && <button className="review-action" onClick={() => { setStatus({ status: "checking" }); setAttempt(n => n + 1); }}>Retry investigation</button>}
        <p>Keeping this view adds a live chart with the captured reporting window and filters. Further dashboard filtering may narrow that captured scope.</p>
      </section>
    </div>
    <footer><span>Your original chart stays in place.</span><span className="spacer" /><button className="review-action" onClick={onClose}>Back to dashboard</button><button className="primary" disabled={!canKeep || !option || status.status !== "ready"} onClick={() => {
      if (!option || !plan.context || status.status !== "ready") return;
      onKeep({ ...option.tile, evidence: { sourceTileId: source.id, sourceTitle: title, question: option.label, period: plan.context.period, capturedAt: new Date().toISOString() } });
    }}>Keep this view</button></footer>
  </StudioDialog>;
}
