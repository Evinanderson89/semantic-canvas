import type { DashboardSpec, FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { CSSProperties } from "react";
import { useId, useMemo, useRef, useState } from "react";
import { sectionsOf } from "../canvas/layouts.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { metricOf, type Model } from "../semantic/model.ts";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";
import type { DrillEntry } from "./drill.ts";
import type { Readiness } from "./readiness.ts";
import { DataFindings, describeFilter, findingTitle } from "./MetricEvidence.tsx";
import { visibleQuery } from "./query.ts";
import { reportFindings } from "./reportFindings.ts";
import { isScopeNote } from "../suggest/resultQuality.ts";
import { downloadSvg } from "./export.ts";
import { useEvidenceDigest } from "./useEvidenceDigest.ts";

export type PresentationMode = "dashboard" | "story" | "infographic";
export const PRESENTATIONS: { id: PresentationMode; label: string; description: string }[] = [
  { id: "dashboard", label: "Dashboard", description: "Your authored canvas, with its current filters and drill context." },
  { id: "story", label: "Story", description: "A reading view: your sections, commentary and evidence in order." },
  { id: "infographic", label: "Infographic", description: "A compact visual brief with headline numbers and supporting evidence." },
];

export function BroadsideHygieneProvenance({ hygieneNotes }: { hygieneNotes?: string[] }) {
  if (!hygieneNotes || hygieneNotes.length === 0) return null;
  return (
    <div className="report-hygiene-provenance" role="note" aria-label="Automated data hygiene provenance">
      <span className="report-hygiene-kicker">✓ Data hygiene &amp; join safety verified</span>
      <span className="report-hygiene-items">{hygieneNotes.join(" · ")}</span>
    </div>
  );
}

export interface TileLineageSummary {
  metrics: { id: string; label: string; formula: string; baseTable: string }[];
  tables: string[];
  joins: string[];
  sql: string;
}

export function buildTileLineageSummary(
  model: Model,
  tile: TileSpec,
  query: ReturnType<typeof visibleQuery>,
  check?: Readiness,
): TileLineageSummary {
  const metrics = tile.metrics.map((id) => {
    const m = metricOf(model, id);
    const formula =
      m?.type === "ratio"
        ? `${m.numerator ?? ""} / ${m.denominator ?? ""}`
        : m?.type === "cumulative"
          ? `RUNNING_SUM(${m.metric ?? id})`
          : m?.expression || id;
    return {
      id,
      label: m?.label ?? id,
      formula,
      baseTable: m?.baseTable ?? "",
    };
  });

  const baseTables = Array.from(new Set(metrics.map((m) => m.baseTable).filter(Boolean)));
  const referencedTables = new Set<string>(baseTables);
  for (const dim of query.dimensions) {
    const raw = dim.includes(":") ? dim.split(":")[1] : dim;
    if (raw?.includes(".")) referencedTables.add(raw.split(".")[0]);
  }
  for (const w of query.where) {
    if (w.source === "dimension" && w.field.includes(".")) {
      referencedTables.add(w.field.split(".")[0]);
    }
  }

  const activeJoins = model.joins.filter(
    (j) =>
      (referencedTables.has(j.left) && referencedTables.has(j.right)) ||
      (baseTables.includes(j.left) && model.joins.length <= 3),
  );
  for (const j of activeJoins) {
    referencedTables.add(j.left);
    referencedTables.add(j.right);
  }

  const joins = activeJoins.map(
    (j) => `${j.left}.${j.leftOn} → ${j.right}.${j.rightOn} (${j.cardinality ?? "many_to_one"})`,
  );

  let sql = check?.sql?.trim() ?? "";
  if (!sql) {
    const primaryTable = baseTables[0] ?? Object.keys(model.tables)[0] ?? "source_table";
    const selectParts: string[] = [];
    for (const dim of query.dimensions) {
      if (dim.includes(":")) {
        const [grain, field] = dim.split(":");
        const col = field.includes(".") ? field : `${primaryTable}.${field}`;
        selectParts.push(`DATE_TRUNC('${grain}', ${col}) AS ${col.split(".").at(-1)}_${grain}`);
      } else {
        selectParts.push(dim);
      }
    }
    for (const m of metrics) {
      selectParts.push(`${m.formula} AS ${m.id}`);
    }
    const joinClauses = activeJoins
      .filter((j) => j.left === primaryTable)
      .map((j) => `${j.type.toUpperCase()} JOIN ${j.right} ON ${j.left}.${j.leftOn} = ${j.right}.${j.rightOn}`);
    const groupCount = query.dimensions.length;
    sql = [
      `SELECT ${selectParts.join(", ") || "*"}`,
      `FROM ${primaryTable}`,
      ...joinClauses,
      ...(groupCount > 0
        ? [`GROUP BY ${Array.from({ length: groupCount }, (_, i) => i + 1).join(", ")}`]
        : []),
    ].join("\n");
  }

  return {
    metrics,
    tables: Array.from(referencedTables),
    joins,
    sql,
  };
}

/** Presentation changes geometry only. Queries, chart types, authored section membership and notes are preserved. */
export function ReportPresentation({
  spec,
  model,
  mode,
  queryContext,
  filtersByTile,
  scopeWarnings,
  drills,
  checks,
  onReadiness,
  digestOverride,
}: {
  spec: DashboardSpec;
  model: Model;
  mode: "story" | "infographic";
  queryContext: string;
  filtersByTile: Record<string, FilterSpec[]>;
  scopeWarnings: Record<string, string[]>;
  drills: Record<string, DrillEntry[]>;
  checks: Record<string, Readiness>;
  onReadiness: (id: string, state: Readiness) => void;
  digestOverride?: string;
}) {
  const notesId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [posterTheme, setPosterTheme] = useState<"broadsheet" | "blueprint" | "dark">("broadsheet");
  const [showColophon, setShowColophon] = useState(true);
  const isMetric = (t: TileSpec) => (t.kind ?? "metric") === "metric";

  const snapshotPayload = useMemo(
    () =>
      spec.tiles.length > 0
        ? {
            version: 1,
            mode,
            title: spec.title,
            model: model.name,
            source: model.source,
            hygieneNotes: model.hygieneNotes ?? [],
            tiles: spec.tiles.map((t) => ({
              id: t.id,
              kind: t.kind ?? "metric",
              title: t.title ?? t.text ?? "",
              metrics: t.metrics,
              dimensions: t.dimensions,
              where: filtersByTile[t.id] ?? [],
              drill: drills[t.id] ?? [],
              evidenceFingerprint: checks[t.id]?.evidenceFingerprint ?? null,
              window: checks[t.id]?.window ?? null,
            })),
          }
        : undefined,
    [mode, spec, model.name, model.source, model.hygieneNotes, filtersByTile, drills, checks],
  );
  const computedDigest = useEvidenceDigest(digestOverride ? undefined : snapshotPayload);
  const effectiveDigest = digestOverride || computedDigest.digest;
  const friendlySource = model.source === "duckglue" ? "DuckDB semantic layer" : model.source;

  const notes = reportFindings(
    spec.tiles
      .filter((t) => isMetric(t) && checks[t.id]?.dataFindings?.length && checks[t.id].status !== "checking")
      .map((t) => {
        const query = visibleQuery(model, t, [...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])], drills[t.id]);
        return {
          id: t.id,
          title: t.title || t.metrics.join(", "),
          findings: checks[t.id].dataFindings ?? [],
          scope: {
            ...query,
            id: undefined,
            window: checks[t.id].window,
            rowRules: checks[t.id].rowRules,
            exceptions: scopeWarnings[t.id] ?? [],
          },
        };
      }),
  );
  const noteId = (number: number) => `${notesId}-${number}`;

  return (
    <div ref={rootRef} className={`report-presentation ${mode}`} data-poster-theme={posterTheme}>
      {spec.tiles.length > 0 && (
        <div className="report-broadside-masthead">
          <div className="report-broadside-kicker">
            <span>{mode === "infographic" ? "BROADSIDE INFOGRAPHIC" : "EXECUTIVE NARRATIVE STORY"}</span>
            <span aria-hidden="true">·</span>
            <span>{model.name}</span>
          </div>
          <div className="report-broadside-actions" data-export-ignore>
            <div className="report-broadside-themes" role="group" aria-label="Poster theme">
              {(
                [
                  { id: "broadsheet", label: "Warm Broadsheet" },
                  { id: "blueprint", label: "Cobalt Blueprint" },
                  { id: "dark", label: "Obsidian Dark" },
                ] as const
              ).map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className="report-theme-btn"
                  aria-pressed={posterTheme === theme.id}
                  onClick={() => setPosterTheme(theme.id)}
                >
                  {theme.label}
                </button>
              ))}
            </div>
            <label
              className="report-colophon-toggle"
              title="Include open-source Semantic Canvas signature on exported posters"
            >
              <input type="checkbox" checked={showColophon} onChange={(e) => setShowColophon(e.target.checked)} />
              <span>Colophon</span>
            </label>
            <button
              type="button"
              className="report-svg-btn"
              onClick={() => {
                if (rootRef.current) {
                  void downloadSvg(
                    `${(spec.title || mode).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${mode}.svg`,
                    rootRef.current,
                  );
                }
              }}
            >
              Download Vector SVG
            </button>
          </div>
        </div>
      )}
      {sectionsOf(spec.tiles)
        .filter((group) => group.some((t) => t.kind !== "heading"))
        .map((group, index) => {
          const heading = group[0].kind === "heading" ? group[0] : null;
          const content = heading ? group.slice(1) : group;
          const isHeadline = (t: TileSpec) => isMetric(t) && ["kpi", "stat"].includes(inferChart(model, t));
          const headlineSpans = new Map<string, number>();
          for (let i = 0; i < content.length; ) {
            if (!isHeadline(content[i])) {
              i++;
              continue;
            }
            const start = i;
            while (i < content.length && isHeadline(content[i])) i++;
            for (let row = start; row < i; ) {
              const count = i - row === 4 ? 2 : Math.min(3, i - row);
              for (let j = 0; j < count; j++) headlineSpans.set(content[row + j].id, 6 / count);
              row += count;
            }
          }
          const nonHeadlineMetrics = content.filter(
            (t) => isMetric(t) && !["kpi", "stat"].includes(inferChart(model, t)),
          );
          const lead =
            mode === "story"
              ? nonHeadlineMetrics[0]
              : nonHeadlineMetrics.length % 2 === 1
                ? nonHeadlineMetrics[0]
                : undefined;
          const isSupport = (t: TileSpec) =>
            isMetric(t) && t.id !== lead?.id && !["kpi", "stat"].includes(inferChart(model, t));
          const fullWidthSupport = new Set<string>();
          for (let i = 0; i < content.length; ) {
            if (!isSupport(content[i])) {
              i++;
              continue;
            }
            const start = i;
            while (i < content.length && isSupport(content[i])) i++;
            if ((i - start) % 2) fullWidthSupport.add(content[i - 1].id);
          }
          return (
            <section className="report-section" key={heading?.id ?? `section-${index}`}>
              {heading && (
                <header className="report-section-heading">
                  <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <h2>{heading.text ?? heading.title}</h2>
                </header>
              )}
              <div className="report-grid">
                {content.map((t) => {
                  const metric = isMetric(t);
                  const headline = metric && ["kpi", "stat"].includes(inferChart(model, t));
                  const query = metric
                    ? visibleQuery(
                        model,
                        t,
                        [...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])],
                        drills[t.id],
                      )
                    : null;
                  const check = checks[t.id];
                  const lineage = query ? buildTileLineageSummary(model, t, query, check) : null;
                  const chartNotes = notes.filter((note) => note.charts.some((chart) => chart.id === t.id));
                  return (
                    <article
                      key={t.id}
                      data-report-tile={t.id}
                      style={headline ? ({ "--headline-span": headlineSpans.get(t.id) } as CSSProperties) : undefined}
                      className={`report-item ${
                        metric
                          ? headline
                            ? "headline"
                            : t.id === lead?.id
                              ? "lead-chart"
                              : `support-chart${fullWidthSupport.has(t.id) ? " full-row" : ""}`
                          : "authored-content"
                      }`}
                    >
                      {t.kind === "filter" ? (
                        <div className="report-filter-note">
                          <strong>
                            {t.title ?? spec.filters?.find((f) => f.id === t.filterId)?.label ?? "Dashboard filter"}
                          </strong>
                          <p>Selections are captured in each chart’s scope below. Change them on the dashboard.</p>
                        </div>
                      ) : (
                        <div
                          className={`report-tile ${
                            metric
                              ? headline
                                ? "headline-tile"
                                : inferChart(model, t) === "table"
                                  ? "table-tile"
                                  : "chart-tile"
                              : "content-tile"
                          }`}
                          style={t.kind === "image" ? { height: Math.max(180, t.layout.h) } : undefined}
                        >
                          <TileBoundary
                            label={t.title ?? t.metrics.join(", ")}
                            onError={(message) => onReadiness(t.id, { status: "error", message })}
                          >
                            <Tile
                              model={model}
                              spec={t}
                              locked
                              presentation
                              queryContext={queryContext}
                              crossFilters={[...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])]}
                              drill={drills[t.id]}
                              scopeWarnings={scopeWarnings[t.id]}
                              onReadiness={onReadiness}
                              onRemove={() => {}}
                            />
                          </TileBoundary>
                        </div>
                      )}
                      {query && lineage && (
                        <>
                          <div className="report-chart-context">
                            <p>
                              {query.dimensions.length
                                ? query.dimensions
                                    .map((d) => {
                                      const [grain] = d.split(":");
                                      return d.includes(":")
                                        ? `${grain[0].toUpperCase()}${grain.slice(1)} periods`
                                        : d.split(".").at(-1)!.replace(/_/g, " ");
                                    })
                                    .join(" · ")
                                : "Aggregate · no breakdown"}
                              {check?.window
                                ? ` · Returned bucket dates: ${check.window.start} to ${check.window.end}`
                                : ""}
                            </p>
                            {query.where.length > 0 && (
                              <ul aria-label="Chart filters">
                                {query.where.map((f, i) => (
                                  <li key={`${f.id}:${i}`}>{describeFilter(f)}</li>
                                ))}
                              </ul>
                            )}
                            {!!check?.rowRules?.length && <p>Access rules applied: {check.rowRules.join(", ")}.</p>}
                            {!!scopeWarnings[t.id]?.length && (
                              <p className="err">Not filtered by {scopeWarnings[t.id].join(", ")}</p>
                            )}
                            {chartNotes.length > 0 && (
                              <ul className="report-finding-summary" aria-label="Data notes for this chart">
                                {chartNotes.map((note) => (
                                  <li
                                    key={note.number}
                                    className={isScopeNote(note.finding) ? "report-scope-summary" : undefined}
                                  >
                                    <a
                                      href={`#${noteId(note.number)}`}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        document.getElementById(noteId(note.number))?.focus();
                                      }}
                                    >
                                      Data note {note.number}: {findingTitle(note.finding, model)}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <details className="report-evidence-drawer">
                            <summary className="report-evidence-summary">
                              <span>ⓘ Supporting Evidence &amp; SQL Lineage</span>
                              <span className="report-evidence-meta">
                                {t.metrics.length} governed {t.metrics.length === 1 ? "metric" : "metrics"}
                                {lineage.joins.length > 0
                                  ? ` · ${lineage.joins.length} verified ${lineage.joins.length === 1 ? "join" : "joins"}`
                                  : ""}
                              </span>
                            </summary>
                            <div className="report-lineage-body">
                              <p>
                                <strong>Governed metrics:</strong>{" "}
                                <code className="mono">
                                  {lineage.metrics.map((m) => `${m.id} (${m.formula})`).join(", ")}
                                </code>
                              </p>
                              {lineage.tables.length > 0 && (
                                <p>
                                  <strong>Tables:</strong>{" "}
                                  <code className="mono">{lineage.tables.join(", ")}</code>
                                </p>
                              )}
                              {lineage.joins.length > 0 && (
                                <p>
                                  <strong>Verified joins:</strong>{" "}
                                  <code className="mono">{lineage.joins.join(" · ")}</code>
                                </p>
                              )}
                              <pre className="sql-preview mono">
                                <code>{lineage.sql}</code>
                              </pre>
                            </div>
                          </details>
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      {!!notes.length && (
        <aside className="report-section-notes" aria-label="Presentation data notes">
          <h3>Data notes</h3>
          {notes.map((note) => (
            <section
              id={noteId(note.number)}
              key={note.number}
              tabIndex={-1}
              aria-label={`Data note ${note.number}: ${findingTitle(note.finding, model)}`}
            >
              <p className="report-note-charts">
                <strong>{note.number}.</strong> {note.charts.map((chart) => chart.title).join(" · ")}
              </p>
              {note.independentScopes && (
                <p className="report-note-charts">
                  This note applies separately to each chart listed. Each chart retains its own reporting window and filters.
                </p>
              )}
              <DataFindings findings={[note.finding]} model={model} compact />
            </section>
          ))}
        </aside>
      )}
      {spec.tiles.length > 0 && (
        <footer className="report-broadside-colophon">
          <BroadsideHygieneProvenance hygieneNotes={model.hygieneNotes} />
          <span>
            Model: {model.name} ({friendlySource})
          </span>
          {effectiveDigest ? (
            <span
              className="report-colophon-digest"
              title={`Full SHA-256 snapshot digest: ${effectiveDigest} (checks content integrity, not analytical correctness)`}
            >
              Snapshot checksum · <code className="mono">sha256: {effectiveDigest.slice(0, 12)}…</code>
            </span>
          ) : (
            <span>Snapshot integrity · Computing checksum…</span>
          )}
          <span>
            Governed evidence: {spec.tiles.filter((t) => (t.kind ?? "metric") === "metric").length} chart tiles ·{" "}
            {notes.length} scope &amp; honesty notes
          </span>
          {showColophon && (
            <span className="report-colophon-brand">
              Prepared with Semantic Canvas · Open-source governed BI · semanticcanvas.ai
            </span>
          )}
        </footer>
      )}
      {!spec.tiles.length && <p>Add charts or commentary to create a presentation.</p>}
    </div>
  );
}
