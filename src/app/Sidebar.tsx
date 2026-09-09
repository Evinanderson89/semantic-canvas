import { useEffect, useState } from "react";
import type { Model } from "../semantic/model.ts";
import { metricsByTable } from "../semantic/model.ts";

const ICONS: Record<string, string> = {
  home: "M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-4H8v4H4a1 1 0 0 1-1-1z",
  registry: "M4 4h2v12H4zM8.5 7h2v9h-2zM13 5h2v11h-2z",
  star: "m10 3 2.2 4.5 5 .7-3.6 3.5.9 4.9L10 14.3 5.5 16.6l.9-4.9L2.8 8.2l5-.7z",
  content: "M4 4h12v3H4zm0 5h12v7H4z",
  grid: "M4 4h5v5H4zm7 0h5v5h-5zM4 11h5v5H4zm7 0h5v5h-5z",
  spark: "M10 2v4M10 14v4M2 10h4M14 10h4M5 5l2.5 2.5M12.5 12.5 15 15M15 5l-2.5 2.5M7.5 12.5 5 15",
  book: "M4 4h5a2 2 0 0 1 2 2v10a2 2 0 0 0-2-2H4zm12 0h-5a2 2 0 0 0-2 2v10a2 2 0 0 1 2-2h5z",
  db: "M10 3c3.3 0 6 1 6 2.2S13.3 7.5 10 7.5 4 6.5 4 5.2 6.7 3 10 3zM4 8c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2v6.8c0 1.2-2.7 2.2-6 2.2s-6-1-6-2.2z",
  clock: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm.8 3.5v4l3 1.7-.8 1.3-3.8-2.2V6.5z",
  users: "M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 16c0-2.5 2.2-4 5-4s5 1.5 5 4zm11.5 0c0-1.6-.6-2.9-1.6-3.8 2.4.2 4.1 1.6 4.1 3.8z",
  groups: "M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4z",
  plug: "M7 2v5M13 2v5M5 7h10v3a4 4 0 0 1-4 4v4h-2v-4a4 4 0 0 1-4-4z",
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"
         fill={d.includes("M2 10h4") || d.includes("M7 2v5") ? "none" : "currentColor"}
         stroke={d.includes("M2 10h4") || d.includes("M7 2v5") ? "currentColor" : "none"}
         strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6">
      <path d={d} />
    </svg>
  );
}

export function Sidebar({ model, active, view, onPick, onView, collapsed, onToggle,
                          principals = [], principal = "", onPrincipal = () => {},
                          sources = [], activeSource = null, demo }: {
  model: Model; active: string | null; view: string;
  onPick: (table: string | null) => void;
  onView: (v: "home" | "registry" | "model" | "connections") => void;
  collapsed: boolean; onToggle: () => void;
  principals?: { id: string; name: string }[];
  principal?: string;
  onPrincipal?: (id: string) => void;
  sources?: { id: string; label: string; status: "ready" | "error"; error?: string }[];
  activeSource?: { label: string; status: "ready" | "error"; error?: string } | null;
  demo?: { active: boolean; onOpen: () => void };
}) {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("sc:theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("sc:theme", theme); } catch { /* Appearance still works without storage. */ }
  }, [theme]);
  const byTable = metricsByTable(model);
  const tables = Object.entries(byTable).sort((a, b) => b[1].length - a[1].length);

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <div className="brand">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none"
             stroke="currentColor" strokeWidth="1.7">
          <path d="M10 2v16M10 6l5-2M10 12l-5 2" strokeLinecap="round" />
        </svg>
        <span>Semantic Canvas</span>
        <button className="collapse" onClick={onToggle} title="Collapse sidebar"
                aria-label="Collapse sidebar">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12" />
          </svg>
        </button>
      </div>

      <button className="search" aria-label="Search metrics" onClick={() => onView("registry")}>
        <Icon d="M9 3a6 6 0 1 0 3.5 10.9l3.3 3.3 1.4-1.4-3.3-3.3A6 6 0 0 0 9 3zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
        <span>Find a metric</span>
      </button>

      <nav>
        <NavItem icon="home" label="Home" active={view === "home" && active === null}
                 onClick={() => onView("home")} />
        <NavItem icon="registry" label="Metric Registry" active={view === "registry"}
                 badge={String(Object.keys(model.metrics).length)}
                 onClick={() => onView("registry")} />
        <NavItem icon="db" label="Data Model" active={view === "model"}
                 badge={String(Object.keys(model.tables).length)}
                 onClick={() => onView("model")} />
        <NavItem icon="plug" label="Connections" active={view === "connections"}
                 badge={String(sources.length)}
                 onClick={() => onView("connections")} />
      </nav>

      <div className="section">Explore by topic</div>
      <nav>
        {tables.map(([name, ms]) => (
          <button key={name}
            className={"nav cat" + (active === name ? " on" : "")}
            onClick={() => onPick(name)}>
            <span className="label">{prettyTable(name)}</span>
            <span className="count">{ms.length}</span>
          </button>
        ))}
        {demo && <button className={"nav cat" + (demo.active ? " on" : "")}
          aria-label="Messy dashboard" aria-current={demo.active ? "page" : undefined}
          title="An example to clean up with Design review and Smart arrange" onClick={demo.onOpen}>
          <span className="label">Messy dashboard</span>
          <span className="count" aria-hidden="true">Example</span>
        </button>}
      </nav>

      <div className="who">
        <div className="workspace-caption"><span title="Roles are simulations on this computer, not authentication">Local alpha · Role preview</span>
          <button className="theme-toggle" aria-label={`Switch to ${theme === "light" ? "dark" : "light"} appearance`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} appearance`} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? "◐" : "◑"}
          </button>
        </div>
        <div className="who-row">
          <span className="avatar">{(principal || "SC").slice(0, 2).toUpperCase()}</span>
          {principals.length > 0 ? (
            <select className="who-sel" value={principal} aria-label="Acting as"
                    title="No principal denies all row-level-secured data"
                    onChange={(e) => onPrincipal(e.target.value)}>
              <option value="">No principal</option>
              {principals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <span className="name">Local</span>}
        </div>
        <button className="who-source" onClick={() => onView("connections")}
                title={activeSource
                  ? `${activeSource.label}${activeSource.status === "error" ? ` — ${activeSource.error}` : ""}`
                  : model.source}>
          <span className={"dot " + (activeSource?.status ?? "ready")} />
          <span>{activeSource?.label ?? model.source}</span>
        </button>
      </div>
    </aside>
  );
}

function NavItem({ icon, label, badge, active, onClick }: any) {
  return (
    <button className={"nav" + (active ? " on" : "")} onClick={onClick}
            disabled={!onClick} aria-label={label}>
      <Icon d={ICONS[icon]} />
      <span className="label">{label}</span>
      {badge && <span className="count">{badge}</span>}
    </button>
  );
}

export function prettyTable(name: string) {
  return name.replace(/^(fct|dim)_/, "").replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSaas\b/g, "SaaS").replace(/\bMrr\b/g, "MRR");
}
