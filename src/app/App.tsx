import React, { useCallback, useEffect, useState } from "react";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";
import { Picker } from "./Picker.tsx";
import { Sidebar, prettyTable } from "./Sidebar.tsx";
import { Canvas } from "../canvas/Canvas.tsx";
import { EditBar } from "./EditBar.tsx";
import { DashboardBeautify } from "./DashboardBeautify.tsx";
import { InsertMenu } from "./InsertMenu.tsx";
import { Interview } from "./Interview.tsx";
import { AgentQuestions } from "./AgentQuestions.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { Inspector } from "./Inspector.tsx";
import { MetricRegistry, DataModel } from "./Explore.tsx";
import { Connections, type Principal, type RlsPolicy, type SourceInfo } from "./Connections.tsx";
import type { Brief } from "../suggest/match.ts";
import { DEFAULT_CANVAS, type CanvasSpec } from "../canvas/presets.ts";
import { overlaps } from "../canvas/geometry.ts";
import { applyLayout } from "../canvas/layouts.ts";
import { demoDashboard, demoDashboardAvailable } from "../suggest/demo.ts";
import { downloadPng, slugForFilename } from "./export.ts";
import { metricsByTable, prettifyModelName, type Model } from "../semantic/model.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

import { readResponse } from "./http.ts";
import { documentSnapshot, fingerprint, withGrain, type DocumentSnapshot, type Draft } from "./document.ts";
import { MAX_DOCUMENT_BYTES } from "../compiler/schema.ts";

const GRAINS = ["day", "week", "month", "quarter", "year"];

export function App() {
  const [bootError, setBootError] = useState("");
  const [model, setModel] = useState<Model | null>(null);
  const [dash, setDash] = useState<DashboardSpec | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [grain, setGrain] = useState("month");
  const [picking, setPicking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [refreshed, setRefreshed] = useState<Date | null>(null);
  const [canvas, setCanvas] = useState<CanvasSpec>(DEFAULT_CANVAS);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [interview, setInterview] = useState(false);
  const [view, setView] = useState<"home" | "registry" | "model" | "connections">("home");
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [policies, setPolicies] = useState<RlsPolicy[]>([]);
  const [asWho, setAsWho] = useState<string>(() => {
    try { return localStorage.getItem("sc:principal") ?? ""; } catch { return ""; }
  });
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [autoSourceId, setAutoSourceId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string>(() => {
    try { return localStorage.getItem("sc:source") ?? ""; } catch { return ""; }
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

  React.useEffect(() => {
    fetch("/api/principals").then((r) => r.json())
      .then((d) => { setPrincipals(d.principals ?? []); setPolicies(d.policies ?? []); })
      .catch(() => {});
  }, []);

  const refreshSources = useCallback(() =>
    fetch("/api/sources").then((r) => r.json())
      .then((d) => { setSources(d.sources ?? []); setAutoSourceId(d.active ?? null);
        if (!sourceRef.current) sourceRef.current = d.active ?? "";
        if (localStorage.getItem("sc:principal") === null && d.defaultPrincipal) {
          asWhoRef.current = d.defaultPrincipal; setAsWho(d.defaultPrincipal);
          localStorage.setItem("sc:principal", d.defaultPrincipal);
        } })
      .catch(() => {}),
  []);
  React.useEffect(() => { refreshSources(); }, [refreshSources]);

  const [dashId, setDashId] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; updated_at: string }[]>([]);
  const [openList, setOpenList] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [refreshToken, setRefreshToken] = useState<string>(crypto.randomUUID());
  const dirty = !!dash && fingerprint(dash, canvas) !== savedFingerprint;
  const documentEpoch = React.useRef(0);
  const draftKey = React.useRef<string>(crypto.randomUUID());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const currentDocument = React.useRef({ dash, canvas, dashId, revision, dirty, source: activeSourceId });
  currentDocument.current = { dash, canvas, dashId, revision, dirty, source: activeSourceId };
  const readDrafts = useCallback(() => {
    try { setDrafts(JSON.parse(localStorage.getItem("sc:drafts") ?? "[]")); } catch { setDrafts([]); }
  }, []);
  useEffect(readDrafts, [readDrafts]);
  const stashDraft = useCallback(() => {
    const d = currentDocument.current;
    if (!d.dash || !d.dirty) return;
    try {
      const all: Draft[] = JSON.parse(localStorage.getItem("sc:drafts") ?? "[]");
      const next: Draft = { ...documentSnapshot(d.dash, d.canvas), key: draftKey.current,
        id: d.dashId, revision: d.revision, source: d.source, updated: new Date().toISOString() };
      localStorage.setItem("sc:drafts", JSON.stringify([next, ...all.filter((x) => x.key !== next.key)]));
      readDrafts();
    } catch { setNotice("Browser recovery storage is full or unavailable. Save this dashboard before leaving."); }
  }, [readDrafts]);
  useEffect(() => { const timer = setTimeout(stashDraft, 500); return () => clearTimeout(timer); }, [dash, canvas, dirty, revision, stashDraft]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => { if (currentDocument.current.dirty) { stashDraft(); e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [stashDraft]);

  // Exploration state is reset on document and role changes.
  const [drills, setDrills] = useState<Record<string, import("./drill.ts").DrillEntry[]>>({});

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

  // Undo history. Every edit pushes; the canvas is a design surface and Cmd+Z is
  // the first thing anyone tries after moving something by accident.
  const past = React.useRef<DocumentSnapshot[]>([]);
  const future = React.useRef<DocumentSnapshot[]>([]);
  const applying = React.useRef(false);

  const commit = React.useCallback((next: DashboardSpec) => {
    if (!applying.current && dash) { past.current.push(documentSnapshot(dash, canvas)); future.current = []; }
    if (past.current.length > 80) past.current.shift();
    setDash(next);
  }, [dash, canvas]);

  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      applying.current = true;
      if (e.shiftKey) {
        const n = future.current.pop();
        if (n && dash) { past.current.push(documentSnapshot(dash, canvas)); setDash(n.spec); setCanvas(n.canvas); }
      } else {
        const p = past.current.pop();
        if (p && dash) { future.current.push(documentSnapshot(dash, canvas)); setDash(p.spec); setCanvas(p.canvas); }
      }
      queueMicrotask(() => { applying.current = false; });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dash, canvas]);

  const changeCanvas = (next: CanvasSpec) => {
    if (dash) { past.current.push(documentSnapshot(dash, canvas)); future.current = []; }
    setCanvas(next);
  };
  const beginDocument = useCallback((next: DashboardSpec | null, options: {
    id?: string | null; revision?: number; canvas?: CanvasSpec; saved?: boolean; draftKey?: string;
  } = {}) => {
    stashDraft();
    documentEpoch.current++;
    draftKey.current = options.draftKey ?? crypto.randomUUID();
    past.current = []; future.current = [];
    const surface = { ...DEFAULT_CANVAS, ...options.canvas };
    if (next?.tiles.length && !options.canvas) surface.height = Math.max(surface.height, ...next.tiles.map((t) => t.layout.y + t.layout.h + 24));
    setDash(next); setCanvas(surface); setDashId(options.id ?? null); setRevision(options.revision ?? 0);
    setSavedFingerprint(next && options.saved ? fingerprint(next, surface) : null);
    setGrain(next?.tiles.flatMap((t) => t.dimensions).find((d) => d.includes(":"))?.split(":")[0] ?? "month");
    setSelected([]); setDrills({}); setNotice(""); setSaving(false); setTable(null);
    setPicking(false); setRefreshed(null); setRefreshToken(crypto.randomUUID());
  }, [stashDraft]);
  const refreshData = () => { setRefreshToken(crypto.randomUUID()); setRefreshed(new Date()); };

  const refreshSaved = React.useCallback(() =>
    fetch("/api/dashboards").then((r) => r.json())
      .then((d) => setSaved(d.dashboards ?? [])), []);
  React.useEffect(() => { refreshSaved(); }, [refreshSaved]);

  const switchSource = useCallback((id: string) => {
    sourceRef.current = id;
    setSourceId(id);
    try { localStorage.setItem("sc:source", id); } catch {}
    beginDocument(null); setView("home"); setModel(null);
    const epoch = documentEpoch.current;
    fetch("/api/model").then(readResponse).then((m) => {
      if (documentEpoch.current === epoch) { setModel(m); setBootError(""); }
    }).catch((e) => { if (documentEpoch.current === epoch) setBootError(e.message); });
    refreshSaved();
  }, [refreshSaved, beginDocument]);

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

  const save = async (asCopy = false) => {
    if (!dash || saving) return;
    const epoch = documentEpoch.current, key = draftKey.current;
    const id = asCopy ? crypto.randomUUID() : dashId ?? crypto.randomUUID();
    const snapshot = documentSnapshot(dash, canvas);
    const body = JSON.stringify({ id, name: dash.title, ...snapshot, revision: asCopy ? 0 : revision, schemaVersion: 1 });
    setSaving(true); setNotice("");
    try {
      if (new Blob([body]).size > MAX_DOCUMENT_BYTES) throw new Error("Dashboard exceeds the 8 MB save limit. Remove or resize an image and try again.");
      const result = await fetch("/api/dashboards", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }).then(readResponse);
      if (documentEpoch.current !== epoch) return;
      setDashId(id); setRevision(result.revision); setSavedFingerprint(JSON.stringify(snapshot));
      try {
        const all: Draft[] = JSON.parse(localStorage.getItem("sc:drafts") ?? "[]");
        localStorage.setItem("sc:drafts", JSON.stringify(all.filter((d) => d.key !== key)));
        readDrafts();
      } catch { /* the server copy is saved even if recovery storage is unavailable */ }
      refreshSaved();
    } catch (e: any) { if (documentEpoch.current === epoch) setNotice(`Save failed: ${e.message}`); }
    finally { if (documentEpoch.current === epoch) setSaving(false); }
  };

  const openSaved = async (id: string) => {
    const epoch = documentEpoch.current;
    try {
      const d = await fetch(`/api/dashboards/${encodeURIComponent(id)}`).then(readResponse);
      if (documentEpoch.current !== epoch) return;
      beginDocument(d.spec, { id, revision: d.revision, canvas: d.canvas, saved: true });
      setOpenList(false); pendingFit.current = true;
    } catch (e: any) { setNotice(`Could not open dashboard: ${e.message}`); }
  };
  const mainRef = React.useRef<HTMLElement>(null);
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
  const inspecting = !!selectedTile && !canvas.locked;

  // Selecting a tile opens the Inspector, which takes real width out of the
  // canvas viewport (the `.shell` grid's third column) -- so a tile sitting
  // near the right edge, fully visible a moment ago, can end up with part
  // of itself behind the panel that just opened to edit it. Scrolling alone
  // can't fix this when the tile itself is wider than what's left of the
  // viewport -- bringing the right edge into view pushes the left edge out,
  // and vice versa, there's no scroll position that shows both. So this
  // shrinks zoom just enough to make the WHOLE tile fit first (never grows
  // it -- only ever gives back room the Inspector took), the same clamped
  // fit-to-available-space `fit()` already does for the whole canvas.
  useEffect(() => {
    if (!selectedTile) return;
    const el = scrollRef.current;
    if (!el) return;
    const pad = 16;
    const { w, h } = selectedTile.layout;
    const viewW = el.clientWidth, viewH = el.clientHeight;
    const neededW = w + pad * 2, neededH = h + pad * 2;
    if (neededW * zoom > viewW || neededH * zoom > viewH) {
      // Floor, not round, and stop here for this pass -- the resulting
      // reflow re-fires this same effect (zoom is a dependency), and only
      // THEN is it safe to measure the real DOM below: rounding up, or
      // trusting the arithmetic without a real re-measure, can leave the
      // tile a few px past the very edge it was just rescued from (fixed
      // chrome around the canvas -- padding, the surface's own margin --
      // doesn't scale with zoom the way the tile itself does).
      const z = Math.floor(Math.max(0.25, Math.min(zoom, viewW / neededW, viewH / neededH)) * 100) / 100;
      if (z < zoom) { setZoom(z); return; }
    }
    // Measured from the actual rendered node, not reconstructed from the
    // layout spec's x/y/w/h -- that formula would have to know every bit of
    // fixed chrome between the canvas edge and the tile, and getting one
    // wrong is exactly how the first version of this effect still left the
    // tile a few pixels into the Inspector.
    const node = el.querySelector<HTMLElement>(".node.selected");
    if (!node) return;
    const elRect = el.getBoundingClientRect(), nodeRect = node.getBoundingClientRect();
    let { scrollLeft, scrollTop } = el;
    const left = nodeRect.left - elRect.left + scrollLeft - pad;
    const top = nodeRect.top - elRect.top + scrollTop - pad;
    const right = nodeRect.right - elRect.left + scrollLeft + pad;
    const bottom = nodeRect.bottom - elRect.top + scrollTop + pad;
    if (right - scrollLeft > viewW) scrollLeft = right - viewW;
    if (left < scrollLeft) scrollLeft = left;
    if (bottom - scrollTop > viewH) scrollTop = bottom - viewH;
    if (top < scrollTop) scrollTop = top;
    el.scrollTo({ left: Math.max(0, scrollLeft), top: Math.max(0, scrollTop), behavior: "auto" });
  }, [selectedTile?.id, inspecting, zoom]);

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

  useEffect(() => { fetch("/api/model").then(readResponse).then((m) => { setModel(m); setBootError(""); }).catch((e) => setBootError(e.message)); }, []);

  const build = useCallback((brief: Brief) => {
    setInterview(false);
    beginDocument(null);
    const epoch = documentEpoch.current;
    return fetch("/api/suggest", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brief, width: canvas.width }),
    }).then(readResponse).then((d) => {
      if (documentEpoch.current !== epoch) return;
      pendingFit.current = true;
      setDash(d); setCanvas((c) => ({ ...c, height: Math.max(c.height, ...d.tiles.map((t: TileSpec) => t.layout.y + t.layout.h + 24)) })); setRefreshed(new Date()); setTable(brief.table ?? null);
      if (brief.grain) setGrain(brief.grain);
    }).catch((e) => { if (documentEpoch.current === epoch) setNotice(e.message); });
  }, [canvas.width, beginDocument]);

  const load = useCallback((t: string | null, g: string) => {
    beginDocument(null);
    const epoch = documentEpoch.current;
    const q = new URLSearchParams({ grain: g, width: String(canvas.width),
                                    ...(t ? { table: t } : {}) });
    return fetch(`/api/suggest?${q}`).then(readResponse).then((d) => {
      if (documentEpoch.current !== epoch) return;
      setTable(t);
      // Show the whole authored canvas rather than clipping it at the viewport.
      pendingFit.current = true;
      setDash(d); setCanvas((c) => ({ ...c, height: Math.max(c.height, ...d.tiles.map((t: TileSpec) => t.layout.y + t.layout.h + 24)) })); setRefreshed(new Date());
    }).catch((e) => { if (documentEpoch.current === epoch) setNotice(e.message); });
  }, [canvas.width, beginDocument]);

  if (!model) return <div className="boot">{bootError ? <><p role="alert">{bootError}</p><button onClick={() => switchSource("")}>Open the default source</button></> : "Loading semantic layer…"}</div>;

  const byTable = metricsByTable(model);
  const tabs = Object.entries(byTable).sort((a, b) => b[1].length - a[1].length).map(([n]) => n);

  const pick = (t: string | null) => {
    setTable(t);
    if (t === null) { beginDocument(null); return; }
    load(t, grain);
  };

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
    if (!dash) return;
    const PAD = 24, GAP = 16;
    const w = Math.round((canvas.width - PAD * 2 - GAP * (drafts.length - 1)) / drafts.length);
    const y = dropPoint(w, 156).y;
    const made = drafts.map((d, i) => ({ ...d, id: nextId(),
      layout: { x: PAD + i * (w + GAP), y, w, h: 156, z: 1 } }));
    commit({ ...dash, tiles: [...dash.tiles, ...made] });
    setSelected(made.map((m) => m.id));
    growCanvasFor(y + 156 + 24);
    pendingReveal.current = { x: PAD, y, w: canvas.width - PAD * 2, h: 156 };
  };

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
      <Sidebar model={model} active={table} view={dash ? "" : view}
               onPick={(t) => { setView("home"); pick(t); }}
               onView={(v) => { setView(v); beginDocument(null); }}
               collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}
               principals={principals} principal={asWho}
               onPrincipal={(id) => {
                 asWhoRef.current = id;
                 setAsWho(id);
                 try { localStorage.setItem("sc:principal", id); } catch {}
                 setDrills({}); refreshData();
               }}
               sources={sources} activeSource={activeSource} />

      <main className="main" ref={mainRef}>
        {notice && <div className="document-notice" role="alert">{notice}</div>}
        {!dash && <div className="document-library"><span className="hint">Local alpha · Roles are simulations on this computer</span>
          <button className="link" onClick={() => { refreshSaved(); setOpenList(true); }}>Open saved dashboard</button>
          {drafts.filter((d) => d.source === activeSourceId).map((d) => <div key={d.key}>
            <button className="link" onClick={() => beginDocument(d.spec, { id: d.id, revision: d.revision, canvas: d.canvas, draftKey: d.key })}>Recover draft: {d.spec.title}</button>
            <button className="link" aria-label={`Discard draft ${d.spec.title}`} onClick={() => {
              localStorage.setItem("sc:drafts", JSON.stringify(drafts.filter((x) => x.key !== d.key))); readDrafts();
            }}>Discard</button>
          </div>)}
        </div>}
        {!dash && view === "connections" ? (
          <Connections sources={sources} activeId={activeSourceId} onSelect={switchSource}
                       onRefresh={refreshSources} principals={principals} policies={policies} />
        ) : !dash && view === "registry" ? (
          <MetricRegistry model={model} onUse={(m) => {
            const t = model.metrics[m].baseTable;
            setView("home"); build({ table: t, metrics: [m], audience: "operator", grain });
          }} />
        ) : !dash && view === "model" ? (
          <DataModel model={model} />
        ) : !dash ? (
          <Entry model={model} onSuggest={() => setInterview(true)}
                 onScratch={() => beginDocument({ title: "Untitled dashboard", tiles: [] })}
                 onDemo={demoDashboardAvailable(model) ? () => {
                   pendingFit.current = true;
                   beginDocument(demoDashboard());
                 } : null} />
        ) : (
          <>
            <div className="topbar">
              <button className="link" onClick={() => beginDocument(null)}>← Back</button>
              <span className="spacer" />
              <span className="save-status" role="status">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
              <span className="refreshed">
                {refreshed && `Refresh requested ${refreshed.toLocaleString(undefined,
                  { dateStyle: "medium", timeStyle: "short" })}`}
              </span>
              <button className="icon" title="Refresh" onClick={refreshData}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M16 10a6 6 0 1 1-1.8-4.2M16 3v3.5h-3.5" /></svg>
              </button>
              <button className="icon" title="Open a saved dashboard"
                      aria-label="Open saved dashboard" onClick={() => { refreshSaved(); setOpenList(true); }}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              </button>
              <button className={"icon" + (dirty ? " primary" : "")} onClick={() => save()} disabled={saving}
                      title={saving ? "Saving…" : dirty ? "Unsaved changes — click to save" : "Saved"}
                      aria-label="Save dashboard">
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 4h9l3 3v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M7 4v4h6V4M7 17v-5h6v5" /></svg>
              </button>
              <button className="link" disabled={saving} onClick={() => save(true)}>Save a copy</button>
              <button className="icon" title="Copy dashboard spec"
                      onClick={() => navigator.clipboard?.writeText(JSON.stringify(dash, null, 2))}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="7" y="3" width="10" height="12" rx="2" /><path d="M13 17H5a2 2 0 0 1-2-2V7" /></svg>
              </button>
              <button className="icon" title={exportingPng ? "Exporting…" : "Export dashboard as PNG"}
                      disabled={exportingPng} onClick={exportDashboardPng}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15h12" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button className="icon primary" title="Add tile" onClick={() => setPicking(true)}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M10 4v12M4 10h12" /></svg>
              </button>
            </div>

            <h1 className="dash-title">{dash.title}</h1>

            <div className="tabs">
              {tabs.map((t) => (
                <button key={t} className={"pill" + (t === table ? " on" : "")}
                        onClick={() => pick(t)}>
                  {prettyTable(t)}
                </button>
              ))}
            </div>

            <div className="controls">
              <label>
                <span>Period</span>
                <select value={grain} onChange={(e) => { setGrain(e.target.value); setDrills({}); commit(withGrain(dash, e.target.value)); }}>
                  {GRAINS.map((g) => (
                    <option key={g} value={g}>{g[0].toUpperCase() + g.slice(1)}ly
                      {g === "day" ? "" : ""}</option>
                  ))}
                </select>
              </label>
              <span className="spacer" />
              <span className="hint mono">
                {dash.tiles.length} tiles · {Object.keys(model.metrics).length} metrics available
              </span>
            </div>

            {!canvas.locked && (
              <EditBar canvas={canvas} onCanvas={changeCanvas} zoom={zoom} onZoom={setZoom} onFit={fit}
                       selected={selected} tiles={dash.tiles}
                       onTiles={(t) => commit({ ...dash, tiles: t })}
                       beautify={<DashboardBeautify dash={dash} canvas={canvas} model={model}
                                                     aiAvailable={aiAvailable} onDash={commit} />} />
            )}
            {canvas.locked && (
              <div className="editbar slim">
                <span className="spacer" />
                <button className="lock on" onClick={() => changeCanvas({ ...canvas, locked: false })}>
                  🔒 Locked — click to edit
                </button>
              </div>
            )}

            {(dash.crossFilters?.length ?? 0) > 0 && (
              <div className="xfilters">
                <span className="xf-label">Filtered by</span>
                {dash.crossFilters!.map((f) => (
                  <button key={f.id} className="xf" title="Remove this filter"
                          onClick={() => setDash({ ...dash,
                            crossFilters: dash.crossFilters!.filter((x) => x.id !== f.id) })}>
                    <b>{f.field.split(".").pop()}</b>
                    <span>{(f.values ?? []).join(", ")}</span>
                    <i>✕</i>
                  </button>
                ))}
                <button className="xf clear"
                        onClick={() => setDash({ ...dash, crossFilters: [] })}>Clear all</button>
              </div>
            )}

            <Canvas canvas={canvas} tiles={dash.tiles} zoom={zoom}
                    selected={selected} onSelect={setSelected}
                    onChange={(t) => { setDash({ ...dash, tiles: t }); }}
                    scrollRef={scrollRef}
                    onCommit={(before) => { past.current.push(documentSnapshot({ ...dash, tiles: before }, canvas));
                                            future.current = [];
                                            if (past.current.length > 80) past.current.shift(); }}
                    renderTile={(t) => (
                      <TileBoundary label={t.title ?? t.metrics.join(", ")}>
                      <Tile key={`${activeSourceId}:${asWho}:${refreshToken}`} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} model={model} spec={t} locked={canvas.locked}
                            crossFilters={dash.crossFilters}
                            onCrossFilter={(f) => setDash((d) => !d ? d : ({
                              ...d,
                              crossFilters: [
                                ...(d.crossFilters ?? []).filter((x) => x.field !== f.field), f],
                            }))}
                            aiAvailable={aiAvailable}
                            drill={drills[t.id]}
                            onDrill={(entry) => setDrills((d) => ({ ...d, [t.id]: [...(d[t.id] ?? []), entry] }))}
                            onDrillUp={(toIndex) => setDrills((d) => ({
                              ...d, [t.id]: (d[t.id] ?? []).slice(0, toIndex) }))}
                            onRemove={(id) => commit({ ...dash, tiles: dash.tiles.filter((x) => x.id !== id) })}
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
          </>
        )}
      </main>

      {inspecting && (
        <Inspector model={model}
                   tile={selectedTile!}
                   onChange={(next) => commit({ ...dash!,
                     tiles: dash!.tiles.map((x) => (x.id === next.id ? next : x)) })}
                   onClose={() => setSelected([])} />
      )}
      {openList && (
        <div className="iv-scrim" onClick={() => setOpenList(false)}>
          <div className="iv open-list" onClick={(e) => e.stopPropagation()}>
            <div className="iv-head"><span className="iv-step">Saved dashboards</span>
              <span className="spacer" />
              <button className="link" onClick={() => setOpenList(false)}>Close</button></div>
            <section>
              {saved.length === 0
                ? <p className="lede">Nothing saved yet. Build a dashboard and hit save.</p>
                : saved.map((d) => (
                    <button key={d.id} className="optcard" onClick={() => openSaved(d.id)}>
                      <b>{d.name}</b><small>{d.updated_at}</small>
                    </button>
                  ))}
            </section>
          </div>
        </div>
      )}
      {interview && <div className="iv-scrim">
        <Interview model={model} onCancel={() => setInterview(false)} onDone={build} />
      </div>}
      <AgentQuestions />
      <AgentChat key={`${activeSourceId}:${asWho}`} />
      {dash && !canvas.locked && (
        <InsertMenu model={model} onInsert={addTile} onInsertMany={addMany}
                    onOpenPicker={() => setPicking(true)} />
      )}
      {picking && <Picker model={model} onAdd={(d) => addTile(d)} onClose={() => setPicking(false)} />}
    </div>
  );
}

function Entry({ model, onSuggest, onScratch, onDemo }: any) {
  return (
    <div className="entry">
      <h2>{prettifyModelName(model.name)}</h2>
      <p className="lede">
        {model.description} Every chart is built from its{" "}
        {Object.keys(model.metrics).length} governed metrics across{" "}
        {Object.keys(model.tables).length} tables — no SQL is written by hand, and
        nothing outside the model can be charted.
      </p>
      <div className="paths">
        <button className="path" onClick={onSuggest}>
          <h3>Suggest a dashboard →</h3>
          <p>Reads the model and proposes one: headline KPIs with movement, trends
             over time grouped so unlike units never share an axis, and the
             breakdowns the join graph actually supports.</p>
        </button>
        <button className="path" onClick={onScratch}>
          <h3>Start from scratch →</h3>
          <p>An empty canvas. Add tiles by picking metrics and dimensions; the
             picker only offers combinations that compile.</p>
        </button>
        {/* Only offered for a model with the specific bundled-sample tables
            and metrics this fixed spec names (see demo.ts) -- a real
            connected source just doesn't get this card, rather than
            showing one that would fail to compile against it. */}
        {onDemo && (
          <button className="path demo" onClick={onDemo}>
            <h3>See Beautify in action →</h3>
            <p>A deliberately rough dashboard -- a noisy chart, a breakdown that
               doesn't actually vary, a chart-kind mismatch, and a messy layout.
               Try Beautify and Smart Arrange on it.</p>
          </button>
        )}
      </div>
    </div>
  );
}
