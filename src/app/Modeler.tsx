import { useEffect, useState, type FormEvent } from "react";
import { readResponse } from "./http.ts";
import type { Proposal, ProposedJoin, ProposedMetric, ProposedTable } from "../modeler/propose.ts";

/**
 * The Modeler (docs/modeler.md): from a warehouse's own catalogue to a
 * reviewed semantic model, published as a Canvas source. The server
 * proposes with evidence; this screen is where a person agrees, corrects,
 * or leaves things out. Admins only, like everything that adds a source.
 */
interface DraftSummary { id: string; label: string; createdAt: string; createdBy: string; updatedAt: string; publishedAt: string | null; sourceId: string | null; fromSource: string | null; connector: string | null; tables: number; joins: number; metrics: number; warnings: number }
interface Draft { id: string; label: string; fromSource?: string; connector?: Record<string, unknown>; createdAt: string; createdBy: string; updatedAt: string; publishedAt: string | null; sourceId: string | null; proposal: Proposal }
type SourceRow = { id: string; label: string; status: "ready" | "error"; connector?: string | null };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40);
const pct = (r: number | null) => r === null ? "not checked" : `${(r * 100).toFixed(r < 0.999 && r > 0.99 ? 1 : 0)}%`;

export function Modeler({ sources, onPublished }: { sources: SourceRow[]; onPublished: (sourceId: string) => void }) {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [open, setOpen] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => fetch("/api/modeler/drafts").then(readResponse).then((d) => setDrafts(d.drafts)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const openDraft = (id: string) => fetch(`/api/modeler/drafts/${encodeURIComponent(id)}`).then(readResponse).then(setOpen).catch((e) => setError(e.message));

  if (open) return <DraftReview draft={open} onBack={() => { setOpen(null); load(); }} onPublished={(id) => { load(); onPublished(id); }} />;
  return (
    <div className="explore modeler">
      <span className="eyebrow">Modeler</span>
      <h1>A semantic model, from the warehouse itself.</h1>
      <p className="lede">Point the Modeler at a lake or a warehouse. It reads the catalogue, measures what is unique and what joins to what, and proposes tables, joins and metrics with the evidence beside each. You review, correct, and publish; the result is an ordinary model file and a source anyone can chart against.</p>
      {error && <p className="conn-err" role="alert">{error}</p>}
      <NewDraft sources={sources} onCreated={(d) => { setDrafts(null); setOpen(d); }} />
      <h4 className="ex-h">Drafts</h4>
      {drafts === null ? <p className="conn-meta">Loading…</p> : drafts.length === 0 ? <p className="conn-meta">No drafts yet. Start one above.</p> : (
        <div className="joins">
          {drafts.map((d) => (
            <button key={d.id} className="join mono modeler-row" onClick={() => openDraft(d.id)}>
              <span>{d.label}</span><em>&nbsp;{d.id}</em>
              <span className="arrow">·</span>
              <span>{d.tables} tables, {d.joins} joins, {d.metrics} metrics{d.warnings ? `, ${d.warnings} to check` : ""}</span>
              <i>{d.publishedAt ? `published as ${d.sourceId}` : "draft"}</i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewDraft({ sources, onCreated }: { sources: SourceRow[]; onCreated: (d: Draft) => void }) {
  const ready = sources.filter((s) => s.status === "ready");
  const [mode, setMode] = useState<"source" | "lake" | "snowflake">(ready.length ? "source" : "lake");
  const [label, setLabel] = useState(""), [id, setId] = useState(""), [idTouched, setIdTouched] = useState(false);
  const [fromSource, setFromSource] = useState(ready[0]?.id ?? "");
  const [lake, setLake] = useState({ lakeRoot: "", awsProfile: "", awsRegion: "" });
  const [snow, setSnow] = useState({ account: "", username: "", password: "", privateKey: "", role: "", warehouse: "COMPUTE_WH", database: "", schema: "PUBLIC" });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    const connector = mode === "lake" ? { type: "duckdb", lakeRoot: lake.lakeRoot, awsProfile: lake.awsProfile || undefined, awsRegion: lake.awsRegion || undefined, poolSize: 2 }
      : mode === "snowflake" ? { type: "snowflake", ...Object.fromEntries(Object.entries(snow).filter(([, v]) => v)), poolSize: 2 } : undefined;
    try {
      const d = await fetch("/api/modeler/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, label: label || id, ...(mode === "source" ? { fromSource } : { connector }) }) }).then(readResponse);
      onCreated(d);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form className="cform" onSubmit={submit} aria-label="New model">
      <div className="cform-grid">
        <label className="ctl"><span>Label</span><input required value={label} placeholder="Orders warehouse" onChange={(e) => { setLabel(e.target.value); if (!idTouched) setId(slugify(e.target.value)); }} /></label>
        <label className="ctl"><span>Source ID</span><input required pattern="[a-z][a-z0-9-]*" value={id} placeholder="orders-warehouse" onChange={(e) => { setId(slugify(e.target.value)); setIdTouched(true); }} /></label>
        <label className="ctl span2"><span>Read from</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {ready.length > 0 && <option value="source">The warehouse behind an existing source</option>}
            <option value="lake">A Parquet lake (a directory, or s3://)</option>
            <option value="snowflake">A Snowflake database and schema</option>
          </select>
        </label>
        {mode === "source" && <label className="ctl span2"><span>Source</span>
          <select value={fromSource} onChange={(e) => setFromSource(e.target.value)}>{ready.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.id})</option>)}</select>
        </label>}
        {mode === "lake" && <>
          <label className="ctl span2"><span>Lake root</span><input required value={lake.lakeRoot} placeholder="~/data/lake or s3://bucket/lake" onChange={(e) => setLake({ ...lake, lakeRoot: e.target.value })} /></label>
          {(lake.lakeRoot.startsWith("s3://") || lake.awsProfile) && <>
            <label className="ctl"><span>AWS profile</span><input value={lake.awsProfile} placeholder="lake-reader" onChange={(e) => setLake({ ...lake, awsProfile: e.target.value })} /></label>
            <label className="ctl"><span>Bucket region</span><input value={lake.awsRegion} placeholder="us-east-2" onChange={(e) => setLake({ ...lake, awsRegion: e.target.value })} /></label>
          </>}
        </>}
        {mode === "snowflake" && <>
          <label className="ctl"><span>Account</span><input required value={snow.account} onChange={(e) => setSnow({ ...snow, account: e.target.value })} /></label>
          <label className="ctl"><span>Username</span><input required value={snow.username} onChange={(e) => setSnow({ ...snow, username: e.target.value })} /></label>
          <label className="ctl"><span>Password</span><input type="password" value={snow.password} onChange={(e) => setSnow({ ...snow, password: e.target.value })} /></label>
          <label className="ctl"><span>Private key (PEM), instead of a password</span><textarea value={snow.privateKey} rows={3} onChange={(e) => setSnow({ ...snow, privateKey: e.target.value })} /></label>
          <label className="ctl"><span>Role</span><input value={snow.role} placeholder="ANALYTICS_READER" onChange={(e) => setSnow({ ...snow, role: e.target.value })} /></label>
          <label className="ctl"><span>Warehouse</span><input required value={snow.warehouse} onChange={(e) => setSnow({ ...snow, warehouse: e.target.value })} /></label>
          <label className="ctl"><span>Database</span><input required value={snow.database} onChange={(e) => setSnow({ ...snow, database: e.target.value })} /></label>
          <label className="ctl"><span>Schema</span><input required value={snow.schema} onChange={(e) => setSnow({ ...snow, schema: e.target.value })} /></label>
          <p className="span2 conn-meta">Credentials go to the server's .env, referenced from sources.yaml; they never come back to the browser.</p>
        </>}
      </div>
      {error && <p className="conn-err" role="alert">{error}</p>}
      <div className="story-actions"><button className="primary small" disabled={busy}>{busy ? "Reading the warehouse…" : "Read the warehouse and propose a model"}</button></div>
      {busy && <p className="conn-meta">One query per table for counts and uniqueness, one per candidate join. A large warehouse takes a minute.</p>}
    </form>
  );
}

function DraftReview({ draft: initial, onBack, onPublished }: { draft: Draft; onBack: () => void; onPublished: (id: string) => void }) {
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [issues, setIssues] = useState<string[]>([]), [error, setError] = useState<string | null>(null), [done, setDone] = useState<string | null>(null);
  const p = draft.proposal;
  const patch = (next: Partial<Proposal>) => { setDraft({ ...draft, proposal: { ...p, ...next } }); setDirty(true); setDone(null); };
  const table = (name: string, change: Partial<ProposedTable>) => patch({ tables: p.tables.map((t) => t.name === name ? { ...t, ...change } : t) });
  const join = (i: number, change: Partial<ProposedJoin>) => patch({ joins: p.joins.map((j, k) => k === i ? { ...j, ...change } : j) });
  const metric = (i: number, change: Partial<ProposedMetric>) => patch({ metrics: p.metrics.map((m, k) => k === i ? { ...m, ...change } : m) });
  const save = async () => {
    setBusy("save"); setError(null);
    try { const d = await fetch(`/api/modeler/drafts/${encodeURIComponent(draft.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: draft.label, proposal: p }) }).then(readResponse); setIssues(d.issues ?? []); setDirty(false); return true; }
    catch (e: any) { setError(e.message); return false; } finally { setBusy(null); }
  };
  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy("publish"); setError(null);
    try {
      const r = await fetch(`/api/modeler/drafts/${encodeURIComponent(draft.id)}/publish`, { method: "POST" }).then(readResponse);
      setDone(r.source?.id ?? draft.id); setDraft({ ...draft, publishedAt: new Date().toISOString(), sourceId: draft.id }); setIssues([]); onPublished(draft.id);
    } catch (e: any) { setError(e.message); if (Array.isArray(e.body?.issues)) setIssues(e.body.issues); } finally { setBusy(null); }
  };
  const included = new Set(p.tables.filter((t) => t.include).map((t) => t.name));
  return (
    <div className="explore modeler">
      <button className="link" onClick={onBack}>← All drafts</button>
      <span className="eyebrow">{draft.publishedAt ? `Published as source ${draft.sourceId}` : "Draft"} · read from {draft.fromSource ?? String(draft.connector?.type ?? "")}</span>
      <h1><input className="modeler-title" value={draft.label} aria-label="Model label" onChange={(e) => { setDraft({ ...draft, label: e.target.value }); setDirty(true); }} /></h1>
      <p className="lede">{p.model.description}</p>
      {p.warnings.length > 0 && <div className="beautify-suggestion modeler-warnings"><div className="eyebrow">To check</div><ul>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}

      <h4 className="ex-h">Tables</h4>
      {p.tables.map((t) => (
        <details key={t.name} className="tbl-card" open={t.include && (!t.grain || t.kind === "unknown")}>
          <summary>
            <input type="checkbox" checked={t.include} aria-label={`Include ${t.name}`} onClick={(e) => e.stopPropagation()} onChange={(e) => table(t.name, { include: e.target.checked })} />
            <b className="mono">{t.name}</b>
            <span className="grain">{t.grain || <i>grain not known</i>}</span>
            <span className="cnt mono">{t.rows.toLocaleString()} rows · {t.columns.length} cols · {t.kind}</span>
          </summary>
          <div className="tbl-body">
            <p className="tbl-body-p"><b>Evidence:</b> {t.evidence}</p>
            <div className="cform-grid">
              <label className="ctl span2"><span>Grain (what one row is)</span><input value={t.grain} placeholder="one row per order" onChange={(e) => table(t.name, { grain: e.target.value })} /></label>
              <label className="ctl"><span>Kind</span><select value={t.kind} onChange={(e) => table(t.name, { kind: e.target.value as ProposedTable["kind"] })}><option value="fact">fact (events, transactions)</option><option value="dimension">dimension (who, what, where)</option><option value="unknown">not sure</option></select></label>
              <label className="ctl"><span>Time column</span><select value={t.timeColumn ?? ""} onChange={(e) => table(t.name, { timeColumn: e.target.value || null })}><option value="">none</option>{t.columns.filter((c) => /date|timestamp/.test(c.type)).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
              <label className="ctl"><span>Reporting lag (days before a period is complete)</span><input type="number" min={0} max={365} value={t.reportingLag ?? ""} placeholder="0" onChange={(e) => table(t.name, { reportingLag: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
              <label className="ctl"><span>Primary key</span><input value={t.primaryKey ?? ""} readOnly /></label>
              <label className="ctl span2"><span>Description</span><input value={t.description} placeholder="What this table holds, for people and the agent" onChange={(e) => table(t.name, { description: e.target.value })} /></label>
            </div>
            <table><thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>{t.columns.map((c) => <tr key={c.name}><td className="mono">{c.name}{c.name === t.primaryKey && <span className="pk">KEY</span>}</td><td className="mono t">{c.type}</td></tr>)}</tbody></table>
          </div>
        </details>
      ))}

      <h4 className="ex-h">Joins</h4>
      {p.joins.length === 0 ? <p className="conn-meta">No join candidates: no column of one table is named like another table's key.</p> : (
        <div className="joins">{p.joins.map((j, i) => (
          <div key={i} className={"join mono" + (!included.has(j.left) || !included.has(j.right) ? " dim" : "")}>
            <input type="checkbox" checked={j.include} aria-label={`Include join ${j.left}.${j.leftOn} to ${j.right}.${j.rightOn}`} onChange={(e) => join(i, { include: e.target.checked })} />
            <span>{j.left}</span><em>.{j.leftOn}</em><span className="arrow">→</span><span>{j.right}</span><em>.{j.rightOn}</em>
            <span className="modeler-evidence">{j.evidence}</span>
            <i className={j.resolution !== null && j.resolution < 0.95 ? "warn" : ""}>{pct(j.resolution)}</i>
          </div>
        ))}</div>
      )}

      <h4 className="ex-h">Metrics</h4>
      <table className="modeler-metrics"><thead><tr><th></th><th>Name</th><th>Label</th><th>Table</th><th>Expression</th><th>Why</th></tr></thead><tbody>
        {p.metrics.map((m, i) => (
          <tr key={i} className={!included.has(m.baseTable) ? "dim" : ""}>
            <td><input type="checkbox" checked={m.include} aria-label={`Include metric ${m.name}`} onChange={(e) => metric(i, { include: e.target.checked })} /></td>
            <td><input className="mono" value={m.name} aria-label="Metric name" onChange={(e) => metric(i, { name: e.target.value })} /></td>
            <td><input value={m.label} aria-label="Metric label" onChange={(e) => metric(i, { label: e.target.value })} /></td>
            <td className="mono">{m.baseTable}</td>
            <td><input className="mono" value={m.expression} aria-label="Metric expression" onChange={(e) => metric(i, { expression: e.target.value })} /></td>
            <td className="modeler-evidence">{m.evidence}</td>
          </tr>
        ))}
      </tbody></table>

      {issues.length > 0 && <div className="beautify-suggestion modeler-warnings"><div className="eyebrow">Before publishing</div><ul>{issues.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {error && <p className="conn-err" role="alert">{error}</p>}
      {done && <p className="conn-meta" role="status">Published. <b>{done}</b> is a source now: open Metric Registry to chart against it, or Connections to see it listed.</p>}
      <div className="story-actions">
        <button className="tgl" onClick={save} disabled={busy !== null || !dirty}>{busy === "save" ? "Saving…" : dirty ? "Save draft" : "Saved"}</button>
        <button className="primary small" onClick={publish} disabled={busy !== null}>{busy === "publish" ? "Publishing…" : draft.publishedAt ? "Publish again" : "Publish as a source"}</button>
        <a className="link" href={`/api/modeler/drafts/${encodeURIComponent(draft.id)}/yaml`} target="_blank" rel="noreferrer">View as YAML</a>
      </div>
      <small className="conn-meta">Publishing writes the model file under the server's data directory and adds the source. Tables you leave out, and joins or metrics that name them, are not written.</small>
    </div>
  );
}
