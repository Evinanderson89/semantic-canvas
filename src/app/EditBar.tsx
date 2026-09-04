import { PRESETS, presetById, type CanvasSpec } from "../canvas/presets.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { boundsOf } from "../canvas/geometry.ts";
import { applyBestLayout } from "../canvas/layouts.ts";

export function EditBar({ canvas, onCanvas, zoom, onZoom, onFit, selected, tiles, onTiles }: {
  canvas: CanvasSpec; onCanvas: (c: CanvasSpec) => void;
  zoom: number; onZoom: (z: number) => void; onFit: () => void;
  selected: string[]; tiles: TileSpec[]; onTiles: (t: TileSpec[]) => void;
}) {
  const sel = tiles.filter((t) => selected.includes(t.id));
  const many = sel.length > 1;

  const patch = (fn: (t: TileSpec) => TileSpec) =>
    onTiles(tiles.map((t) => (selected.includes(t.id) ? fn(t) : t)));

  const align = (how: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => {
    if (!many) return;
    const b = boundsOf(sel.map((t) => t.layout));
    patch((t) => {
      const l = { ...t.layout };
      if (how === "left") l.x = b.x;
      if (how === "right") l.x = b.x + b.w - l.w;
      if (how === "hcenter") l.x = b.x + (b.w - l.w) / 2;
      if (how === "top") l.y = b.y;
      if (how === "bottom") l.y = b.y + b.h - l.h;
      if (how === "vcenter") l.y = b.y + (b.h - l.h) / 2;
      return { ...t, layout: { ...l, x: Math.round(l.x), y: Math.round(l.y) } };
    });
  };

  const distribute = (axis: "x" | "y") => {
    if (sel.length < 3) return;
    const sorted = [...sel].sort((a, b) => a.layout[axis] - b.layout[axis]);
    const first = sorted[0].layout[axis];
    const lastT = sorted[sorted.length - 1];
    const last = lastT.layout[axis];
    const step = (last - first) / (sorted.length - 1);
    const pos = new Map(sorted.map((t, i) => [t.id, Math.round(first + step * i)]));
    onTiles(tiles.map((t) => (pos.has(t.id)
      ? { ...t, layout: { ...t.layout, [axis]: pos.get(t.id)! } } : t)));
  };

  const layer = (dir: "front" | "back") => {
    const zs = tiles.map((t) => (t.layout as any).z ?? 1);
    const target = dir === "front" ? Math.max(...zs, 1) + 1 : Math.min(...zs, 1) - 1;
    patch((t) => ({ ...t, layout: { ...t.layout, z: target } as any }));
  };

  /** Picks the best-fitting named layout for the current tile set (Exec
   *  Summary if there's a real headline + support-chart mix, Grid otherwise)
   *  and packs into it. Grows the canvas if that needs more vertical room
   *  than it has -- never shrinks a preset/custom height that already fits. */
  const smartArrange = () => {
    if (!tiles.length) return;
    const { tiles: packed } = applyBestLayout(tiles, canvas.width);
    onTiles(packed);
    const bottom = Math.max(...packed.map((t) => t.layout.y + t.layout.h)) + 24;
    if (bottom > canvas.height) onCanvas({ ...canvas, height: Math.round(bottom) });
  };

  return (
    <div className="editbar">
      <label className="ctl">
        <span>Canvas</span>
        <select value={canvas.preset}
                onChange={(e) => {
                  const p = presetById(e.target.value);
                  if (p) onCanvas({ ...canvas, preset: p.id, width: p.width, height: p.height });
                  else onCanvas({ ...canvas, preset: "custom" });
                }}>
          {["Screen", "Print"].map((g) => (
            <optgroup key={g} label={g}>
              {PRESETS.filter((p) => p.group === g).map((p) => (
                <option key={p.id} value={p.id}>{p.label} — {p.hint}</option>
              ))}
            </optgroup>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>

      {canvas.preset === "custom" && (
        <label className="ctl narrow">
          <span>Size</span>
          <span className="pair">
            <input type="number" value={canvas.width} min={320} max={4000}
                   onChange={(e) => onCanvas({ ...canvas, width: +e.target.value || 320 })} />
            <em>×</em>
            <input type="number" value={canvas.height} min={320} max={4000}
                   onChange={(e) => onCanvas({ ...canvas, height: +e.target.value || 320 })} />
          </span>
        </label>
      )}

      <span className="sep" />

      <label className="ctl narrow">
        <span>Zoom</span>
        <select value={String(zoom)} onChange={(e) => onZoom(+e.target.value)}>
          {[0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5].map((z) => (
            <option key={z} value={z}>{Math.round(z * 100)}%</option>
          ))}
          {![0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5].includes(zoom) &&
            <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        </select>
      </label>
      <button className="tgl" onClick={onFit} title="Zoom so the whole canvas fits">Fit</button>

      <button className={"tgl" + (canvas.snap ? " on" : "")}
              onClick={() => onCanvas({ ...canvas, snap: !canvas.snap })}
              title="Snap to grid">Snap {canvas.snap ? canvas.grid : "off"}</button>
      {canvas.snap && (
        <select className="mini" value={canvas.grid}
                onChange={(e) => onCanvas({ ...canvas, grid: +e.target.value })}>
          {[4, 8, 12, 16, 24].map((g) => <option key={g} value={g}>{g}px</option>)}
        </select>
      )}

      <span className="sep" />

      <button className="tgl" onClick={smartArrange} disabled={tiles.length < 2}
              title="Repack every tile into clean rows, in reading order -- fixes overlap, gaps and drift after a bunch of manual moves">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" />
          <rect x="3" y="11" width="14" height="6" rx="1" />
        </svg>
        Smart arrange
      </button>

      <span className="sep" />

      <div className={"group" + (many ? "" : " off")}>
        {([["left","Align left","M3 3v14M6 6h11v3H6zM6 12h7v3H6z"],
           ["hcenter","Align centre","M10 3v14M5 6h10v3H5zM7 12h6v3H7z"],
           ["right","Align right","M17 3v14M3 6h11v3H3zM7 12h7v3H7z"],
           ["top","Align top","M3 3h14M6 6h3v11H6zM12 6h3v7h-3z"],
           ["vcenter","Align middle","M3 10h14M6 5h3v10H6zM12 7h3v6h-3z"],
           ["bottom","Align bottom","M3 17h14M6 3h3v11H6zM12 7h3v7h-3z"]] as const)
          .map(([k, title, d]) => (
            <button key={k} title={title} onClick={() => align(k as any)}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d={d} /></svg>
            </button>
          ))}
        <button title="Distribute horizontally" onClick={() => distribute("x")}
                disabled={sel.length < 3}>⇹</button>
        <button title="Distribute vertically" onClick={() => distribute("y")}
                disabled={sel.length < 3}>⇳</button>
      </div>

      <span className="sep" />

      <div className={"group" + (sel.length ? "" : " off")}>
        <button title="Bring to front" onClick={() => layer("front")}>⬆︎</button>
        <button title="Send to back" onClick={() => layer("back")}>⬇︎</button>
      </div>

      <span className="spacer" />
      <span className="selinfo">{sel.length ? `${sel.length} selected` : `${tiles.length} tiles`}</span>
      <button className={"lock" + (canvas.locked ? " on" : "")}
              onClick={() => onCanvas({ ...canvas, locked: !canvas.locked })}>
        {canvas.locked ? "🔒 Locked" : "🔓 Editing"}
      </button>
    </div>
  );
}
