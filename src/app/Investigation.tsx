import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { numericValue } from "../charts/values.ts";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { makeFormatter, resolveFormat } from "../format/format.ts";
import { humanDimensionName } from "../suggest/drivers.ts";
import {
  defaultDetailViews,
  describeFilter,
  formatPeriodHuman,
  humanSegmentLabel,
  investigationContext,
  investigationOptions,
  rankStorySubdetails,
  storyArcsForOptions,
  type InvestigationOption,
  type InvestigationResult,
  type StoryArc,
} from "../suggest/investigate.ts";
import type { Model } from "../semantic/model.ts";
import type { DrillEntry } from "./drill.ts";
import { readResponse } from "./http.ts";
import type { Readiness } from "./readiness.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";

type DetailConfiguration = NonNullable<TileSpec["detailDashboard"]>;

interface DriverSummary {
  priorHuman: string;
  latestHuman: string;
  badges: Record<string, string>;
  topMover: {
    dimension: string;
    label: string;
    segment: string;
    summaryLine: string;
  } | null;
}

function normalizeConfiguration(raw: DetailConfiguration): DetailConfiguration {
  const cleanSubtitle = raw.subtitle?.trim();
  return {
    title: raw.title.trim(),
    ...(cleanSubtitle ? { subtitle: cleanSubtitle } : {}),
    views: raw.views,
    layout: raw.layout,
  };
}

function stepBackPeriod(isoDate: string, grain = "month"): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (grain === "day" || grain === "week") dt.setUTCDate(dt.getUTCDate() - (grain === "day" ? 1 : 7));
  else if (grain === "month" || grain === "quarter") dt.setUTCMonth(dt.getUTCMonth() - (grain === "month" ? 1 : 3));
  else if (grain === "year") dt.setUTCFullYear(dt.getUTCFullYear() - 1);
  return dt.toISOString().slice(0, 10);
}

export function Investigation({
  source,
  result,
  model,
  filters,
  drill,
  queryContext,
  scopeWarnings,
  canKeep,
  aiAvailable,
  initialMode,
  modeSeq = 0,
  setupChanged,
  dirtyDashboard,
  savingDashboard,
  onSaveDashboard,
  onConfigure,
  onKeep,
  onClose,
}: {
  source: TileSpec;
  result: InvestigationResult;
  model: Model;
  filters: FilterSpec[];
  drill: DrillEntry[];
  queryContext: string;
  aiAvailable?: boolean;
  initialMode?: "configure" | "smart";
  modeSeq?: number;
  setupChanged?: boolean;
  dirtyDashboard?: boolean;
  savingDashboard?: boolean;
  onSaveDashboard?: () => Promise<void>;
  onConfigure: (configuration: DetailConfiguration) => void;
  scopeWarnings: string[];
  canKeep: boolean;
  onKeep: (tile: TileSpec) => void;
  onClose: () => void;
}) {
  const smartPanelId = useId();
  const smartBtnRef = useRef<HTMLButtonElement>(null);
  const customizeBtnRef = useRef<HTMLButtonElement>(null);
  const filterSig = JSON.stringify(filters);
  const drillSig = JSON.stringify(drill);

  const plan = useMemo(() => {
    try {
      const context = investigationContext(model, source, filters, drill, result);
      return { context, options: investigationOptions(model, source, context), error: "" };
    } catch (e: any) {
      return { context: null, options: [], error: e.message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, source, filterSig, drillSig, result]);

  const sourceTitle = source.title ?? source.metrics.join(", ");
  const propInitial: DetailConfiguration = useMemo(
    () =>
      source.detailDashboard ?? {
        title: `${sourceTitle} details`.slice(0, 120),
        views: defaultDetailViews(plan.options),
        layout: "grid",
      },
    [source.detailDashboard, sourceTitle, plan.options],
  );

  // Optimistic activeConfig prevents rapid multi-clicks from dropping views before parent re-render.
  const [activeConfig, setActiveConfig] = useState<DetailConfiguration>(propInitial);
  const [editing, setEditing] = useState(initialMode === "configure" && canKeep);
  const [smartOpen, setSmartOpen] = useState(initialMode === "smart" && canKeep);
  const [showAllSubdetails, setShowAllSubdetails] = useState(false);
  const [draft, setDraft] = useState<DetailConfiguration>(propInitial);
  const [driversState, setDriversState] = useState<"idle" | "loading" | "ready">("idle");
  const [driverSummary, setDriverSummary] = useState<DriverSummary | null>(null);
  const [saveError, setSaveError] = useState("");

  const propInitialKey = JSON.stringify(propInitial);
  useEffect(() => {
    setActiveConfig(propInitial);
    if (!editing) setDraft(propInitial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propInitialKey]);

  const handledModeSeq = useRef(modeSeq);
  useEffect(() => {
    if (modeSeq === handledModeSeq.current) return;
    handledModeSeq.current = modeSeq;
    if (!canKeep) return;
    if (initialMode === "configure") {
      setSmartOpen(false);
      setDraft(activeConfig);
      setEditing(true);
    } else if (initialMode === "smart") {
      setEditing(false);
      setSmartOpen(true);
    }
  }, [modeSeq, initialMode, canKeep, activeConfig]);

  const displayed = editing ? draft : activeConfig;

  const fmtSpec = useMemo(() => resolveFormat(model, source), [model, source]);
  const fmtMetric = useMemo(() => makeFormatter(fmtSpec), [fmtSpec]);
  const isPercentMetric = fmtSpec.number === "percent";

  const formatDeltaValue = useCallback(
    (deltaVal: number) => {
      const sign = deltaVal >= 0 ? "+" : "−";
      if (isPercentMetric) {
        return `${sign}${(Math.abs(deltaVal) * 100).toFixed(1)} pp`;
      }
      return `${sign}${fmtMetric(Math.abs(deltaVal))}`;
    },
    [fmtMetric, isPercentMetric],
  );

  // Deterministic factual headline summary from the already-returned result rows.
  const factualTakeaway = useMemo(() => {
    if (!plan.context?.dateEnd || source.metrics.length !== 1) return "";
    const mIdx = result.columns.indexOf(source.metrics[0]);
    if (mIdx < 0 || !result.rows.length) return "";
    const latestVal = numericValue(result.rows.at(-1)?.[mIdx]);
    if (latestVal === null) return "";
    const latestHuman = formatPeriodHuman(plan.context.dateEnd, plan.context.grain);
    const prevVal = result.rows.length >= 2 ? numericValue(result.rows.at(-2)?.[mIdx]) : null;
    if (prevVal !== null) {
      return `${latestHuman} stood at ${fmtMetric(latestVal)} (${formatDeltaValue(latestVal - prevVal)} vs. prior period).`;
    }
    return `${latestHuman} stood at ${fmtMetric(latestVal)}.`;
  }, [plan.context, source.metrics, result, fmtMetric, formatDeltaValue]);

  // Deterministic live movement attribution (zero AI tokens) when Smart Story Builder opens.
  useEffect(() => {
    if (
      !smartOpen ||
      source.metrics.length !== 1 ||
      !plan.context?.latestWindow ||
      plan.context.where.some((f) => f.source === "metric")
    ) {
      return;
    }
    const ac = new AbortController();
    setDriversState("loading");
    const timeDim = plan.context.query.dimensions.find((d) => d.includes(":"));
    const grain = plan.context.grain ?? "month";
    const hasExplicitMin = plan.context.where.some(
      (f) => f.id !== "investigation:window" && f.min != null && f.field.endsWith(plan.context!.latestWindow!.field.split(".").at(-1)!),
    );
    const driverWhere = plan.context.where.map((f) =>
      f.id === "investigation:window" && plan.context!.dateStart === plan.context!.dateEnd && !hasExplicitMin
        ? { ...f, min: stepBackPeriod(String(f.min), grain) }
        : f,
    );

    fetch("/api/query/drivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        metric: source.metrics[0],
        timeDimension: timeDim,
        where: driverWhere,
        maxDimensions: 10,
        topN: 2,
      }),
    })
      .then(readResponse)
      .then((res: any) => {
        if (ac.signal.aborted) return;
        const expectedLatest = String(plan.context?.latestWindow?.min ?? "");
        if (expectedLatest && String(res?.latestPeriod ?? "") !== expectedLatest) {
          setDriversState("idle");
          return;
        }
        const additive = Boolean(res?.additive);
        const netDelta = Number(res?.delta ?? 0);
        const netDeltaText = formatDeltaValue(netDelta);
        const badges: Record<string, string> = {};
        let best: (NonNullable<DriverSummary["topMover"]> & { rankScore: number }) | null = null;

        for (const dim of Array.isArray(res?.dimensions) ? res.dimensions : []) {
          const dimField = String(dim.dimension ?? "");
          const isBoolDim = /(^|\.)is_/i.test(dimField);
          const colName = dimField.split(".").at(-1) ?? dimField;
          const humanDim = humanDimensionName(colName);
          const top = Array.isArray(dim.topDrivers) ? dim.topDrivers[0] : Array.isArray(dim.segments) ? dim.segments[0] : null;
          if (!top || typeof top.contribution !== "number" || !Number.isFinite(top.contribution) || top.contribution === 0) continue;

          const segLabel = humanSegmentLabel(String(top.value ?? top.segment ?? ""), dimField);
          const signedDelta = formatDeltaValue(top.contribution);
          const rawShare = Number(top.share ?? 0);
          const cleanAdditiveShare =
            additive &&
            netDelta !== 0 &&
            Math.sign(top.contribution) === Math.sign(netDelta) &&
            Math.abs(rawShare) > 0 &&
            Math.abs(rawShare) <= 1;

          if (cleanAdditiveShare) {
            const pct = Math.round(Math.abs(rawShare) * 100);
            badges[dimField] = `Top mover: ${segLabel} (${signedDelta} · ${pct}% of net shift)`;
          } else if (additive) {
            badges[dimField] = `Largest swing: ${segLabel} (${signedDelta})`;
          } else {
            badges[dimField] = `Largest shift: ${segLabel} (${signedDelta})`;
          }

          const summaryLine = cleanAdditiveShare
            ? `Largest shift by ${humanDim}: ${segLabel} moved ${signedDelta} (${Math.round(Math.abs(rawShare) * 100)}% of ${netDeltaText} net shift).`
            : additive && netDelta !== 0
              ? `Largest swing by ${humanDim}: ${segLabel} moved ${signedDelta} (vs. ${netDeltaText} net shift; partially offset by other segments).`
              : `Largest segment shift by ${humanDim}: ${segLabel} moved ${signedDelta}.`;

          const rankScore = Math.abs(top.contribution) * (isBoolDim ? 0.15 : 1);
          if (!best || rankScore > best.rankScore) {
            best = {
              dimension: dimField,
              label: humanDim,
              segment: segLabel,
              summaryLine,
              rankScore,
            };
          }
        }

        setDriverSummary({
          priorHuman: formatPeriodHuman(String(res?.priorPeriod ?? ""), grain),
          latestHuman: formatPeriodHuman(String(res?.latestPeriod ?? ""), grain),
          badges,
          topMover: best
            ? {
                dimension: best.dimension,
                label: best.label,
                segment: best.segment,
                summaryLine: best.summaryLine,
              }
            : null,
        });
        setDriversState("ready");
      })
      .catch(() => {
        if (!ac.signal.aborted) setDriversState("idle");
      });

    return () => ac.abort();
  }, [smartOpen, source.metrics, plan.context, queryContext, formatDeltaValue]);

  const rankedSubdetails = useMemo(
    () => rankStorySubdetails(plan.options, displayed.views, driverSummary?.badges ?? {}),
    [plan.options, displayed.views, driverSummary],
  );
  const storyArcs = useMemo(
    () => storyArcsForOptions(sourceTitle, plan.options, driverSummary?.topMover?.dimension, factualTakeaway),
    [sourceTitle, plan.options, driverSummary?.topMover?.dimension, factualTakeaway],
  );

  const slotsRemaining = Math.max(0, 6 - displayed.views.length);
  const unaddedCount = Math.min(
    slotsRemaining,
    plan.options.filter((o) => !displayed.views.includes(o.id)).length,
  );
  const unaddedBridges = plan.options.filter((o) => o.role === "bridge" && !displayed.views.includes(o.id));

  // Only show the top-mover quick-add button when NO active view already breaks down that dimension.
  const moverAlreadyShown = Boolean(
    driverSummary?.topMover &&
      plan.options.some(
        (o) => o.dimensionField === driverSummary.topMover!.dimension && displayed.views.includes(o.id),
      ),
  );
  const topMoverViewOption =
    driverSummary?.topMover && !moverAlreadyShown
      ? plan.options.find(
          (o) =>
            o.dimensionField === driverSummary.topMover!.dimension &&
            (o.role === "mix" || o.role === "bridge"),
        ) ?? plan.options.find((o) => o.dimensionField === driverSummary.topMover!.dimension)
      : undefined;

  const commitSmartUpdate = (updater: (prev: DetailConfiguration) => DetailConfiguration) => {
    setActiveConfig((prev) => {
      const normalized = normalizeConfiguration(updater(prev));
      setDraft(normalized);
      onConfigure(normalized);
      return normalized;
    });
  };

  const toggleSubdetail = (optionId: string) => {
    commitSmartUpdate((prev) => {
      const exists = prev.views.includes(optionId);
      if (exists) {
        if (prev.views.length <= 1) return prev;
        return { ...prev, views: prev.views.filter((v) => v !== optionId) };
      }
      if (prev.views.length >= 6) return prev;
      return { ...prev, views: [...prev.views, optionId] };
    });
  };

  const applyArc = (arc: StoryArc) => {
    commitSmartUpdate(() => ({
      title: arc.title,
      subtitle: arc.subtitle,
      layout: arc.layout,
      views: arc.views,
    }));
    setSmartOpen(false);
    requestAnimationFrame(() => smartBtnRef.current?.focus({ preventScroll: true }));
  };

  const handleSaveMain = async () => {
    if (!onSaveDashboard) return;
    setSaveError("");
    try {
      await onSaveDashboard();
    } catch (e: any) {
      setSaveError(e?.message ?? "Could not save the dashboard.");
    }
  };

  const handleEscape = useCallback(() => {
    if (smartOpen) {
      setSmartOpen(false);
      requestAnimationFrame(() => smartBtnRef.current?.focus({ preventScroll: true }));
      return true;
    }
    if (editing) {
      setDraft(activeConfig);
      setEditing(false);
      requestAnimationFrame(() => customizeBtnRef.current?.focus({ preventScroll: true }));
      return true;
    }
    return false;
  }, [smartOpen, editing, activeConfig]);

  const move = (index: number, delta: number) =>
    setDraft((current) => {
      const views = [...current.views];
      [views[index], views[index + delta]] = [views[index + delta], views[index]];
      return { ...current, views };
    });

  const visibleSuggestions = showAllSubdetails ? rankedSubdetails : rankedSubdetails.slice(0, 6);

  const userFilters = useMemo(
    () => (plan.context?.where ?? []).filter((f) => !f.id.startsWith("investigation:")),
    [plan.context],
  );
  const humanScopeSummary = useMemo(() => {
    if (!plan.context) return "";
    const periodPart =
      plan.context.dateStart && plan.context.dateEnd
        ? `${plan.context.grain ? plan.context.grain[0].toUpperCase() + plan.context.grain.slice(1) : "Period"} · ${formatPeriodHuman(plan.context.dateStart, plan.context.grain)} – ${formatPeriodHuman(plan.context.dateEnd, plan.context.grain)}`
        : "Aggregate scope";
    const filterPart = userFilters.length
      ? `${userFilters.length} active ${userFilters.length === 1 ? "filter" : "filters"}`
      : "All segments in scope";
    return `${periodPart} · ${filterPart}`;
  }, [plan.context, userFilters]);

  return (
    <StudioDialog title="Detail dashboard" onClose={onClose} onEscape={handleEscape} className="detail-dashboard-dialog">
      <div className="detail-dashboard-scroll">
        <header className="detail-dashboard-heading">
          <div className="detail-heading-copy">
            <span className="eyebrow">{editing ? "Set up the click experience" : "A closer look"}</span>
            <h2>{displayed.title}</h2>
            {displayed.subtitle && <p className="detail-story-subtitle">{displayed.subtitle}</p>}
            <p className="detail-origin-line">
              From <strong>{sourceTitle}</strong>
              {humanScopeSummary ? ` · ${humanScopeSummary}` : ""}
            </p>
          </div>
          {!editing && canKeep && (
            <div className="detail-heading-actions">
              {plan.options.length > 1 && (
                <button
                  ref={smartBtnRef}
                  type="button"
                  className={"smart-subdetails-btn" + (smartOpen ? " active" : "")}
                  aria-expanded={smartOpen}
                  aria-controls={smartOpen ? smartPanelId : undefined}
                  onClick={() => setSmartOpen((v) => !v)}
                >
                  <span aria-hidden="true">✦</span>
                  <span>Smart-add story details</span>
                  {unaddedCount > 0 && <span className="smart-subdetails-count">{unaddedCount}</span>}
                </button>
              )}
              <button
                ref={customizeBtnRef}
                type="button"
                className="review-action"
                onClick={() => {
                  setSmartOpen(false);
                  setDraft(activeConfig);
                  setEditing(true);
                }}
              >
                Customize this dashboard
              </button>
            </div>
          )}
        </header>

        {setupChanged && !editing && (
          <p className="detail-unsaved" role="status">
            {dirtyDashboard === false
              ? "Detail dashboard saved with your main dashboard."
              : onSaveDashboard
                ? "Setup applied to your draft. Save below or on the main dashboard to keep it."
                : "Setup applied to your draft. Close this popup and save the main dashboard to keep it."}
          </p>
        )}

        {saveError && (
          <p role="alert" className="err">
            Save failed: {saveError}
          </p>
        )}

        {plan.error && (
          <p role="alert" className="err">
            {plan.error}
          </p>
        )}

        {smartOpen && !editing && canKeep && (
          <section id={smartPanelId} className="smart-subdetails-panel" aria-label="Smart story subdetails">
            <div className="smart-panel-header">
              <div>
                <span className="eyebrow">STORY BUILDER</span>
                <h3>Add breakdowns &amp; supporting views</h3>
              </div>
              <div className="smart-panel-meta">
                <span className="smart-slot-pill">{displayed.views.length} of 6 views shown</span>
                <button
                  type="button"
                  className="review-action"
                  onClick={() => {
                    setSmartOpen(false);
                    requestAnimationFrame(() => smartBtnRef.current?.focus({ preventScroll: true }));
                  }}
                >
                  Done
                </button>
              </div>
            </div>

            {driversState === "loading" && (
              <p className="smart-signal-banner is-loading" role="status">
                Checking period-over-period segment shifts…
              </p>
            )}

            {driverSummary?.topMover && (
              <div className="smart-signal-banner" role="region" aria-label="What moved most">
                <div className="smart-signal-copy">
                  <span className="eyebrow">
                    WHAT MOVED MOST · {driverSummary.priorHuman} → {driverSummary.latestHuman}
                  </span>
                  <p>{driverSummary.topMover.summaryLine}</p>
                </div>
                {topMoverViewOption && displayed.views.length < 6 && (
                  <button
                    type="button"
                    className="primary small"
                    onClick={() => toggleSubdetail(topMoverViewOption.id)}
                  >
                    + Add {driverSummary.topMover.label.toLowerCase()} view
                  </button>
                )}
              </div>
            )}

            {!driverSummary?.topMover && driversState !== "loading" && unaddedBridges.length > 0 && (
              <div className="smart-signal-banner" role="region" aria-label="Available revenue bridges">
                <div className="smart-signal-copy">
                  <span className="eyebrow">AVAILABLE REVENUE BRIDGES</span>
                  <p>
                    {unaddedBridges.length} additional movement {unaddedBridges.length === 1 ? "slice is" : "slices are"} ready for {sourceTitle}:{" "}
                    <strong>{unaddedBridges.map((b) => b.label).join(" · ")}</strong>.
                  </p>
                </div>
                {displayed.views.length < 6 && (
                  <button
                    type="button"
                    className="primary small"
                    onClick={() => toggleSubdetail(unaddedBridges[0].id)}
                  >
                    + Add {unaddedBridges[0].label}
                  </button>
                )}
              </div>
            )}

            {storyArcs.length > 0 && (
              <div className="smart-arcs-section">
                <div className="smart-section-label">1-Click Story Arcs</div>
                <div className="story-arcs-grid" role="group" aria-label="One-click story arcs">
                  {storyArcs.map((arc) => {
                    const activeArc =
                      displayed.layout === arc.layout &&
                      JSON.stringify(displayed.views) === JSON.stringify(arc.views);
                    return (
                      <button
                        key={arc.id}
                        type="button"
                        className={"story-arc-card" + (activeArc ? " is-active" : "")}
                        aria-pressed={activeArc}
                        onClick={() => applyArc(arc)}
                      >
                        <div className="story-arc-top">
                          <span className="story-arc-audience">{arc.audience}</span>
                          <span className="story-arc-meta">
                            {arc.views.length} views · {arc.layout === "focus" ? "Lead chart" : "Grid"}
                          </span>
                        </div>
                        <strong>{arc.label}</strong>
                        <span>{arc.description}</span>
                        <em className="story-arc-cta">{activeArc ? "✓ Active story arc" : "Apply preset →"}</em>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="smart-subdetails-section">
              <div className="smart-section-label">Add or Remove Individual Views</div>
              <div className="smart-subdetails-grid" role="list" aria-label="Recommended story subdetails">
                {visibleSuggestions.map((item) => {
                  const full = !item.active && displayed.views.length >= 6;
                  const lastRemaining = item.active && displayed.views.length <= 1;
                  return (
                    <div
                      key={item.option.id}
                      role="listitem"
                      className={"smart-subdetail-card" + (item.active ? " is-active" : "")}
                    >
                      <div className="smart-subdetail-badges">
                        <span className="smart-subdetail-kicker">{item.option.kicker}</span>
                        <span className="smart-subdetail-chart">{item.option.chartLabel}</span>
                      </div>
                      {item.driverBadge && (
                        <div className="smart-driver-pill">
                          <span aria-hidden="true">★</span> {item.driverBadge}
                        </div>
                      )}
                      <div className="smart-subdetail-row">
                        <div className="smart-subdetail-text">
                          <h4>{item.option.label}</h4>
                          <p>{item.option.question}</p>
                        </div>
                        <button
                          type="button"
                          className={"subdetail-toggle-btn" + (item.active ? " is-active" : "")}
                          disabled={full || lastRemaining}
                          aria-label={
                            item.active
                              ? `Remove ${item.option.label} from detail dashboard`
                              : `Add ${item.option.label} to detail dashboard`
                          }
                          onClick={() => toggleSubdetail(item.option.id)}
                        >
                          {item.active ? "✓ Added" : full ? "6/6 full" : "+ Add view"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {rankedSubdetails.length > 6 && (
                <button
                  type="button"
                  className="link smart-more-btn"
                  onClick={() => setShowAllSubdetails((v) => !v)}
                >
                  {showAllSubdetails
                    ? "Show top 6 recommendations"
                    : `Browse all ${rankedSubdetails.length} views (${rankedSubdetails.length - 6} more)`}
                </button>
              )}
            </div>
          </section>
        )}

        {editing && (
          <section className="detail-dashboard-setup" aria-label="Detail dashboard setup">
            <div className="detail-setup-fields">
              <label>
                Dashboard title
                <input
                  className="txt"
                  maxLength={120}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </label>
              <label>
                Layout
                <select
                  aria-label="Detail dashboard layout"
                  className="txt"
                  value={draft.layout}
                  onChange={(e) => setDraft({ ...draft, layout: e.target.value as DetailConfiguration["layout"] })}
                >
                  <option value="grid">Side by side</option>
                  <option value="focus">Lead with one large chart</option>
                </select>
              </label>
            </div>
            <label className="detail-story-note-field">
              Executive takeaway (optional)
              <input
                aria-label="Story takeaway"
                className="txt"
                maxLength={320}
                placeholder="Optional 1-sentence takeaway shown at the top of this detail dashboard…"
                value={draft.subtitle ?? ""}
                onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
              />
            </label>
            <p>Choose up to six views. The preview below is what opens when someone clicks this chart.</p>
            <div className="detail-view-choices">
              {plan.options.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={draft.views.includes(option.id)}
                    disabled={draft.views.length >= 6 && !draft.views.includes(option.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        views: e.target.checked
                          ? [...draft.views, option.id]
                          : draft.views.filter((id) => id !== option.id),
                      })
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <ol className="detail-view-order" aria-label="Chart order">
              {draft.views.map((id, index) => (
                <li key={id}>
                  <span>{plan.options.find((o) => o.id === id)?.label ?? "Unavailable view"}</span>
                  <button
                    type="button"
                    className="review-action"
                    aria-label={`Move chart ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="review-action"
                    aria-label={`Move chart ${index + 1} down`}
                    disabled={index === draft.views.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="review-action"
                    aria-label={`Remove chart ${index + 1}`}
                    onClick={() => setDraft({ ...draft, views: draft.views.filter((v) => v !== id) })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}

        {!!scopeWarnings.length && (
          <p className="err">
            The original chart was not filtered by {scopeWarnings.join(", ")}. These views keep that scope.
          </p>
        )}

        {plan.context && (
          <details className="detail-dashboard-scope">
            <summary>Reporting period and filters</summary>
            <p>{plan.context.period}</p>
            {plan.context.where.map((f, i) => (
              <p key={`${f.id}:${i}`}>{describeFilter(f)}</p>
            ))}
            <p>
              Waterfalls and latest-period breakdowns use the latest displayed period. Trends and comparisons retain the original reporting window.
            </p>
          </details>
        )}

        {displayed.views.length === 0 && <p role="status">Choose a view to start your detail dashboard.</p>}

        <div className={`detail-dashboard-grid ${displayed.layout}`} aria-label="Detail dashboard charts">
          {displayed.views.map((id, index) => {
            const option = plan.options.find((o) => o.id === id);
            return option ? (
              <DetailCard
                key={id}
                option={option}
                model={model}
                queryContext={queryContext}
                aiAvailable={aiAvailable}
                headline={option.tile.chart === "kpi"}
                lead={
                  index ===
                  displayed.views.findIndex((view) => plan.options.find((o) => o.id === view)?.tile.chart !== "kpi")
                }
                onKeep={
                  canKeep && !editing && plan.context
                    ? () =>
                        onKeep({
                          ...option.tile,
                          evidence: {
                            sourceTileId: source.id,
                            sourceTitle,
                            question: option.label,
                            period: option.period ?? plan.context!.period,
                            capturedAt: new Date().toISOString(),
                            note: [
                              option.reason,
                              scopeWarnings.length ? `Not filtered by ${scopeWarnings.join(", ")}.` : "",
                            ]
                              .filter(Boolean)
                              .join(" "),
                          },
                        })
                    : undefined
                }
              />
            ) : (
              <section key={id} className="detail-dashboard-card" aria-label="View unavailable in this scope">
                <h3>View unavailable in this scope</h3>
                <p>This configured view cannot run with the current metric or filters. Its scope has not been widened.</p>
              </section>
            );
          })}
        </div>
      </div>

      <footer>
        {editing ? (
          <>
            <span className="muted sm">Saved with the main dashboard. Current filters apply when opened.</span>
            <span className="spacer" />
            <button
              type="button"
              className="detail-cancel"
              onClick={() => {
                setDraft(activeConfig);
                setEditing(false);
                requestAnimationFrame(() => customizeBtnRef.current?.focus({ preventScroll: true }));
              }}
            >
              Cancel setup
            </button>
            <button
              type="button"
              className="primary"
              disabled={!draft.title.trim() || !draft.views.length || !canKeep}
              onClick={() => {
                const normalized = normalizeConfiguration(draft);
                setActiveConfig(normalized);
                onConfigure(normalized);
                setEditing(false);
                requestAnimationFrame(() => customizeBtnRef.current?.focus({ preventScroll: true }));
              }}
            >
              Apply setup
            </button>
          </>
        ) : (
          <>
            <span className="muted sm">
              {displayed.views.length} related {displayed.views.length === 1 ? "view" : "views"}
              {aiAvailable ? " · AI explanations run only on click" : ""}
            </span>
            <span className="spacer" />
            {setupChanged && dirtyDashboard && onSaveDashboard && (
              <button
                type="button"
                className="detail-cancel"
                disabled={savingDashboard}
                onClick={() => {
                  void handleSaveMain();
                }}
              >
                {savingDashboard ? "Saving…" : "Save to dashboard"}
              </button>
            )}
            <button type="button" className="primary" onClick={onClose}>
              Back to dashboard
            </button>
          </>
        )}
      </footer>
    </StudioDialog>
  );
}

function DetailCard({
  option,
  model,
  queryContext,
  aiAvailable,
  headline,
  lead,
  onKeep,
}: {
  option: InvestigationOption;
  model: Model;
  queryContext: string;
  aiAvailable?: boolean;
  headline: boolean;
  lead: boolean;
  onKeep?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Readiness>({ status: "checking" });
  const record = useCallback(
    (_id: string, value: Readiness) =>
      setStatus((before) => (JSON.stringify(before) === JSON.stringify(value) ? before : value)),
    [],
  );
  const latestStart = option.tile.where?.find((f) => f.id === "investigation:latest")?.min;

  return (
    <section
      className={`detail-dashboard-card${headline ? " headline" : ""}${lead ? " lead" : ""}`}
      aria-label={option.label}
    >
      <div className="detail-card-heading">
        <div className="detail-card-titles">
          <span className="detail-card-kicker">{option.kicker}</span>
          <h3>{option.label}</h3>
        </div>
        {onKeep && (
          <button type="button" className="link" disabled={status.status !== "ready"} onClick={onKeep}>
            Add to main dashboard
          </button>
        )}
      </div>
      {option.period && latestStart && (
        <p className="detail-chart-note">
          <strong>
            {new Date(`${latestStart}T00:00:00Z`).toLocaleDateString("en-US", {
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })}
          </strong>{" "}
          · {option.reason.split(" Latest displayed period:")[0]}
        </p>
      )}
      <div className={"detail-chart" + (option.tile.chart === "table" ? " is-table" : "")} key={`${option.id}:${attempt}`}>
        <TileBoundary onError={(message) => record(option.id, { status: "error", message })}>
          <Tile
            spec={option.tile}
            model={model}
            locked
            embedded
            onRemove={() => {}}
            queryContext={`${queryContext}:detail:${attempt}`}
            onReadiness={record}
            aiAvailable={aiAvailable}
            explanationContext={option.reason}
            showExplain={!headline}
          />
        </TileBoundary>
      </div>

      {status.status === "error" && (
        <div role="alert">
          <p>{status.message}</p>
          <button
            type="button"
            className="review-action"
            onClick={() => {
              setStatus({ status: "checking" });
              setAttempt((n) => n + 1);
            }}
          >
            Retry this chart
          </button>
        </div>
      )}
      {status.status === "checking" && (
        <p role="status" className="muted sm">
          Loading chart…
        </p>
      )}
    </section>
  );
}
