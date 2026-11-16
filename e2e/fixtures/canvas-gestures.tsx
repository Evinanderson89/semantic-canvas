import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas } from "../../src/canvas/Canvas.tsx";
import { DEFAULT_CANVAS } from "../../src/canvas/presets.ts";
import type { TileSpec } from "../../src/compiler/spec.ts";
import "../../src/app/styles.css";

const initial: TileSpec[] = [
  { id: "a", title: "Revenue", kind: "heading", metrics: [], dimensions: [], layout: { x: 40, y: 40, w: 243, h: 143 } },
  { id: "b", title: "Retention", kind: "heading", metrics: [], dimensions: [], layout: { x: 360, y: 40, w: 240, h: 140 } },
  { id: "c", title: "Pinned note", kind: "heading", pinned: true, metrics: [], dimensions: [], layout: { x: 40, y: 300, w: 240, h: 140 } },
];
function Fixture() {
  const [tiles, setTiles] = useState(initial), [selected, setSelected] = useState(["a"]);
  const [history, setHistory] = useState<TileSpec[][]>([]), [locked, setLocked] = useState(false);
  const [zoom, setZoom] = useState(1), [snap, setSnap] = useState(false);
  useEffect(() => {
    const update = (event: Event) => {
      const action = (event as CustomEvent).detail;
      if (action === "lock") setLocked(true);
      if (action === "rename") setTiles(current => current.map(t => ({ ...t, title: `${t.title} updated` })));
      if (action === "remove") setTiles(current => current.filter(t => t.id !== "a"));
    };
    window.addEventListener("fixture-update", update);
    return () => window.removeEventListener("fixture-update", update);
  }, []);
  return <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
    <nav style={{ display: "flex", gap: 12, padding: 16 }}>
      <button onClick={() => setSelected(["a", "b", "c"])}>Select all</button>
      <button onClick={() => setZoom(.75)}>Zoom to 75%</button>
      <button onClick={() => setSnap(true)}>Enable snapping</button>
      <button disabled={!history.length} onClick={() => { setTiles(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>Undo gesture</button>
    </nav>
    <pre id="gesture-state" hidden>{JSON.stringify({ tiles, selected, history: history.length })}</pre>
    <Canvas canvas={{ ...DEFAULT_CANVAS, width: 1000, height: 650, locked, snap }} tiles={tiles} zoom={zoom}
      selected={selected} onSelect={setSelected} onChange={setTiles} onCommit={before => setHistory(h => [...h, before])}
      renderTile={t => <div style={{ height: "100%", padding: 20, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 8 }}><h2>{t.title}</h2><p>Arrange this section.</p></div>} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
