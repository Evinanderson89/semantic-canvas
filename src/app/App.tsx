import { applyProposal } from "../canvas/proposals.ts";
import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";
import { validateTile } from "../compiler/compile.ts";
import React, { useCallback, useEffect, useState } from "react";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";
import { Picker } from "./Picker.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Canvas } from "../canvas/Canvas.tsx";
import { EditBar } from "./EditBar.tsx";
import { Popover } from "./Popover.tsx";
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
import { prettifyModelName, type Model } from "../semantic/model.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

import { readResponse } from "./http.ts";
import { documentSnapshot, fingerprint, withGrain, parseDrafts, documentGrain, type DocumentSnapshot, type Draft } from "./document.ts";
import { MAX_DOCUMENT_BYTES } from "../compiler/schema.ts";

const GRAINS = ["day", "week", "month", "quarter", "year"];

export function App() {
  const [bootError, setBootError] = useState("");
  const [model, setModel] = useState<Model | null>(null);
  const [dash, setDash] = useState<DashboardSpec | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [demoActive, setDemoActive] = useState(false);
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
    try { setDrafts(parseDrafts(localStorage.getItem("sc:drafts"))); } catch { setDrafts([]); }
  }, []);
  useEffect(readDrafts, [readDrafts]);
  const stashDraft = useCallback(() => {
    const d = currentDocument.current;
    if (!d.dash || !d.dirty) return true;
    try {
      const all: Draft[] = parseDrafts(localStorage.getItem("sc:drafts"));
      const next: Draft = { ...documentSnapshot(d.dash, d.canvas), key: draftKey.current,
        id: d.dashId, revision: d.revision, source: d.source, updated: new Date().toISOString() };
      localStorage.setItem("sc:drafts", JSON.stringify([next, ...all.filter((x) => x.key !== next.key)]));
      readDrafts();
      return true;
    } catch { setNotice("Recovery backup failed. Your dashboard is still open. Save it or download a backup before leaving."); return false; }
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

  const compose = (spec: DashboardSpec, surface: CanvasSpec) => {
    if (dash) { past.current.push(documentSnapshot(dash, canvas)); future.current = []; }
    setDash(spec); setCanvas(surface);
  };
  const changeCanvas = (next: CanvasSpec) => {
    if (dash) { past.current.push(documentSnapshot(dash, canvas)); future.current = []; }
    setCanvas(next);
  };
  const beginDocument = useCallback((next: DashboardSpec | null, options: {
    id?: string | null; revision?: number; canvas?: CanvasSpec; saved?: boolean; draftKey?: string;
  } = {}) => {
    if (!stashDraft()) return false;
    documentEpoch.current++;
    draftKey.current = options.draftKey ?? crypto.randomUUID();
    past.current = []; future.current = [];
    const surface = { ...DEFAULT_CANVAS, ...options.canvas };
    if (next?.tiles.length && !options.canvas) surface.height = Math.max(surface.height, ...next.tiles.map((t) => t.layout.y + t.layout.h + 24));
    setDash(next); setCanvas(surface); setDashId(options.id ?? null); setRevision(options.revision ?? 0);
    setSavedFingerprint(next && options.saved ? fingerprint(next, surface) : null);
    setGrain(documentGrain(next));
    setSelected([]); setDrills({}); setNotice(""); setSaving(false); setTable(null); setDemoActive(false);
    setPicking(false); setRefreshed(null); setRefreshToken(crypto.randomUUID());
    return true;
  }, [stashDraft]);
  const refreshData = () => { setRefreshToken(crypto.randomUUID()); setRefreshed(new Date()); };

  const refreshSaved = React.useCallback(() =>
    fetch("/api/dashboards").then((r) => r.json())
      .then((d) => setSaved(d.dashboards ?? [])), []);
  React.useEffect(() => { refreshSaved(); }, [refreshSaved]);

  const switchSource = useCallback((id: string) => {
    if (!beginDocument(null)) return;
    sourceRef.current = id;
    setSourceId(id);
    try { localStorage.setItem("sc:source", id); } catch {}
    setView("home"); setModel(null);
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
        const all: Draft[] = parseDrafts(localStorage.getItem("sc:drafts"));
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
  const backupInput = React.useRef<HTMLInputElement>(null);
  const mainRef = React.useRef<HTMLElement>(null);
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
    const surface = freshCanvas();
    if (!beginDocument(null, { canvas: surface })) return;
    const epoch = documentEpoch.current;
    return fetch("/api/suggest", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brief, width: surface.width }),
    }).then(readResponse).then((d) => {
      if (documentEpoch.current !== epoch) return;
      pendingFit.current = true;
      setDash(d); setCanvas((c) => ({ ...c, height: Math.max(c.height, ...d.tiles.map((t: TileSpec) => t.layout.y + t.layout.h + 24)) })); setRefreshed(new Date()); setTable(brief.table ?? null);
      setGrain(documentGrain(d));
    }).catch((e) => { if (documentEpoch.current === epoch) setNotice(e.message); });
  }, [freshCanvas, beginDocument]);

  const load = useCallback((t: string | null, g: string) => {
    const surface = freshCanvas();
    if (!beginDocument(null, { canvas: surface })) return;
    const epoch = documentEpoch.current;
    const q = new URLSearchParams({ grain: g, width: String(surface.width),
                                    ...(t ? { table: t } : {}) });
    return fetch(`/api/suggest?${q}`).then(readResponse).then((d) => {
      if (documentEpoch.current !== epoch) return;
      setTable(t); setGrain(documentGrain(d));
      // Show the whole authored canvas rather than clipping it at the viewport.
      pendingFit.current = true;
      setDash(d); setCanvas((c) => ({ ...c, height: Math.max(c.height, ...d.tiles.map((t: TileSpec) => t.layout.y + t.layout.h + 24)) })); setRefreshed(new Date());
    }).catch((e) => { if (documentEpoch.current === epoch) setNotice(e.message); });
  }, [freshCanvas, beginDocument]);

  if (!model) return <div className="boot">{bootError ? <><p role="alert">{bootError}</p><button onClick={() => switchSource("")}>Open the default source</button></> : "Loading semantic layer…"}</div>;

  const pick = (t: string | null) => {
    if (t === null) { beginDocument(null); return; }
    load(t, GRAINS.includes(grain) ? grain : "month");
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
               demo={demoDashboardAvailable(model) ? { active: demoActive, onOpen: () => {
                 const surface = freshCanvas(), example = demoDashboard(surface.width);
                 surface.height = Math.max(surface.height, ...example.tiles.map(t => t.layout.y + t.layout.h + 24));
                 if (beginDocument(example, { canvas: surface })) {
                   setDemoActive(true); setView("home"); pendingFit.current = true;
                 }
               } } : undefined}
               onPick={(t) => { setView("home"); pick(t); }}
               onView={(v) => { if (beginDocument(null)) setView(v); }}
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
        <input ref={backupInput} type="file" accept="application/json,.json" hidden aria-label="Import dashboard backup" onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; const epoch = documentEpoch.current;
          try {
            if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Backup exceeds the 8 MB document limit");
            const data = JSON.parse(await file.text()); if (documentEpoch.current !== epoch) return;
            if (data.schemaVersion !== 1) throw new Error("Unsupported backup version");
            if (data.source && data.source !== activeSourceId) throw new Error(`Select the backup's source (${data.source}) before importing it`);
            const spec = dashboardSchema.parse(data.spec), surface = canvasSchema.parse(data.canvas);
            const issues = spec.tiles.flatMap(t => validateTile(model, t)); if (issues.length) throw new Error(issues[0].problem);
            if (beginDocument(spec, { canvas: surface })) { setView("home"); setNotice("Backup restored as a new dashboard. Save to keep a server copy."); }
          } catch (error: any) { setNotice(`Could not import backup: ${error.message}`); }
        }} />
        {notice && <div className="document-notice" role="alert"><span>{notice}</span>{dash && <button className="link" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, source: activeSourceId, ...documentSnapshot(dash, canvas) }, null, 2)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = `${slugForFilename(dash.title)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download backup</button>}{dash && notice.startsWith("Recovery backup failed") && <button className="link" onClick={() => {
          if (window.confirm("Leave this dashboard without saving? Download a backup first if you want to keep these changes.")) { currentDocument.current.dirty = false; beginDocument(null); setView("home"); }
        }}>Discard and leave</button>}</div>}
        {!dash && view === "connections" ? (
          <Connections sources={sources} activeId={activeSourceId} onSelect={switchSource}
                       onRefresh={() => { refreshSources(); fetch("/api/model").then(readResponse).then(m => { setModel(m); refreshData(); }).catch(e => setNotice(e.message)); }} principals={principals} policies={policies} />
        ) : !dash && view === "registry" ? (
          <MetricRegistry model={model} onUse={(m) => {
            const t = model.metrics[m].baseTable;
            setView("home"); build({ table: t, metrics: [m], audience: "operator", grain });
          }} />
        ) : !dash && view === "model" ? (
          <DataModel model={model} />
        ) : !dash ? (
          <><Entry model={model} onSuggest={() => setInterview(true)}
                 onScratch={() => { pendingFit.current = true; beginDocument({ title: "Untitled dashboard", tiles: [] }, { canvas: freshCanvas() }); }} />
        <div className="document-library"><div className="library-heading"><h3>Continue your work</h3><span>Saved dashboards and drafts on this computer</span></div>
          <button className="link" onClick={() => { refreshSaved(); setOpenList(true); }}>Open saved dashboard</button>
          <button className="link" onClick={() => backupInput.current?.click()}>Import backup</button>
          {drafts.filter((d) => d.source === activeSourceId).map((d) => <div key={d.key}>
            <button className="link" onClick={() => beginDocument(d.spec, { id: d.id, revision: d.revision, canvas: d.canvas, draftKey: d.key })}>Recover draft: {d.spec.title}</button>
            <button className="link" aria-label={`Discard draft ${d.spec.title}`} onClick={() => {
              localStorage.setItem("sc:drafts", JSON.stringify(drafts.filter((x) => x.key !== d.key))); readDrafts();
            }}>Discard</button>
          </div>)}
        </div>
          </>
        ) : (
          <>
            <div className="topbar">
              <button className="link back-link" onClick={() => beginDocument(null)}>← <span>Workspace</span></button>
              <span className="spacer" />
              <span className={"save-status" + (dirty ? " dirty" : "")} role="status">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
              <button className="icon quiet" title="Refresh" aria-label="Refresh" onClick={refreshData}>
                <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M16 10a6 6 0 1 1-1.8-4.2M16 3v3.5h-3.5" /></svg>
              </button>
              <button className="save-button" onClick={() => save()} disabled={saving} aria-label="Save dashboard">
                {saving ? "Saving…" : "Save"}
              </button>
              <Popover label="Dashboard actions" trigger={<span aria-hidden="true">•••</span>} align="end" className="document-menu">
                {(close) => <>
                  <button onClick={() => { close(); refreshSaved(); setOpenList(true); }}>Open saved dashboard</button>
                  <button disabled={saving} onClick={() => { close(); save(true); }}>Save a copy</button>
                  <button disabled={exportingPng} onClick={() => { close(); exportDashboardPng(); }}>
                    {exportingPng ? "Exporting…" : "Export dashboard as PNG"}
                  </button>
                  <button onClick={() => { close(); navigator.clipboard?.writeText(JSON.stringify(dash, null, 2)); }}>Copy dashboard spec</button>
                </>}
              </Popover>
            </div>

            <div className="dashboard-heading">
              <div className="dashboard-identity">
                <span className="eyebrow">Dashboard</span>
                <h1 className="dash-title">{dash.title}</h1>
                <div className="dashboard-meta">
                  <span>{dash.tiles.length} tiles</span><span aria-hidden="true">·</span>
                  <span>{prettifyModelName(model.name)}</span>
                  {refreshed && <span className="refresh-detail" title={`Refresh requested ${refreshed.toLocaleString()}`}>· Refresh requested {refreshed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
                </div>
                {demoActive && <p className="demo-hint">Use <b>Design review</b> to improve the charts, then <b>Smart arrange</b> to bring it together.</p>}
              </div>
              <label className="period-control">
                <span>Period</span>
                <select aria-label="Period" value={documentGrain(dash)} onChange={(e) => { const next = withGrain(dash, e.target.value); const issues = next.tiles.flatMap(t => validateTile(model, t)); if (issues.length) { setNotice(issues[0].problem); return; } setNotice(""); setGrain(e.target.value); setDrills({}); commit(next); }}>
                  {documentGrain(dash) === "mixed" && <option value="mixed" disabled>Mixed periods</option>}
                  {GRAINS.map((g) => <option key={g} value={g}>{g === "day" ? "Daily" : g[0].toUpperCase() + g.slice(1) + "ly"}</option>)}
                </select>
              </label>
            </div>

            {!canvas.locked && (
              <EditBar canvas={canvas} onCanvas={changeCanvas} zoom={zoom} onZoom={setZoom} onFit={fit}
                       selected={selected} tiles={dash.tiles}
                       onCompose={(tiles, surface) => compose({ ...dash, tiles }, surface)}
                       onTiles={(t) => commit({ ...dash, tiles: t })}
                       beautify={<DashboardBeautify dash={dash} canvas={canvas} model={model}
                                                     aiAvailable={aiAvailable} onDash={d => compose(d, { ...canvas, height: Math.max(canvas.height, ...d.tiles.map(t => t.layout.y + t.layout.h + 24)) })} queryContext={`${activeSourceId}:${asWho}:${refreshToken}`} drills={drills} />} />
            )}
            {canvas.locked && (
              <div className="editbar slim">
                <span className="spacer" />
                <button className="lock on" onClick={() => changeCanvas({ ...canvas, locked: false })}>
                  Edit dashboard
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
                    emptyState={!canvas.locked ? <div className="canvas-empty">
                      <div className="empty-composition" aria-hidden="true"><i /><i /><i /></div>
                      <h2>Every story starts somewhere.</h2>
                      <p>Add your first metric, then make it your own.</p>
                      <button className="save-button" onClick={() => setPicking(true)}>Add a chart</button>
                      <span>Or add a heading or note from the toolbar below.</span>
                    </div> : undefined}
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
                            onRemove={(id) => commit({ ...dash, tiles: dash.tiles.filter((x) => x.id !== id).map(x => ({ ...x, section: x.section === id ? undefined : x.section })) })}
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
      <AgentChat key={`${activeSourceId}:${asWho}`} document={dash ? { spec: dash, canvas, selected } : null}
        onApply={(proposal, expected) => {
          if (!dash || fingerprint(dash, canvas) !== expected) { setNotice("The dashboard changed. Request a fresh proposal before applying it."); return false; }
          try { const next = applyProposal(dash, canvas, proposal, model); compose(next.spec, next.canvas); setNotice("Changes applied. Undo restores the previous version."); return true; }
          catch (e: any) { setNotice(`Could not apply proposal: ${e.message}`); return false; }
        }} />
      {dash && !canvas.locked && (
        <InsertMenu model={model} onInsert={addTile} onInsertMany={addMany}
                    onOpenPicker={() => setPicking(true)} />
      )}
      {picking && <Picker model={model} onAdd={(d) => addTile(d)} onClose={() => setPicking(false)} />}
    </div>
  );
}

function Entry({ model, onSuggest, onScratch }: any) {
  return (
    <div className="entry">
      <div className="eyebrow">Your analytics studio</div>
      <h2>Give your data<br /><em>a point of view.</em></h2>
      <p className="lede">A space to explore what matters, compose a dashboard, and tell the story behind the numbers.</p>
      <div className="model-summary"><span className="dot ready" />{prettifyModelName(model.name)}<span>· {Object.keys(model.metrics).length} metrics ready to explore</span></div>
      <div className="paths">
        <button className="path suggested" onClick={onSuggest}>
          <span className="path-glyph" aria-hidden="true">✧</span>
          <h3>Suggest a dashboard <span>↗</span></h3>
          <p>Start with a question. Find a useful set of metrics, trends, and comparisons.</p>
        </button>
        <button className="path" onClick={onScratch}>
          <span className="path-glyph" aria-hidden="true">+</span>
          <h3>Start from scratch <span>↗</span></h3>
          <p>Make room for your own perspective. Add charts, notes, and a clear narrative.</p>
        </button>
      </div>
    </div>
  );
}
