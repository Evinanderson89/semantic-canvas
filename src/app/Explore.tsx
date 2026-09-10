import { useMemo, useState } from "react";
import type { Model } from "../semantic/model.ts";
import { metricsByTable } from "../semantic/model.ts";
import { prettyTable } from "./Sidebar.tsx";

/**
 * Metric Registry and Data Model are not new features — the model already
 * carries everything they show. They existed as dead sidebar links, which is
 * worse than not existing: a promise the tool doesn't keep.
 */
export function MetricRegistry({ model, onUse }: {
  model: Model; onUse: (metric: string) => void;
}) {
  const [q, setQ] = useState("");
  const [table, setTable] = useState<string | null>(null);
  const all = Object.values(model.metrics);
  const tables = Object.keys(metricsByTable(model));

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((m) =>
      (!table || m.baseTable === table) &&
      (!n || `${m.name} ${m.label} ${m.description} ${m.synonyms.join(" ")}`
        .toLowerCase().includes(n)));
  }, [q, table, all]);

  return (
    <div className="explore">
      <div className="eyebrow">Your semantic layer</div>
      <h1>Metric Registry</h1>
      <p className="lede">A shared language for your data. Explore a metric, understand its meaning, and bring it onto the canvas.</p>

      <div className="ex-tools">
        <input autoFocus className="txt" aria-label="Filter metrics" placeholder="Find a metric…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by topic" value={table ?? ""} onChange={(e) => setTable(e.target.value || null)}>
          <option value="">All topics</option>
          {tables.map((t) => <option key={t} value={t}>{prettyTable(t)}</option>)}
        </select>
      </div>

      <div className="ex-count">{shown.length} {shown.length === 1 ? "metric" : "metrics"}{q || table ? ` of ${all.length}` : ""}</div>
      <div className="mlist">
        {shown.map((m) => (
          <div key={m.name} className="mrow">
            <div className="mrow-top">
              <b>{m.label}</b>

              <button className="use" onClick={() => onUse(m.name)}>Chart it →</button>
            </div>
            {m.description && <p>{m.description}</p>}
            <div className="metric-topic">{prettyTable(m.baseTable)}</div>
            <details className="metric-definition"><summary>View definition</summary>
            <code className="metric-id">{m.name}</code>
            <pre className="expr">{m.expression}</pre>
            {m.filter && <div className="afilter mono">always: {m.filter}</div>}
            {m.synonyms.length > 0 && (
              <div className="syns">{m.synonyms.map((s) => <i key={s}>{s}</i>)}</div>
            )}
            </details>
          </div>
        ))}
        {shown.length === 0 && <div className="empty">Nothing matches “{q}”.</div>}
      </div>
    </div>
  );
}

export function DataModel({ model }: { model: Model }) {
  const byTable = metricsByTable(model);
  return (
    <div className="explore">
      <h1>Data Model</h1>
      <p className="lede">{Object.keys(model.tables).length} tables and {model.joins.length} joins,
        read from the {model.source} semantic layer. Joins are what let a metric on one table be
        cut by a dimension on another.</p>

      <h4 className="ex-h">Joins</h4>
      <div className="joins">
        {model.joins.map((j, i) => (
          <div key={i} className="join mono">
            <span>{j.left}</span><em>.{j.leftOn}</em>
            <span className="arrow">→</span>
            <span>{j.right}</span><em>.{j.rightOn}</em>
            <i>{j.type}</i>
          </div>
        ))}
      </div>

      <h4 className="ex-h">Tables</h4>
      {Object.values(model.tables).map((t) => (
        <details key={t.name} className="tbl-card">
          <summary>
            <b className="mono">{t.name}</b>
            <span className="grain">{t.grain}</span>
            <span className="cnt mono">{t.columns.length} cols · {(byTable[t.name] ?? []).length} metrics</span>
          </summary>
          <div className="tbl-body">
            {t.description && <p>{t.description}</p>}
            {t.synonyms.length > 0 && (
              <div className="syns">{t.synonyms.map((s) => <i key={s}>{s}</i>)}</div>
            )}
            <table>
              <thead><tr><th>Column</th><th>Type</th><th>Description</th></tr></thead>
              <tbody>
                {t.columns.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}
                      {t.partitionKeys.includes(c.name) && <span className="pk">PARTITION</span>}</td>
                    <td className="mono t">{c.type}</td>
                    <td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
