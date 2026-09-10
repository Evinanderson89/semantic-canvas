import { useState } from "react";
import type { DashboardSpec } from "../compiler/spec.ts";
import { currentTab, duplicateTab, removeTab, tabsOf } from "./tabs.ts";
import { Popover } from "./Popover.tsx";
import { StudioDialog } from "./StudioDialog.tsx";
export function TabStrip({ spec, active, locked, onSelect, onChange }: { spec: DashboardSpec; active: string; locked: boolean; onSelect: (id: string) => void; onChange: (s: DashboardSpec) => void }) {
  const tabs = tabsOf(spec), current = currentTab(spec, active);
  const [editing, setEditing] = useState<"add" | "rename" | "delete" | null>(null), [name, setName] = useState("");
  const start = (mode: "add" | "rename" | "delete") => { setName(mode === "add" ? "" : current.title); setEditing(mode); };
  return <div className="tab-strip"><div className="dashboard-tabs" role="tablist" aria-label="Dashboard tabs">
    {tabs.map((t, i) => <button key={t.id} role="tab" aria-selected={current.id === t.id} tabIndex={current.id === t.id ? 0 : -1}
      onKeyDown={e => { const n = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null; if (n != null) { e.preventDefault(); onSelect(tabs[n].id); (e.currentTarget.parentElement?.children[n] as HTMLElement)?.focus(); } }}
      onClick={() => onSelect(t.id)}>{t.title}<small>{spec.tiles.filter(x => (x.tabId ?? tabs[0].id) === t.id && (x.kind ?? "metric") === "metric").length}</small></button>)}
  </div>{!locked && <><button className="link add-tab" disabled={tabs.length >= 20} aria-label="Add tab" onClick={() => start("add")}>＋</button>
    <Popover label="Tab actions" trigger="•••" align="end">{close => <>
      <button onClick={() => { close(); start("rename"); }}>Rename tab</button>
      <button disabled={tabs.length >= 20} onClick={() => { close(); const next = duplicateTab(spec, current.id); onChange(next); onSelect(tabsOf(next).at(-1)!.id); }}>Duplicate tab</button>
      <button disabled={tabs.length < 2} onClick={() => { close(); start("delete"); }}>Delete tab</button>
    </>}</Popover></>}
    {editing && <StudioDialog title={editing === "delete" ? "Delete tab" : editing === "add" ? "New tab" : "Rename tab"} onClose={() => setEditing(null)}><form onSubmit={e => {
      e.preventDefault(); if (editing === "delete") { onChange(removeTab(spec, current.id)); onSelect(tabs.find(t => t.id !== current.id)!.id); }
      else if (name.trim()) { const id = editing === "add" ? crypto.randomUUID() : current.id;
        onChange({ ...spec, tabs: editing === "add" ? [...tabs, { id, title: name.trim() }] : tabs.map(t => t.id === id ? { ...t, title: name.trim() } : t) }); onSelect(id); }
      setEditing(null);
    }}><section>{editing === "delete" ? <p>Delete “{current.title}” and its contents? You can undo this change.</p> : <label className="form-field">Tab name<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Retention, growth, customers…" /></label>}</section><footer><button className="primary" type="submit">{editing === "delete" ? "Delete tab" : "Save tab"}</button></footer></form></StudioDialog>}
  </div>;
}
