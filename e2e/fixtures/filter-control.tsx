import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilterControl } from "../../src/app/FilterControls.tsx";
import { model as initialModel } from "../../test/fixtures.ts";
import type { DashboardFilter, DashboardSpec, FilterValue } from "../../src/compiler/spec.ts";
import "../../src/app/styles.css";
import "../../src/app/buttons.css";

function Fixture() {
  const [model, setModel] = useState(initialModel), [metric, setMetric] = useState("revenue");
  const [context, setContext] = useState(0), [date, setDate] = useState(false), [value, setValue] = useState<FilterValue>({});
  const filter: DashboardFilter = { id: "country", label: "Country", field: date ? "fct_sales.sold_on" : "dim_users.country",
    control: date ? "date" : "select", presentation: date ? "range" : "chips", scope: "report",
    bindings: [{ tileId: "same-tile", field: date ? "fct_sales.sold_on" : "dim_users.country" }] };
  const spec: DashboardSpec = { title: "Filter fixture", filters: [filter], tiles: [{ id: "same-tile", metrics: [metric], dimensions: [], layout: { x: 0, y: 0, w: 500, h: 300 } }] };
  return <main style={{ padding: 24 }}><div>
    <button onClick={() => setMetric("users")}>Change metric base</button>
    <button onClick={() => setModel(m => structuredClone(m))}>Reload semantic model</button>
    <button onClick={() => setContext(n => n + 1)}>Change viewing context</button>
    <button onClick={() => setDate(true)}>Use date control</button>
  </div><section aria-label="Dashboard filter" style={{ paddingTop: 24 }}>
    <FilterControl filter={filter} value={value} onChange={setValue} spec={spec} model={model} queryContext={String(context)} />
  </section></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
