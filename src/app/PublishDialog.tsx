import { useEffect, useState, type FormEvent } from "react";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";
import { describeExpression } from "./connected.tsx";

/**
 * The admin's review of a table Ingest connected (docs/connected-canvas.md):
 * which draft metrics enter the governed catalogue and with what semantics.
 * Only ticked metrics are sent; the body is exactly publishSchema in
 * src/sources/connected.ts, and the server's validation is shown as-is.
 */
const GRAINS = ["day", "week", "month", "quarter", "year"] as const;
type Direction = "higher" | "lower" | "neutral";
interface DraftMetric { label: string; expression: string; description?: string; reviewed: boolean; time_grains?: string[]; time_dimension?: string; direction?: Direction; importance?: number }
export interface ConnectedDraft {
  dataset: string; status: "unreviewed" | "published";
  table: { description?: string; grain?: string; default_date_column?: string; columns: { name: string; type: string }[] };
  metrics: Record<string, DraftMetric>;
}
export interface Review { publish: boolean; label: string; description: string; direction: "" | Direction; grains: string[]; timeDimension: string; importance: string }
export interface TableReview { grain: string; description: string; dateColumn: string }

export const isDateColumn = (c: { type: string }) => /date|timestamp/i.test(c.type);

export const reviewOf = (d: ConnectedDraft, m: DraftMetric): Review => ({
  publish: m.reviewed, label: m.label, description: m.description ?? "", direction: m.direction ?? "", grains: m.time_grains ?? [],
  timeDimension: m.time_dimension ?? (d.table.default_date_column ? `${d.dataset}.${d.table.default_date_column}` : ""),
  importance: m.importance === undefined ? "" : String(m.importance),
});

/** Only ticked metrics, only fields that were set; description travels even when blank so it can be cleared. */
export function publishBody(table: TableReview, reviews: Record<string, Review>) {
  const metrics: Record<string, unknown> = {};
  for (const [name, r] of Object.entries(reviews)) {
    if (!r.publish) continue;
    metrics[name] = { reviewed: true, description: r.description.trim(),
      ...(r.label.trim() ? { label: r.label.trim() } : {}), ...(r.direction ? { direction: r.direction } : {}),
      ...(r.grains.length ? { time_grains: r.grains, ...(r.timeDimension ? { time_dimension: r.timeDimension } : {}) } : {}),
      ...(r.importance.trim() !== "" ? { importance: Number(r.importance) } : {}) };
  }
  return { metrics, table: { description: table.description.trim(), ...(table.grain.trim() ? { grain: table.grain.trim() } : {}), ...(table.dateColumn ? { default_date_column: table.dateColumn } : {}) } };
}

export function PublishDialog({ sourceId, dataset, onClose, onPublished }: { sourceId: string; dataset: string; onClose: () => void; onPublished: () => void }) {
  const [draft, setDraft] = useState<ConnectedDraft | null>(null);
  const [table, setTable] = useState<TableReview>({ grain: "", description: "", dateColumn: "" });
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/sources/${encodeURIComponent(sourceId)}/connected/${encodeURIComponent(dataset)}`;
  useEffect(() => {
    fetch(base).then(readResponse<ConnectedDraft>).then((d) => {
      setDraft(d);
      setTable({ grain: d.table.grain ?? "", description: d.table.description ?? "", dateColumn: d.table.default_date_column ?? "" });
      setReviews(Object.fromEntries(Object.entries(d.metrics).map(([name, m]) => [name, reviewOf(d, m)])));
    }).catch((e) => setError(e.message));
  }, [base]);
  const dateColumns = draft?.table.columns.filter(isDateColumn) ?? [];
  const set = (name: string, patch: Partial<Review>) => setReviews((r) => ({ ...r, [name]: { ...r[name], ...patch } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await fetch(`${base}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publishBody(table, reviews)) }).then(readResponse);
      onPublished();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <StudioDialog title={`Review and publish ${dataset}`} wide onClose={onClose}><form onSubmit={submit}><section>
    <h2>Review and publish</h2>
    <p className="lede">Publishing puts <code className="mono">{dataset}</code> and the ticked metrics in the governed catalogue for everyone, viewers included. Metrics left unticked stay unreviewed.</p>
    {draft && <>
      <div className="cform-grid publish-form">
        <label className="ctl span2"><span>Grain</span><input value={table.grain} placeholder="one row per …" onChange={(e) => setTable({ ...table, grain: e.target.value })} /></label>
        <label className="ctl span2"><span>Description</span><input value={table.description} onChange={(e) => setTable({ ...table, description: e.target.value })} /></label>
        <label className="ctl"><span>Default date column</span>
          <select value={table.dateColumn} onChange={(e) => setTable({ ...table, dateColumn: e.target.value })}>
            <option value="">None</option>{dateColumns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select></label>
      </div>
      <h4 className="ex-h">Metrics</h4>
      {Object.entries(draft.metrics).map(([name, m]) => { const r = reviews[name]; return r && <fieldset key={name} className="publish-metric">
        <legend><label className="check"><input type="checkbox" checked={r.publish} onChange={(e) => set(name, { publish: e.target.checked })} />Publish <code className="mono">{name}</code></label>{m.reviewed && <span className="active-badge">Published</span>}</legend>
        <p className="publish-meaning">{describeExpression(m.expression)} <code className="mono">{m.expression}</code></p>
        <div className="cform-grid publish-form">
          <label className="ctl"><span>Label</span><input value={r.label} disabled={!r.publish} onChange={(e) => set(name, { label: e.target.value })} /></label>
          <label className="ctl"><span>Description</span><input value={r.description} disabled={!r.publish} onChange={(e) => set(name, { description: e.target.value })} /></label>
          <label className="ctl"><span>Direction</span>
            <select value={r.direction} disabled={!r.publish} onChange={(e) => set(name, { direction: e.target.value as Review["direction"] })}>
              <option value="">Not set</option><option value="higher">Higher is better</option><option value="lower">Lower is better</option><option value="neutral">Neutral</option>
            </select></label>
          <label className="ctl"><span>Importance (0–100)</span><input type="number" min={0} max={100} value={r.importance} disabled={!r.publish} onChange={(e) => set(name, { importance: e.target.value })} /></label>
          <div className="ctl"><span>Time grains</span><div className="publish-grains">
            {GRAINS.map((g) => <label key={g} className="check"><input type="checkbox" checked={r.grains.includes(g)} disabled={!r.publish}
              onChange={(e) => set(name, { grains: GRAINS.filter((x) => x === g ? e.target.checked : r.grains.includes(x)) })} />{g}</label>)}
          </div></div>
          {r.grains.length > 0 && <label className="ctl"><span>Time dimension</span>
            <select value={r.timeDimension} disabled={!r.publish} onChange={(e) => set(name, { timeDimension: e.target.value })}>
              <option value="">Choose a date column</option>{dateColumns.map((c) => <option key={c.name} value={`${draft.dataset}.${c.name}`}>{c.name}</option>)}
            </select></label>}
        </div>
      </fieldset>; })}
      {!Object.keys(draft.metrics).length && <p className="conn-meta">This table has no draft metrics; publishing makes the table itself available.</p>}
    </>}
    {!draft && !error && <p className="conn-meta">Loading the draft…</p>}
    {error && <div className="cform-err" role="alert">{error}</div>}
  </section><footer><span className="spacer" /><button type="button" className="link" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !draft}>{busy ? "Publishing…" : "Publish"}</button></footer></form></StudioDialog>;
}
