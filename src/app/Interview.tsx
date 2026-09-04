import { useMemo, useState } from "react";
import type { Model } from "../semantic/model.ts";
import { metricsByTable } from "../semantic/model.ts";
import { matchModel, DEFAULT_BRIEF, type Brief } from "../suggest/match.ts";
import { prettyTable } from "./Sidebar.tsx";

const PREF_KEY = "semantic-canvas:prefs";
const loadPrefs = (): Partial<Brief> => {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}"); } catch { return {}; }
};
const savePrefs = (b: Brief) => {
  const { audience, grain, compare, includeBreakdowns, includeTable } = b;
  try { localStorage.setItem(PREF_KEY,
    JSON.stringify({ audience, grain, compare, includeBreakdowns, includeTable })); } catch {}
};

const AUDIENCES = [
  { id: "exec", label: "Executive", hint: "A few big numbers and the trend. Nothing to dig through." },
  { id: "operator", label: "Operator", hint: "Headlines plus the breakdowns you act on week to week." },
  { id: "analyst", label: "Analyst", hint: "Dense. More metrics, more cuts, and the underlying table." },
] as const;

const GRAINS = [
  { id: "day", label: "Daily" }, { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" }, { id: "quarter", label: "Quarterly" },
];

/**
 * Scoping, not guessing. "Suggest a dashboard" used to generate instantly from
 * the model's shape alone, which produces something plausible and generic. The
 * interview trades ten seconds for a dashboard that reflects who it is for and
 * what it is about -- and the answers persist, so the second one is faster.
 */
export function Interview({ model, onCancel, onDone }: {
  model: Model; onCancel: () => void; onDone: (b: Brief) => void;
}) {
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [brief, setBrief] = useState<Brief>({ ...DEFAULT_BRIEF, ...loadPrefs() });
  const [remember, setRemember] = useState(true);

  const matches = useMemo(() => matchModel(model, text), [model, text]);
  const byTable = metricsByTable(model);
  const subject = brief.table ?? matches.subject
    ?? Object.entries(byTable).sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? null;
  const available = subject ? byTable[subject] ?? [] : [];

  const suggestedMetrics = useMemo(() => {
    const hits = matches.metrics.filter((m) => m.metric.baseTable === subject).map((m) => m.metric.name);
    const cap = brief.audience === "analyst" ? 6 : brief.audience === "operator" ? 4 : 3;
    return (hits.length ? hits : available.map((m) => m.name)).slice(0, cap);
  }, [matches, subject, available, brief.audience]);

  const chosen = brief.metrics ?? suggestedMetrics;
  const set = (p: Partial<Brief>) => setBrief((b) => ({ ...b, ...p }));

  const finish = () => {
    const final: Brief = { ...brief, text, table: subject, metrics: chosen };
    if (remember) savePrefs(final);
    onDone(final);
  };

  return (
    <div className="iv">
      <div className="iv-head">
        <span className="iv-step">Step {step + 1} of 4</span>
        <div className="iv-bar"><i style={{ width: `${((step + 1) / 4) * 100}%` }} /></div>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>

      {step === 0 && (
        <section>
          <h2>What should this dashboard tell you?</h2>
          <p className="lede">Describe it in your own words. I'll match it against the
            {" "}{Object.keys(model.metrics).length} metrics in your semantic layer — you'll
            confirm everything before anything is built.</p>
          <textarea autoFocus value={text} rows={3} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. how is revenue retention trending, and where are we losing customers" />
          <div className="chips">
            {["how is revenue retention trending",
              "where are we losing customers",
              "marketing spend efficiency and cost per customer"].map((s) => (
              <button key={s} className="chip" onClick={() => setText(s)}>{s}</button>
            ))}
          </div>
          {text.trim() && (
            <div className="readback">
              <b>Reading that as:</b>{" "}
              {matches.subject ? <>subject <code>{prettyTable(matches.subject)}</code></> : "no strong subject yet"}
              {matches.metrics.length > 0 && <> · {matches.metrics.slice(0, 4)
                .map((m) => m.metric.label).join(", ")}</>}
            </div>
          )}
        </section>
      )}

      {step === 1 && (
        <section>
          <h2>Is this the right subject?</h2>
          <p className="lede">Everything on one tile has to come from one base table, so the
            subject decides what can sit together.</p>
          <div className="opts">
            {Object.entries(byTable).sort((a, b) => b[1].length - a[1].length).map(([name, ms]) => (
              <button key={name} className={"optcard" + (subject === name ? " on" : "")}
                      onClick={() => set({ table: name, metrics: undefined })}>
                <b>{prettyTable(name)}</b>
                <small>{model.tables[name]?.grain || `${ms.length} metrics`}</small>
                <span className="n">{ms.length}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2>Which numbers lead?</h2>
          <p className="lede">These become the headline cards. The rest of the model stays
            available to add later.</p>
          <div className="metric-grid">
            {available.map((m) => {
              const on = chosen.includes(m.name);
              return (
                <button key={m.name} className={"optcard sm" + (on ? " on" : "")}
                        onClick={() => set({ metrics: on
                          ? chosen.filter((x) => x !== m.name) : [...chosen, m.name] })}>
                  <b>{m.label}</b><small>{m.description?.slice(0, 64)}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2>Who reads it, and how often?</h2>
          <p className="lede">This sets density — how many tiles, how much breakdown, and
            whether the underlying table comes along.</p>
          <div className="opts">
            {AUDIENCES.map((a) => (
              <button key={a.id} className={"optcard" + (brief.audience === a.id ? " on" : "")}
                      onClick={() => set({ audience: a.id,
                        includeBreakdowns: a.id !== "exec", includeTable: a.id === "analyst" })}>
                <b>{a.label}</b><small>{a.hint}</small>
              </button>
            ))}
          </div>
          <div className="row2">
            <label className="ctl"><span>Period</span>
              <select value={brief.grain} onChange={(e) => set({ grain: e.target.value })}>
                {GRAINS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <label className="ctl"><span>Compare against</span>
              <select value={brief.compare} onChange={(e) => set({ compare: e.target.value as any })}>
                <option value="prior">Prior period</option>
                <option value="first">First period</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={!!brief.includeBreakdowns}
                     onChange={(e) => set({ includeBreakdowns: e.target.checked })} />
              Include breakdowns
            </label>
            <label className="check">
              <input type="checkbox" checked={!!brief.includeTable}
                     onChange={(e) => set({ includeTable: e.target.checked })} />
              Include the detail table
            </label>
          </div>
          <label className="check remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember these preferences for next time
          </label>
        </section>
      )}

      <div className="iv-foot">
        <button className="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</button>
        <span className="spacer" />
        {step === 0 && <button className="ghost" onClick={() => onDone({ ...brief, metrics: undefined })}>
          Skip — just show me something</button>}
        {step < 3
          ? <button className="primary" onClick={() => setStep((s) => s + 1)}>Continue</button>
          : <button className="primary" onClick={finish}>Build it</button>}
      </div>
    </div>
  );
}
