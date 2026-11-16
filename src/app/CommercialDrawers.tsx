import { useEffect, useState } from "react";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import { metricOf, type Model } from "../semantic/model.ts";
import { dashboardToYaml, diffDashboardSpecs } from "../store/codeSync.ts";
import { slugForFilename } from "./export.ts";
import { readResponse } from "./http.ts";
import { StudioDialog } from "./StudioDialog.tsx";

export interface DigestHighlightView {
  tileId: string;
  title: string;
  metric: string;
  label: string;
  formattedValue: string;
  delta: number | null;
  percentChange: number | null;
  period: string | null;
}

export interface NormalizedExecutiveDigest {
  headline: string;
  briefFingerprint: string | null;
  highlights: DigestHighlightView[];
  scopeNotes: string[];
  markdown: string;
  html: string;
  bundle: unknown;
}

export function buildLocalDigestPreview(spec: DashboardSpec, model: Model): NormalizedExecutiveDigest {
  const metricTiles = spec.tiles.filter(
    (t) => (!t.kind || t.kind === "metric") && Array.isArray(t.metrics) && t.metrics.length > 0,
  );
  const highlights: DigestHighlightView[] = [];
  for (const tile of metricTiles) {
    const title = tile.title ?? tile.metrics.map((m) => metricOf(model, m)?.label ?? m).join(", ");
    for (const metricName of tile.metrics) {
      const m = metricOf(model, metricName);
      highlights.push({
        tileId: tile.id,
        title,
        metric: metricName,
        label: m?.label ?? metricName,
        formattedValue: "Draft preview",
        delta: null,
        percentChange: null,
        period: (tile.dimensions ?? []).find((d) => d.includes(":")) ?? null,
      });
    }
  }
  const headline = `${spec.title} — ${metricTiles.length} metric ${metricTiles.length === 1 ? "tile" : "tiles"} (${highlights.length} governed ${highlights.length === 1 ? "measure" : "measures"})`;
  const scopeNotes = [
    "Unsaved draft preview. Save the dashboard to compute warehouse-verified values and a SHA-256 signature.",
  ];
  const markdown = [
    `# ${spec.title} — Executive Digest (Draft)`,
    "",
    `## Headline Summary`,
    `- ${headline}`,
    ...highlights.map((h) => `- ${h.title} (${h.label}): ${h.formattedValue}`),
  ].join("\n");
  const html = `<article class="executive-digest"><h1>${spec.title} — Executive Digest</h1><p>${headline}</p></article>`;
  return {
    headline,
    briefFingerprint: null,
    highlights,
    scopeNotes,
    markdown,
    html,
    bundle: {
      version: 1,
      title: spec.title,
      generatedAt: new Date().toISOString(),
      specSummary: { tiles: spec.tiles.length },
    },
  };
}

export function normalizeDigestPayload(
  raw: any,
  spec: DashboardSpec,
  model: Model,
): NormalizedExecutiveDigest {
  const d = raw?.digest ?? raw ?? {};
  const rawHighlights: any[] = Array.isArray(d.highlights)
    ? d.highlights
    : Array.isArray(raw?.highlights)
      ? raw.highlights
      : Array.isArray(d.kpis)
        ? d.kpis
        : [];
  const highlights: DigestHighlightView[] = rawHighlights.map((item, idx) => ({
    tileId: String(item.tileId ?? `kpi-${idx}`),
    title: String(item.title ?? item.label ?? item.metric ?? "Metric"),
    metric: String(item.metric ?? item.label ?? "metric"),
    label: String(item.label ?? (item.metric ? metricOf(model, item.metric)?.label : undefined) ?? item.title ?? "Metric"),
    formattedValue: String(item.formattedValue ?? item.headlineValue ?? item.value ?? "N/A"),
    delta: typeof item.delta === "number" ? item.delta : null,
    percentChange: typeof item.percentChange === "number" ? item.percentChange : null,
    period: typeof item.period === "string" ? item.period : null,
  }));
  const headline = String(
    d.headline ??
      raw?.headline ??
      (Array.isArray(d.headlineBullets) && d.headlineBullets[0]) ??
      `${d.title ?? spec.title} — Executive Digest`,
  );
  const briefFingerprint =
    typeof (d.briefFingerprint ?? raw?.briefFingerprint ?? raw?.bundle?.signatureHash ?? d.provenanceHash) === "string"
      ? String(d.briefFingerprint ?? raw?.briefFingerprint ?? raw?.bundle?.signatureHash ?? d.provenanceHash)
      : null;
  const scopeNotes: string[] = Array.isArray(d.scopeNotes)
    ? d.scopeNotes.map(String)
    : Array.isArray(raw?.scopeNotes)
      ? raw.scopeNotes.map(String)
      : Array.isArray(d.caveats)
        ? d.caveats.map(String)
        : [];
  const markdown = String(
    d.markdown ??
      raw?.markdown ??
      `# ${spec.title} — Executive Digest\n\n${headline}`,
  );
  const html = String(
    d.html ??
      raw?.html ??
      `<article class="executive-digest"><h1>${spec.title} — Executive Digest</h1><p>${headline}</p></article>`,
  );
  const bundle = raw?.bundle ?? raw;
  return {
    headline,
    briefFingerprint,
    highlights,
    scopeNotes,
    markdown,
    html,
    bundle,
  };
}

function downloadJsonBundle(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExecutiveDigestDialog({
  dashboardId,
  spec,
  model,
  onClose,
}: {
  dashboardId: string | null;
  spec: DashboardSpec;
  model: Model;
  onClose: () => void;
}) {
  const [digest, setDigest] = useState<NormalizedExecutiveDigest>(() =>
    buildLocalDigestPreview(spec, model),
  );
  const [loading, setLoading] = useState(Boolean(dashboardId));
  const [error, setError] = useState("");
  const [copiedKind, setCopiedKind] = useState<"" | "md" | "html">("");

  useEffect(() => {
    if (!dashboardId) {
      setDigest(buildLocalDigestPreview(spec, model));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/digest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(readResponse)
      .then((res) => {
        if (!active) return;
        setDigest(normalizeDigestPayload(res, spec, model));
        setLoading(false);
      })
      .catch((e: any) => {
        if (!active) return;
        setError(e?.message ?? "Could not generate executive digest");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dashboardId, spec, model]);

  const copyText = (text: string, kind: "md" | "html") => {
    void navigator.clipboard?.writeText(text);
    setCopiedKind(kind);
  };

  return (
    <StudioDialog title="Executive Digest & Verified Brief" wide onClose={onClose}>
      <div className="commercial-drawer digest-drawer">
        {!dashboardId && (
          <p className="muted sm" role="status">
            Save this dashboard once to generate a server-verified SHA-256 Executive Digest, or preview the local summary below.
          </p>
        )}
        {loading && <p className="muted sm" role="status">Computing governed KPIs and SHA-256 provenance…</p>}
        {error && <p className="sm" role="alert">{error}</p>}

        <section className="ins-sec">
          <div className="mini-row">
            <h5>Headline Summary</h5>
            {digest.briefFingerprint && (
              <span className="badge sha256-badge" title={digest.briefFingerprint}>
                SHA-256 · {digest.briefFingerprint.slice(0, 12)}…
              </span>
            )}
          </div>
          <p><b>{digest.headline}</b></p>
        </section>

        <section className="ins-sec">
          <h5>Metric Highlights</h5>
          {digest.highlights.length === 0 ? (
            <p className="muted sm">No metric tiles on this dashboard yet.</p>
          ) : (
            <ul className="digest-highlights">
              {digest.highlights.map((h) => (
                <li key={`${h.tileId}:${h.metric}`}>
                  <b>{h.label}</b> ({h.title}): <span>{h.formattedValue}</span>
                  {h.delta !== null && (
                    <em>
                      {" "}
                      · Δ {h.delta > 0 ? `+${h.delta}` : h.delta}
                      {h.percentChange !== null ? ` (${(h.percentChange * 100).toFixed(1)}%)` : ""}
                    </em>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ins-sec">
          <h5>Scope & Data Honesty Notes</h5>
          {digest.scopeNotes.length === 0 ? (
            <p className="muted sm">All queried periods are complete and backed by reviewed metrics.</p>
          ) : (
            <ul className="digest-notes">
              {digest.scopeNotes.map((note, idx) => (
                <li key={idx}>{note}</li>
              ))}
            </ul>
          )}
        </section>

        <footer className="story-actions">
          <button onClick={() => copyText(digest.markdown, "md")}>
            {copiedKind === "md" ? "Copied Markdown" : "Copy Markdown"}
          </button>
          <button onClick={() => copyText(digest.html, "html")}>
            {copiedKind === "html" ? "Copied HTML" : "Copy HTML"}
          </button>
          <button
            className="primary"
            onClick={() =>
              downloadJsonBundle(`${slugForFilename(spec.title)}-verified-brief.json`, digest.bundle)
            }
          >
            Download Verified Brief (.json)
          </button>
        </footer>
      </div>
    </StudioDialog>
  );
}

export interface YamlDiffSummaryView {
  addedTiles: number;
  removedTiles: number;
  modifiedTiles: number;
  changedFilters: number;
}

export function buildStarterYaml(
  dashboardId: string | null,
  spec: DashboardSpec,
  canvas: CanvasSpec,
): string {
  return dashboardToYaml({
    id: dashboardId ?? "draft-dashboard",
    name: spec.title,
    spec,
    canvas,
  });
}

export function buildYamlImportPayload(
  yaml: string,
  currentSpec: DashboardSpec,
  dryRun = true,
) {
  return {
    yaml,
    dryRun,
    currentSpec,
  };
}

export function summarizeYamlDiff(result: any, currentSpec: DashboardSpec): YamlDiffSummaryView {
  if (result?.diff?.summary) {
    return {
      addedTiles: Number(result.diff.summary.addedTiles ?? 0),
      removedTiles: Number(result.diff.summary.removedTiles ?? 0),
      modifiedTiles: Number(result.diff.summary.modifiedTiles ?? 0),
      changedFilters: Number(result.diff.summary.changedFilters ?? 0),
    };
  }
  const d =
    result?.diff ??
    (result?.spec ? diffDashboardSpecs(currentSpec, result.spec) : null);
  return {
    addedTiles: Array.isArray(d?.addedTiles) ? d.addedTiles.length : Number(d?.addedTiles ?? 0),
    removedTiles: Array.isArray(d?.removedTiles) ? d.removedTiles.length : Number(d?.removedTiles ?? 0),
    modifiedTiles: Array.isArray(d?.modifiedTiles) ? d.modifiedTiles.length : Number(d?.modifiedTiles ?? 0),
    changedFilters:
      typeof d?.changedFilters === "number"
        ? d.changedFilters
        : (Array.isArray(d?.filterChanges?.added) ? d.filterChanges.added.length : 0) +
          (Array.isArray(d?.filterChanges?.removed) ? d.filterChanges.removed.length : 0),
  };
}

export function YamlCodeSyncDialog({
  dashboardId,
  spec,
  canvas,
  onApply,
  onClose,
}: {
  dashboardId: string | null;
  spec: DashboardSpec;
  canvas: CanvasSpec;
  onApply: (spec: DashboardSpec, canvas?: CanvasSpec) => void;
  onClose: () => void;
}) {
  const [yaml, setYaml] = useState<string>(() => buildStarterYaml(dashboardId, spec, canvas));
  const [loading, setLoading] = useState(Boolean(dashboardId));
  const [error, setError] = useState("");
  const [validatedResult, setValidatedResult] = useState<{
    spec: DashboardSpec;
    canvas?: CanvasSpec;
    summary: YamlDiffSummaryView;
  } | null>(null);

  useEffect(() => {
    if (!dashboardId) {
      setYaml(buildStarterYaml(null, spec, canvas));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/yaml`)
      .then(async (res) => {
        if (!res.ok) return readResponse(res);
        const text = await res.text();
        if (text.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(text);
            return parsed.yaml ?? text;
          } catch {
            return text;
          }
        }
        return text;
      })
      .then((loadedYaml) => {
        if (!active) return;
        setYaml(String(loadedYaml));
        setLoading(false);
      })
      .catch((e: any) => {
        if (!active) return;
        setError(e?.message ?? "Could not load dashboard YAML");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dashboardId, spec, canvas]);

  const previewAndValidate = async () => {
    setError("");
    try {
      const res = await fetch("/api/dashboards/import-yaml", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildYamlImportPayload(yaml, spec, true)),
      }).then(readResponse);
      setValidatedResult({
        spec: res.spec,
        canvas: res.canvas,
        summary: summarizeYamlDiff(res, spec),
      });
    } catch (e: any) {
      setValidatedResult(null);
      setError(e?.message ?? "YAML validation failed");
    }
  };

  const applyToCanvas = async () => {
    if (validatedResult) {
      onApply(validatedResult.spec, validatedResult.canvas);
      onClose();
      return;
    }
    setError("");
    try {
      const res = await fetch("/api/dashboards/import-yaml", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildYamlImportPayload(yaml, spec, true)),
      }).then(readResponse);
      onApply(res.spec, res.canvas);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Could not apply YAML to canvas");
    }
  };

  return (
    <StudioDialog title="Dashboard-as-Code (YAML Sync)" wide onClose={onClose}>
      <div className="commercial-drawer yaml-sync-drawer">
        {loading && <p className="muted sm" role="status">Loading canonical YAML…</p>}
        {error && <p className="sm" role="alert">{error}</p>}

        <textarea
          aria-label="Dashboard YAML"
          className="txt area code-area"
          rows={14}
          value={yaml}
          onChange={(e) => {
            setYaml(e.target.value);
            setValidatedResult(null);
          }}
        />

        {validatedResult && (
          <section className="ins-sec" role="status">
            <h5>Diff & Validation Summary</h5>
            <p className="sm">
              Valid against semantic model · Added tiles: <b>{validatedResult.summary.addedTiles}</b> · Removed tiles:{" "}
              <b>{validatedResult.summary.removedTiles}</b> · Modified tiles:{" "}
              <b>{validatedResult.summary.modifiedTiles}</b> · Changed filters:{" "}
              <b>{validatedResult.summary.changedFilters}</b>
            </p>
          </section>
        )}

        <footer className="story-actions">
          <button onClick={previewAndValidate}>Preview Diff & Validate</button>
          <button className="primary" onClick={applyToCanvas}>
            Apply YAML to Canvas
          </button>
        </footer>
      </div>
    </StudioDialog>
  );
}

export interface OperationsSnapshotView {
  telemetry: {
    activeUsers: number;
    totalQueries: number;
    aiRedesigns: number;
    digestExports: number;
    cacheHits: number;
    queryReliability: number;
    readySources: number;
    totalGovernedMetrics: number;
  };
  manifest: {
    version: string;
    apiVersion: string;
    minGatewayVersion: string;
    capabilities: string[];
  };
  auditEvents: {
    id: string;
    timestamp: string;
    action: string;
    actor: string;
    outcome: string;
  }[];
}

export function normalizeOperationsSnapshot(
  metrics: any,
  manifest: any,
  audit: any,
): OperationsSnapshotView {
  const m = metrics ?? {};
  const man = manifest ?? {};
  const rawEvents: any[] = Array.isArray(audit?.events)
    ? audit.events
    : Array.isArray(audit)
      ? audit
      : [];

  const capabilities: string[] = Array.isArray(man.capabilities)
    ? man.capabilities.map(String)
    : [
        ...(Array.isArray(man.supportedAdapters) ? man.supportedAdapters : []),
        ...(Array.isArray(man.supportedConnectors) ? man.supportedConnectors : []),
        ...(Array.isArray(man.supportedAiProviders) ? man.supportedAiProviders : []),
      ].map(String);

  return {
    telemetry: {
      activeUsers: Number(m.activeUsers ?? m.uniqueActors ?? 0),
      totalQueries: Number(m.totalQueries ?? m.queries ?? m.dashboardsSaved ?? 0),
      aiRedesigns: Number(m.aiRedesigns ?? m.metricsProposed ?? 0),
      digestExports: Number(m.digestExports ?? m.lockedDashboardsSaved ?? 0),
      cacheHits: Number(m.cacheHits ?? 0),
      queryReliability: Number(m.queryReliability ?? 1),
      readySources: Number(m.readySources ?? 0),
      totalGovernedMetrics: Number(m.totalGovernedMetrics ?? 0),
    },
    manifest: {
      version: String(man.version ?? "0.1.0"),
      apiVersion: String(man.apiVersion ?? `v${man.libraryFormatVersion ?? 2}`),
      minGatewayVersion: String(
        man.minGatewayVersion ?? man.compatibility?.gatewayMinVersion ?? "0.1.0",
      ),
      capabilities,
    },
    auditEvents: rawEvents.map((ev, idx) => ({
      id: String(ev.id ?? `audit-${idx}`),
      timestamp: String(ev.timestamp ?? ev.ts ?? ""),
      action: String(ev.action ?? ev.event ?? "event"),
      actor: String(ev.actor ?? "system"),
      outcome: String(
        ev.outcome ??
          (String(ev.event ?? "").includes("revoked") || String(ev.event ?? "").includes("limited")
            ? "restricted"
            : "ok"),
      ),
    })),
  };
}

export function OperationsAuditDialog({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<OperationsSnapshotView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      fetch("/api/operations/metrics").then(readResponse),
      fetch("/api/operations/manifest").then(readResponse),
      fetch("/api/operations/audit?limit=25").then(readResponse),
    ])
      .then(([metrics, manifest, audit]) => {
        if (!active) return;
        setSnapshot(normalizeOperationsSnapshot(metrics, manifest, audit));
        setLoading(false);
      })
      .catch((e: any) => {
        if (!active) return;
        setError(e?.message ?? "Could not load operations telemetry");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <StudioDialog title="Operations, ROI & Audit Log" wide onClose={onClose}>
      <div className="commercial-drawer ops-audit-drawer">
        {loading && <p className="muted sm" role="status">Loading operations metrics, manifest, and audit trail…</p>}
        {error && <p className="sm" role="alert">{error}</p>}

        {snapshot && (
          <>
            <section className="ins-sec">
              <h5>Usage & Executive ROI Telemetry</h5>
              <div className="ops-metrics-grid">
                <div><span>Active users</span><b>{snapshot.telemetry.activeUsers}</b></div>
                <div><span>Total queries</span><b>{snapshot.telemetry.totalQueries}</b></div>
                <div><span>AI redesigns</span><b>{snapshot.telemetry.aiRedesigns}</b></div>
                <div><span>Digest exports</span><b>{snapshot.telemetry.digestExports}</b></div>
                <div><span>Cache hits</span><b>{snapshot.telemetry.cacheHits}</b></div>
                <div><span>Query reliability</span><b>{Math.round(snapshot.telemetry.queryReliability * 100)}%</b></div>
              </div>
            </section>

            <section className="ins-sec">
              <h5>Suite Release Manifest</h5>
              <p className="sm">
                Version: <b>{snapshot.manifest.version}</b> · API: <b>{snapshot.manifest.apiVersion}</b> · Min Gateway:{" "}
                <b>{snapshot.manifest.minGatewayVersion}</b>
              </p>
              <div className="capability-badges">
                {snapshot.manifest.capabilities.map((cap) => (
                  <span key={cap} className="badge">
                    {cap}
                  </span>
                ))}
              </div>
            </section>

            <section className="ins-sec">
              <h5>Durable Audit Log</h5>
              {snapshot.auditEvents.length === 0 ? (
                <p className="muted sm">No audit events recorded yet.</p>
              ) : (
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.auditEvents.map((ev) => (
                      <tr key={ev.id}>
                        <td>{ev.timestamp}</td>
                        <td><code>{ev.action}</code></td>
                        <td>{ev.actor}</td>
                        <td>{ev.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </StudioDialog>
  );
}
