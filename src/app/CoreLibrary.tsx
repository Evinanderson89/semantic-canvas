import { useCallback, useEffect, useRef, useState } from "react";
import { folderPath, viewSaveSchema, type CoreLibrary, type LibraryFolder, type LibraryItem, type LibraryView } from "../library/model.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { captureView } from "../library/views.ts";
import { MAX_DOCUMENT_BYTES } from "../compiler/schema.ts";
import { readResponse } from "./http.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { Popover } from "./Popover.tsx";
import { useSession } from "./Session.tsx";

const empty: CoreLibrary = { folders: [], items: [] };
export function useCoreLibrary(context: string) {
  const [state, setState] = useState({ context, data: empty, error: "", loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    const refresh = async () => {
      try {
        const data = await fetch("/api/library", { signal: ac.signal }).then(readResponse);
        if (!ac.signal.aborted) setState({ context, data, error: "", loading: false });
      } catch (e: any) { if (!ac.signal.aborted) setState(s => ({ context, data: s.context === context ? s.data : empty, error: e.message, loading: false })); }
    };
    void refresh();
    const focused = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focused);
    return () => { ac.abort(); window.removeEventListener("focus", focused); };
  }, [context, version]);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  return { ...(state.context === context ? state : { data: empty, error: "", loading: true }), refresh };
}

export function LibraryIcon({ kind }: { kind: "folder" | "dashboard" | "view" | "library" }) {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    {kind === "folder" ? <path d="M2.5 5a1 1 0 0 1 1-1H8l2 2h6.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z" />
      : kind === "dashboard" ? <><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M3 8h14M10 8v9" /></>
      : kind === "view" ? <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 13V9m4 4V7m4 6v-3" /></>
      : <><rect x="3" y="3" width="3" height="14" rx="1" /><rect x="9" y="3" width="3" height="14" rx="1" /><path d="m15 3 2 14" /></>}
  </svg>;
}

export function LibraryNavigation({ data, loading, error, activeId, onBrowse, onOpen }: {
  data: CoreLibrary; loading: boolean; error: string; activeId: string | null;
  onBrowse: (folder: string | null) => void; onOpen: (item: LibraryItem) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (f: LibraryFolder) => expanded[f.id] ?? f.name === "Company overview";
  const branch = (parentId: string | null, depth = 0) => <>
    {data.folders.filter(f => f.parentId === parentId).map(f => <div key={f.id} className="library-branch">
      <div className="library-folder-nav" style={{ paddingLeft: 8 + depth * 10 }}>
        <button className="library-chevron" aria-label={`${isOpen(f) ? "Collapse" : "Expand"} folder ${f.name}`} aria-expanded={isOpen(f)} onClick={() => setExpanded(old => ({ ...old, [f.id]: !isOpen(f) }))}>{isOpen(f) ? "⌄" : "›"}</button>
        <button className="library-folder-open" onClick={() => onBrowse(f.id)}><LibraryIcon kind="folder" /><span>{f.name}</span></button>
      </div>
      {isOpen(f) && depth < 8 && branch(f.id, depth + 1)}
    </div>)}
    {data.items.filter(i => i.folderId === parentId).sort((a, b) => Number(!!b.isTemplate) - Number(!!a.isTemplate)).slice(0, 8).map(i => <button key={`${i.kind}:${i.id}`} className={`library-item-nav${i.id === activeId && i.kind === "dashboard" ? " on" : ""}`} style={{ paddingLeft: 18 + depth * 10 }} title={i.name} aria-current={i.id === activeId ? "page" : undefined} aria-label={`${i.isTemplate ? "Starter" : i.kind === "view" ? "Saved view" : "Dashboard"}: ${i.name}`} onClick={() => onOpen(i)}>
      <LibraryIcon kind={i.kind} /><span>{i.name}</span>{(i.kind === "view" || i.isTemplate) && <small>{i.isTemplate ? "Starter" : "View"}</small>}
    </button>)}
    {data.items.filter(i => i.folderId === parentId).length > 8 && <button className="library-browse-link" style={{ paddingLeft: 18 + depth * 10 }} onClick={() => onBrowse(parentId)}>See all {data.items.filter(i => i.folderId === parentId).length} items →</button>}
  </>;
  return <div className="library-navigation">
    <button className="library-heading-nav" onClick={() => onBrowse(null)}><LibraryIcon kind="library" /><span>CoreCanvas Library</span><span aria-hidden="true">↗</span></button>
    {loading ? <p className="library-nav-note">Opening library…</p> : error ? <button className="library-nav-note link" onClick={() => onBrowse(null)}>Library unavailable · Retry</button> : <>
      {branch(null)}
      {!data.items.length && !data.folders.length && <p className="library-nav-note">A home for your dashboards and reusable views.</p>}
      <button className="library-browse-link" onClick={() => onBrowse(null)}>Browse & organize <span aria-hidden="true">→</span></button>
    </>}
  </div>;
}

const send = (path: string, method: string, body: unknown) => fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(readResponse);
export function FolderOptions({ folders, exclude }: { folders: LibraryFolder[]; exclude?: string }) {
  return <><option value="">Library root</option>{folders.filter(f => !folderPath(folders, f.id).some(x => x.id === exclude)).map(f => <option key={f.id} value={f.id}>{folderPath(folders, f.id).map(x => x.name).join(" / ")}</option>)}</>;
}

export function LibraryBrowser({ data, loading, error, refresh, folderId, onFolder, onOpen, onNewDashboard, viewsOnly = false }: {
  data: CoreLibrary; loading: boolean; error: string; refresh: () => void; folderId: string | null;
  onFolder: (id: string | null) => void; onOpen: (item: LibraryItem) => void; onNewDashboard?: (folderId: string | null) => void; viewsOnly?: boolean;
}) {
  const { canEdit } = useSession();
  const [search, setSearch] = useState(""), [kind, setKind] = useState("all");
  const [editing, setEditing] = useState<{ type: "folder"; folder?: LibraryFolder } | { type: "item"; item: LibraryItem } | null>(null);
  const [deleting, setDeleting] = useState<{ type: "folder"; folder: LibraryFolder } | { type: "item"; item: LibraryItem } | null>(null);
  const [name, setName] = useState(""), [parent, setParent] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState("");
  const folder = data.folders.find(f => f.id === folderId), current = folder?.id ?? null;
  const needle = search.trim().toLocaleLowerCase();
  const folders = data.folders.filter(f => needle ? f.name.toLocaleLowerCase().includes(needle) : f.parentId === current);
  const items = data.items.filter(i => (!viewsOnly || i.kind === "view") && (kind === "all" || kind === i.kind) && (needle ? `${i.name} ${i.description}`.toLocaleLowerCase().includes(needle) : i.folderId === current));
  const folderSummary = (folder: LibraryFolder) => {
    const children = data.folders.filter(f => f.parentId === folder.id).length;
    const count = data.items.filter(i => folderPath(data.folders, i.folderId).some(f => f.id === folder.id) && (!viewsOnly || i.kind === "view")).length;
    const unit = viewsOnly ? "view" : "item";
    return !viewsOnly && children && !count ? `${children} ${children === 1 ? "folder" : "folders"}` : `${count} ${unit}${count === 1 ? "" : "s"}`;
  };
  const editFolder = (f?: LibraryFolder) => { setEditing({ type: "folder", folder: f }); setName(f?.name ?? ""); setParent(f ? f.parentId ?? "" : current ?? ""); setProblem(""); };
  const editItem = (item: LibraryItem) => { setEditing({ type: "item", item }); setName(item.name); setParent(item.folderId ?? ""); setProblem(""); };
  const mutate = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setProblem("");
    try { await fn(); refresh(); setEditing(null); setDeleting(null); }
    catch (e: any) { setProblem(e.message); refresh(); }
    finally { setBusy(false); }
  };
  return <div className={`core-library${viewsOnly ? " picker-library" : ""}`}>
    <div className="library-page-heading"><div><span className="eyebrow">Made to keep. Ready to reuse.</span><h1>{viewsOnly ? "Find a saved view" : "CoreCanvas Library"}</h1><p>{viewsOnly ? "Add a saved chart or section to the current tab." : "Organize dashboards into folders. Keep your best views close."}</p></div>
      {!viewsOnly && canEdit && <div className="library-create-actions"><button className="link" onClick={() => editFolder()}>+ New folder</button>{onNewDashboard && <button className="save-button" onClick={() => onNewDashboard(current)}>+ New dashboard</button>}</div>}
    </div>
    <div className="library-breadcrumbs"><button onClick={() => { setSearch(""); onFolder(null); }}>Library</button>{folderPath(data.folders, current).map(f => <span key={f.id}><i aria-hidden="true">/</i><button onClick={() => { setSearch(""); onFolder(f.id); }}>{f.name}</button></span>)}</div>
    <div className="library-search-row"><input type="search" aria-label="Search library" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a dashboard, folder, or view…" />
      {!viewsOnly && <select aria-label="Library item type" value={kind} onChange={e => setKind(e.target.value)}><option value="all">Everything</option><option value="dashboard">Dashboards</option><option value="view">Saved views</option></select>}
      <button className="link" onClick={refresh}>Refresh library</button>
    </div>
    {error && <p role="alert" className="library-error">{error}</p>}
    {loading ? <p className="library-empty" role="status">Opening your library…</p> : <>
      {folders.length > 0 && <div className="library-folder-grid">{folders.map(f => <div key={f.id} className="library-folder-card"><button className="library-folder-target" onClick={() => { setSearch(""); onFolder(f.id); }}><LibraryIcon kind="folder" /><span><strong>{f.name}</strong><small>{folderSummary(f)}</small></span></button>
        {!viewsOnly && canEdit && <Popover label={`Folder actions for ${f.name}`} trigger="···" align="end">{close => <div className="library-menu"><button onClick={() => { close(); editFolder(f); }}>Rename or move</button><button onClick={() => { close(); setProblem(""); setDeleting({ type: "folder", folder: f }); }}>Delete folder</button></div>}</Popover>}
      </div>)}</div>}
      {items.length > 0 && <div className="library-item-list">{items.map(item => <div key={`${item.kind}:${item.id}`} className="library-row">
        <button className="library-item-target" onClick={() => onOpen(item)} aria-label={`${viewsOnly ? "Insert view" : item.kind === "view" ? "Preview view" : item.isTemplate ? "Start dashboard" : "Open dashboard"} ${item.name}`}><span className={`library-item-glyph ${item.kind}`}><LibraryIcon kind={item.kind} /></span><span><strong>{item.name}</strong><small>{item.description || `${item.tileCount} tiles · ${item.kind === "view" ? "Reusable view" : "Dashboard"}`}{needle && item.folderId ? ` · ${folderPath(data.folders, item.folderId).map(f => f.name).join(" / ")}` : ""}</small></span></button>
        <span className="library-kind-label">{viewsOnly ? "Insert →" : item.kind === "view" ? "View" : item.isTemplate ? "Starter" : "Dashboard"}</span>
        {!viewsOnly && canEdit && <Popover label={`Library actions for ${item.name}`} trigger="···" align="end">{close => <div className="library-menu"><button onClick={() => { close(); editItem(item); }}>Rename or move</button><button onClick={() => { close(); setProblem(""); setDeleting({ type: "item", item }); }}>Delete {item.kind}</button></div>}</Popover>}
      </div>)}</div>}
      {!items.length && !folders.length && <div className="library-empty"><LibraryIcon kind="library" /><h2>{needle ? "Nothing matches yet." : "Room for your next good idea."}</h2><p>{needle ? "Try another name, or clear your search." : viewsOnly ? "Save a chart or section from a dashboard using Views → Save a view." : "Save a dashboard to add it here, or save a reusable section from the Views menu."}</p></div>}
    </>}
    {editing && <StudioDialog title={editing.type === "folder" ? editing.folder ? "Organize folder" : "New folder" : `Organize ${editing.item.kind}`} onClose={() => !busy && setEditing(null)}><form onSubmit={e => { e.preventDefault(); void mutate(() => editing.type === "folder" ? send("/api/library/folders", "POST", { id: editing.folder?.id ?? crypto.randomUUID(), revision: editing.folder?.revision ?? 0, name: name.trim(), parentId: parent || null }) : send(`/api/library/items/${editing.item.kind}/${encodeURIComponent(editing.item.id)}`, "PATCH", { revision: editing.item.revision, name: name.trim(), folderId: parent || null })); }}>
      <section><label className="form-field">Name<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label><label className="form-field">Folder<select aria-label="Parent folder" value={parent} onChange={e => setParent(e.target.value)} disabled={busy}><FolderOptions folders={data.folders} exclude={editing.type === "folder" ? editing.folder?.id : undefined} /></select></label>{problem && <p role="alert">{problem}</p>}</section>
      <footer><button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button></footer></form></StudioDialog>}
    {deleting && <StudioDialog title={`Delete ${deleting.type === "folder" ? "folder" : deleting.item.kind}`} onClose={() => !busy && setDeleting(null)}><section><p>Delete “{deleting.type === "folder" ? deleting.folder.name : deleting.item.name}”?</p><p className="muted">{deleting.type === "folder" ? "Only empty folders can be deleted. Move anything you want to keep first." : deleting.item.kind === "view" ? "Copies already inserted into dashboards will stay in place." : "This removes the saved dashboard and its chart activity."}</p>{problem && <p role="alert">{problem}</p>}</section><footer><button className="primary" disabled={busy} onClick={() => void mutate(() => deleting.type === "folder" ? send(`/api/library/folders/${encodeURIComponent(deleting.folder.id)}`, "DELETE", { revision: deleting.folder.revision }) : send(deleting.item.kind === "dashboard" ? `/api/dashboards/${encodeURIComponent(deleting.item.id)}` : `/api/library/views/${encodeURIComponent(deleting.item.id)}`, "DELETE", { revision: deleting.item.revision }))}>{busy ? "Deleting…" : "Delete"}</button><button className="link" disabled={busy} onClick={() => setDeleting(null)}>Keep it</button></footer></StudioDialog>}
  </div>;
}

export function SaveViewDialog({ book, canvas, activeTab, selected, folders, defaultFolder, model, onSaved, onClose }: {
  book: DashboardSpec; canvas: CanvasSpec; activeTab: string; selected: string[]; folders: LibraryFolder[]; defaultFolder: string | null; model: Model;
  onSaved: () => void; onClose: () => void;
}) {
  const [name, setName] = useState((selected.length === 1 ? book.tiles.find(t => t.id === selected[0])?.title : book.title)?.slice(0, 100) ?? "Saved view");
  const [description, setDescription] = useState(""), [folder, setFolder] = useState(defaultFolder ?? ""), [mode, setMode] = useState(selected.length ? "selected" : "tab");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const id = useRef(crypto.randomUUID());
  const draft = captureView(book, canvas, activeTab, mode === "selected" ? selected : [], name || "Saved view");
  return <StudioDialog title="Save a view" onClose={() => !busy && onClose()}><form onSubmit={async e => {
    e.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const body = viewSaveSchema.parse({ id: id.current, name: name.trim(), description, folderId: folder || null, ...draft });
      if (new Blob([JSON.stringify(body)]).size > MAX_DOCUMENT_BYTES) throw new Error("This view exceeds the 8 MB limit. Try a smaller selection.");
      await send("/api/library/views", "POST", body); onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><section><p className="view-save-intro">Keep this composition in CoreCanvas Library, ready for the next dashboard.</p>
    <label className="form-field">View name<input autoFocus required maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
    <label className="form-field">Description <span className="optional">Optional</span><textarea maxLength={1000} rows={2} value={description} disabled={busy} onChange={e => setDescription(e.target.value)} placeholder="When should someone use this view?" /></label>
    <div className="form-grid"><label className="form-field">Include<select value={mode} disabled={busy} onChange={e => setMode(e.target.value)}><option value="tab">Current tab</option>{selected.length > 0 && <option value="selected">Selected tiles</option>}</select></label><label className="form-field">Folder<select aria-label="Save view folder" value={folder} disabled={busy} onChange={e => setFolder(e.target.value)}><FolderOptions folders={folders} /></select></label></div>
    <ViewComposition view={{ ...draft, name, description }} model={model} />
    <p className="muted">Includes layout, labels, and saved filter defaults. Temporary selections and drill-downs are not saved. Inserted views become independent copies.</p>{error && <p role="alert">{error}</p>}
  </section><footer><span className="muted">{draft.spec.tiles.length} tiles</span><span className="spacer" /><button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save view"}</button></footer></form></StudioDialog>;
}

export function ViewComposition({ view, model }: { view: Pick<LibraryView, "spec" | "canvas" | "name" | "description">; model: Model }) {
  const metrics = [...new Set(view.spec.tiles.flatMap(t => t.metrics))];
  return <div className="view-composition"><svg viewBox={`0 0 ${view.canvas.width} ${view.canvas.height}`} role="img" aria-label={`Layout of ${view.name || "saved view"}`}>
    {view.spec.tiles.map(t => <rect key={t.id} x={t.layout.x} y={t.layout.y} width={t.layout.w} height={t.layout.h} rx={6} fill={t.kind === "heading" ? "var(--accent)" : t.kind === "text" ? "var(--line-2)" : "var(--accent-soft)"} stroke="var(--line-2)" />)}
  </svg><div><strong>{view.name || "Untitled view"}</strong>{view.description && <p>{view.description}</p>}<small>{metrics.length ? metrics.map(m => model.metrics[m]?.label ?? m).join(" · ") : "Labels and canvas elements"}</small><small>{view.spec.filters?.length ? `${view.spec.filters.length} saved filters · ` : ""}{view.spec.tiles.length} tiles · Live catalogue metrics</small></div></div>;
}

export function ViewPreviewDialog({ item, model, canInsert, onInsert, onOpen, onClose }: {
  item: LibraryItem; model: Model; canInsert: boolean; onInsert: (view: LibraryView) => void; onOpen: (view: LibraryView) => void; onClose: () => void;
}) {
  const session = useSession();
  const [view, setView] = useState<LibraryView | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/library/views/${encodeURIComponent(item.id)}`, { signal: ac.signal }).then(readResponse).then(d => { if (!ac.signal.aborted) setView(viewSaveSchema.parse(d)); }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [item.id]);
  return <StudioDialog title="Saved view" onClose={onClose}><section>{error ? <p role="alert">{error}</p> : !view ? <p role="status">Opening view…</p> : <><ViewComposition view={view} model={model} /><p className="muted">Uses live metrics from this catalogue. Adding it to a dashboard creates an independent copy with its own filters and chart activity.</p></>}</section>
    {view && <footer>{canInsert && <button className="primary" onClick={() => onInsert(view)}>Insert into current tab</button>}<button className={canInsert ? "link" : "primary"} onClick={() => onOpen(view)}>{session.canEdit ? "Use as new dashboard" : "Open view"}</button></footer>}
  </StudioDialog>;
}
