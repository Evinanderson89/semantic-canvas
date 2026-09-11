import type { ConnectedInfo } from "../semantic/model.ts";

/** Editors and admins see ingested tables before an admin publishes them; the badge says so wherever one is listed. */
export const UnreviewedBadge = () => <span className="active-badge warn" title="Registered by Ingest and not yet published by an administrator. Hidden from viewers and left out of suggestions.">Ingested, unreviewed</span>;
/** Every connected table is a snapshot (docs/connected-canvas.md); this line goes on the source and on every tile that uses it. */
export const dataAsOf = (c: Pick<ConnectedInfo, "loadedAt">) => `Data as of ${new Date(c.loadedAt).toLocaleString()}`;
export function Provenance({ connected }: { connected: ConnectedInfo }) {
  const p = connected.provenance;
  return <p className="mono conn-meta">{p.source} · {p.rows.toLocaleString()} rows · loaded by {p.loadedBy} · {dataAsOf(connected)}</p>;
}
/** The plain-language line Ingest shows next to a draft metric ("Count of rows"), derived from the expression so the review screen can show the same. */
export function describeExpression(expression: string): string {
  const m = /^\s*(count|sum|avg|min|max)\s*\(\s*(distinct\s+)?([^()]*?)\s*\)\s*$/i.exec(expression);
  if (!m) return expression;
  const [, fn, distinct, arg] = m, f = fn.toLowerCase();
  if (f === "count") return arg === "*" ? "Count of rows" : `${distinct ? "Distinct count" : "Count"} of ${arg}`;
  return `${{ sum: "Total", avg: "Average", min: "Smallest", max: "Largest" }[f]} of ${arg}`;
}
