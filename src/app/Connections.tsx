import { useSession } from "./Session.tsx";
import { WorkspaceSetup } from "./WorkspaceSetup.tsx";
import { ClaudeConnection } from "./ClaudeConnection.tsx";
import { ChatgptConnection } from "./ChatgptConnection.tsx";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { readResponse } from "./http.ts";
import type { ConnectedProvenance } from "../semantic/model.ts";
import { UnreviewedBadge, dataAsOf } from "./connected.tsx";
import { PublishDialog } from "./PublishDialog.tsx";
import { PrivateKeyInput } from "./PrivateKeyInput.tsx";

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
  const [refreshingSheet, setRefreshingSheet] = useState<string | null>(null);
  const [sheetRefreshMsg, setSheetRefreshMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  const refreshSpreadsheet = async (sourceId: string, file?: File | null) => {
    if (!file) return;
    setRefreshingSheet(sourceId);
    setSheetRefreshMsg((prev) => ({ ...prev, [sourceId]: { ok: true, text: "Updating spreadsheet data…" } }));
    try {
      const lower = file.name.toLowerCase();
      let format: "csv" | "xlsx";
      let content: string;
      if (lower.endsWith(".xlsx")) {
        format = "xlsx";
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        content = btoa(binary);
      } else {
        format = "csv";
        content = await file.text();
      }
      const res = await fetch(`/api/modeler/spreadsheet/refresh/${encodeURIComponent(sourceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, format, content }),
      }).then(readResponse);
      setSheetRefreshMsg((prev) => ({
        ...prev,
        [sourceId]: { ok: true, text: `Refreshed ${res.rowsUpdated} rows across ${(res.tablesUpdated ?? []).join(", ")}.` },
      }));
      onRefresh();
    } catch (e: any) {
      setSheetRefreshMsg((prev) => ({ ...prev, [sourceId]: { ok: false, text: String(e?.message ?? e) } }));
    } finally {
      setRefreshingSheet(null);
    }
  };

  const remove = async (id: string) => {
    setRemoving(id);
    setRemoveError(null);
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
      await readResponse(r);
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
      {canAdmin && <ClaudeConnection key={`claude:${activeId}`} source={activeId} label={sources.find(s => s.id === activeId)?.label ?? "your source"} />}
      {canAdmin && <ChatgptConnection key={`chatgpt:${activeId}`} source={activeId} label={sources.find(s => s.id === activeId)?.label ?? "your source"} principals={principals} />}

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
                  {s.connector?.toLowerCase().includes("duckdb") && s.id !== "sample-warehouse" && (
                    <label className="link conn-action" style={{ cursor: "pointer" }} title="Upload an updated .xlsx or .csv file to refresh this source in place">
                      {refreshingSheet === s.id ? "Refreshing…" : "↻ Refresh sheet"}
                      <input
                        type="file"
                        accept=".xlsx,.csv,.tsv"
                        hidden
                        disabled={refreshingSheet !== null}
                        onChange={(e) => {
                          void refreshSpreadsheet(s.id, e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  )}
                  <button className="link conn-action"
                          onClick={() => setForm({ kind: "edit", id: s.id })}>Edit</button>
                  <button className="link conn-action"
                          onClick={() => { setConfirmRemove(s.id); setRemoveError(null); }}>Remove</button>
                </>
              )}
            </div>
            {sheetRefreshMsg[s.id] && (
              <p className={sheetRefreshMsg[s.id].ok ? "conn-meta" : "conn-err"} role="status">
                {sheetRefreshMsg[s.id].text}
              </p>
            )}
            {s.status === "ready" ? (
              <p className="mono conn-meta">
                {s.tables} tables · {s.metrics} metrics{s.connected ? ` · ${s.connected} connected by Ingest${s.unreviewed ? ` (${s.unreviewed} unreviewed)` : ""}` : ""}{s.connectMs != null && Number.isFinite(s.connectMs) ? ` · connected in ${s.connectMs}ms` : ""}
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
      <p className="tbl-body-p">Enable story review, explanations, and reference imports with an Anthropic, OpenAI, Gemini, or OpenAI-compatible API key. Credentials stay on your server.</p>
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

const aiStatusSchema = z.object({ configured: z.boolean(), provider: z.string().optional(), model: z.string().optional(), baseUrl: z.string().optional(), issue: z.string().nullable().optional(), canSetKey: z.boolean().optional() });
type AiStatus = z.infer<typeof aiStatusSchema>;
const DEFAULT_AI_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.4",
  gemini: "gemini-2.5-pro",
  "openai-compatible": "gpt-4o",
};

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
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-opus-5");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setStatusError(null);
    fetch("/api/agent/status", { signal: controller.signal }).then(readResponse).then(value => {
      const parsed = aiStatusSchema.safeParse(value);
      if (!parsed.success) throw new Error("The server returned an invalid AI status. Try loading it again.");
      if (!controller.signal.aborted) {
        setStatus(parsed.data);
        const p = parsed.data.provider ?? "anthropic";
        setProvider(p);
        setModel(parsed.data.model ?? (DEFAULT_AI_MODELS[p] ?? "claude-opus-5"));
        setBaseUrl(parsed.data.baseUrl ?? "");
      }
    }).catch(e => { if (!controller.signal.aborted) setStatusError(String(e?.message ?? e)); });
    return () => controller.abort();
  }, [statusAttempt]);

  const save = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const defaultProvider = status?.provider ?? "anthropic";
      const defaultModel = status?.model ?? (DEFAULT_AI_MODELS[defaultProvider] ?? "claude-opus-5");
      const defaultBaseUrl = status?.baseUrl ?? "";
      const body = provider === defaultProvider && model === defaultModel && baseUrl.trim() === defaultBaseUrl
        ? { apiKey: key }
        : {
            apiKey: key,
            provider,
            model: model.trim(),
            ...(provider === "openai-compatible" || baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          };
      const r = await fetch("/api/agent/key", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await readResponse(r);
      setKey("");
      setEditing(false);
      setStatusAttempt(attempt => attempt + 1);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await fetch("/api/agent/key", { method: "DELETE" }).then(readResponse);
      setConfirmRemove(false);
      setStatusAttempt(attempt => attempt + 1);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <section className="cform" aria-label="Embedded agent connection">
    {statusError ? <><p className="cform-err" role="alert">Could not load AI connection status. {statusError}</p>
      <div className="cform-actions"><button onClick={() => setStatusAttempt(attempt => attempt + 1)}>Retry AI status</button></div></>
      : <p className="conn-meta" role="status">Loading AI connection status…</p>}
  </section>;

  return (
    <section aria-label="Embedded agent connection">
      <div className="mlist">
        <div className="mrow">
          <div className="mrow-top">
            <span className={"dot " + (status.configured ? "ready" : "error")} />
            <b>Embedded agent</b>
            <span className="base mono">{[status.provider, status.model].filter(Boolean).join(" / ")}</span>
            {status.configured
              ? <span className="active-badge">Configured</span>
              : <span className="active-badge err">Not configured</span>}
            {!editing && !confirmRemove && (
              <>
                <button className="link conn-action" disabled={status.canSetKey === false} onClick={() => { setError(null); setEditing(true); }}>
                  {status.configured ? "Replace key" : "Add key"}
                </button>
                {status.configured && (
                  <button className="link conn-action" onClick={() => { setError(null); setConfirmRemove(true); }}>Remove</button>
                )}
              </>
            )}
          </div>
          <p className="mono conn-meta">
            {status.configured
              ? "An AI credential is configured. Availability is checked when you use an AI feature."
              : status.issue ?? "The chat panel on the canvas stays hidden until a key is added."}
          </p>
          {confirmRemove && (
            <div className="conn-confirm">
              <span>Remove the AI key? The chat panel disappears until a new one is added.</span>
              <button className="link" disabled={busy} onClick={remove}>
                {busy ? "Removing…" : "Confirm remove"}
              </button>
              <button className="link" disabled={busy} onClick={() => { setConfirmRemove(false); setError(null); }}>Cancel</button>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <form className="cform" onSubmit={save}>
          <div className="cform-grid">
            <label className="ctl">
              <span>Provider</span>
              <select aria-label="Provider" disabled={busy} value={provider}
                      onChange={(e) => {
                        const next = e.target.value;
                        setProvider(next);
                        setModel(DEFAULT_AI_MODELS[next] ?? "claude-opus-5");
                        if (next !== "openai-compatible") setBaseUrl("");
                      }}>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </label>
            <label className="ctl">
              <span>Model</span>
              <input required disabled={busy} value={model}
                     placeholder={DEFAULT_AI_MODELS[provider] ?? "claude-opus-5"}
                     onChange={(e) => setModel(e.target.value)} />
            </label>
            {provider === "openai-compatible" && (
              <label className="ctl span2">
                <span>Base URL</span>
                <input required disabled={busy} value={baseUrl}
                       placeholder="https://your-gateway.example.com/v1"
                       onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
            )}
            <label className="ctl span2">
              <span>{provider === "anthropic" ? "Anthropic API key" : provider === "openai" ? "OpenAI API key" : provider === "gemini" ? "Gemini API key" : "API key"}</span>
              <input required type="password" disabled={busy} value={key}
                     placeholder={provider === "anthropic" ? "sk-ant-…" : provider === "openai" ? "sk-…" : provider === "gemini" ? "AIza…" : "Bearer token or API key"}
                     autoFocus
                     onChange={(e) => setKey(e.target.value)} />
            </label>
          </div>
          <div className="cform-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Validating…" : "Save"}
            </button>
            <button type="button" className="ghost" disabled={busy}
                    onClick={() => {
                      setEditing(false); setKey(""); setError(null);
                      const p = status.provider ?? "anthropic";
                      setProvider(p);
                      setModel(status.model ?? (DEFAULT_AI_MODELS[p] ?? "claude-opus-5"));
                      setBaseUrl(status.baseUrl ?? "");
                    }}>Cancel</button>
          </div>
        </form>
      )}
      {error && <div className="cform-err" role="alert">{error}</div>}
    </section>
  );
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

type Adapter = "duckglue" | "dbt" | "snowflake-semantic";
type ConnectorType = "duckdb" | "snowflake" | "postgres" | "bigquery";
interface FormState {
  id: string; label: string; adapter: Adapter; model: string;
  connectorType: ConnectorType;
  lakeRoot: string; poolSize: string; awsProfile: string; awsRegion: string;
  account: string; username: string; authMethod: "key" | "password";
  privateKey: string; privateKeyPass: string; password: string;
  role: string; warehouse: string; database: string; schema: string;
  connectionString: string; host: string; port: string; ssl: boolean;
  projectId: string; dataset: string; location: string; credentialsJson: string;
}
const BLANK_FORM: FormState = {
  id: "", label: "", adapter: "duckglue", model: "",
  connectorType: "duckdb", lakeRoot: "", poolSize: "4", awsProfile: "", awsRegion: "",
  account: "", username: "", authMethod: "key",
  privateKey: "", privateKeyPass: "", password: "",
  role: "", warehouse: "COMPUTE_WH", database: "", schema: "PUBLIC",
  connectionString: "", host: "", port: "5432", ssl: true,
  projectId: "", dataset: "", location: "US", credentialsJson: "",
};
const sourceConfigSchema = z.object({
  id: z.string().min(1), label: z.string().optional(), model: z.string().min(1),
  adapter: z.enum(["duckglue", "dbt", "snowflake-semantic"]),
  connector: z.object({
    type: z.enum(["duckdb", "snowflake", "postgres", "bigquery"]).default("duckdb"),
    poolSize: z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number().int().positive()).optional(),
    lakeRoot: z.string().optional(), awsProfile: z.string().optional(), awsRegion: z.string().optional(),
    account: z.string().optional(), username: z.string().optional(), role: z.string().optional(),
    warehouse: z.string().optional(), database: z.string().optional(), schema: z.string().optional(),
    host: z.string().optional(), port: z.union([z.number(), z.string()]).optional(), ssl: z.union([z.boolean(), z.string()]).optional(),
    projectId: z.string().optional(), dataset: z.string().optional(), location: z.string().optional(),
  }),
});

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!editId) return;
    const controller = new AbortController();
    setLoading(true); setLoadError(null);
    fetch(`/api/sources/${encodeURIComponent(editId)}/config`, { signal: controller.signal }).then(readResponse).then((value) => {
      const parsed = sourceConfigSchema.safeParse(value);
      if (!parsed.success || parsed.data.id !== editId) throw new Error("The server returned incomplete or mismatched source settings. Reload them before editing.");
      if (controller.signal.aborted) return;
      const d = parsed.data, c = d.connector;
      setForm((f) => ({
        ...BLANK_FORM, id: d.id, label: d.label ?? d.id, adapter: d.adapter,
        model: d.model, connectorType: c.type,
        lakeRoot: c.lakeRoot ?? "", poolSize: c.poolSize != null ? String(c.poolSize) : f.poolSize,
        awsProfile: c.awsProfile ?? "", awsRegion: c.awsRegion ?? "",
        account: c.account ?? "", username: c.username ?? "",
        role: c.role ?? "", warehouse: c.warehouse ?? f.warehouse, database: c.database ?? "",
        schema: c.schema ?? (c.type === "postgres" ? "public" : f.schema),
        host: c.host ?? "", port: c.port != null ? String(c.port) : "5432",
        ssl: c.ssl === true || c.ssl === "true" || c.ssl === "require",
        projectId: c.projectId ?? "", dataset: c.dataset ?? "", location: c.location ?? "US",
      }));
      setIdTouched(true);
    }).catch((e) => { if (!controller.signal.aborted) setLoadError(String(e?.message ?? e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [editId, loadAttempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy || loading || loadError) return;
    setError(null);
    setBusy(true);
    const connector: Record<string, any> = { type: form.connectorType, poolSize: Number(form.poolSize) };
    if (form.connectorType === "duckdb") {
      connector.lakeRoot = form.lakeRoot;
      if (form.lakeRoot.startsWith("s3://") || form.awsProfile) { connector.awsProfile = form.awsProfile || undefined; connector.awsRegion = form.awsRegion || undefined; }
    } else if (form.connectorType === "postgres") {
      Object.assign(connector, {
        connectionString: form.connectionString || undefined,
        host: form.host || undefined,
        port: form.port || undefined,
        database: form.database || undefined,
        username: form.username || undefined,
        password: form.password || undefined,
        schema: form.schema || "public",
        ssl: form.ssl ? "true" : "false",
      });
    } else if (form.connectorType === "bigquery") {
      Object.assign(connector, {
        projectId: form.projectId,
        dataset: form.dataset,
        location: form.location || undefined,
        credentialsJson: form.credentialsJson || undefined,
      });
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
      await readResponse(r);
      onSaved();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (loading || loadError) return <section className="cform" aria-label="Source settings">
    {loading ? <p className="conn-meta" role="status">Loading saved source settings…</p>
      : <p className="cform-err" role="alert">Could not load saved source settings. {loadError}</p>}
    <div className="cform-actions">
      {loadError && <button onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry loading source</button>}
      <button onClick={onCancel}>Cancel</button>
    </div>
  </section>;

  return (
    <form className="cform" aria-label={isEdit ? "Edit source" : "Add source"} onSubmit={submit}>
      <fieldset className="cform-grid" disabled={busy}>
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
          <select aria-label="Semantic adapter" value={form.adapter}
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
          <select aria-label="Connector" value={form.connectorType}
                  onChange={(e) => {
                    const t = e.target.value as ConnectorType;
                    setForm((f) => ({
                      ...f,
                      connectorType: t,
                      schema: t === "postgres" && f.schema === "PUBLIC" ? "public" : f.schema,
                      poolSize: t === "snowflake" || t === "postgres" ? "6" : "4",
                    }));
                  }}>
            <option value="duckdb">DuckDB (Parquet / CSV / S3)</option>
            <option value="postgres">PostgreSQL (Supabase / RDS / Neon)</option>
            <option value="bigquery">Google BigQuery</option>
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
          const file = e.target.files?.[0]; e.target.value = ""; if (!file || busy) return;
          setBusy(true); setError(null);
          try {
            if (file.size > 5 * 1024 * 1024) throw new Error("Semantic model exceeds 5 MB");
            const r = await fetch("/api/setup/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: await file.text(), adapter: form.adapter }) });
            const d = await readResponse(r); set("model", d.path);
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
        ) : form.connectorType === "postgres" ? (
          <>
            <label className="ctl span2">
              <span>Connection string (optional — or fill host &amp; credentials below)</span>
              <input type="password" value={form.connectionString}
                     placeholder={isEdit ? "unchanged if left blank" : "postgres://reader:pass@db.example.com:5432/analytics"}
                     onChange={(e) => set("connectionString", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Host</span>
              <input required={!isEdit && !form.connectionString} value={form.host} placeholder="db.example.com"
                     onChange={(e) => set("host", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Port</span>
              <input value={form.port} placeholder="5432" onChange={(e) => set("port", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Database</span>
              <input required={!isEdit && !form.connectionString} value={form.database} placeholder="analytics"
                     onChange={(e) => set("database", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Schema</span>
              <input value={form.schema} placeholder="public" onChange={(e) => set("schema", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Username</span>
              <input required={!isEdit && !form.connectionString} value={form.username} placeholder="analytics_ro"
                     onChange={(e) => set("username", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Password</span>
              <input type="password" value={form.password} placeholder={isEdit ? "unchanged if left blank" : ""}
                     onChange={(e) => set("password", e.target.value)} />
            </label>
            <label className="ctl span2" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.ssl} onChange={(e) => set("ssl", e.target.checked)} />
              <span>Require TLS / SSL (recommended for Supabase, Neon, and RDS)</span>
            </label>
          </>
        ) : form.connectorType === "bigquery" ? (
          <>
            <label className="ctl">
              <span>GCP Project ID</span>
              <input required={!isEdit} value={form.projectId} placeholder="my-analytics-prod"
                     onChange={(e) => set("projectId", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Dataset</span>
              <input required={!isEdit} value={form.dataset} placeholder="analytics_marts"
                     onChange={(e) => set("dataset", e.target.value)} />
            </label>
            <label className="ctl">
              <span>Location</span>
              <input value={form.location} placeholder="US" onChange={(e) => set("location", e.target.value)} />
            </label>
            <label className="ctl span2">
              <span>Service Account JSON (read-only BigQuery Data Viewer + Job User)</span>
              <textarea rows={4} required={!isEdit} value={form.credentialsJson}
                        placeholder={isEdit ? "Leave blank to keep saved service account credentials" : '{"type":"service_account","client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n..."}'}
                        onChange={(e) => set("credentialsJson", e.target.value)} />
            </label>
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
              <select aria-label="Auth method" value={form.authMethod} onChange={(e) => set("authMethod", e.target.value as any)}>
                <option value="key">Key pair (recommended for a service account)</option>
                <option value="password">Password</option>
              </select>
            </label>
            {form.authMethod === "key" ? (
              <>
                <PrivateKeyInput required={!isEdit} value={form.privateKey}
                  placeholder={isEdit ? "unchanged if left blank" : "Paste your PEM private key"}
                  onChange={value => set("privateKey", value)} />
                <label className="ctl">
                  <span>Private key passphrase (optional)</span>
                  <input type="password" value={form.privateKeyPass}
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
      </fieldset>

      <div className="cform-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Connecting…" : isEdit ? "Save" : "Connect"}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <div className="cform-err" role="alert">{error}</div>}
    </form>
  );
}
