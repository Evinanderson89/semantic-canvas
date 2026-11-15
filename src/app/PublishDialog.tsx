import { useEffect, useState, type FormEvent } from "react";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";
import { describeExpression } from "./connected.tsx";

/**
 * The admin's review of a table Ingest connected (docs/connected-canvas.md):
 * which draft metrics enter the governed catalogue and with what semantics.
 * Publication choices are explicit; the body is exactly publishSchema in
 * src/sources/connected.ts, and the server's validation is shown as-is.
 */
const GRAINS = ["day", "week", "month", "quarter", "year"] as const;
type Direction = "higher" | "lower" | "neutral";
interface DraftMetric { label: string; expression: string; description?: string; reviewed: boolean; time_grains?: string[]; time_dimension?: string; direction?: Direction; importance?: number }
export interface ConnectedDraft {
  dataset: string; status: "unreviewed" | "published"; revision?: string;
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

/** Explicit publication state and clearable metadata; omitted API fields remain unchanged. */
export function publishBody(table: TableReview, reviews: Record<string, Review>) {
  const metrics: Record<string, unknown> = {};
  for (const [name, r] of Object.entries(reviews)) {
    if (!r.publish) { metrics[name] = { reviewed: false }; continue; }
    metrics[name] = { reviewed: true, description: r.description.trim(),
      label: r.label.trim(), direction: r.direction || null,
      time_grains: r.grains.length ? r.grains : null, time_dimension: r.grains.length ? r.timeDimension || null : null,
      importance: r.importance.trim() !== "" ? Number(r.importance) : null };
  }
  return { metrics, table: { description: table.description.trim(), grain: table.grain.trim() || null, default_date_column: table.dateColumn || null } };
}

export function PublishDialog({ sourceId, dataset, onClose, onPublished }: { sourceId: string; dataset: string; onClose: () => void; onPublished: () => void }) {
  const [draft, setDraft] = useState<ConnectedDraft | null>(null);
  const [table, setTable] = useState<TableReview>({ grain: "", description: "", dateColumn: "" });
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const base = `/api/sources/${encodeURIComponent(sourceId)}/connected/${encodeURIComponent(dataset)}`;
  useEffect(() => {
    const controller = new AbortController();
    setDraft(null); setReviews({}); setError(null);
    fetch(base, { signal: controller.signal }).then(readResponse<ConnectedDraft>).then((d) => {
      if (controller.signal.aborted) return;
      setDraft(d);
      setTable({ grain: d.table.grain ?? "", description: d.table.description ?? "", dateColumn: d.table.default_date_column ?? "" });
      setReviews(Object.fromEntries(Object.entries(d.metrics).map(([name, m]) => [name, reviewOf(d, m)])));
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, loadAttempt]);
  const dateColumns = draft?.table.columns.filter(isDateColumn) ?? [];
  const set = (name: string, patch: Partial<Review>) => setReviews((r) => ({ ...r, [name]: { ...r[name], ...patch } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy || !draft) return; setBusy(true); setError(null);
    try {
      const result = await fetch(`${base}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...publishBody(table, reviews), expectedRevision: draft.revision }) }).then(readResponse);
      if (Object.entries(reviews).some(([name, review]) => result.metrics?.find((m: { name: string; reviewed: boolean }) => m.name === name)?.reviewed !== review.publish)) throw new Error("Publication changed while saving. Reopen the review to see the current published metrics.");
      onPublished();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <StudioDialog title={`Review and publish ${dataset}`} wide onClose={onClose}><form onSubmit={submit}><section>
    <h2>Review and publish</h2>
    <p className="lede">Choose which metrics from <code className="mono">{dataset}</code> are published to the governed catalogue. Unchecking a published metric withdraws it from viewer use. The underlying table remains published.</p>
    {draft && <>
      {Object.entries(draft.metrics).some(([name, m]) => m.reviewed && !reviews[name]?.publish) && <div className="cform-err publication-warning" role="status"><strong>Withdrawing published metrics</strong><p>{Object.entries(draft.metrics).filter(([name, m]) => m.reviewed && !reviews[name]?.publish).map(([, m]) => m.label).join(", ")}. Viewer charts using these metrics will stop returning results, and their alerts will need review. You can publish them again later.</p></div>}
      <div className="cform-grid publish-form">
        <label className="ctl span2"><span>Grain</span><input disabled={busy} value={table.grain} placeholder="one row per …" onChange={(e) => setTable({ ...table, grain: e.target.value })} /></label>
        <label className="ctl span2"><span>Description</span><input disabled={busy} value={table.description} onChange={(e) => setTable({ ...table, description: e.target.value })} /></label>
        <label className="ctl"><span>Default date column</span>
          <select disabled={busy} value={table.dateColumn} onChange={(e) => setTable({ ...table, dateColumn: e.target.value })}>
            <option value="">None</option>{dateColumns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select></label>
      </div>
      <h4 className="ex-h">Metrics</h4>
      {Object.entries(draft.metrics).map(([name, m]) => { const r = reviews[name]; return r && <fieldset key={name} className="publish-metric" disabled={busy}>
        <legend><label className="check"><input type="checkbox" checked={r.publish} onChange={(e) => set(name, { publish: e.target.checked })} />Publish <code className="mono">{name}</code></label>{m.reviewed && <span className={`active-badge${r.publish ? "" : " warn"}`}>{r.publish ? "Published" : "Withdrawal pending"}</span>}</legend>
        <p className="publish-meaning">{describeExpression(m.expression)} <code className="mono">{m.expression}</code></p>
        <div className="cform-grid publish-form">
          <label className="ctl"><span>Label</span><input value={r.label} required disabled={!r.publish} onChange={(e) => set(name, { label: e.target.value })} /></label>
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
    {!draft && error && <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry loading review</button>}
  </section><footer><span className="spacer" /><button type="button" className="link" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !draft}>{busy ? "Saving…" : draft?.status === "published" ? "Save publication changes" : "Publish"}</button></footer></form></StudioDialog>;
}
