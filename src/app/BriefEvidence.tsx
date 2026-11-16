import type { FilterSpec, PresentationBrief, TileSpec } from "../compiler/spec.ts";
import { metricOf, type Model } from "../semantic/model.ts";
import { isScopeNote } from "../suggest/resultQuality.ts";
import { describeFilter } from "./MetricEvidence.tsx";
import type { Readiness } from "./readiness.ts";

export function BriefEvidence({ charts, checks, model, brief, busy, scopeWarnings, filtersFor, onAppend }: {
  charts: TileSpec[]; checks: Record<string, Readiness>; model: Model; brief: PresentationBrief; busy: boolean;
  scopeWarnings: Record<string, string[]>; filtersFor: (tile: TileSpec) => FilterSpec[];
  onAppend: (field: "takeaway" | "nextStep", text: string) => void;
}) {
  return <details className="report-evidence-drafts"><summary>Build your brief from the evidence</summary>
    <p>These observations are calculated from the included charts’ current query results, with values rounded for readability. Choose what belongs in your brief; a change or breakdown alone does not establish its cause.</p>
    {charts.map(tile => {
      const check = checks[tile.id], title = tile.title ?? tile.metrics.join(", ");
      if (check?.status !== "ready") return <p key={tile.id}>{title}: {check?.status === "error" ? "Resolve the chart error before drafting." : "Waiting for this chart…"}</p>;
      if (!check.observations?.length) return <p key={tile.id}>{title}: {check.observationNote ?? "No numeric observations are available."}</p>;
      const filters = filtersFor(tile);
      const scope = `${filters.length ? filters.map(describeFilter).join("; ") : "No additional chart filters"}${check.rowRules?.length ? `; access rules: ${check.rowRules.join(", ")}` : ""}.`;
      const caveats = [...(scopeWarnings[tile.id]?.length ? [`Not filtered by ${scopeWarnings[tile.id].join(", ")}.`] : []),
        ...(check.dataFindings ?? []).map(f => `${f.title}: ${f.evidence}${f.impact ? ` Why it matters: ${f.impact}` : ""}`)].join(" ");
      return <section key={tile.id}><h3>{title}</h3>{check.observationNote && <p>{check.observationNote}</p>}{check.observations.map(observation => {
        const source = `Source: ${title}; metric ${observation.metric}; ${observation.basis}. ${scope}`;
        const qualifications = [observation.unitNote, caveats].filter(Boolean).join(" ");
        const fact = `${observation.statement}\n${source}${qualifications ? `\n${qualifications}` : ""}`;
        const question = check.dataFindings?.find(f => !isScopeNote(f))?.nextStep ?? observation.nextQuestion;
        const next = question ? `${question}\n${source}${qualifications ? `\n${qualifications}` : ""}` : "";
        const metric = metricOf(model, observation.metric);
        const button = (field: "takeaway" | "nextStep", text: string, label: string, max: number) => {
          const added = brief[field].includes(text), full = brief[field].length + text.length + 2 > max;
          return <button className="review-action" disabled={busy || added || full} title={full ? `Shorten the ${field === "takeaway" ? "takeaway" : "next step"} to make room.` : undefined} onClick={() => onAppend(field, text)}>{added ? "Added" : label}</button>;
        };
        return <article key={observation.metric} className="brief-observation">
          <p className="brief-observation-statement">{observation.statement}</p><p className="brief-observation-source">{source}</p>
          {qualifications && <p className="brief-observation-caveats">{qualifications}</p>}
          <details><summary>Metric definition</summary><p>{metric?.description ?? "No description supplied in the model."}</p><p>Declared unit: {metric?.unit ?? "not supplied"}</p><code>{metric?.expression}</code></details>
          <div className="brief-observation-actions">{button("takeaway", fact, "Add observation to takeaway", 4000)}</div>
          {next && <div className="brief-followup"><strong>Suggested follow-up</strong><p>{question}</p>{button("nextStep", next, "Add next question", 2000)}</div>}
        </article>;
      })}</section>;
    })}
    {!charts.length && <p>Select a chart to inspect its evidence.</p>}
  </details>;
}
