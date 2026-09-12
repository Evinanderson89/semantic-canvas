import { useSession } from "./Session.tsx";
import { WorkspaceSetup } from "./WorkspaceSetup.tsx";
import { useEffect, useState, type FormEvent } from "react";
import { readResponse } from "./http.ts";
import type { ConnectedProvenance } from "../semantic/model.ts";
import { UnreviewedBadge, dataAsOf } from "./connected.tsx";
import { PublishDialog } from "./PublishDialog.tsx";

export interface SourceInfo {
  id: string; label: string; adapter: string;
  status: "ready" | "error"; error?: string; connectMs?: number;
  connector: string | null; tables: number; metrics: number;
  connected?: number; unreviewed?: number;
}
interface ConnectedTable { dataset: string; status: "unreviewed" | "published"; importId: string; provenance: ConnectedProvenance; loadedAt: string; registeredBy: string; columns: number; metrics: { name: string; label: string; reviewed: boolean }[] }
export interface RlsPolicy { id: string; field: string; claim: string }
export interface Principal { id: string; name: string }

type FormMode = { kind: "add" } | { kind: "edit"; id: string } | null;

export function Connections({ sources, activeId, onSelect, onRefresh, principals, policies }: {
  sources: SourceInfo[]; activeId: string; onSelect: (id: string) => void;
  onRefresh: () => void; principals: Principal[]; policies: RlsPolicy[];
}) {
  const { canAdmin } = useSession();
  const [form, setForm] = useState<FormMode>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const remove = async (id: string) => {
    setRemoving(id);
    setRemoveError(null);
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) { setRemoveError(d.error ?? "Could not remove."); return; }
      setConfirmRemove(null);
      onRefresh();
    } catch (e: any) {
      setRemoveError(String(e?.message ?? e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="explore">
      <h1>Connections</h1>
      <p className="lede">Connect your semantic layer, check your workspace, and bring your team’s metrics together.</p>
      {canAdmin && <WorkspaceSetup refreshKey={sources} />}

      <div className="ex-head-row">
        <h4 className="ex-h" style={{ margin: 0 }}>Sources</h4>
        <button className="link" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="mlist">
        {sources.map((s) => (
          <div key={s.id} className="mrow">
            <div className="mrow-top">
              <span className={"dot " + s.status} title={s.status} />
              <b>{s.label}</b>
              <span className="base mono">
                {s.adapter}{s.connector ? ` / ${s.connector}` : ""}
              </span>
              {s.id === activeId && <span className="active-badge">Active</span>}
              {s.status === "ready" && s.id !== activeId && (
                <button className="use" onClick={() => onSelect(s.id)}>Use this source →</button>
              )}
              {s.status === "error" && <span className="active-badge err">Unavailable</span>}
              {canAdmin && form === null && confirmRemove !== s.id && (
                <>
                  <button className="link conn-action"
                          onClick={() => setForm({ kind: "edit", id: s.id })}>Edit</button>
                  <button className="link conn-action"
                          onClick={() => { setConfirmRemove(s.id); setRemoveError(null); }}>Remove</button>
                </>
              )}
            </div>
            {s.status === "ready" ? (
              <p className="mono conn-meta">
                {s.tables} tables · {s.metrics} metrics{s.connected ? ` · ${s.connected} connected by Ingest${s.unreviewed ? ` (${s.unreviewed} unreviewed)` : ""}` : ""} · connected in {s.connectMs}ms
              </p>
            ) : (
              <p className="conn-err">{s.error}</p>
            )}
            {s.status === "ready" && s.connected ? <ConnectedTables sourceId={s.id} onChange={onRefresh} /> : null}
            {confirmRemove === s.id && (
              <div className="conn-confirm">
                <span>Remove "{s.label}"? This edits <code className="mono">sources.yaml</code>
                  {" "}right away -- it can be re-added, but not undone from here.</span>
                <button className="link" disabled={removing === s.id}
                        onClick={() => remove(s.id)}>
                  {removing === s.id ? "Removing…" : "Confirm remove"}
                </button>
                <button className="link" disabled={removing === s.id}
                        onClick={() => setConfirmRemove(null)}>Cancel</button>
              </div>
            )}
            {confirmRemove === s.id && removeError && <div className="cform-err">{removeError}</div>}
          </div>
        ))}
        {sources.length === 0 && <div className="empty">No sources configured.</div>}
      </div>

      {canAdmin && <>
      <div className="ex-head-row">
        <h4 className="ex-h" style={{ margin: 0 }}>
          {form?.kind === "edit" ? "Edit source" : "Add a source"}
        </h4>
        {form === null && <button className="link" onClick={() => setForm({ kind: "add" })}>+ Add source</button>}
      </div>
      {form !== null ? (
        <SourceForm
          editId={form.kind === "edit" ? form.id : null}
          onCancel={() => setForm(null)}
          onSaved={() => { setForm(null); onRefresh(); }}
        />
      ) : (
        <p className="tbl-body-p">Connect your warehouse with a read-only account. We test each connection before saving it. Leave saved credentials blank when editing to keep them.</p>
      )}

      <h4 className="ex-h">AI agent</h4>
      <p className="tbl-body-p">Enable story review, explanations, and reference imports with an Anthropic API key. Credentials stay on your server.</p>
      <AiAgentSection />
      </>}

      <h4 className="ex-h">Row-level security</h4>
      <p className="tbl-body-p">
        Every query is scoped server-side to the acting principal on top of whatever the client
        sent, so a client that strips its own filters still only gets governed rows. Policies are
        defined once in <code className="mono">security/policies.yaml</code> and apply across
        every source.
      </p>
      {policies.length > 0 ? (
        <table className="rls-table">
          <thead><tr><th>Policy</th><th>Field</th><th>Claim</th></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td className="mono">{p.field}</td>
                <td className="mono">{p.claim}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty">No RLS policies configured.</div>
      )}

      <h4 className="ex-h">Principals</h4>
      <div className="syns">
        {principals.map((p) => <i key={p.id}>{p.name}</i>)}
        {principals.length === 0 && <span className="conn-meta mono">none configured</span>}
      </div>
    </div>
  );
}

interface AiStatus { configured: boolean; provider: string; model: string }

/**
 * Tables Ingest registered on this source (docs/connected-canvas.md): each is a
 * snapshot, so provenance and "data as of" sit right on the source. Viewers
 * only receive published entries; the server decides who may disconnect.
 */
function ConnectedTables({ sourceId, onChange }: { sourceId: string; onChange: () => void }) {
  const { canEdit, canAdmin, user } = useSession();
  const [tables, setTables] = useState<ConnectedTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const load = () => fetch(`/api/sources/${encodeURIComponent(sourceId)}/connected`).then(readResponse).then((d) => setTables(d.tables)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [sourceId]);
  const disconnect = async (dataset: string) => {
    setBusy(dataset); setError(null);
    try { await fetch(`/api/sources/${encodeURIComponent(sourceId)}/connected/${encodeURIComponent(dataset)}`, { method: "DELETE" }).then(readResponse); onChange(); load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  if (!tables?.length) return error ? <div className="cform-err">{error}</div> : null;
  return <div className="connected-tables">
    {tables.map((t) => <div key={t.dataset} className="connected-table">
      <div className="mrow-top">
        <b className="mono">{t.dataset}</b>
        {t.status === "unreviewed" ? <UnreviewedBadge /> : <span className="active-badge">Published</span>}
        <span className="conn-meta">{t.columns} cols · {t.metrics.length} metrics{t.status === "published" ? ` (${t.metrics.filter((m) => m.reviewed).length} reviewed)` : ""}</span>
        {canAdmin && <button className="link conn-action" disabled={busy === t.dataset} onClick={() => setReviewing(t.dataset)}>Review and publish</button>}
        {canEdit && (user == null || user.id === t.registeredBy || user.role === "admin") &&
          <button className="link conn-action" disabled={busy === t.dataset} onClick={() => disconnect(t.dataset)}>{busy === t.dataset ? "Disconnecting…" : "Disconnect"}</button>}
      </div>
      <p className="mono conn-meta">{t.provenance.source} · {t.provenance.rows.toLocaleString()} rows · loaded by {t.provenance.loadedBy} · {dataAsOf(t)}</p>
      {t.metrics.length > 0 && <div className="syns">{t.metrics.map((m) => <i key={m.name} title={m.name} className={m.reviewed ? "reviewed" : undefined}>{m.label} · {m.reviewed ? "published" : "draft"}</i>)}</div>}
    </div>)}
    {error && <div className="cform-err">{error}</div>}
    {reviewing && <PublishDialog sourceId={sourceId} dataset={reviewing} onClose={() => setReviewing(null)} onPublished={() => { setReviewing(null); onChange(); load(); }} />}
  </div>;
}

/**
 * Same shape as adding a source: nothing is saved until the server has
 * validated it (here, a models.retrieve() auth check rather than a trial
 * connection), and the credential never round-trips back to the browser
 * once it's set -- this section only ever knows "configured" or not.
 */
function AiAgentSection() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = () => fetch("/api/agent/status").then((r) => r.json()).then(setStatus).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/agent/key", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not validate that key."); return; }
      setKey("");
      setEditing(false);
      refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch("/api/agent/key", { method: "DELETE" });
      setConfirmRemove(false);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <>
      <div className="mlist">
        <div className="mrow">
          <div className="mrow-top">
            <span className={"dot " + (status.configured ? "ready" : "error")} />
            <b>Embedded agent</b>
            <span className="base mono">{status.provider}/{status.model}</span>
            {status.configured
              ? <span className="active-badge">Configured</span>
              : <span className="active-badge err">Not configured</span>}
            {!editing && !confirmRemove && (
              <>
                <button className="link conn-action" onClick={() => setEditing(true)}>
                  {status.configured ? "Replace key" : "Add key"}
                </button>
                {status.configured && (
                  <button className="link conn-action" onClick={() => setConfirmRemove(true)}>Remove</button>
                )}
              </>
            )}
          </div>
          <p className="mono conn-meta">
            {status.configured
              ? "Chat panel is live on the canvas."
              : "The chat panel on the canvas stays hidden until a key is added."}
          </p>
          {confirmRemove && (
            <div className="conn-confirm">
              <span>Remove the AI key? The chat panel disappears until a new one is added.</span>
              <button className="link" disabled={busy} onClick={remove}>
                {busy ? "Removing…" : "Confirm remove"}
              </button>
              <button className="link" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <form className="cform" onSubmit={save}>
          <div className="cform-grid">
            <label className="ctl span2">
              <span>Anthropic API key</span>
              <input required type="password" value={key} placeholder="sk-ant-…" autoFocus
                     onChange={(e) => setKey(e.target.value)} />
            </label>
          </div>
          <div className="cform-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Validating…" : "Save"}
            </button>
            <button type="button" className="ghost" disabled={busy}
                    onClick={() => { setEditing(false); setKey(""); setError(null); }}>Cancel</button>
          </div>
          {error && <div className="cform-err">{error}</div>}
        </form>
      )}
    </>
  );
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

type Adapter = "duckglue" | "dbt" | "snowflake-semantic";
type ConnectorType = "duckdb" | "snowflake";
interface FormState {
  id: string; label: string; adapter: Adapter; model: string;
  connectorType: ConnectorType;
  lakeRoot: string; poolSize: string; awsProfile: string; awsRegion: string;
  account: string; username: string; authMethod: "key" | "password";
  privateKey: string; privateKeyPass: string; password: string;
  role: string; warehouse: string; database: string; schema: string;
}
const BLANK_FORM: FormState = {
  id: "", label: "", adapter: "duckglue", model: "",
  connectorType: "duckdb", lakeRoot: "", poolSize: "4", awsProfile: "", awsRegion: "",
  account: "", username: "", authMethod: "key",
  privateKey: "", privateKeyPass: "", password: "",
  role: "", warehouse: "COMPUTE_WH", database: "", schema: "PUBLIC",
};

/**
 * Tests before it saves: the server connects with these exact values first,
 * and only writes .env / sources.yaml on success. So this form fails loud and
 * in place rather than leaving a broken source in the config.
 *
 * In edit mode (editId set) a blank field means "keep the current value" --
 * the server resolves that fallback itself from the existing block, so a
 * credential can be left alone without ever being sent back to the browser
 * (the GET .../config prefill this form loads omits privateKey/password/
 * privateKeyPass for exactly that reason).
 */
function SourceForm({ editId, onCancel, onSaved }: {
  editId: string | null; onCancel: () => void; onSaved: () => void;
}) {
  const isEdit = editId !== null;
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!editId) return;
    fetch(`/api/sources/${encodeURIComponent(editId)}/config`).then((r) => r.json()).then((d) => {
      const c = d.connector ?? {};
      setForm((f) => ({
        ...f, id: d.id ?? editId, label: d.label ?? "", adapter: d.adapter ?? f.adapter,
        model: d.model ?? "", connectorType: c.type ?? f.connectorType,
        lakeRoot: c.lakeRoot ?? "", poolSize: c.poolSize != null ? String(c.poolSize) : f.poolSize,
        awsProfile: c.awsProfile ?? "", awsRegion: c.awsRegion ?? "",
        account: c.account ?? "", username: c.username ?? "",
        role: c.role ?? "", warehouse: c.warehouse ?? f.warehouse, database: c.database ?? "",
        schema: c.schema ?? f.schema,
      }));
      setIdTouched(true);
    }).catch((e) => setError(String(e?.message ?? e))).finally(() => setLoading(false));
  }, [editId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const connector: Record<string, any> = { type: form.connectorType, poolSize: Number(form.poolSize) };
    if (form.connectorType === "duckdb") {
      connector.lakeRoot = form.lakeRoot;
      if (form.lakeRoot.startsWith("s3://") || form.awsProfile) { connector.awsProfile = form.awsProfile || undefined; connector.awsRegion = form.awsRegion || undefined; }
    } else {
      Object.assign(connector, {
        account: form.account, username: form.username,
        role: form.role || undefined, warehouse: form.warehouse,
        database: form.database, schema: form.schema,
      });
      if (form.authMethod === "key") {
        connector.privateKey = form.privateKey;
        connector.privateKeyPass = form.privateKeyPass || undefined;
      } else {
        connector.password = form.password;
      }
    }
    try {
      const r = await fetch(isEdit ? `/api/sources/${encodeURIComponent(editId!)}` : "/api/sources", {
        method: isEdit ? "PUT" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(isEdit ? {} : { id: form.id }), label: form.label || form.id,
          adapter: form.adapter, model: form.model, connector,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not connect."); return; }
      onSaved();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="cform"><span className="conn-meta">Loading…</span></div>;

  return (
    <form className="cform" onSubmit={submit}>
      <div className="cform-grid">
        <label className="ctl">
          <span>Label</span>
          <input required value={form.label} placeholder="dbt on Snowflake"
                 onChange={(e) => {
                   const v = e.target.value;
                   setForm((f) => ({ ...f, label: v, id: idTouched ? f.id : slugify(v) }));
                 }} />
        </label>
        <label className="ctl">
          <span>ID</span>
          <input required disabled={isEdit} pattern="[a-z][a-z0-9-]*" value={form.id}
                 placeholder="dbt-snowflake"
                 onChange={(e) => { set("id", slugify(e.target.value)); setIdTouched(true); }} />
        </label>

        <label className="ctl">
          <span>Semantic adapter</span>
          <select value={form.adapter}
                  onChange={(e) => {
                    const a = e.target.value as Adapter;
                    // The semantic model lives in Snowflake either way here,
                    // so default the connector to match -- still overridable.
                    setForm((f) => ({ ...f, adapter: a,
                      connectorType: a === "snowflake-semantic" ? "snowflake" : f.connectorType,
                      poolSize: a === "snowflake-semantic" && f.connectorType !== "snowflake" ? "6" : f.poolSize }));
                  }}>
            <option value="duckglue">duckglue</option>
            <option value="dbt">dbt (semantic manifest / MetricFlow)</option>
            <option value="snowflake-semantic">Snowflake semantic model (Cortex Analyst)</option>
          </select>
        </label>
        <label className="ctl">
          <span>Connector</span>
          <select value={form.connectorType}
                  onChange={(e) => {
                    const t = e.target.value as ConnectorType;
                    setForm((f) => ({ ...f, connectorType: t, poolSize: t === "snowflake" ? "6" : "4" }));
                  }}>
            <option value="duckdb">DuckDB</option>
            <option value="snowflake">Snowflake</option>
          </select>
        </label>

        <label className="ctl span2">
          <span>Model path</span>
          <input required value={form.model}
                 placeholder={form.adapter === "duckglue" ? "~/path/to/warehouse.yaml"
                   : form.adapter === "dbt" ? "~/path/to/dbt/target"
                   : "~/path/to/semantic_model.yaml"}
                 onChange={(e) => set("model", e.target.value)} />
        </label>

        {form.adapter !== "dbt" && <label className="ctl span2"><span>Or upload your semantic model</span><input type="file" accept=".yaml,.yml" disabled={busy} onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
          setBusy(true); setError(null);
          try {
            if (file.size > 5 * 1024 * 1024) throw new Error("Semantic model exceeds 5 MB");
            const r = await fetch("/api/setup/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: await file.text(), adapter: form.adapter }) });
            const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Upload failed"); set("model", d.path);
          } catch (error: any) { setError(error.message); } finally { setBusy(false); }
        }} /><small>The model stays on your server. The connection test validates it before the source is saved.</small></label>}
        {form.adapter === "dbt" && <p className="span2">Mount your dbt target folder on the server, including manifest.json and semantic_manifest.json.</p>}

        {form.connectorType === "duckdb" ? (
          <>
            <label className="ctl span2">
              <span>Lake root</span>
              <input required={!isEdit} value={form.lakeRoot}
                     placeholder={isEdit ? "unchanged if left blank" : "~/path/to/lake"}
                     onChange={(e) => set("lakeRoot", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Pool size</span>
              <input type="number" min={1} value={form.poolSize}
                     onChange={(e) => set("poolSize", e.target.value)} />
            </label>
            {(form.lakeRoot.startsWith("s3://") || form.awsProfile) && <>
              <p className="span2">An S3 lake signs requests with a named profile from the server's <code>~/.aws/config</code> (an SSO login or an assumed role). No key is stored here.</p>
              <label className="ctl">
                <span>AWS profile</span>
                <input value={form.awsProfile} placeholder="lake-reader"
                       onChange={(e) => set("awsProfile", e.target.value)} />
              </label>
              <label className="ctl">
                <span>Bucket region</span>
                <input value={form.awsRegion} placeholder="us-east-2"
                       onChange={(e) => set("awsRegion", e.target.value)} />
              </label>
            </>}
          </>
        ) : (
          <>
            <label className="ctl">
              <span>Account</span>
              <input required={!isEdit} value={form.account} onChange={(e) => set("account", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Username</span>
              <input required={!isEdit} value={form.username} onChange={(e) => set("username", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Auth method</span>
              <select value={form.authMethod} onChange={(e) => set("authMethod", e.target.value as any)}>
                <option value="key">Key pair (recommended for a service account)</option>
                <option value="password">Password</option>
              </select>
            </label>
            {form.authMethod === "key" ? (
              <>
                <label className="ctl">
                  <span>Private key</span>
                  <input required={!isEdit} value={form.privateKey}
                         placeholder={isEdit ? "unchanged if left blank" : "-----BEGIN PRIVATE KEY-----"}
                         onChange={(e) => set("privateKey", e.target.value)} />
                </label>
                <label className="ctl">
                  <span>Private key passphrase (optional)</span>
                  <input value={form.privateKeyPass}
                         placeholder={isEdit ? "unchanged if left blank" : undefined}
                         onChange={(e) => set("privateKeyPass", e.target.value)} />
                </label>
              </>
            ) : (
              <label className="ctl">
                <span>Password</span>
                <input required={!isEdit} type="password" value={form.password}
                       placeholder={isEdit ? "unchanged if left blank" : undefined}
                       onChange={(e) => set("password", e.target.value)} />
              </label>
            )}
            <label className="ctl">
              <span>Role (optional)</span>
              <input value={form.role}
                     placeholder={isEdit ? "unchanged if left blank" : undefined}
                     onChange={(e) => set("role", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Warehouse</span>
              <input value={form.warehouse} onChange={(e) => set("warehouse", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Database</span>
              <input required={!isEdit} value={form.database} onChange={(e) => set("database", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Schema</span>
              <input value={form.schema} onChange={(e) => set("schema", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Pool size</span>
              <input type="number" min={1} value={form.poolSize}
                     onChange={(e) => set("poolSize", e.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="cform-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Connecting…" : isEdit ? "Save" : "Connect"}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <div className="cform-err">{error}</div>}
    </form>
  );
}
