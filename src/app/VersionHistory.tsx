import { useEffect, useState } from "react";
import { z } from "zod";
import { dashboardSchema, canvasSchema } from "../compiler/schema.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";
import { versionChanges, type VersionChangeGroup } from "./versionChanges.ts";
import "./versionHistory.css";

const versionListSchema = z.object({ versions: z.array(z.object({
  revision: z.number().int().positive(), name: z.string(), savedAt: z.string().datetime({ offset: true }).nullable(),
  tiles: z.number().int().nonnegative().max(500), current: z.boolean(),
})).refine(versions => new Set(versions.map(v => v.revision)).size === versions.length) });
const savedVersionSchema = z.object({ id: z.string(), revision: z.number().int().positive(), spec: dashboardSchema, canvas: canvasSchema });
type Version = z.infer<typeof versionListSchema>["versions"][number];
export type SavedVersion = { revision: number; spec: DashboardSpec; canvas: CanvasSpec };
export function VersionHistory({ id, current, currentCanvas, dirty, canEdit, onRestore, onClose }: {
  id: string; current: DashboardSpec; currentCanvas: CanvasSpec; dirty: boolean; canEdit: boolean;
  onRestore: (version: SavedVersion) => void; onClose: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]), [selected, setSelected] = useState<number | null>(null);
  const [document, setDocument] = useState<SavedVersion | null>(null), [error, setError] = useState("");
  const [listError, setListError] = useState(""), [loadingList, setLoadingList] = useState(true);
  const [listAttempt, setListAttempt] = useState(0), [versionAttempt, setVersionAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingList(true); setListError(""); setError(""); setVersions([]); setSelected(null); setDocument(null);
    fetch(`/api/dashboards/${encodeURIComponent(id)}/versions`, { signal: controller.signal }).then(readResponse).then(raw => {
      const parsed = versionListSchema.safeParse(raw);
      if (!parsed.success) throw new Error("The saved-version list could not be read. Retry loading history.");
      const versions = [...parsed.data.versions].sort((a, b) => b.revision - a.revision);
      if (!controller.signal.aborted) { setVersions(versions); setSelected(versions[0]?.revision ?? null); }
    }).catch(e => { if (!controller.signal.aborted) setListError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoadingList(false); });
    return () => controller.abort();
  }, [id, listAttempt]);
  useEffect(() => {
    setDocument(null); if (selected === null) return;
    const controller = new AbortController(); setError("");
    fetch(`/api/dashboards/${encodeURIComponent(id)}/versions/${selected}`, { signal: controller.signal }).then(readResponse)
      .then(raw => {
        const parsed = savedVersionSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id || parsed.data.revision !== selected)
          throw new Error("The response does not contain the requested saved version. Retry loading this version.");
        if (!controller.signal.aborted) setDocument(parsed.data);
      }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, selected, versionAttempt]);
  const changes = document ? versionChanges({ spec: current, canvas: currentCanvas }, document) : [];
  const groups: VersionChangeGroup[] = ["Data and scope", "Story and content", "Layout and appearance"];
  const firstTab = document?.spec.tabs?.[0]?.id ?? "main";
  const tiles = document?.spec.tiles.filter(t => !t.tabId || t.tabId === firstTab) ?? [];
  return <StudioDialog title="Version history" wide onClose={onClose}>
    <section className="version-intro"><h2>Your dashboard, over time.</h2><p>Every successful save keeps a version of the layout, chart choices, filters and authored text. Restoring opens a draft; Save creates the next version.</p>
      <p className="muted">Data and metric definitions are queried live. This is design history, not a snapshot of historical results. Versions overwritten before history was introduced are unavailable.</p></section>
    <div className="version-browser"><nav aria-label="Saved versions">
      {loadingList && <p role="status">Loading version history…</p>}
      {listError && <><p role="alert">{listError}</p><button onClick={() => setListAttempt(n => n + 1)}>Retry loading history</button></>}
      {!loadingList && !listError && !versions.length && <><p>No saved versions are available.</p><button onClick={() => setListAttempt(n => n + 1)}>Reload history</button></>}
      {versions.map(v => <button key={v.revision} aria-pressed={v.revision === selected} onClick={() => { if (selected !== v.revision) { setDocument(null); setError(""); setSelected(v.revision); } }}>
      <strong>Version {v.revision}{v.current ? " · Latest saved" : ""}</strong>
      <span>{v.savedAt ? new Date(v.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Earlier save · date unavailable"}</span><span>{v.tiles} tiles · {v.name}</span>
    </button>)}</nav><section className="version-preview" aria-label="Selected version">
      {document ? <><span className="eyebrow">Version {document.revision} · layout preview</span><h3>{document.spec.title}</h3>
        <svg role="img" aria-label={`Layout of version ${document.revision}`} viewBox={`0 0 ${document.canvas.width} ${Math.max(300, ...tiles.map(t => t.layout.y + t.layout.h + 24))}`}>
          {tiles.map(t => <g key={t.id}><rect x={t.layout.x} y={t.layout.y} width={t.layout.w} height={t.layout.h} rx={8} className={t.kind === "heading" || t.kind === "text" ? "version-text-tile" : ""} /><text x={t.layout.x + 12} y={t.layout.y + 26} fontSize={16}>{(t.title || t.text || t.kind || "Chart").slice(0, Math.max(12, Math.floor(t.layout.w / 9)))}</text>{(!t.kind || t.kind === "metric") && <text className="version-kind" x={t.layout.x + 12} y={t.layout.y + 50} fontSize={13}>{t.chart ?? "Automatic chart"}</text>}</g>)}
        </svg>
        {(document.spec.tabs?.length ?? 1) > 1 && <p>{document.spec.tabs!.length} tabs · first tab shown above. Changes below include every tab.</p>}
        <div className="version-changes" aria-label="Changes if restored">
          <h4>What restoring would change</h4>
          <p>Compared with your current work{dirty ? ", including unsaved edits" : ""}. Each row reads from current work to the selected saved version.</p>
          {!changes.length && <p>No authored changes. This version matches your current design.</p>}
          {groups.map(group => {
            const items = changes.filter(c => c.group === group);
            return items.length ? <details key={`${document.revision}:${group}`} open={group === "Data and scope"}>
              <summary>{group} · {items.length} {items.length === 1 ? "change" : "changes"}</summary>
              <ul>{items.map((change, i) => <li key={i}>
                <strong>{change.subject} · {change.field}</strong>
                <dl><div><dt>Current work</dt><dd>{change.current}</dd></div><div><dt>Version {document.revision}</dt><dd>{change.saved}</dd></div></dl>
              </li>)}</ul>
            </details> : null;
          })}
        </div>
        <details><summary>Chart and text inventory</summary><ul>{document.spec.tiles.map(t => <li key={t.id}>{t.title ?? t.text ?? t.metrics.join(", ")} <small>({t.chart ?? t.kind ?? "chart"})</small></li>)}</ul></details>
      </> : selected !== null && !error && <p role="status">Loading saved version…</p>}
      {error && <><p role="alert">{error}</p>{!document && selected !== null && <button onClick={() => { setError(""); setVersionAttempt(n => n + 1); }}>Retry loading version</button>}</>}
    </section></div>
    <footer><span>{dirty ? "Your unsaved changes stay in recovery drafts." : "The latest saved version stays in history."}</span><span className="spacer" /><button onClick={onClose}>Close</button>
      <button className="primary" disabled={!document || document.revision !== selected || !canEdit || loadingList || !!listError} onClick={() => { try { if (document && document.revision === selected) onRestore(document); } catch (e: any) { setError(e.message); } }}>Restore as draft</button></footer>
  </StudioDialog>;
}
