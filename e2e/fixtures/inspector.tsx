// Browser component fixture: same tile identity and dimensions, changing metric/model context.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../../src/app/Inspector.tsx";
import { model as initialModel } from "../../test/fixtures.ts";
import type { TileSpec } from "../../src/compiler/spec.ts";

function Fixture() {
  const [model, setModel] = useState(initialModel);
  const [tile, setTile] = useState<TileSpec>({ id: "same-tile", title: "Profile fixture", metrics: ["revenue"], dimensions: ["country"],
    layout: { x: 0, y: 0, w: 500, h: 400 } });
  return <><button onClick={() => setTile(t => ({ ...t, metrics: ["users"] }))}>Change metric base</button>
    <button onClick={() => setModel(m => structuredClone(m))}>Reload semantic model</button>
    <Inspector model={model} tile={tile} onChange={setTile} onClose={() => {}} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
