import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TileSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "./presets.ts";
import { guidesFor, snapTo, type Box } from "./geometry.ts";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = typeof HANDLES[number];

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
  const drag = useRef<any>(null);

  const boxOf = (t: TileSpec): Box => ({ ...t.layout });

  const begin = useCallback((e: React.PointerEvent, id: string, handle: Handle | null) => {
    if (canvas.locked || tiles.find(t => t.id === id)?.pinned) return;
    if (!handle && (e.target as HTMLElement).closest("button,input,select,textarea,[contenteditable=true]")) return;
    e.stopPropagation();
    (e.currentTarget.closest(".node") as HTMLElement)?.focus({ preventScroll: true });
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Direct DOM toggle, not React state -- a drag already fires onChange
    // (and a re-render) on every pointermove; a state update just to flip
    // one class would add a second one for no reason. Suppresses the
    // tile's own position/size transition (added so an automatic reflow --
    // tile-overlap self-healing -- reads as "the system moved this" rather
    // than a silent teleport) for exactly the duration a drag is what's
    // actually moving the tile, so the transition can't fight the cursor
    // and make dragging feel laggy.
    surface.current?.classList.add("dragging");
    const ids = (selected.includes(id) ? selected : [id]).filter(id => !tiles.find(t => t.id === id)?.pinned);
    if (!selected.includes(id)) onSelect(e.shiftKey ? [...selected, id] : [id]);
    drag.current = {
      handle, ids, startX: e.clientX, startY: e.clientY,
      // Snapshot before the gesture so one drag is one undo step, however many
      // hundred pointermove frames it takes.
      before: tiles,
      moved: false,
      origin: Object.fromEntries(tiles.filter((t) => ids.includes(t.id))
        .map((t) => [t.id, { ...t.layout }])),
    };
  }, [canvas.locked, selected, tiles, onSelect]);

  useEffect(() => {
    if (canvas.locked) return;
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
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

      d.moved = true;
      const next = tiles.map((t) => {
        if (!d.ids.includes(t.id)) return t;
        const o = d.origin[t.id];
        const l = d.handle ? resize(o, d.handle, dx, dy) : { ...o, x: o.x + dx, y: o.y + dy };
        return { ...t, layout: {
          ...t.layout,
          x: snapTo(Math.max(0, l.x), canvas.grid, canvas.snap),
          y: snapTo(Math.max(0, l.y), canvas.grid, canvas.snap),
          w: Math.max(80, snapTo(l.w, canvas.grid, canvas.snap)),
          h: Math.max(60, snapTo(l.h, canvas.grid, canvas.snap)),
        } };
      });
      onChange(next);
    };
    const up = () => {
      const d = drag.current;
      if (d?.moved) onCommit(d.before);
      drag.current = null;
      setGuides([]);
      surface.current?.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [tiles, zoom, canvas, onChange, onCommit, canvas.locked]);

  // Keyboard nudge, delete, and layer order -- the shortcuts any design surface
  // is expected to have.
  useEffect(() => {
    if (canvas.locked) return;
    const key = (e: KeyboardEvent) => {
      if (!selected.length || !(e.target as HTMLElement)?.closest(".canvas-surface")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable || (e.target as HTMLElement)?.closest("[role=dialog]")) return;
      const step = e.shiftKey ? 10 : canvas.snap ? canvas.grid : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (nudge[e.key]) {
        e.preventDefault();
        const [dx, dy] = nudge[e.key];
        onCommit(tiles);
        onChange(tiles.map((t) => selected.includes(t.id) && !t.pinned
          ? { ...t, layout: e.altKey ? { ...t.layout, w: Math.max(80, t.layout.w + dx), h: Math.max(48, t.layout.h + dy) } : { ...t.layout, x: Math.max(0, t.layout.x + dx), y: Math.max(0, t.layout.y + dy) } } : t));
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
          <span className="sr-only" id="canvas-keyboard-help">Arrow keys move selected tiles. Hold Shift for larger steps. Hold Alt to resize. Escape clears selection. Text editing uses normal cursor keys.</span>
          {!tiles.length && emptyState}
          {tiles.map((t) => {
            const on = selected.includes(t.id);
            return (
              <div key={t.id}
                   className={"node" + (on ? " selected" : "") + (t.pinned ? " pinned" : "")}
                   tabIndex={canvas.locked ? -1 : 0} role="group"
                   aria-label={`${t.title ?? t.text ?? t.metrics.join(", ")}${t.pinned ? ", pinned" : ""}`}
                   aria-describedby="canvas-keyboard-help"
                   onFocus={(e) => { if (e.target === e.currentTarget && !canvas.locked) onSelect([t.id]); }}
                   style={{ left: t.layout.x, top: t.layout.y,
                            width: t.layout.w, height: t.layout.h,
                            zIndex: (t.layout as any).z ?? 1 }}
                   onPointerDown={(e) => { e.stopPropagation();
                     if (canvas.locked) return;
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
