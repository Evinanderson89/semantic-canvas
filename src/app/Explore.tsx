import { useMemo, useState, type FormEvent } from "react";
import type { Metric, Model, Origin } from "../semantic/model.ts";
import { isUnreviewed, isUnreviewedTable, metricsByTable } from "../semantic/model.ts";
import { prettyTable } from "./Sidebar.tsx";
import { Provenance, UnreviewedBadge } from "./connected.tsx";
import { useSession } from "./Session.tsx";
import { readResponse } from "./http.ts";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** Where a metric came from, when it was not the base model: proposed here and waiting, or added in Canvas and published. */
export function OriginBadge({ origin, reviewed }: { origin?: Origin; reviewed?: boolean }) {
  if (!origin) return null;
  if (reviewed === false) return <span className="active-badge warn" title={`Proposed on ${when(origin.at)}. Editors can chart it; viewers see it once an administrator publishes it.`}>Proposed by {origin.by}, unreviewed</span>;
  return <span className="active-badge modeler-status" title={`${origin.kind === "modeler" ? "Added by the Modeler" : "Proposed on the Metric Registry"} on ${when(origin.at)}${origin.publishedBy ? `, published by ${origin.publishedBy}` : ""}. Not in the base model file.`}>Added in Canvas · {origin.by} · {when(origin.at)}</span>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 64);

/**
 * Propose a metric (docs/modeler.md, "Proposed metrics"): one aggregate over a
 * table's own columns. Nothing runs when it is defined; the server probes it
 * once, then it is live for editors, badged, until an administrator publishes it.
 */
function ProposeMetric({ model, sourceId, onChanged }: { model: Model; sourceId: string; onChanged: () => void }) {
  const tables = Object.keys(model.tables).filter((t) => !isUnreviewedTable(model.tables[t]));
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ label: "", name: "", baseTable: tables[0] ?? "", expression: "", filter: "", description: "" });
  const [nameTouched, setNameTouched] = useState(false);
  const [problems, setProblems] = useState<string[]>([]), [busy, setBusy] = useState(false), [done, setDone] = useState<string | null>(null);
  const columns = model.tables[form.baseTable]?.columns ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setProblems([]); setDone(null);
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/metrics`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name, label: form.label, baseTable: form.baseTable, expression: form.expression, ...(form.filter.trim() ? { filter: form.filter } : {}), ...(form.description.trim() ? { description: form.description } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setProblems(body.problems?.length ? body.problems : [body.error ?? "Could not propose it."]); return; }
      setDone(form.label); setForm({ label: "", name: "", baseTable: form.baseTable, expression: "", filter: "", description: "" }); setNameTouched(false); onChanged();
    } catch (err: any) { setProblems([String(err?.message ?? err)]); } finally { setBusy(false); }
  };
  if (!open) return <div className="propose-metric-cta"><button className="tgl" onClick={() => setOpen(true)}>Propose a metric</button>{done && <span className="conn-meta" role="status"> “{done}” is live for editors, marked unreviewed; an administrator publishes it to everyone.</span>}</div>;
  return (
    <form className="cform propose-metric" onSubmit={submit} aria-label="Propose a metric">
      <div className="eyebrow">Propose a metric</div>
      <p className="tbl-body-p">One aggregate over one table's columns. Nothing runs until a chart asks for it; the warehouse checks it once now. Editors can chart it straight away; viewers see it when an administrator publishes it.</p>
      <div className="cform-grid">
        <label className="ctl"><span>Label</span><input required value={form.label} placeholder="Refunded orders" onChange={(e) => setForm((f) => ({ ...f, label: e.target.value, name: nameTouched ? f.name : slug(e.target.value) }))} /></label>
        <label className="ctl"><span>Name</span><input required pattern="[a-z][a-z0-9_]*" value={form.name} placeholder="refunded_orders" onChange={(e) => { setForm((f) => ({ ...f, name: slug(e.target.value) })); setNameTouched(true); }} /></label>
        <label className="ctl"><span>Table</span><select value={form.baseTable} onChange={(e) => setForm((f) => ({ ...f, baseTable: e.target.value }))}>{tables.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="ctl"><span>Columns you can use</span><span className="mono propose-columns">{columns.map((c) => c.name).join(", ")}</span></label>
        <label className="ctl span2"><span>Expression</span><input required className="mono" value={form.expression} placeholder={`SUM(${form.baseTable}.${columns.find((c) => /double|int|number/i.test(c.type))?.name ?? "amount"})`} onChange={(e) => setForm((f) => ({ ...f, expression: e.target.value }))} /></label>
        <label className="ctl span2"><span>Always-on filter (optional)</span><input className="mono" value={form.filter} placeholder={`${form.baseTable}.status = 'refunded'`} onChange={(e) => setForm((f) => ({ ...f, filter: e.target.value }))} /></label>
        <label className="ctl span2"><span>What it means (optional)</span><input value={form.description} placeholder="Orders refunded in full, counted on the refund date." onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></label>
      </div>
      {problems.length > 0 && <ul className="conn-err propose-problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="story-actions">
        <button className="primary small" disabled={busy}>{busy ? "Checking with the warehouse…" : "Check and propose"}</button>
        <button type="button" className="tgl" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function MetricActions({ m, sourceId, onChanged }: { m: Metric; sourceId: string; onChanged: () => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  if (!m.origin) return null;
  const mine = m.origin.byId && session.user?.id === m.origin.byId;
  const canPublish = session.canAdmin && m.reviewed === false;
  const canRemove = session.canAdmin || (mine && m.reviewed === false);
  if (!canPublish && !canRemove) return null;
  const act = async (path: string, method: string) => {
    setBusy(true); setError(null);
    try { await fetch(path, { method }).then(readResponse); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <span className="metric-actions">
    {canPublish && <button className="primary small" disabled={busy} onClick={() => act(`/api/sources/${encodeURIComponent(sourceId)}/metrics/${encodeURIComponent(m.name)}/publish`, "POST")}>Publish to everyone</button>}
    {canRemove && <button className="link" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.label}? Charts using it will stop working.`)) act(`/api/sources/${encodeURIComponent(sourceId)}/metrics/${encodeURIComponent(m.name)}`, "DELETE"); }}>{m.reviewed === false && mine && !session.canAdmin ? "Withdraw" : "Remove"}</button>}
    {error && <span className="conn-err">{error}</span>}
  </span>;
}

/**
 * Metric Registry and Data Model are not new features — the model already
 * carries everything they show. They existed as dead sidebar links, which is
 * worse than not existing: a promise the tool doesn't keep.
 */
export function MetricRegistry({ model, onUse, initialTable = null, sourceId = "", onChanged = () => {} }: {
  model: Model; onUse: (metric: string) => void; initialTable?: string | null;
  sourceId?: string; onChanged?: () => void;
}) {
  const session = useSession();
  const [q, setQ] = useState("");
  const [table, setTable] = useState<string | null>(initialTable);
  const all = Object.values(model.metrics);
  const tables = Object.keys(metricsByTable(model));

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((m) =>
      (!table || m.baseTable === table) &&
      (!n || `${m.name} ${m.label} ${m.description} ${m.synonyms.join(" ")}`
        .toLowerCase().includes(n)));
  }, [q, table, all]);

  return (
    <div className="explore">
      <div className="eyebrow">Your semantic layer</div>
      <h1>Metric Registry</h1>
      <p className="lede">A shared language for your data. Explore a metric, understand its meaning, and bring it onto the canvas.</p>
      {session.canEdit && sourceId && <ProposeMetric model={model} sourceId={sourceId} onChanged={onChanged} />}

      <div className="ex-tools">
        <input autoFocus className="txt" aria-label="Filter metrics" placeholder="Find a metric…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by topic" value={table ?? ""} onChange={(e) => setTable(e.target.value || null)}>
          <option value="">All topics</option>
          {tables.map((t) => <option key={t} value={t}>{prettyTable(t)}</option>)}
        </select>
      </div>

      <div className="ex-count">{shown.length} {shown.length === 1 ? "metric" : "metrics"}{q || table ? ` of ${all.length}` : ""}</div>
      <div className="mlist">
        {shown.map((m) => (
          <div key={m.name} className="mrow">
            <div className="mrow-top">
              <b>{m.label}</b>
              {m.origin ? <OriginBadge origin={m.origin} reviewed={m.reviewed} /> : isUnreviewed(model, m) && <UnreviewedBadge />}
              {sourceId && <MetricActions m={m} sourceId={sourceId} onChanged={onChanged} />}
              <button className="use" onClick={() => onUse(m.name)}>Chart it →</button>
            </div>
            {m.description && <p>{m.description}</p>}
            <div className="metric-topic">{prettyTable(m.baseTable)}</div>
            <details className="metric-definition"><summary>View definition</summary>
            <code className="metric-id">{m.name}</code>
            <pre className="expr">{m.expression}</pre>
            {m.filter && <div className="afilter mono">always: {m.filter}</div>}
            {m.synonyms.length > 0 && (
              <div className="syns">{m.synonyms.map((s) => <i key={s}>{s}</i>)}</div>
            )}
            </details>
          </div>
        ))}
        {shown.length === 0 && <div className="empty">Nothing matches “{q}”.</div>}
      </div>
    </div>
  );
}

export function DataModel({ model }: { model: Model }) {
  const byTable = metricsByTable(model);
  return (
    <div className="explore">
      <h1>Data Model</h1>
      <p className="lede">{Object.keys(model.tables).length} tables and {model.joins.length} joins,
        read from the {model.source} semantic layer. Joins are what let a metric on one table be
        cut by a dimension on another.</p>

      <h4 className="ex-h">Joins</h4>
      <div className="joins">
        {model.joins.map((j, i) => (
          <div key={i} className="join mono">
            <span>{j.left}</span><em>.{j.leftOn}</em>
            <span className="arrow">→</span>
            <span>{j.right}</span><em>.{j.rightOn}</em>
            <i>{j.type}</i>
          </div>
        ))}
      </div>

      <h4 className="ex-h">Tables</h4>
      {Object.values(model.tables).map((t) => (
        <details key={t.name} className="tbl-card">
          <summary>
            <b className="mono">{t.name}</b>
            {isUnreviewedTable(t) && <UnreviewedBadge />}
            {t.origin && <OriginBadge origin={t.origin} />}
            <span className="grain">{t.grain}</span>
            <span className="cnt mono">{t.columns.length} cols · {(byTable[t.name] ?? []).length} metrics</span>
          </summary>
          <div className="tbl-body">
            {t.description && <p>{t.description}</p>}
            {t.connected && <Provenance connected={t.connected} />}
            {t.synonyms.length > 0 && (
              <div className="syns">{t.synonyms.map((s) => <i key={s}>{s}</i>)}</div>
            )}
            <table>
              <thead><tr><th>Column</th><th>Type</th><th>Description</th></tr></thead>
              <tbody>
                {t.columns.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}
                      {t.partitionKeys.includes(c.name) && <span className="pk">PARTITION</span>}</td>
                    <td className="mono t">{c.type}</td>
                    <td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
