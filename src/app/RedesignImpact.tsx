import type { redesignImpact } from "./redesignImpact.ts";

export function RedesignImpact({ impact }: { impact: ReturnType<typeof redesignImpact> }) {
  return <section className="redesign-impact" aria-label="Verified proposal changes">
    <h3>What will change</h3>
    <p>Compared with your current dashboard, using the validated proposal.</p>
    <ul className="impact-counts">
      {impact.analysisChanged > 0 && <li><strong>{impact.analysisChanged}</strong> existing chart{impact.analysisChanged === 1 ? " changes" : "s change"} the analysis</li>}
      {impact.presentationChanged > 0 && <li><strong>{impact.presentationChanged}</strong> existing tile{impact.presentationChanged === 1 ? " changes" : "s change"} presentation</li>}
      {impact.added > 0 && <li><strong>{impact.added}</strong> tile{impact.added === 1 ? "" : "s"} added</li>}
      {impact.removed > 0 && <li><strong>{impact.removed}</strong> tile{impact.removed === 1 ? "" : "s"} removed</li>}
    </ul>
    {!!impact.additions.length && <section aria-label="Metrics added to charts">
      <h4>Metrics added to charts</h4>
      <ul>{impact.additions.map(change => <li key={change.id}><strong>{change.title}</strong> ({change.newTile ? "new chart" : "existing chart"}): {change.added.map(metric => metric.label).join(", ")}</li>)}</ul>
      <p>A new chart can reuse metrics already shown elsewhere.</p>
    </section>}
    {!!impact.substitutions.length && <div className="impact-removed-evidence" role="region" aria-label="Metric substitutions">
      <h4>Charts showing different metrics</h4>
      <ul>{impact.substitutions.map(change => <li key={change.id}><strong>{change.title}</strong>
        <div>Before: {change.before.map(metric => metric.label).join(", ")}</div>
        <div>Proposed: {change.after.map(metric => metric.label).join(", ")}</div>
      </li>)}</ul>
      <p>These charts change what is being measured. Their tile IDs are retained.</p>
    </div>}
    {!!impact.removedMetrics.length && <div className="impact-removed-evidence" role="region" aria-label="Metrics no longer shown">
      <h4>No longer shown</h4>
      <ul>{impact.removedMetrics.map(metric => <li key={metric.name}>{metric.label} <code>{metric.name}</code></li>)}</ul>
      <p>These metrics disappear from the proposed dashboard, including charts repurposed to show something else. Review the description and commentary against the new contents.</p>
    </div>}
    {impact.analysisChanged === 0 && <p>Retained charts keep their metrics, reporting breakdowns, comparisons and effective query filters.</p>}
    <p>{impact.metrics.length} catalogue metric{impact.metrics.length === 1 ? "" : "s"} used in the proposed dashboard. This proposal does not edit metric definitions.</p>
    {impact.dashboardTitle && <p>Dashboard title: {impact.dashboardTitle.before} → {impact.dashboardTitle.after}</p>}
    {impact.dashboardDescription && <section aria-label="Dashboard description changes">
      <h4>Dashboard description</h4>
      <dl><div><dt>Before</dt><dd>{impact.dashboardDescription.before || "No description"}</dd></div>
        <div><dt>Proposed</dt><dd>{impact.dashboardDescription.after || "No description"}</dd></div></dl>
    </section>}
    {impact.tiles.map(tile => <details key={tile.id}>
      <summary>{tile.title} <span className="impact-status">{tile.status}</span>{tile.status === "changed" && tile.changes.some(c => c.analytical) && <span className="impact-scope">Analysis changes</span>}</summary>
      <dl>{tile.changes.map(change => <div key={change.label} className={change.analytical ? "impact-analytical" : ""}>
        <dt>{change.label}</dt><dd><span>Before</span> {change.before}</dd><dd><span>Proposed</span> {change.after}</dd>
      </div>)}</dl>
    </details>)}
  </section>;
}
