import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TileSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "./presets.ts";
import { guidesFor, snapTo, type Box } from "./geometry.ts";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = typeof HANDLES[number];
type Gesture = {
  pointerId: number; capture: Element; handle: Handle | null; ids: string[];
  startX: number; startY: number; started: boolean; moved: boolean;
  origin: Record<string, Box>;
};
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
// Restore only the geometry this gesture owns. Preserve edits to chart content,
// newly added tiles and removals that arrived while the pointer was held.
const restoreGeometry = (tiles: TileSpec[], origin: Gesture["origin"]) => tiles.map(t => {
  const o = origin[t.id];
  return !o || sameBox(t.layout, o) ? t : { ...t, layout: { ...t.layout, x: o.x, y: o.y, w: o.w, h: o.h } };
});

/**
 * A free-positioning canvas: absolute coordinates, overlap permitted, z-order
 * explicit. Deliberately not a packing grid -- a grid prevents overlap and
 * reflows your neighbours, which is the behaviour that makes a dashboard feel
 * like it is fighting you.
 */
export function Canvas({
  canvas, tiles, zoom, selected, onSelect, onChange, onCommit, renderTile, scrollRef, emptyState,
}: {
  emptyState?: React.ReactNode;
  canvas: CanvasSpec;
  tiles: TileSpec[];
  zoom: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** Called continuously during a gesture. Must NOT record undo history. */
  onChange: (tiles: TileSpec[]) => void;
  /** Called once when a gesture ends. This is the undo boundary. */
  onCommit: (before: TileSpec[]) => void;
  renderTile: (t: TileSpec, selected: boolean) => React.ReactNode;
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<{ axis: "v" | "h"; at: number }[]>([]);
  const drag = useRef<Gesture | null>(null);
  const latestTiles = useRef(tiles);
  latestTiles.current = tiles;
  const pointerFocus = useRef(false);

  const boxOf = (t: TileSpec): Box => ({ ...t.layout });

  const focusNode = (node: HTMLElement | null) => {
    pointerFocus.current = true;
    node?.focus({ preventScroll: true });
    pointerFocus.current = false;
  };

  const finish = useCallback((cancelled: boolean, pointerId?: number) => {
    const d = drag.current;
    if (!d || pointerId !== undefined && pointerId !== d.pointerId) return;
    // Clear before releasing capture: lostpointercapture must not undo a
    // normally completed gesture or commit it a second time.
    drag.current = null;
    if (d.capture.hasPointerCapture?.(d.pointerId)) d.capture.releasePointerCapture(d.pointerId);
    setGuides([]);
    surface.current?.classList.remove("dragging");
    const current = latestTiles.current, before = restoreGeometry(current, d.origin);
    if (cancelled) {
      if (before.some((t, i) => t !== current[i])) { latestTiles.current = before; onChange(before); }
    } else if (d.moved && before.some((t, i) => t !== current[i])) onCommit(before);
  }, [onChange, onCommit]);

  const begin = useCallback((e: React.PointerEvent, id: string, handle: Handle | null) => {
    if (e.button !== 0 || !e.isPrimary || drag.current) return;
    if (canvas.locked || tiles.find(t => t.id === id)?.pinned) return;
    if (!handle && (e.target as HTMLElement).closest("button,[role=button],input,select,textarea,[contenteditable=true]")) return;
    e.stopPropagation();
    const node = e.currentTarget.closest(".node") as HTMLElement;
    focusNode(node);
    if (!handle && e.shiftKey && selected.includes(id)) {
      onSelect(selected.filter(s => s !== id));
      return;
    }
    const selection = selected.includes(id) ? selected : e.shiftKey ? [...selected, id] : [id];
    onSelect(selection);
    // Wait for actual movement before capturing. Capturing the tile on
    // pointerdown retargets an ordinary chart click away from its SVG,
    // preventing drill-down and cross-filtering.
    const ids = selection.filter(id => !tiles.find(t => t.id === id)?.pinned);
    drag.current = {
      pointerId: e.pointerId, capture: node, handle, ids, startX: e.clientX, startY: e.clientY,
      started: false, moved: false,
      origin: Object.fromEntries(tiles.filter((t) => ids.includes(t.id))
        .map((t) => [t.id, { ...t.layout }])),
    };
  }, [canvas.locked, selected, tiles, onSelect]);

  useEffect(() => {
    if (canvas.locked) { finish(true); return; }
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!(e.buttons & 1)) { finish(true, e.pointerId); return; }
      // Capture can be released before the browser dispatches got/lostcapture.
      // Treat that as cancellation even when no lostpointercapture event fires.
      if (d.started && !d.capture.hasPointerCapture(e.pointerId)) { finish(true, e.pointerId); return; }
      // A tap or fractional mouse jitter is a selection, not a layout edit.
      if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 3) return;
      if (!d.started) {
        d.started = true;
        // The tile survives chart rerenders during a drag; SVG marks may not.
        d.capture.setPointerCapture(e.pointerId);
        // Disable layout transitions only while the pointer is moving a tile.
        surface.current?.classList.add("dragging");
      }
      let dx = (e.clientX - d.startX) / zoom;
      let dy = (e.clientY - d.startY) / zoom;

      // Single-tile moves get alignment guides against everything else.
      if (!d.handle && d.ids.length === 1) {
        const o = d.origin[d.ids[0]];
        const proposed: Box = { ...o, x: o.x + dx, y: o.y + dy };
        const others = tiles.filter((t) => !d.ids.includes(t.id)).map(boxOf);
        const g = guidesFor(proposed, others);
        dx += g.dx; dy += g.dy;
        setGuides(g.lines.slice(0, 4));
      }

      const current = latestTiles.current;
      const next = current.map((t) => {
        if (!d.ids.includes(t.id)) return t;
        const o = d.origin[t.id];
        const l = d.handle ? resize(o, d.handle, dx, dy) : { ...o, x: o.x + dx, y: o.y + dy };
        return { ...t, layout: {
          ...t.layout,
          x: snapTo(Math.max(0, l.x), canvas.grid, canvas.snap),
          y: snapTo(Math.max(0, l.y), canvas.grid, canvas.snap),
          w: d.handle ? Math.max(80, snapTo(l.w, canvas.grid, canvas.snap)) : o.w,
          h: d.handle ? Math.max(60, snapTo(l.h, canvas.grid, canvas.snap)) : o.h,
        } };
      });
      d.moved = next.some(t => d.origin[t.id] && !sameBox(t.layout, d.origin[t.id]));
      if (next.some((t, i) => !sameBox(t.layout, current[i].layout))) {
        latestTiles.current = next;
        onChange(next);
      }
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      finish(!!d?.started && !d.capture.hasPointerCapture(e.pointerId), e.pointerId);
    };
    const cancel = (e: PointerEvent) => finish(true, e.pointerId);
    const blur = () => finish(true);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        e.preventDefault(); e.stopImmediatePropagation(); finish(true);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", blur); window.removeEventListener("keydown", escape);
    };
  }, [tiles, zoom, canvas, onChange, finish]);

  // Keyboard nudge, delete, and layer order -- the shortcuts any design surface
  // is expected to have.
  useEffect(() => {
    if (canvas.locked) return;
    const key = (e: KeyboardEvent) => {
      if (drag.current) return;
      if (!selected.length || !(e.target as HTMLElement)?.closest(".canvas-surface")) return;
      if (document.querySelector("dialog[open]")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable || (e.target as HTMLElement)?.closest("[role=dialog],[role=button]")) return;
      const step = e.shiftKey ? 10 : canvas.snap ? canvas.grid : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (nudge[e.key]) {
        e.preventDefault();
        const [dx, dy] = nudge[e.key];
        if (!e.repeat) onCommit(tiles);
        onChange(tiles.map((t) => selected.includes(t.id) && !t.pinned
          ? { ...t, layout: e.altKey ? { ...t.layout, w: Math.max(80, t.layout.w + dx), h: Math.max(60, t.layout.h + dy) } : { ...t.layout, x: Math.max(0, t.layout.x + dx), y: Math.max(0, t.layout.y + dy) } } : t));
      }
      if (e.key === "Escape") onSelect([]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected, tiles, canvas, onChange, onCommit, onSelect]);

  return (
    <div className="canvas-scroll" ref={scrollRef}>
      <div className="canvas-stage" style={{ width: canvas.width * zoom, height: canvas.height * zoom }}>
        <div ref={surface} className={"canvas-surface" + (canvas.locked ? " locked" : "")}
             style={{ width: canvas.width, height: canvas.height,
                      transform: `scale(${zoom})`, transformOrigin: "top left",
                      backgroundSize: canvas.snap ? `${canvas.grid * 4}px ${canvas.grid * 4}px` : undefined }}
             onPointerDown={() => onSelect([])}>
          <span className="sr-only" id="canvas-keyboard-help">Arrow keys move selected tiles. Hold Shift for larger steps. Hold Alt to resize. Escape cancels a drag or clears selection. Shift-click adds or removes a tile from the selection. Text editing uses normal cursor keys.</span>
          {!tiles.length && emptyState}
          {tiles.map((t) => {
            const on = selected.includes(t.id);
            return (
              <div key={t.id}
                   className={"node" + (on ? " selected" : "") + (t.pinned ? " pinned" : "")}
                   tabIndex={canvas.locked ? -1 : 0} role="group"
                   aria-label={`${t.title?.trim() || t.text?.trim() || t.metrics.join(", ") || (t.kind === "image" ? "Image" : t.kind === "divider" ? "Divider" : t.kind === "heading" ? "Heading" : t.kind === "text" ? "Text note" : t.kind === "filter" ? "Filter" : "Untitled chart")}${t.pinned ? ", pinned" : ""}`}
                   aria-describedby="canvas-keyboard-help"
                   onFocus={(e) => { if (e.target === e.currentTarget && !canvas.locked && !pointerFocus.current) onSelect([t.id]); }}
                   style={{ left: t.layout.x, top: t.layout.y,
                            width: t.layout.w, height: t.layout.h,
                            zIndex: (t.layout as any).z ?? 1 }}
                   onPointerDown={(e) => { e.stopPropagation();
                     if (canvas.locked || e.button !== 0 || !e.isPrimary || drag.current) return;
                     if (!(e.target as HTMLElement).closest("button,[role=button],input,select,textarea,[contenteditable=true]")) focusNode(e.currentTarget);
                     onSelect(e.shiftKey
                       ? (selected.includes(t.id) ? selected.filter((s) => s !== t.id) : [...selected, t.id])
                       : [t.id]); }}>
                <div className="node-inner" onPointerDown={(e) => begin(e, t.id, null)}>
                  {renderTile(t, on)}
                </div>
                {on && !canvas.locked && !t.pinned && HANDLES.map((h) => (
                  <span key={h} className={`handle ${h}`}
                        onPointerDown={(e) => begin(e, t.id, h)} />
                ))}
              </div>
            );
          })}

          {guides.map((g, i) => (
            <div key={i} className={"guide " + g.axis}
                 style={g.axis === "v" ? { left: g.at } : { top: g.at }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function resize(o: Box, h: Handle, dx: number, dy: number): Box {
  let { x, y } = o;
  let width = o.w, height = o.h;
  if (h.includes("e")) width = o.w + dx;
  if (h.includes("s")) height = o.h + dy;
  if (h.includes("w")) { x = o.x + dx; width = o.w - dx; }
  if (h.includes("n")) { y = o.y + dy; height = o.h - dy; }
  return { x, y, w: width, h: height };
}

export { HANDLES };
