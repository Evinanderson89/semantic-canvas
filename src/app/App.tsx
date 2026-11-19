import { VersionHistory } from "./VersionHistory.tsx";
import { Investigation } from "./Investigation.tsx";
import type { InvestigationResult } from "../suggest/investigate.ts";
import { ReviewHandoff } from "./ReviewHandoff.tsx";
import type { PresentationMode } from "./ReportPresentation.tsx";
import { presentationContentKey, withPresentationBrief } from "./presentationBrief.ts";
import { unappliedFilters } from "./filters.ts";
import { ChartActivityProvider } from "./ChartActivity.tsx";
import { ChartSettings, useChartPreferences } from "./ChartPreferences.tsx";
import { LibraryBrowser, LibraryNavigation, SaveViewDialog, ViewPreviewDialog, useCoreLibrary } from "./CoreLibrary.tsx";
import { StudioDialog } from "./StudioDialog.tsx";
import { fitStarter } from "../library/fitStarter.ts";
import { insertView } from "../library/views.ts";
import { viewSaveSchema, type LibraryItem, type LibraryView } from "../library/model.ts";
import { useSession } from "./Session.tsx";
import { applyProposal } from "../canvas/proposals.ts";
import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";
import { validateTile } from "../compiler/compile.ts";
import React, { useCallback, useEffect, useState } from "react";
import { Tile } from "./Tile.tsx";
import { drillQueryKey, retainDrillSessions, type DrillSessions } from "./drill.ts";
import { TileBoundary } from "./TileBoundary.tsx";
import { Picker } from "./Picker.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Canvas } from "../canvas/Canvas.tsx";
import { EditBar } from "./EditBar.tsx";
import { Popover } from "./Popover.tsx";
import { DashboardBeautify } from "./DashboardBeautify.tsx";
import { AiRedesign } from "./AiRedesign.tsx";
import { validateRedesign } from "../suggest/redesign.ts";
import { InsertMenu } from "./InsertMenu.tsx";
import { Interview } from "./Interview.tsx";
import { AgentQuestions } from "./AgentQuestions.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { Inspector } from "./Inspector.tsx";
import { MetricRegistry, DataModel } from "./Explore.tsx";
import { Connections, type Principal, type RlsPolicy, type SourceInfo } from "./Connections.tsx";
import { Modeler } from "./Modeler.tsx";
import { SpreadsheetImport } from "./SpreadsheetImport.tsx";
import type { Brief } from "../suggest/match.ts";
import { DEFAULT_CANVAS, THEME_PRESETS, type CanvasSpec } from "../canvas/presets.ts";
import { overlaps } from "../canvas/geometry.ts";
import { applyLayout } from "../canvas/layouts.ts";
import { prepareNewTile } from "../suggest/prepareTile.ts";
import { downloadPng, downloadSvg, slugForFilename } from "./export.ts";
import { ExecutiveDigestDialog, YamlCodeSyncDialog, OperationsAuditDialog } from "./CommercialDrawers.tsx";
import { SemanticCoachDialog } from "./SemanticCoach.tsx";
import { CommandPalette, type PaletteItem } from "./CommandPalette.tsx";
import { metricOf, calendarOf, prettifyModelName, todayOf, type Model } from "../semantic/model.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

import { readResponse } from "./http.ts";
import { documentSnapshot, fingerprint, withGrain, parseDrafts, documentGrain, type DocumentSnapshot, type Draft } from "./document.ts";
import { MAX_DOCUMENT_BYTES } from "../compiler/schema.ts";
import { currentTab, mergeTab, tabView, tabsOf } from "./tabs.ts";
import { filtersForTile, globalWindowFilterForTile, validateDashboard } from "./filters.ts";
import { PRESETS, PRESET_IDS } from "./datePresets.ts";
import { showcaseStarters } from "../library/showcase.ts";
import type { DatePreset, FilterValue } from "../compiler/spec.ts";

import { DistributeDialog } from "./DistributeDialog.tsx";
import { demoDashboard, demoDashboardAvailable } from "../suggest/demo.ts";
import { ReferenceImport } from "./ReferenceImport.tsx";
import { TabStrip } from "./TabStrip.tsx";
import { FilterControl, FilterDesigner, filterTileSize } from "./FilterControls.tsx";
import { linkedSource, parseLink, stripLink } from "./link.ts";

const GRAINS = ["day", "week", "month", "quarter", "year"];

export function App() {
  const session = useSession();
  const storage = session.mode === "team" ? sessionStorage : localStorage;
  const draftStorageKey = session.user ? `sc:team:${session.user.id}:drafts` : "sc:drafts";
  const sourceStorageKey = session.user ? `sc:team:${session.user.id}:source` : "sc:source";
  const [bootError, setBootError] = useState("");
  const [model, setModel] = useState<Model | null>(null);
  const [book, setBook] = useState<DashboardSpec | null>(null);
  const [activeTabId, setActiveTabId] = useState("main");
  const [referenceImport, setReferenceImport] = useState(false);
  const [spreadsheetImport, setSpreadsheetImport] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [filterEditing, setFilterEditing] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, FilterValue>>({});
  const [dateWindow, setDateWindow] = useState<DatePreset | "all">("all");
  const dash = React.useMemo(() => book ? tabView(book, activeTabId) : null, [book, activeTabId]);
  const setDash = useCallback((update: React.SetStateAction<DashboardSpec | null>) => {
    setBook(previous => {
      const view = previous ? tabView(previous, activeTabId) : null;
      const next = typeof update === "function" ? update(view) : update;
      return next ? mergeTab(previous, next, activeTabId) : null;
    });
  }, [activeTabId]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [dashboardFolder, setDashboardFolder] = useState<string | null>(null);
  const [grain, setGrain] = useState("month");
  const [picking, setPicking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 650px)");
    const resize = () => setCollapsed(compact.matches);
    resize(); compact.addEventListener("change", resize);
    return () => compact.removeEventListener("change", resize);
  }, []);
  const [refreshed, setRefreshed] = useState<Date | null>(null);
  const [canvas, setCanvas] = useState<CanvasSpec>({ ...DEFAULT_CANVAS, locked: !session.canEdit });
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [investigating, setInvestigating] = useState<{ id: string; result: InvestigationResult } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [handoffMode, setHandoffMode] = useState<PresentationMode>("dashboard");
  const [interview, setInterview] = useState(false);
  const [aiRedesign, setAiRedesign] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [yamlSyncOpen, setYamlSyncOpen] = useState(false);
  const [opsAuditOpen, setOpsAuditOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // /modeler is the Modeler's own address on the gateway (registered as its own app); the SPA serves it like any path.
  const [view, setView] = useState<"home" | "registry" | "model" | "connections" | "library" | "modeler">(() => location.pathname.replace(/\/+$/, "") === "/modeler" ? "modeler" : "home");
  // ?source=&table= from an "Open in Semantic Canvas" link: read once, applied when the sources (then the model) are known, and stripped.
  const link = React.useRef<ReturnType<typeof parseLink> | null>(parseLink(location.search));
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [linkedTable, setLinkedTable] = useState<string | null>(null);
  const [registryTable, setRegistryTable] = useState<string | null>(null);
  const [libraryFolder, setLibraryFolder] = useState<string | null>(null);
  const [viewPicker, setViewPicker] = useState(false), [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewPreview, setViewPreview] = useState<LibraryItem | null>(null);
  const [viewPickError, setViewPickError] = useState(""), [viewPickBusy, setViewPickBusy] = useState(false);
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [policies, setPolicies] = useState<RlsPolicy[]>([]);
  const [asWho, setAsWho] = useState<string>(() => {
    try { return localStorage.getItem("sc:principal") ?? ""; } catch { return ""; }
  });
  const chartPreferences = useChartPreferences(session.user ? `team:${session.user.id}` : `local:${asWho}`);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sandboxMode, setSandboxMode] = useState(false);
  const [sandboxDismissed, setSandboxDismissed] = useState(false);
  const sandboxAutoOpened = React.useRef(false);
  const [autoSourceId, setAutoSourceId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string>(() => {
    try { return storage.getItem(sourceStorageKey) ?? ""; } catch { return ""; }
  });
  const activeSourceId = sourceId || autoSourceId || "";
  const activeSource = sources.find((s) => s.id === activeSourceId) ?? null;

  // Read via refs rather than the closed-over state, so a switch takes effect
  // on the very next fetch -- including one fired in the same handler that
  // called setAsWho/setSourceId, before this effect has re-run.
  const asWhoRef = React.useRef(asWho);
  const sourceRef = React.useRef(sourceId);
  React.useEffect(() => {
    const orig = window.fetch;
    window.fetch = (input: any, init: any = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? input.toString(), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return orig(input, init);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
      if (asWhoRef.current) headers.set("x-sc-principal", asWhoRef.current);
      if (sourceRef.current) headers.set("x-sc-source", sourceRef.current);
      return orig(input, { ...init, headers });
    };
    return () => { window.fetch = orig; };
  }, []);

  const coreLibrary = useCoreLibrary(`${activeSourceId}:${asWho}`);

  React.useEffect(() => {
    fetch("/api/principals").then((r) => r.json())
      .then((d) => { setPrincipals(d.principals ?? []); setPolicies(d.policies ?? []); })
      .catch(() => {});
  }, []);

  const refreshSources = useCallback(() =>
    fetch("/api/sources").then((r) => r.json())
      .then((d) => { setSources(d.sources ?? []); setAutoSourceId(d.active ?? null); setSourcesLoaded(true);
        if (typeof d.sandbox === "boolean") setSandboxMode(d.sandbox);
        if (!sourceRef.current) sourceRef.current = d.active ?? "";
        if (localStorage.getItem("sc:principal") === null && d.defaultPrincipal) {
          asWhoRef.current = d.defaultPrincipal; setAsWho(d.defaultPrincipal);
          localStorage.setItem("sc:principal", d.defaultPrincipal);
        } })
      .catch(() => {}),
  []);
  React.useEffect(() => { refreshSources(); }, [refreshSources]);

  const [dashId, setDashId] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; updated_at: string | null }[]>([]);
  const [openList, setOpenList] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, updateNotice] = useState<{ message: string; kind: "error" | "success" | "info" } | null>(null);
  const noticeOrigin = React.useRef<HTMLElement | null>(null);
  const setNotice = useCallback((message: string, kind: "error" | "success" | "info" = "error") => {
    if (message && document.activeElement instanceof HTMLElement && !document.activeElement.closest(".document-notice")) {
      noticeOrigin.current = document.activeElement;
    }
    updateNotice(message ? { message, kind } : null);
  }, []);
  const dismissNotice = () => {
    updateNotice(null);
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      const origin = noticeOrigin.current;
      const target = origin !== document.body && origin?.isConnected && origin.getClientRects().length ? origin
        : document.querySelector<HTMLButtonElement>('button[aria-label="Save dashboard"]');
      target?.focus({ preventScroll: true });
    });
  };
  const [refreshToken, setRefreshToken] = useState<string>(crypto.randomUUID());
  const dirty = session.canEdit && !!book && fingerprint(book, canvas) !== savedFingerprint;
  const documentEpoch = React.useRef(0);
  const draftKey = React.useRef<string>(crypto.randomUUID());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const currentDocument = React.useRef({ dash: book, canvas, dashId, revision, dirty, source: activeSourceId, folderId: dashboardFolder });
  currentDocument.current = { dash: book, canvas, dashId, revision, dirty, source: activeSourceId, folderId: dashboardFolder };
  const readDrafts = useCallback(() => {
    try { setDrafts(parseDrafts(storage.getItem(draftStorageKey))); } catch { setDrafts([]); }
  }, []);
  useEffect(readDrafts, [readDrafts]);
  const stashDraft = useCallback(() => {
    const d = currentDocument.current;
    if (!session.canEdit || !d.dash || !d.dirty) return true;
    try {
      const all: Draft[] = parseDrafts(storage.getItem(draftStorageKey));
      const next: Draft = { ...documentSnapshot(d.dash, d.canvas), key: draftKey.current,
        id: d.dashId, revision: d.revision, source: d.source, folderId: d.folderId, updated: new Date().toISOString() };
      storage.setItem(draftStorageKey, JSON.stringify([next, ...all.filter((x) => x.key !== next.key)]));
      readDrafts();
      return true;
    } catch { setNotice("Recovery backup failed. Your dashboard is still open. Save it or download a backup before leaving."); return false; }
  }, [readDrafts]);
  useEffect(() => { window.addEventListener("sc:session-ending", stashDraft); return () => window.removeEventListener("sc:session-ending", stashDraft); }, [stashDraft]);
  useEffect(() => { const timer = setTimeout(stashDraft, 500); return () => clearTimeout(timer); }, [book, canvas, dirty, revision, stashDraft]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => { if (currentDocument.current.dirty) { stashDraft(); e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [stashDraft]);

  // Exploration state is reset on document and role changes.
  const [drillSessions, setDrillSessions] = useState<DrillSessions>({});
  // Filter before rendering, so an edited chart never sends even one request
  // with the previous query's drill range. Prune stored sessions as well so
  // undo cannot revive stale exploration after a query change or removal.
  const activeDrillSessions = React.useMemo(() => retainDrillSessions(book?.tiles ?? [], drillSessions, model), [book, drillSessions, model]);
  const drills = React.useMemo(() => Object.fromEntries(Object.entries(activeDrillSessions).map(([id, session]) => [id, session.entries])), [activeDrillSessions]);
  useEffect(() => { setDrillSessions(current => retainDrillSessions(book?.tiles ?? [], current, model)); }, [book, model]);

  // Same status the AgentChat toggle polls for -- whether "Explain this" on
  // a tile should even offer itself, rather than showing a button that
  // always 503s. Polled independently rather than lifting AgentChat's own
  // state up: cheap, and keeps that component self-contained.
  const [aiAvailable, setAiAvailable] = useState(false);
  React.useEffect(() => {
    let stopped = false;
    const poll = () => fetch("/api/agent/status").then((r) => r.json())
      .then((d) => { if (!stopped) setAiAvailable(Boolean(d.configured)); }).catch(() => {});
    poll();
    const id = setInterval(poll, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  useEffect(() => { setInvestigating(null); }, [activeSourceId, asWho, refreshToken]);

  // Undo history. Every edit pushes; the canvas is a design surface and Cmd+Z is
  // the first thing anyone tries after moving something by accident.
  const past = React.useRef<DocumentSnapshot[]>([]);
  const future = React.useRef<DocumentSnapshot[]>([]);
  const applying = React.useRef(false);

  const commit = React.useCallback((next: DashboardSpec) => {
    if (!applying.current && book) { past.current.push(documentSnapshot(book, canvas)); future.current = []; }
    if (past.current.length > 80) past.current.shift();
    setDash(next);
  }, [book, canvas, setDash]);
  const commitBook = (next: DashboardSpec) => {
    const parsed = dashboardSchema.safeParse(next);
    if (!parsed.success) { setNotice("This change exceeds the document limits. Keep at most 20 tabs, 500 tiles and 64 filters."); return; }
    if (book) { past.current.push(documentSnapshot(book, canvas)); future.current = []; }
    if (past.current.length > 80) past.current.shift();
    setBook(parsed.data);
  };

  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (canvas.locked || document.querySelector("dialog[open], .cmdk-dialog")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      applying.current = true;
      if (e.shiftKey) {
        const n = future.current.pop();
        if (n && book) { past.current.push(documentSnapshot(book, canvas)); setBook(n.spec); setCanvas(n.canvas); }
      } else {
        const p = past.current.pop();
        if (p && book) { future.current.push(documentSnapshot(book, canvas)); setBook(p.spec); setCanvas(p.canvas); }
      }
      queueMicrotask(() => { applying.current = false; });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [book, canvas]);

  React.useEffect(() => {
    if (!model) return;
    const onPaletteKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onPaletteKey);
    return () => window.removeEventListener("keydown", onPaletteKey);
  }, [Boolean(model)]);

  const compose = (spec: DashboardSpec, surface: CanvasSpec) => {
    if (book) { past.current.push(documentSnapshot(book, canvas)); future.current = []; }
    setDash(spec); setCanvas(surface);
  };
  const changeCanvas = (next: CanvasSpec) => {
    if (book && fingerprint(book, canvas) !== fingerprint(book, next)) { past.current.push(documentSnapshot(book, canvas)); future.current = []; }
    setSelected([]); setCanvas(next);
  };
  const beginDocument = useCallback((next: DashboardSpec | null, options: {
    id?: string | null; revision?: number; canvas?: CanvasSpec; saved?: boolean; draftKey?: string; folderId?: string | null;
  } = {}) => {
    if (!stashDraft()) return false;
    documentEpoch.current++;
    draftKey.current = options.draftKey ?? crypto.randomUUID();
    past.current = []; future.current = [];
    const surface = { ...DEFAULT_CANVAS, ...options.canvas, locked: !session.canEdit };
    if (next?.tiles.length && !options.canvas) surface.height = Math.max(surface.height, ...next.tiles.map((t) => t.layout.y + t.layout.h + 24));
    setBook(next); setActiveTabId(next ? tabsOf(next)[0].id : "main"); setFilterValues({}); setDateWindow("all");
    setCanvas(surface); setDashId(options.id ?? null); setRevision(options.revision ?? 0);
    setSavedFingerprint(next && options.saved ? fingerprint(next, surface) : null);
    setGrain(documentGrain(next));
    setSelected([]); setReferenceImport(false); setDistributing(false); setFilterEditing(null); setDrillSessions({}); setNotice(""); setSaving(false); setTemplateId(null); setDashboardFolder(options.folderId ?? null);
    setHistoryOpen(false); setInvestigating(null); setHandoff(false); setPicking(false); setViewPicker(false); setSaveViewOpen(false); setViewPreview(null); setViewPickError(""); setViewPickBusy(false); setRefreshed(null); setRefreshToken(crypto.randomUUID());
    return true;
  }, [stashDraft]);
  const refreshData = () => { setRefreshToken(crypto.randomUUID()); setRefreshed(new Date()); };

  const refreshSaved = React.useCallback(() => {
    coreLibrary.refresh(); const source = sourceRef.current;
    return fetch("/api/dashboards").then(readResponse)
      .then(d => { if (sourceRef.current === source) setSaved(d.dashboards ?? []); }).catch(() => {});
  }, [coreLibrary.refresh]);
  React.useEffect(() => { refreshSaved(); }, [refreshSaved]);

  const switchSource = useCallback((id: string) => {
    if (!beginDocument(null)) return;
    sourceRef.current = id;
    setSourceId(id);
    setLibraryFolder(null);
    try { storage.setItem(sourceStorageKey, id); } catch {}
    setView("home"); setModel(null);
    const epoch = documentEpoch.current;
    fetch("/api/model").then(readResponse).then((m) => {
      if (documentEpoch.current === epoch) { setModel(m); setBootError(""); }
    }).catch((e) => { if (documentEpoch.current === epoch) setBootError(e.message); });
    refreshSaved();
  }, [refreshSaved, beginDocument]);

  useEffect(() => {
    if (!sourcesLoaded || !link.current) return;
    const pending = link.current; link.current = null;
    history.replaceState(history.state, "", stripLink(location.href));
    const next = linkedSource(pending, sources);
    if (next && next !== activeSourceId) switchSource(next);
    else if (next) { sourceRef.current = next; setSourceId(next); try { storage.setItem(sourceStorageKey, next); } catch {} }
    setLinkedTable(pending.table);
  }, [sourcesLoaded, sources, activeSourceId, switchSource]);
  useEffect(() => {
    if (!model || !linkedTable) return;
    setLinkedTable(null);
    if (model.tables[linkedTable]) { setRegistryTable(linkedTable); setView("registry"); }
  }, [model, linkedTable]);

  const [exportingPng, setExportingPng] = useState(false);
  const exportDashboardPng = async () => {
    const surface = scrollRef.current?.querySelector<HTMLElement>(".canvas-surface");
    if (!surface || exportingPng) return;
    setExportingPng(true);
    try {
      await downloadPng(`${slugForFilename(dash?.title ?? "dashboard")}.png`, surface);
    } catch (e: any) {
      // A one-off failure (e.g. a cross-origin image on the canvas) isn't
      // worth a whole toast system -- logged for anyone who hits it.
      console.error("dashboard PNG export failed:", e);
    } finally {
      setExportingPng(false);
    }
  };

  const save = async (asCopy = false, throwOnFailure = false, candidate = book) => {
    if (!book || saving) return;
    const epoch = documentEpoch.current, key = draftKey.current;
    const id = asCopy ? crypto.randomUUID() : dashId ?? crypto.randomUUID();
    const snapshot = documentSnapshot(candidate ?? book, canvas);
    const body = JSON.stringify({ id, name: book.title, ...snapshot, revision: asCopy ? 0 : revision, schemaVersion: 1, ...(!dashId || asCopy ? { folderId: dashboardFolder } : {}) });
    setSaving(true); setNotice("");
    try {
      if (new Blob([body]).size > MAX_DOCUMENT_BYTES) throw new Error("Dashboard exceeds the 8 MB save limit. Remove or resize an image and try again.");
      const result = await fetch("/api/dashboards", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }).then(readResponse);
      if (documentEpoch.current !== epoch) return;
      setDashId(id); setTemplateId(null); setRevision(result.revision); setSavedFingerprint(JSON.stringify(snapshot));
      try {
        const all: Draft[] = parseDrafts(storage.getItem(draftStorageKey));
        storage.setItem(draftStorageKey, JSON.stringify(all.filter((d) => d.key !== key)));
        readDrafts();
      } catch { /* the server copy is saved even if recovery storage is unavailable */ }
      refreshSaved();
    } catch (e: any) { if (documentEpoch.current === epoch) setNotice(`Save failed: ${e.message}`); if (throwOnFailure) throw e; }
    finally { if (documentEpoch.current === epoch) setSaving(false); }
  };

  const openSaved = async (id: string) => {
    const epoch = documentEpoch.current;
    try {
      const d = await fetch(`/api/dashboards/${encodeURIComponent(id)}`).then(readResponse);
      if (documentEpoch.current !== epoch) return;
      const document = d.isTemplate ? fitStarter(d.spec, d.canvas, freshCanvas().width) : d;
      if (!beginDocument(document.spec, { id: d.isTemplate ? null : id, revision: d.isTemplate ? 0 : d.revision, canvas: document.canvas, saved: !d.isTemplate, folderId: d.folderId })) return;
      setTemplateId(d.isTemplate ? id : null);
      setOpenList(false); pendingFit.current = true;
    } catch (e: any) { setNotice(`Could not open dashboard: ${e.message}`); }
  };
  const browseLibrary = (folder: string | null) => {
    if (beginDocument(null)) { setView("library"); setLibraryFolder(folder); if (window.matchMedia("(max-width: 650px)").matches) setCollapsed(true); coreLibrary.refresh(); }
  };
  const openLibraryItem = (item: LibraryItem) => {
    if (item.kind === "dashboard") void openSaved(item.id); else setViewPreview(item);
  };
  const addSavedView = (view: LibraryView) => {
    if (!book || !model || !session.canEdit) return;
    const next = insertView(book, canvas, activeTabId, view.spec, model);
    if (new Blob([JSON.stringify(next.spec)]).size > MAX_DOCUMENT_BYTES) throw new Error("Adding this view would exceed the 8 MB dashboard limit.");
    commitBook(next.spec); setCanvas(next.canvas); setSelected([]);
    pendingReveal.current = { x: 24, y: next.top, w: Math.max(100, canvas.width - 48), h: 180 };
    setViewPicker(false); setViewPreview(null); setNotice(`“${view.name}” added. Undo restores the previous canvas.`, "success");
  };
  const chooseLibraryView = async (item: LibraryItem) => {
    if (viewPickBusy) return; const epoch = documentEpoch.current;
    setViewPickBusy(true); setViewPickError("");
    try {
      const savedView = viewSaveSchema.parse(await fetch(`/api/library/views/${encodeURIComponent(item.id)}`).then(readResponse));
      if (documentEpoch.current === epoch) addSavedView(savedView);
    } catch (e: any) { if (documentEpoch.current === epoch) setViewPickError(e.message); }
    finally { if (documentEpoch.current === epoch) setViewPickBusy(false); }
  };
  const backupInput = React.useRef<HTMLInputElement>(null);
  const mainRef = React.useRef<HTMLElement>(null);
  const topbarRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const header = topbarRef.current;
    if (!header) return;
    const measure = () => mainRef.current?.parentElement?.style.setProperty("--dashboard-header-height", `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [Boolean(dash), view]);
  // New compositions start at a readable size for this workspace. Saved
  // documents keep their authored dimensions when opened or resized.
  const freshCanvas = useCallback((): CanvasSpec => ({ ...DEFAULT_CANVAS, preset: "custom",
    width: Math.max(640, Math.min(1440, Math.floor(((mainRef.current?.clientWidth ?? 1100) - 44) / 8) * 8)),
  }), []);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * Place new work where the user is looking -- unless something is already
   * there. The naive viewport-based spot used to be returned unconditionally,
   * so on a dashboard with anything scrolled into view, every new tile landed
   * in the exact same place: on top of whatever was already there, fully
   * hiding it with no sign anything had been added.
   */
  const dropPoint = React.useCallback((w: number, h: number) => {
    const el = scrollRef.current;
    const naive = (() => {
      if (!el) return { x: 24, y: 24 };
      const pad = 28;
      const x = Math.max(0, Math.round((el.scrollLeft + pad) / zoom));
      const y = Math.max(0, Math.round((el.scrollTop + pad) / zoom));
      return {
        x: Math.min(x, Math.max(0, canvas.width - w - 8)),
        y: Math.min(y, Math.max(0, canvas.height - h - 8)),
      };
    })();
    const existing = (dash?.tiles ?? []).map((t) => t.layout);
    if (!existing.some((b) => overlaps({ ...naive, w, h }, b))) return naive;
    const bottom = existing.length ? Math.max(...existing.map((b) => b.y + b.h)) + 16 : 24;
    return { x: 24, y: bottom };
  }, [zoom, canvas.width, canvas.height, dash?.tiles]);
  const selectedTile = dash && selected.length === 1
    ? dash.tiles.find((t) => t.id === selected[0]) ?? null : null;
  const inspecting = !!selectedTile && selectedTile.kind !== "filter" && !canvas.locked;

  // Selection opens the Inspector without moving the user's canvas. Fit and
  // zoom remain explicit controls; revealing newly inserted content is separate.
  /** Zoom so the authored canvas fits the space actually available. */
  const fit = React.useCallback(() => {
    const avail = (mainRef.current?.clientWidth ?? 900) - 44;
    setZoom(Math.max(0.25, Math.min(1, Math.round((avail / canvas.width) * 100) / 100)));
  }, [canvas.width]);

  // A fresh `dash` from `/api/suggest` is exactly when the editor mounts for
  // the first time -- switching away from the Entry screen, not just
  // updating a tile within it. A bare `requestAnimationFrame(fit)` fired
  // right at fetch-resolution time raced that mount: React's commit for
  // the new `dash` (and the DOM it brings -- `.main`, the canvas surface)
  // isn't guaranteed to have landed by the time that single rAF callback
  // runs, so `fit()` could measure `mainRef`'s width from the OLD screen
  // (the Entry page's `<main>`, wider, no sidebar categories yet) --
  // computing a zoom that fits THAT, not the dashboard actually on screen,
  // and leaving a wide suggested dashboard overflowing the real viewport
  // at 100%. A `useEffect` keyed on `dash` is guaranteed by React to run
  // AFTER the DOM for that render has committed, so `mainRef.current` is
  // always the real, current editor layout by the time this fires. Only
  // armed by `pendingFit` -- an ordinary tile edit also changes `dash` and
  // must NOT re-fit, or every edit would silently undo a zoom level the
  // user set on purpose.
  const pendingFit = React.useRef(false);
  useEffect(() => {
    if (!pendingFit.current) return;
    pendingFit.current = false;
    fit();
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [dash, fit]);

  // Same race, different trigger: adding a tile below existing content
  // (dropPoint's "below everything" fallback, see growCanvasFor above) can
  // grow `canvas.height` in the very same call -- but that's a SEPARATE
  // `setCanvas` state update, not guaranteed to have reached the DOM by
  // the time a scroll immediately afterward reads `.canvas-scroll`'s
  // scrollHeight. Measured directly once: `el.scrollTo()` right after
  // `growCanvasFor()` left `scrollHeight === clientHeight` (the container
  // hadn't grown yet), so the scroll had nothing to move into and silently
  // no-opped. Deferred to a `useEffect` keyed on `dash` for the same
  // reason `pendingFit` is -- guaranteed to run after React has actually
  // committed both the new tile and the taller canvas.
  const pendingReveal = React.useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const at = pendingReveal.current;
    if (!at) return;
    pendingReveal.current = null;
    const el = scrollRef.current;
    if (!el) return;
    const pad = 16;
    const left = at.x * zoom - pad, top = at.y * zoom - pad;
    const right = (at.x + at.w) * zoom + pad, bottom = (at.y + at.h) * zoom + pad;
    let { scrollLeft, scrollTop } = el;
    const viewW = el.clientWidth, viewH = el.clientHeight;
    if (right - scrollLeft > viewW) scrollLeft = right - viewW;
    if (left < scrollLeft) scrollLeft = left;
    if (bottom - scrollTop > viewH) scrollTop = bottom - viewH;
    if (top < scrollTop) scrollTop = top;
    el.scrollTo({ left: Math.max(0, scrollLeft), top: Math.max(0, scrollTop), behavior: "auto" });
  }, [dash, zoom]);

  useEffect(() => {
    const epoch = documentEpoch.current;
    fetch("/api/model").then(readResponse).then((m) => { if (documentEpoch.current === epoch) { setModel(m); setBootError(""); } })
      .catch((e) => { if (documentEpoch.current === epoch) setBootError(e.message); });
  }, []);

  // In Public Sandbox mode, open the flagship SaaS overview dashboard immediately on first visit
  // so visitors land directly inside a live, populated executive dashboard rather than a blank menu.
  useEffect(() => {
    if (!sandboxMode || sandboxAutoOpened.current || !model || book || view !== "home" || link.current) return;
    const starter = showcaseStarters()["SaaS overview"];
    if (!starter || !model.metrics.ending_mrr) return;
    sandboxAutoOpened.current = true;
    const fitted = fitStarter(starter, DEFAULT_CANVAS, freshCanvas().width);
    if (beginDocument(fitted.spec, { canvas: fitted.canvas })) {
      setTemplateId("starter:SaaS overview");
      pendingFit.current = true;
    }
  }, [sandboxMode, model, book, view, freshCanvas, beginDocument]);

  const build = useCallback((brief: Brief) => {
    setInterview(false);
    const surface = freshCanvas();
    if (!beginDocument(null, { canvas: surface })) return;
    const epoch = documentEpoch.current;
    return fetch("/api/suggest", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brief, width: surface.width }),
    }).then(readResponse).then((d) => {
      if (documentEpoch.current !== epoch) return;
      pendingFit.current = true;
      setDash(d); setCanvas((c) => ({ ...c, height: Math.max(c.height, ...d.tiles.map((t: TileSpec) => t.layout.y + t.layout.h + 24)) })); setRefreshed(new Date());
      setGrain(documentGrain(d));
    }).catch((e) => { if (documentEpoch.current === epoch) setNotice(e.message); });
  }, [freshCanvas, beginDocument]);

  if (!model) return bootError ? <div className="setup-empty"><Connections sources={sources} activeId={activeSourceId} onSelect={switchSource} onRefresh={() => { refreshSources(); switchSource(""); }} principals={principals} policies={policies} /><p role="alert">{session.canAdmin ? "Connect a source to open your metric catalogue." : "No accessible source is ready. Contact your workspace administrator."}</p></div> : <div className="boot">Loading semantic layer…</div>;

  const nextId = () => `t${Math.random().toString(36).slice(2, 8)}`;
  // dropPoint pushes a tile below existing content when the natural spot is
  // occupied -- on a canvas already near the bottom of its fixed height, that
  // can place the new tile past canvas.height, where .canvas-surface's own
  // overflow:hidden clips it: not overlapping anything, but invisible either
  // way. Grow the canvas the same way Smart Arrange already does.
  const growCanvasFor = (bottom: number) => {
    if (bottom > canvas.height) setCanvas((c) => ({ ...c, height: Math.round(bottom) }));
  };
  // The same "below everything" fallback dropPoint uses to avoid hiding a
  // new tile UNDER existing content can just as easily place it below the
  // current SCROLL position instead -- growing the canvas fixes the tile
  // being clipped past canvas.height, but does nothing for a viewport that
  // simply never scrolled there. Arms the `pendingReveal` effect above
  // rather than scrolling right here -- see its own comment for why.
  const addTile = (t: Omit<TileSpec, "id" | "layout">, size?: { w: number; h: number }) => {
    if (!dash) return;
    const id = nextId();
    const w = size?.w ?? 420, h = size?.h ?? 280;
    const at = dropPoint(w, h);
    commit({ ...dash, tiles: [...dash.tiles, { ...t, id, layout: { ...at, w, h, z: 1 } }] });
    setSelected([id]);
    growCanvasFor(at.y + h + 24);
    pendingReveal.current = { x: at.x, y: at.y, w, h };
  };

  const addMany = (drafts: Omit<TileSpec, "id" | "layout">[]) => {
    if (!dash || !drafts.length) return;
    const PAD = 24, GAP = 16;
    let prepared: TileSpec[];
    try {
      prepared = drafts.map(d => prepareNewTile(model, { ...d, id: nextId(), layout: { x: 0, y: 0, w: 300, h: 156, z: 1 } }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not prepare these metrics for a KPI group.");
      return;
    }
    const available = Math.max(1, canvas.width - PAD * 2);
    const columns = Math.max(1, Math.min(prepared.length, Math.floor((available + GAP) / (260 + GAP))));
    const w = Math.floor((available - GAP * (columns - 1)) / columns);
    const h = prepared.some(t => t.dimensions.length) ? 220 : 156;
    const groupHeight = Math.ceil(prepared.length / columns) * (h + GAP) - GAP;
    // Reserve the whole group, including wrapped rows, and use the exact
    // origin we collision-tested. Existing authored content stays in place.
    const at = dropPoint(available, groupHeight);
    const made = prepared.map((d, i) => ({ ...d,
      layout: { ...d.layout, x: at.x + (i % columns) * (w + GAP), y: at.y + Math.floor(i / columns) * (h + GAP), w, h } }));
    commit({ ...dash, tiles: [...dash.tiles, ...made] });
    setSelected(made.map((m) => m.id));
    growCanvasFor(at.y + groupHeight + PAD);
    // A tall wrapped group cannot all fit in the viewport. Reveal its start.
    pendingReveal.current = { x: at.x, y: at.y, w: available, h };
  };

  const themeKeywordAliases: Record<string, string[]> = {
    "broadside": ["broadside", "editorial", "paper", "light", "default"],
    "newsroom-dark": ["newsroom-dark", "boardroom-dark", "executive-slate", "dark", "slate", "night"],
    "swiss-grid": ["swiss-grid", "high-contrast-print", "print", "monochrome", "contrast", "grid"],
    "studio-warm": ["studio-warm", "editorial-warm", "warm", "cream", "amber"],
  };

  const paletteItems: PaletteItem[] = [
    ...(session.canEdit ? [{
      id: "action:new-dashboard",
      label: "New dashboard from scratch",
      subtitle: "Start an empty governed canvas",
      category: "Actions" as const,
      keywords: ["new", "scratch", "blank", "create", "dashboard", "canvas"],
      onSelect: () => {
        const c = freshCanvas();
        if (beginDocument({ title: "Untitled dashboard", tiles: [] }, { canvas: c })) {
          pendingFit.current = true;
          setView("home");
        }
      },
    }] : []),
    {
      id: "action:semantic-coach",
      label: "Semantic Layer Coach & Dialect Converter",
      subtitle: dash
        ? "Score readiness, generate YAML fixes & convert across 5 dialects"
        : "Audit semantic readiness & convert across DuckGlue, Snowflake, MetricFlow, Glue & Cube",
      category: "Actions",
      keywords: ["coach", "dialect", "converter", "snowflake", "cortex", "metricflow", "dbt", "glue", "cube", "duckglue", "readiness", "semantic"],
      onSelect: () => {
        if (!dash) {
          setRegistryTable(null);
          setView("registry");
        }
        setCoachOpen(true);
      },
    },
    ...(dash ? [
      {
        id: "action:executive-digest",
        label: "Executive digest & snapshot with integrity checksum",
        subtitle: "Warehouse-verified headline values, Markdown & SHA-256 integrity checksum",
        category: "Actions" as const,
        keywords: ["digest", "brief", "sha256", "sha-256", "verified", "checksum", "snapshot", "executive", "summary"],
        onSelect: () => setDigestOpen(true),
      },
      {
        id: "action:yaml-sync",
        label: "Dashboard-as-Code (YAML sync & diff)",
        subtitle: "Inspect, diff & apply declarative dashboard YAML",
        category: "Actions" as const,
        keywords: ["yaml", "code", "git", "diff", "sync", "spec", "dashboard-as-code"],
        onSelect: () => setYamlSyncOpen(true),
      },
      ...(dash.tiles.length > 0 ? [{
        id: "action:review-share",
        label: "Review and share (Dashboard, Story & Infographic)",
        subtitle: "Editorial review, story presentation & infographic export",
        category: "Actions" as const,
        keywords: ["review", "share", "story", "infographic", "handoff", "presentation", "pdf"],
        onSelect: () => { setHandoffMode("dashboard"); setHandoff(true); },
      }] : []),
      ...(session.canEdit ? [{
        id: "action:ai-redesign",
        label: "Improve dashboard with AI",
        subtitle: "Preview improved layout, chart types & comparisons",
        category: "Actions" as const,
        keywords: ["ai", "improve", "redesign", "beautify", "arrange", "layout"],
        onSelect: () => setAiRedesign(true),
      }] : []),
      {
        id: "action:export-svg",
        label: "Export dashboard as Vector SVG",
        subtitle: "Print-grade scalable vector export of the canvas",
        category: "Actions" as const,
        keywords: ["export", "svg", "vector", "download", "print", "illustrator", "figma"],
        onSelect: () => {
          const surface = scrollRef.current?.querySelector<HTMLElement>(".canvas-surface");
          if (!surface) return;
          try {
            downloadSvg(`${slugForFilename(dash.title || "dashboard")}.svg`, surface);
          } catch (e: any) {
            setNotice(`Could not export SVG: ${e.message}`);
          }
        },
      },
      {
        id: "action:export-png",
        label: "Export dashboard as PNG",
        subtitle: "High-DPI raster image export of the canvas",
        category: "Actions" as const,
        keywords: ["export", "png", "image", "screenshot", "download"],
        onSelect: () => { void exportDashboardPng(); },
      },
    ] : []),
    {
      id: "action:ops-audit",
      label: "Operations, ROI & audit log",
      subtitle: "Query latency, cache hit rate & governance audit trail",
      category: "Actions",
      keywords: ["operations", "roi", "audit", "log", "telemetry", "governance", "cost"],
      onSelect: () => setOpsAuditOpen(true),
    },
    ...(dash && !canvas.locked
      ? THEME_PRESETS.map((preset): PaletteItem => ({
          id: `theme:${preset.id}`,
          label: `Theme: ${preset.label}`,
          subtitle: `${preset.hint ?? "Editorial canvas theme"}${(canvas.theme ?? "broadside") === preset.id ? " · Active" : ""}`,
          category: "Themes",
          keywords: [preset.id, preset.label, ...(themeKeywordAliases[preset.id] ?? [])],
          onSelect: () => changeCanvas({ ...canvas, theme: preset.id }),
        }))
      : []),
    {
      id: "nav:home",
      label: "Workspace Home",
      subtitle: !dash && view === "home" ? "Current view · Start or resume drafts" : "Return to workspace entry & drafts",
      category: "Navigate",
      keywords: ["workspace", "home", "start", "drafts", "entry"],
      onSelect: () => { if (beginDocument(null)) { setRegistryTable(null); setView("home"); } },
    },
    {
      id: "nav:library",
      label: "CoreCanvas Library",
      subtitle: "Saved dashboards, folders & reusable chart views",
      category: "Navigate",
      keywords: ["library", "corecanvas", "saved", "views", "folders", "templates"],
      onSelect: () => browseLibrary(null),
    },
    {
      id: "nav:registry",
      label: "Metric Registry",
      subtitle: `${Object.keys(model.metrics).length} governed metrics, synonyms & SQL contracts`,
      category: "Navigate",
      keywords: ["metric", "registry", "catalogue", "catalog", "definitions", "sql", "synonyms"],
      onSelect: () => { if (beginDocument(null)) { setRegistryTable(null); setView("registry"); } },
    },
    {
      id: "nav:model",
      label: "Data Model",
      subtitle: `${Object.keys(model.tables).length} tables & ${model.joins.length} verified joins`,
      category: "Navigate",
      keywords: ["data", "model", "tables", "joins", "grain", "schema", "columns"],
      onSelect: () => { if (beginDocument(null)) { setRegistryTable(null); setView("model"); } },
    },
    ...(session.canAdmin ? [{
      id: "nav:modeler",
      label: "Modeler",
      subtitle: "Extend tables, relationships & governed semantic definitions",
      category: "Navigate" as const,
      keywords: ["modeler", "author", "publish", "tables", "joins", "schema"],
      onSelect: () => { if (beginDocument(null)) { setRegistryTable(null); setView("modeler"); } },
    }] : []),
    {
      id: "nav:connections",
      label: "Connections",
      subtitle: `${sources.length || 1} warehouse sources, RLS policies & AI providers`,
      category: "Navigate",
      keywords: ["connections", "sources", "warehouse", "duckdb", "snowflake", "rls", "security"],
      onSelect: () => { if (beginDocument(null)) { setRegistryTable(null); setView("connections"); } },
    },
    ...Object.values(model.metrics).map((m): PaletteItem => ({
      id: `metric:${m.name}`,
      label: m.label,
      subtitle: `${m.baseTable} · ${m.type ?? "simple"}`,
      category: "Semantic Metrics",
      keywords: [m.name, m.baseTable, ...(m.synonyms ?? [])],
      onSelect: () => {
        if (dash && session.canEdit && !canvas.locked) {
          try {
            const prepared = prepareNewTile(model, {
              id: nextId(),
              kind: "metric",
              title: m.label,
              metrics: [m.name],
              dimensions: [],
              chart: "kpi",
              layout: { x: 0, y: 0, w: 320, h: 164, z: 1 },
            });
            const { id: _id, layout: _layout, ...draft } = prepared;
            const hasDim = prepared.dimensions.length > 0;
            addTile(draft, hasDim ? { w: 420, h: 248 } : { w: 320, h: 164 });
          } catch (err) {
            setNotice(err instanceof Error ? err.message : `Could not add ${m.label}.`);
          }
        } else if (!dash && session.canEdit) {
          setView("home");
          void build({ table: m.baseTable, metrics: [m.name], audience: "operator", grain });
        } else if (beginDocument(null)) {
          setRegistryTable(m.baseTable);
          setView("registry");
        }
      },
    })),
  ];

  return (
    <div className={"shell" + (collapsed ? " narrow" : "") + (inspecting ? " inspecting" : "")}>
      {collapsed && (
        <button className="reveal" title="Show sidebar" aria-label="Show sidebar"
                onClick={() => setCollapsed(false)}>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none"
               stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12" />
          </svg>
        </button>
      )}
      <Sidebar model={model} view={dash ? "" : view}
               library={<LibraryNavigation key={activeSourceId} data={coreLibrary.data} loading={coreLibrary.loading} error={coreLibrary.error} activeId={dashId ?? templateId} onBrowse={browseLibrary} onOpen={openLibraryItem} />}
               onView={(v) => { if (beginDocument(null)) { setRegistryTable(null); setView(v); } }}
               collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}
               onSettings={() => setSettingsOpen(true)}
               principals={principals} principal={asWho}
               onPrincipal={(id) => {
                 asWhoRef.current = id;
                 setAsWho(id);
                 try { localStorage.setItem("sc:principal", id); } catch {}
                 setDrillSessions({}); setFilterValues({}); refreshData();
               }}
               sources={sources} activeSource={activeSource} />

      <main className="main" ref={mainRef}>
        {sandboxMode && !sandboxDismissed && (
          <div className="sandbox-banner" role="status">
            <span>
              <strong>Public Sandbox</strong> · Live sample warehouse loaded — toggle Story &amp; Infographic below, or upload your own file.
            </span>
            <div className="sandbox-banner-actions">
              {session.canAdmin && (
                <button type="button" className="sandbox-upload-btn" onClick={() => setSpreadsheetImport(true)}>
                  ⊞ Drop Excel / CSV
                </button>
              )}
              <a href="https://github.com/Evinanderson89/semantic-canvas#quick-start" target="_blank" rel="noreferrer">
                Self-host in 60s ↗
              </a>
              <button type="button" className="link" aria-label="Dismiss sandbox banner" onClick={() => setSandboxDismissed(true)}>
                ✕
              </button>
            </div>
          </div>
        )}
        <input ref={backupInput} type="file" accept="application/json,.json" hidden aria-label="Import dashboard backup" onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; const epoch = documentEpoch.current;
          try {
            if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Backup exceeds the 8 MB document limit");
            const data = JSON.parse(await file.text()); if (documentEpoch.current !== epoch) return;
            if (data.schemaVersion !== 1) throw new Error("Unsupported backup version");
            if (data.source && data.source !== activeSourceId) throw new Error(`Select the backup's source (${data.source}) before importing it`);
            const spec = dashboardSchema.parse(data.spec), surface = canvasSchema.parse(data.canvas);
            const issues = validateDashboard(model, spec); if (issues.length) throw new Error(issues[0].problem);
            if (beginDocument(spec, { canvas: surface })) { setView("home"); setNotice("Backup restored as a new dashboard. Save to keep a server copy.", "success"); }
          } catch (error: any) { setNotice(`Could not import backup: ${error.message}`); }
        }} />
        {notice && <div className={`document-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-atomic="true"><span>{notice.message}</span>{notice.kind === "error" && dash && <button className="link" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, source: activeSourceId, ...documentSnapshot(book!, canvas) }, null, 2)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = `${slugForFilename(dash.title)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download backup</button>}{notice.kind === "error" && dash && notice.message.startsWith("Recovery backup failed") && <button className="link" onClick={() => {
          if (window.confirm("Leave this dashboard without saving? Download a backup first if you want to keep these changes.")) { currentDocument.current.dirty = false; beginDocument(null); setView("home"); }
        }}>Discard and leave</button>}<button type="button" className="link" aria-label="Dismiss notification" onClick={dismissNotice}>Dismiss</button></div>}
        {!dash && (
          <div className="cmdk-workspace-bar">
            <button
              type="button"
              className="cmdk-trigger"
              aria-label="Open command palette"
              title="Jump to a governed metric, run an action, or navigate (⌘K / Ctrl+K)"
              onClick={() => setPaletteOpen(true)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" />
              </svg>
              <span className="cmdk-trigger-label">Jump to metric or action</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        )}
        {!dash && view === "library" ? (
          <LibraryBrowser key={activeSourceId} data={coreLibrary.data} loading={coreLibrary.loading} error={coreLibrary.error} refresh={refreshSaved} folderId={libraryFolder} onFolder={setLibraryFolder} onOpen={openLibraryItem}
            onNewDashboard={folderId => { if (beginDocument({ title: "Untitled dashboard", tiles: [] }, { canvas: freshCanvas(), folderId })) pendingFit.current = true; }} />
        ) : !dash && view === "connections" ? (
          <Connections sources={sources} activeId={activeSourceId} onSelect={switchSource}
                       onRefresh={() => { refreshSources(); fetch("/api/model").then(readResponse).then(m => { setModel(m); refreshData(); }).catch(e => setNotice(e.message)); }} principals={principals} policies={policies} />
        ) : !dash && view === "registry" ? (
          <MetricRegistry model={model} initialTable={registryTable} sourceId={activeSourceId ?? ""}
            onChanged={() => fetch("/api/model").then(readResponse).then(m => { setModel(m); refreshData(); }).catch(e => setNotice(e.message))} onUse={(m) => {
            const t = metricOf(model, m).baseTable;
            setView("home"); build({ table: t, metrics: [m], audience: "operator", grain });
          }} />
        ) : !dash && view === "model" ? (
          <DataModel model={model} sourceId={activeSourceId ?? ""} onChanged={() => fetch("/api/model").then(readResponse).then(m => { setModel(m); refreshData(); }).catch(e => setNotice(e.message))} />
        ) : !dash && view === "modeler" ? (
          <Modeler sources={sources} onPublished={() => refreshSources()} onImportSpreadsheet={session.canAdmin ? () => setSpreadsheetImport(true) : undefined} />
        ) : !dash ? (
          <>{session.canEdit ? <Entry model={model} onDemo={demoDashboardAvailable(model) ? () => { const c = freshCanvas(); if (beginDocument(demoDashboard(c.width), { canvas: c })) { pendingFit.current = true; setView("home"); } } : undefined} onSuggest={() => setInterview(true)} onReference={() => setReferenceImport(true)} onSpreadsheet={session.canAdmin ? () => setSpreadsheetImport(true) : undefined}
                 onScratch={() => { pendingFit.current = true; beginDocument({ title: "Untitled dashboard", tiles: [] }, { canvas: freshCanvas() }); }} /> : <div className="explore"><span className="eyebrow">Company workspace</span><h1>Your metrics, in focus.</h1><p className="lede">Open a shared dashboard below, or browse CoreCanvas Library. Filters and drill-downs follow your company’s data permissions.</p></div>}
        <div className="document-library"><div className="library-heading"><h3>Continue your work</h3><span>{session.mode === "team" ? "Shared dashboards and your drafts in this tab" : "Saved dashboards and drafts on this computer"}</span></div>
          <button className="link" onClick={() => { refreshSaved(); setOpenList(true); }}>Open saved dashboard</button>
          {session.canEdit && <button className="link" onClick={() => backupInput.current?.click()}>Import backup</button>}
          {drafts.filter((d) => d.source === activeSourceId).map((d) => <div key={d.key}>
            <button className="link" onClick={() => beginDocument(d.spec, { id: d.id, revision: d.revision, canvas: d.canvas, draftKey: d.key, folderId: d.folderId })}>Recover draft: {d.spec.title}</button>
            <button className="link" aria-label={`Discard draft ${d.spec.title}`} onClick={() => {
              try {
                const current = parseDrafts(storage.getItem(draftStorageKey));
                storage.setItem(draftStorageKey, JSON.stringify(current.filter(x => x.key !== d.key)));
                readDrafts();
              } catch { setNotice("Could not discard the draft. Recovery storage is unavailable or unreadable; your saved recovery data has not been replaced."); }
            }}>Discard</button>
          </div>)}
        </div>
          </>
        ) : (
          <>
            <div className="topbar doc-head canvas-head" ref={topbarRef}>
              <button className="link back-link" onClick={() => beginDocument(null)}>← <span>Workspace</span></button>
              <div className="dashboard-identity">
                <h1 className="dash-title">{dash.title}</h1>
                <div className="dashboard-meta">
                  <span>{dash.tiles.length} tiles</span><span aria-hidden="true">·</span>
                  <span>{prettifyModelName(model.name)}</span>
                  <span className="masthead-pill" title="SHA-256 checks content integrity, not analytical correctness or authorship.">Snapshot with integrity checksum</span>
                  {templateId && <span title="This starter opens as a new dashboard. Save to keep your version.">· Starter copy</span>}
                  {refreshed && <span className="refresh-detail" title={`Refresh requested ${refreshed.toLocaleString()}`}>· Refresh requested {refreshed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
                </div>
              </div>
              <div className="dashboard-actions">
              <label className="period-control window-control">
                <span>Window</span>
                <select aria-label="Date window" value={dateWindow} onChange={(e) => { setDateWindow(e.target.value as DatePreset | "all"); setDrillSessions({}); }}>
                  <option value="all">All dates</option>
                  {PRESET_IDS.map((pid) => <option key={pid} value={pid}>{PRESETS[pid].label}</option>)}
                </select>
              </label>
              <label className="period-control">
                <span>Period</span>
                <select aria-label="Period" disabled={canvas.locked} value={documentGrain(dash)} onChange={(e) => { const next = withGrain(dash, e.target.value); const issues = next.tiles.flatMap(t => validateTile(model, t)); if (issues.length) { setNotice(issues[0].problem); return; } setNotice(""); setGrain(e.target.value); setDrillSessions({}); commit(next); }}>
                  {documentGrain(dash) === "mixed" && <option value="mixed" disabled>Per-chart periods</option>}
                  {GRAINS.map((g) => <option key={g} value={g}>{g === "day" ? "Daily" : g[0].toUpperCase() + g.slice(1) + "ly"}</option>)}
                </select>
              </label>
              <span className={"save-status" + (dirty ? " dirty" : "")} role="status">{!session.canEdit ? "Viewer access" : saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
              <button
                type="button"
                className="cmdk-trigger"
                aria-label="Open command palette"
                title="Jump to a governed metric, run an action, or switch theme (⌘K / Ctrl+K)"
                onClick={() => setPaletteOpen(true)}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" />
                </svg>
                <span className="cmdk-trigger-label">Jump</span>
                <kbd>⌘K</kbd>
              </button>
              <button className="icon quiet" title="Refresh" aria-label="Refresh" onClick={refreshData}>
                <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M16 10a6 6 0 1 1-1.8-4.2M16 3v3.5h-3.5" /></svg>
              </button>
              <button className="save-button" onClick={() => save()} disabled={saving || !session.canEdit} aria-label="Save dashboard">
                {saving ? "Saving…" : "Save"}
              </button>
              <button className="review-action" disabled={!dash.tiles.length} onClick={() => { setHandoffMode("dashboard"); setHandoff(true); }}>Review and share</button>
              <Popover label="Dashboard actions" trigger={<span aria-hidden="true">•••</span>} align="end" className="document-menu">
                {(close) => <>
                  <button onClick={() => { close(); refreshSaved(); setOpenList(true); }}>Open saved dashboard</button>
                  <button disabled={saving || !session.canEdit} onClick={() => { close(); save(true); }}>Save a copy</button>
                  <button disabled={!session.canEdit} onClick={() => { close(); setDistributing(true); }}>Copy charts to…</button>
                  <button disabled={!session.canEdit || !dash.tiles.length} onClick={() => { close(); coreLibrary.refresh(); setSaveViewOpen(true); }}>Save a view to library</button>
                  <button disabled={!session.canEdit} onClick={() => { close(); setReferenceImport(true); }}>Recreate from reference</button>
                  <button onClick={() => { close(); setDigestOpen(true); }}>Executive digest &amp; integrity snapshot</button>
                  <button onClick={() => { close(); setYamlSyncOpen(true); }}>Dashboard-as-Code (YAML)</button>
                  <button onClick={() => { close(); setCoachOpen(true); }}>Semantic layer coach</button>
                  <button disabled={exportingPng} onClick={() => { close(); exportDashboardPng(); }}>
                    {exportingPng ? "Exporting…" : "Export dashboard as PNG"}
                  </button>
                  <button onClick={() => {
                    close();
                    const surface = scrollRef.current?.querySelector<HTMLElement>(".canvas-surface");
                    if (!surface) return;
                    try {
                      downloadSvg(`${slugForFilename(dash?.title ?? "dashboard")}.svg`, surface);
                    } catch (e: any) {
                      setNotice(`Could not export SVG: ${e.message}`);
                    }
                  }}>Export dashboard as SVG</button>
                  <button onClick={() => { close(); setOpsAuditOpen(true); }}>Operations, ROI & audit log</button>
                  <button onClick={() => { close(); navigator.clipboard?.writeText(JSON.stringify(book, null, 2)); }}>Copy dashboard spec</button>
                </>}
              </Popover>
              </div>
            </div>

            <div className={`document-state-bar${canvas.locked ? " preview" : ""}`} aria-label="Dashboard mode">
              <span className="mode-label">{!session.canEdit ? "VIEWER" : canvas.locked ? "PREVIEW" : "EDIT MODE"}</span>
              <div className="journey-bar" role="group" aria-label="End-to-end analytics journey">
                {session.canEdit && (
                  <button
                    type="button"
                    className="journey-step"
                    aria-pressed={!canvas.locked && !handoff && !aiRedesign}
                    title="Edit tiles, layout, and chart formatting on the canvas"
                    onClick={() => {
                      setHandoff(false);
                      setAiRedesign(false);
                      if (canvas.locked) changeCanvas({ ...canvas, locked: false });
                    }}
                  >
                    <span className="journey-num">1</span>
                    Edit Canvas
                  </button>
                )}
                {session.canEdit && (
                  <button
                    type="button"
                    className="journey-step"
                    disabled={!dash.tiles.length}
                    aria-pressed={aiRedesign}
                    title="Open the before/after AI & deterministic redesign studio"
                    onClick={() => {
                      setHandoff(false);
                      if (canvas.locked) changeCanvas({ ...canvas, locked: false });
                      setAiRedesign(true);
                    }}
                  >
                    <span className="journey-num">2</span>
                    Improve &amp; Arrange
                  </button>
                )}
                <button
                  type="button"
                  className="journey-step"
                  disabled={!dash.tiles.length}
                  aria-pressed={handoff && handoffMode === "story"}
                  title="Open the question-led Executive Story view with supporting evidence"
                  onClick={() => {
                    setHandoffMode("story");
                    setHandoff(true);
                  }}
                >
                  <span className="journey-num">3</span>
                  Executive Story
                </button>
                <button
                  type="button"
                  className="journey-step"
                  disabled={!dash.tiles.length}
                  aria-pressed={handoff && handoffMode === "infographic"}
                  title="Open the Broadside Infographic poster view with vector SVG export"
                  onClick={() => {
                    setHandoffMode("infographic");
                    setHandoff(true);
                  }}
                >
                  <span className="journey-num">4</span>
                  Broadside Infographic
                </button>
              </div>
              <span className="state-version"><strong>{dashId ? `Saved version ${revision}` : "Not saved yet"}</strong>{canvas.locked ? " · Preview does not publish" : ""}</span>
              <span className="spacer" />
              <button disabled={!dashId} title={!dashId ? "Save once to start version history" : "Browse and restore saved dashboard designs"} onClick={() => setHistoryOpen(true)}>Version history</button>
              {session.canEdit && <div className="mode-switch" aria-label="Dashboard viewing mode">
                <button aria-label="Edit dashboard" aria-pressed={!canvas.locked} onClick={() => changeCanvas({ ...canvas, locked: false })}>Edit</button>
                <button aria-label="Preview dashboard" aria-pressed={canvas.locked} onClick={() => changeCanvas({ ...canvas, locked: true })}>Preview</button>
              </div>}
            </div>

            <TabStrip spec={book!} active={activeTabId} locked={canvas.locked} onChange={commitBook} onSelect={id => {
              setActiveTabId(id); setSelected([]); setDrillSessions({}); setBook(b => b ? { ...b, crossFilters: [] } : b); pendingFit.current = true;
            }} />
            {(book!.filters ?? []).some(f => (f.scope === "report" || f.tabId === currentTab(book!, activeTabId).id) && !dash.tiles.some(t => t.filterId === f.id)) && <div className="shared-filter-shelf" aria-label="Dashboard filters">
              {(book!.filters ?? []).filter(f => (f.scope === "report" || f.tabId === currentTab(book!, activeTabId).id) && !dash.tiles.some(t => t.filterId === f.id)).map(f => <FilterControl key={f.id} compact filter={f} value={filterValues[f.id] ?? f.defaultValue ?? {}} onChange={v => setFilterValues(values => ({ ...values, [f.id]: v }))} spec={book!} model={model} activeTab={currentTab(book!, activeTabId).id} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} onEdit={!canvas.locked ? () => setFilterEditing(f.id) : undefined} />)}
            </div>}
            {!canvas.locked && (
              <EditBar model={model} canvas={canvas} onCanvas={changeCanvas} zoom={zoom} onZoom={setZoom} onFit={fit} onSettings={() => setSettingsOpen(true)} onRedesign={() => setAiRedesign(true)}
                       selected={selected} tiles={dash.tiles}
                       onCompose={(tiles, surface) => compose({ ...dash, tiles }, surface)}
                       onTiles={(t) => commit({ ...dash, tiles: t })}
                       beautify={<DashboardBeautify key={`${activeSourceId}:${asWho}:${draftKey.current}:${activeTabId}`} dash={dash} canvas={canvas} model={model} activeTabId={currentTab(book!, activeTabId).id}
                                                     aiAvailable={aiAvailable} canConfigureAi={session.canAdmin} onConnections={() => setView("connections")} onDash={d => compose(d, { ...canvas, height: Math.max(canvas.height, ...d.tiles.map(t => t.layout.y + t.layout.h + 24)) })} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} drills={drills} filtersByTile={Object.fromEntries(dash.tiles.map(t => [t.id, [...filtersForTile(book!, t, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, t, dateWindow, todayOf(model), calendarOf(model))]]))} />} />
            )}


            {(dash.crossFilters?.length ?? 0) > 0 && (
              <div className="xfilters">
                <span className="xf-label">Filtered by</span>
                {dash.crossFilters!.map((f) => (
                  <button key={f.id} className="xf" title="Remove this filter"
                          onClick={() => setDash({ ...dash,
                            crossFilters: dash.crossFilters!.filter((x) => x.id !== f.id) })}>
                    <b>{f.field.split(".").pop()}</b>
                    <span>{(f.values ?? []).map(v => v === null ? "Missing (null)" : String(v)).join(", ")}</span>
                    <i>✕</i>
                  </button>
                ))}
                <button className="xf clear"
                        onClick={() => setDash({ ...dash, crossFilters: [] })}>Clear all</button>
              </div>
            )}

            <ChartActivityProvider key={`${activeSourceId}:${asWho}:${draftKey.current}`} preferences={chartPreferences.preferences} dashboardId={dashId} document={book!} revision={revision} dirty={dirty} onSave={() => save(false, true)} model={model}>
            <Canvas canvas={canvas} tiles={dash.tiles} zoom={zoom}
                    emptyState={!canvas.locked ? <div className="canvas-empty">
                      <div className="empty-composition" aria-hidden="true"><i /><i /><i /></div>
                      <h2>Every story starts somewhere.</h2>
                      <p>Add your first metric, then make it your own.</p>
                      <button className="save-button" onClick={() => setAiRedesign(true)}>Build with AI</button>
                      <button className="link" onClick={() => setInterview(true)}>Choose a guided starting point</button>
                      <button className="link" onClick={() => setPicking(true)}>Add a chart</button>
                      <span>Or add a heading or note from the toolbar below.</span>
                    </div> : undefined}
                    selected={selected} onSelect={setSelected}
                    onChange={(t) => { setDash({ ...dash, tiles: t }); }}
                    scrollRef={scrollRef}
                    onCommit={(before) => { past.current.push(documentSnapshot(mergeTab(book, { ...dash, tiles: before }, activeTabId), canvas));
                                            future.current = [];
                                            if (past.current.length > 80) past.current.shift(); }}
                    renderTile={(t) => t.kind === "filter" ? (() => {
                      const f = book!.filters?.find(f => f.id === t.filterId);
                      return f ? <FilterControl filter={f} value={filterValues[f.id] ?? f.defaultValue ?? {}} onChange={v => setFilterValues(values => ({ ...values, [f.id]: v }))} spec={book!} model={model} activeTab={currentTab(book!, activeTabId).id} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} onEdit={!canvas.locked ? () => setFilterEditing(f.id) : undefined} /> : <p role="alert">This filter needs a connection.</p>;
                    })() : (
                      <TileBoundary label={t.title ?? t.metrics.join(", ")}>
                      <Tile key={`${activeSourceId}:${asWho}:${refreshToken}`} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} model={model} spec={t} locked={canvas.locked}
                            scopeWarnings={unappliedFilters(book!, t, filterValues, model)}
                            crossFilters={[...(dash.crossFilters ?? []), ...filtersForTile(book!, t, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, t, dateWindow, todayOf(model), calendarOf(model))]}
                            onCrossFilter={(f) => setDash((d) => !d ? d : ({
                              ...d,
                              crossFilters: [
                                ...(d.crossFilters ?? []).filter((x) => x.field !== f.field), f],
                            }))}
                            onInvestigate={result => setInvestigating({ id: t.id, result })}
                            aiAvailable={aiAvailable}
                            drill={drills[t.id]}
                            onDrill={(entry) => setDrillSessions((d) => ({ ...d, [t.id]: { query: drillQueryKey(t),
                              entries: [...(d[t.id]?.query === drillQueryKey(t) ? d[t.id].entries : []), entry] } }))}
                            onDrillUp={(toIndex) => setDrillSessions((d) => ({ ...d, [t.id]: { query: drillQueryKey(t),
                              entries: (d[t.id]?.query === drillQueryKey(t) ? d[t.id].entries : []).slice(0, toIndex) } }))}
                            onRemove={(id) => commit({ ...dash, tiles: dash.tiles.filter((x) => x.id !== id).map(x => ({ ...x, section: x.section === id ? null : x.section })) })}
                            onUpdate={(next) => {
                              const merged = dash.tiles.map((x) => (x.id === next.id ? next : x));
                              // A tile's own edit can change its HEIGHT (Beautify's
                              // "Remove breakdown"/"Show over time" resize the tile
                              // to match what it now shows) without knowing what
                              // sits below it -- so a tile that grew, or a neighbor
                              // that never moved to make room, can end up visually
                              // overlapping. Only reflows when that update actually
                              // produced a collision, never on an ordinary edit that
                              // didn't touch layout at all.
                              const collided = merged.some((t) => t.id !== next.id && overlaps(t.layout, next.layout));
                              // stretch:false -- this is a correction, not the
                              // user asking for a clean layout. Stretching the
                              // tile that just grew would only make the NEXT
                              // resize's collision harder to resolve without
                              // stretching again, the same compounding this
                              // option exists to avoid for repeated additions.
                              commit({ ...dash, tiles: collided ? applyLayout("grid", merged, canvas.width, false) : merged });
                            }} />
                      </TileBoundary>
                    )} />
            </ChartActivityProvider>
          </>
        )}
      </main>

      {settingsOpen && <ChartSettings preferences={chartPreferences.preferences} onChange={chartPreferences.update} error={chartPreferences.error} onClose={() => setSettingsOpen(false)} />}
      {historyOpen && dashId && book && <VersionHistory key={`${activeSourceId}:${dashId}`} id={dashId} current={book} currentCanvas={canvas} dirty={dirty} canEdit={session.canEdit && !saving} onClose={() => setHistoryOpen(false)} onRestore={version => {
        const issues = validateDashboard(model, version.spec);
        if (issues.length) throw new Error(`This version needs updated metric definitions: ${issues[0].problem}`);
        if (beginDocument(version.spec, { id: dashId, revision, canvas: version.canvas, folderId: dashboardFolder })) {
          setNotice(`Version ${version.revision} restored as an unsaved draft. Save to create version ${revision + 1}; earlier versions remain available.`, "success");
          pendingFit.current = true;
        } else throw new Error("Could not preserve your current draft. Download a backup before restoring.");
      }} />}
      {saveViewOpen && book && <SaveViewDialog key={`${activeSourceId}:${asWho}`} book={book} canvas={canvas} activeTab={activeTabId} selected={selected} folders={coreLibrary.data.folders} defaultFolder={coreLibrary.data.folders.some(f => f.id === libraryFolder) ? libraryFolder : null} model={model} onClose={() => setSaveViewOpen(false)} onSaved={() => { setSaveViewOpen(false); coreLibrary.refresh(); setNotice("View saved to CoreCanvas Library. Find it under Views → Browse saved views.", "success"); }} />}
      {viewPicker && book && <StudioDialog title="CoreCanvas Library" wide onClose={() => { if (!viewPickBusy) setViewPicker(false); }}>
        <LibraryBrowser key={activeSourceId} viewsOnly data={coreLibrary.data} loading={coreLibrary.loading} error={coreLibrary.error} refresh={coreLibrary.refresh} folderId={libraryFolder} onFolder={setLibraryFolder} onOpen={chooseLibraryView} />
        {viewPickError && <p className="library-error" role="alert">{viewPickError}</p>}{viewPickBusy && <p className="library-error" role="status">Adding your view…</p>}
      </StudioDialog>}
      {viewPreview && <ViewPreviewDialog key={`${activeSourceId}:${asWho}:${viewPreview.id}`} item={viewPreview} model={model} canInsert={!!book && session.canEdit && !canvas.locked} onClose={() => setViewPreview(null)}
        onInsert={v => { try { addSavedView(v); } catch (e: any) { setViewPreview(null); setNotice(e.message); } }}
        onOpen={v => { const issues = validateDashboard(model, v.spec); if (issues.length) { setViewPreview(null); setNotice(issues[0].problem); return; } if (beginDocument({ ...v.spec, title: v.name }, { canvas: v.canvas })) { setView("home"); pendingFit.current = true; } }} />}

      {spreadsheetImport && session.canAdmin && (
        <SpreadsheetImport
          onClose={() => setSpreadsheetImport(false)}
          onImported={({ sourceId, label, tableName, metrics }) => {
            setSpreadsheetImport(false);
            refreshSources();
            sourceRef.current = sourceId;
            setSourceId(sourceId);
            setLibraryFolder(null);
            try { storage.setItem(sourceStorageKey, sourceId); } catch {}
            setView("home");
            const epoch = documentEpoch.current;
            fetch("/api/model").then(readResponse).then((nextModel) => {
              if (documentEpoch.current !== epoch) return;
              setModel(nextModel);
              setBootError("");
              build({
                table: tableName,
                metrics: metrics.slice(0, 4),
                audience: "operator",
                grain: "month",
                text: `Overview of ${label}`,
              });
              setNotice(`Imported "${label}" and built an instant governed dashboard.`, "success");
            }).catch((e) => setNotice(e.message));
          }}
        />
      )}
      {referenceImport && <ReferenceImport key={`${activeSourceId}:${asWho}`} model={model} width={freshCanvas().width} aiAvailable={aiAvailable} onClose={() => setReferenceImport(false)} onConnections={() => { if (beginDocument(null)) setView("connections"); }} onCreate={(spec, height) => {
        if (beginDocument(spec, { canvas: { ...freshCanvas(), height } })) { setView("home"); pendingFit.current = true; setNotice("Reference recreated with live catalogue metrics. Review the matches and save when ready.", "success"); }
      }} />}
      {distributing && book && <DistributeDialog key={`${activeSourceId}:${asWho}`} spec={book} selected={selected} activeTab={activeTabId} currentId={dashId} model={model} canvas={canvas} filterValues={filterValues} onChange={(s, c) => { commitBook(s); setCanvas(c); }} onClose={() => setDistributing(false)} onNotice={message => setNotice(message, "success")} />}
      {filterEditing && book && <FilterDesigner key={filterEditing} spec={book} model={model} tabId={currentTab(book, activeTabId).id} existing={book.filters?.find(f => f.id === filterEditing)} onClose={() => setFilterEditing(null)} onDelete={() => {
        commitBook({ ...book, filters: book.filters?.filter(f => f.id !== filterEditing), tiles: book.tiles.filter(t => t.filterId !== filterEditing) }); setFilterEditing(null);
      }} onSave={f => {
        const owner = currentTab(book, activeTabId).id;
        const kept = book.tiles.filter(t => t.filterId !== f.id || f.scope === "report" || (t.tabId ?? tabsOf(book)[0].id) === owner).map(t => t.filterId === f.id ? { ...t, title: f.label } : t);
        const existing = kept.some(t => t.filterId === f.id);
        const size = filterTileSize(f), at = { ...dropPoint(size.w, size.h), ...size };
        const next = { ...book, filters: [...(book.filters ?? []).filter(x => x.id !== f.id), f], tiles: existing ? kept : [...kept, { id: nextId(), kind: "filter" as const, filterId: f.id, tabId: owner, title: f.label, metrics: [], dimensions: [], layout: at }] };
        const issues = validateDashboard(model, next); if (issues.length) { setNotice(issues[0].problem); return; }
        commitBook(next); if (!existing) { growCanvasFor(at.y + size.h + 24); pendingReveal.current = at; } setFilterEditing(null);
      }} />}
      {inspecting && (
        <Inspector model={model}
                   queryContext={`${activeSourceId}:${asWho}:${refreshToken}`}
                   tile={selectedTile!}
                   onChange={(next) => commit({ ...dash!,
                     tiles: dash!.tiles.map((x) => (x.id === next.id ? next : x)) })}
                   onClose={() => setSelected([])} />
      )}
      {openList && (
        <StudioDialog title="Saved dashboards" onClose={() => setOpenList(false)}>
            <section>
              {saved.length === 0
                ? <p className="lede">Nothing saved yet. Build a dashboard and hit save.</p>
                : saved.map((d) => (
                    <button key={d.id} className="optcard" onClick={() => openSaved(d.id)}>
                      <b>{d.name}</b><small>{d.updated_at ? new Date(d.updated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Earlier save · time zone unavailable"}</small>
                    </button>
                  ))}
            </section>
        </StudioDialog>
      )}
      {interview && <div className="iv-scrim">
        <Interview model={model} onCancel={() => setInterview(false)} onDone={build} />
      </div>}
      <AgentQuestions />
      {investigating && dash?.tiles.some(t => t.id === investigating.id) && <Investigation
        key={JSON.stringify([activeSourceId, asWho, refreshToken, dash, filterValues, drills, investigating.id])}
        source={dash.tiles.find(t => t.id === investigating.id)!} result={investigating.result} model={model}
        filters={[...(dash.crossFilters ?? []), ...filtersForTile(book!, dash.tiles.find(t => t.id === investigating.id)!, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, dash.tiles.find(t => t.id === investigating.id)!, dateWindow, todayOf(model), calendarOf(model))]}
        drill={drills[investigating.id] ?? []} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`}
        scopeWarnings={unappliedFilters(book!, dash.tiles.find(t => t.id === investigating.id)!, filterValues, model)}
        canKeep={session.canEdit && !canvas.locked} onClose={() => setInvestigating(null)}
        onKeep={candidate => {
          if (!session.canEdit || canvas.locked) return;
          const issues = validateTile(model, candidate); if (issues.length) { setNotice(issues[0].problem); return; }
          const { id, layout, ...draft } = candidate;
          addTile(draft, { w: Math.min(900, canvas.width - 48), h: 440 }); setInvestigating(null);
          setNotice("Investigation added with its captured period and filters. One undo removes it.", "success");
        }} />}
      {handoff && dash && <ReviewHandoff canEdit={session.canEdit} activeTabId={activeTabId} canSave={session.canEdit && !saving} initialMode={handoffMode} key={`${activeSourceId}:${asWho}:${refreshToken}:${activeTabId}:${draftKey.current}:${presentationContentKey(dash)}:${JSON.stringify([filterValues, drills])}`} spec={dash} canvas={canvas} model={model} dirty={dirty}
        evidenceScope={JSON.stringify({ source: activeSourceId, principal: asWho, user: session.user?.id, policy: session.policy })}
        queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} drills={drills}
        filtersByTile={Object.fromEntries(dash.tiles.map(t => [t.id, [...filtersForTile(book!, t, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, t, dateWindow, todayOf(model), calendarOf(model))]]))}
        scopeWarnings={Object.fromEntries(dash.tiles.map(t => [t.id, unappliedFilters(book!, t, filterValues, model)]))}
        onClose={() => setHandoff(false)} onKeepBrief={brief => { if (book && session.canEdit) { const next = withPresentationBrief(book, activeTabId, brief); if (next !== book) commitBook(next); } }}
        onSave={async brief => { if (!book || !session.canEdit || saving) throw new Error("Saving is unavailable"); const next = withPresentationBrief(book, activeTabId, brief); if (next !== book) commitBook(next); await save(false, true, next); }}
        onWatch={() => { chartPreferences.update("alerts", true); setHandoff(false); setNotice("Chart alerts are visible. Choose a chart’s bell to preview a watch. Save edits first; watches use saved filter defaults.", "info"); }}
        onImproveArrange={session.canEdit ? () => {
          setHandoff(false);
          if (canvas.locked) changeCanvas({ ...canvas, locked: false });
          setAiRedesign(true);
        } : undefined} />}
      {aiRedesign && dash && session.canEdit && <AiRedesign filterContext={JSON.stringify([filterValues, dateWindow])} activeTabId={currentTab(book!, activeTabId).id} resolveFilters={proposed => Object.fromEntries(proposed.tiles.map(t => [t.id, [...filtersForTile({ ...book!, filters: proposed.filters ?? book!.filters, tiles: proposed.tiles }, t, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, t, dateWindow, todayOf(model), calendarOf(model))]]))} key={`redesign:${activeSourceId}:${asWho}:${draftKey.current}:${activeTabId}`} spec={dash} canvas={canvas} model={model} available={aiAvailable} canConfigure={session.canAdmin}
        resolveScopeWarnings={proposed => Object.fromEntries(proposed.tiles.map(t => [t.id, unappliedFilters(proposed, t, filterValues, model)]))}
        onClose={() => setAiRedesign(false)} onConfigure={() => { setAiRedesign(false); setView("connections"); }}
        queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} drills={drills} filtersByTile={Object.fromEntries(dash.tiles.map(t => [t.id, [...filtersForTile(book!, t, filterValues, todayOf(model), calendarOf(model)), ...globalWindowFilterForTile(model, t, dateWindow, todayOf(model), calendarOf(model))]]))}
        onApply={(proposal, expected) => {
          if (!session.canEdit || canvas.locked || fingerprint(dash, canvas) !== expected) { setNotice("The dashboard changed. Generate a fresh redesign first."); return false; }
          try { const next = validateRedesign(dash, canvas, proposal, model, currentTab(book!, activeTabId).id); compose(next.spec, next.canvas); setNotice("Redesign applied. One undo restores the previous version.", "success"); return true; }
          catch (e: any) { setNotice(`Could not apply redesign: ${e.message}`); return false; }
        }} />}
      <AgentChat key={`${activeSourceId}:${asWho}:${draftKey.current}:${activeTabId}`} document={dash && session.canEdit && !canvas.locked ? { spec: dash, canvas, selected, activeTabId: currentTab(book!, activeTabId).id } : null}
        onApply={(proposal, expected) => {
          if (!session.canEdit || canvas.locked || !dash || fingerprint(dash, canvas) !== expected) { setNotice("The dashboard changed. Request a fresh proposal before applying it."); return false; }
          try { const next = applyProposal(dash, canvas, proposal, model, currentTab(book!, activeTabId).id); compose(next.spec, next.canvas); setNotice("Changes applied. Undo restores the previous version.", "success"); return true; }
          catch (e: any) { setNotice(`Could not apply proposal: ${e.message}`); return false; }
        }} />
      {dash && !canvas.locked && (
        <InsertMenu model={model} onInsert={addTile} onInsertMany={addMany}
                    onLibrary={() => { setViewPickError(""); coreLibrary.refresh(); setViewPicker(true); }} onSaveView={() => { coreLibrary.refresh(); setSaveViewOpen(true); }} canSaveView={dash.tiles.length > 0}
                    onOpenPicker={() => setPicking(true)} onFilter={() => setFilterEditing("new")} />
      )}
      {picking && <Picker model={model} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} onAdd={(d) => addTile(d)} onClose={() => setPicking(false)} />}
      {digestOpen && dash && <ExecutiveDigestDialog dashboardId={dashId} spec={dash} model={model} onClose={() => setDigestOpen(false)} />}
      {yamlSyncOpen && dash && <YamlCodeSyncDialog dashboardId={dashId} spec={dash} canvas={canvas} onApply={(nextSpec, nextCanvas) => { compose(nextSpec, nextCanvas ?? canvas); setNotice("Dashboard YAML applied to canvas.", "success"); }} onClose={() => setYamlSyncOpen(false)} />}
      {opsAuditOpen && <OperationsAuditDialog onClose={() => setOpsAuditOpen(false)} />}
      {coachOpen && <SemanticCoachDialog model={model} sourceId={activeSourceId ?? ""} onChanged={() => fetch("/api/model").then(readResponse).then(m => { setModel(m); refreshData(); }).catch(e => setNotice(e.message))} onClose={() => setCoachOpen(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
    </div>
  );
}

function Entry({ model, onSuggest, onScratch, onReference, onSpreadsheet, onDemo }: any) {
  return (
    <div className="entry">
      <div className="eyebrow">Semantic Canvas</div>
      <h2>Dashboards from<br /><em>governed metrics.</em></h2>
      <p className="lede">Drop an Excel or CSV sheet, ask a question in plain English, or sketch a layout. Every chart uses reviewed definitions, and the brief shows what it leaves out.</p>
      {onDemo && <button className="demo-entry-link" onClick={onDemo}>Try the design playground <span aria-hidden="true">→</span><small>Start with a messy dashboard. Improve the charts, then shape the story.</small></button>}
      <div className="model-summary"><span className="dot ready" />{prettifyModelName(model.name)}<span>· {Object.keys(model.metrics).length} metrics ready to explore</span></div>
      <div className="paths">
        {onSpreadsheet && (
          <button className="path spreadsheet-path" onClick={onSpreadsheet}>
            <span className="path-glyph" aria-hidden="true">⊞</span>
            <h3>Drop an Excel or CSV sheet <span>↗</span></h3>
            <p>Upload an .xlsx or .csv file—no SQL or YAML needed. Confirm 3 plain-English details on a 5-row preview and get an instant dashboard.</p>
          </button>
        )}
        <button className="path suggested" onClick={onSuggest}>
          <span className="path-glyph" aria-hidden="true">✧</span>
          <h3>Suggest a dashboard <span>↗</span></h3>
          <p>Start from a question. It proposes the metrics, trends and breakdowns, and you confirm before anything is built.</p>
        </button>
        <button className="path" onClick={onScratch}>
          <span className="path-glyph" aria-hidden="true">+</span>
          <h3>Start from scratch <span>↗</span></h3>
          <p>An empty canvas. Add charts, headings and notes; arrange them yourself.</p>
        </button>
        <button className="path reference-path" aria-label="Recreate from reference" onClick={onReference}>
          <span className="path-glyph" aria-hidden="true">▧</span><div><h3>Recreate from reference <span>↗</span></h3><p>A sketch, photo or PDF becomes a layout on catalogue metrics. Unmatched boxes stay placeholders, never guesses.</p></div>
        </button>
      </div>
    </div>
  );
}
