import { useCallback, useEffect, useState } from "react";
import { MetricColorProvider } from "../charts/MetricColors.tsx";
import type { DashboardSpec, FilterSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import {
  buildSampleWorkbookPayload,
  SAMPLE_WORKBOOKS,
  type SpreadsheetDetectedJoin,
  type SpreadsheetPreview,
} from "../modeler/spreadsheetTypes.ts";
import type { DrillEntry } from "./drill.ts";
import { validateDashboard } from "./filters.ts";
import { readResponse } from "./http.ts";
import { parseLink } from "./link.ts";
import type { Readiness } from "./readiness.ts";
import { ReportPresentation, type PresentationMode } from "./ReportPresentation.tsx";
import { parseShareLink } from "./shareLink.ts";
import { SpreadsheetJoinsSection } from "./SpreadsheetImport.tsx";

export const SANDBOX_TOUR_STORAGE_KEY = "sc:sandbox-tour-v1";

export type SandboxTourStep = 1 | 2 | 3 | 4;

export interface SandboxTourStepMeta {
  step: SandboxTourStep;
  shortTitle: string;
  description: string;
  ctaLabel: string;
  busyLabel?: string;
}

export const SANDBOX_TOUR_STEPS: readonly SandboxTourStepMeta[] = [
  {
    step: 1,
    shortTitle: "1. Catch Excel Errors",
    description:
      "Inspect a real 2-tab Excel workbook with 3 corporate traps—including a “100% matched” duplicate Store ID that would silently inflate Net Sales by +$160,000.",
    ctaLabel: "Clean Workbook & Build Dashboard →",
    busyLabel: "Cleaning workbook & building dashboard…",
  },
  {
    step: 2,
    shortTitle: "2. Governed Dashboard",
    description:
      "Explore the live governed dashboard in clean Preview mode—click any bar to cross-filter or inspect exact DuckDB SQL lineage with $0 join double-counting.",
    ctaLabel: "Shape into Executive Story →",
  },
  {
    step: 3,
    shortTitle: "3. Executive Story",
    description:
      "Synthesize the exact same governed metrics into a question-led executive narrative—without copying numbers into static slide decks.",
    ctaLabel: "Render Broadside Infographic →",
  },
  {
    step: 4,
    shortTitle: "4. Broadside Poster",
    description:
      "Share a publication-grade Broadside poster whose ruled colophon credits every stripped Grand Total and prevented duplicate-key double-count.",
    ctaLabel: "Unlock Full Sandbox →",
  },
];

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function isSandboxTourCompleted(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(SANDBOX_TOUR_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markSandboxTourCompleted(
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SANDBOX_TOUR_STORAGE_KEY, "done");
  } catch {
    // Storage may be disabled in private browsing; tour still unlocks in memory.
  }
}

export function resetSandboxTourCompleted(
  storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(SANDBOX_TOUR_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors.
  }
}

export function hasIncomingDeepLink(search: string): boolean {
  const link = parseLink(search);
  return Boolean(link.source || link.table || parseShareLink(search));
}

export type PosterQuestAction =
  | "open_current_dash_poster"
  | "open_saas_starter_poster"
  | "build_current_model_poster"
  | "switch_to_saas_poster";

export function canSwitchToSaasSource(
  sources: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  return sources.length === 0 || sources.some((s) => s.id === "duckglue-local" && s.status === "ready");
}

export function starterNeedsSaasSwitch(opts: {
  model: Model | null;
  starterSpec: DashboardSpec;
  activeSourceId: string;
  sources: ReadonlyArray<{ id: string; status: string }>;
}): boolean {
  if (!opts.model) return canSwitchToSaasSource(opts.sources);
  const issues = validateDashboard(opts.model, opts.starterSpec);
  if (issues.length === 0) return false;
  return opts.activeSourceId !== "duckglue-local" && canSwitchToSaasSource(opts.sources);
}

export function resolvePosterQuestAction(opts: {
  hasDashTiles: boolean;
  model: Model | null;
  saasStarterSpec: DashboardSpec | undefined;
  activeSourceId: string;
  sources: ReadonlyArray<{ id: string; status: string }>;
}): PosterQuestAction {
  if (opts.hasDashTiles) return "open_current_dash_poster";
  if (opts.model && opts.saasStarterSpec && validateDashboard(opts.model, opts.saasStarterSpec).length === 0) {
    return "open_saas_starter_poster";
  }
  if (
    opts.model &&
    Object.keys(opts.model.tables).length > 0 &&
    Object.keys(opts.model.metrics).length > 0
  ) {
    return "build_current_model_poster";
  }
  return "switch_to_saas_poster";
}

export function shouldAutoStartSandboxTour(opts: {
  sandboxMode: boolean;
  hasDeepLink: boolean;
  storage?: Pick<Storage, "getItem"> | null;
}): boolean {
  if (!opts.sandboxMode || opts.hasDeepLink) return false;
  return !isSandboxTourCompleted(opts.storage === undefined ? defaultStorage() : opts.storage);
}

export function DashboardModeBar({
  canEdit,
  locked,
  hasTiles,
  dashId,
  revision,
  handoff,
  handoffMode,
  aiRedesign,
  hygieneNotes,
  onSelectDashboardView,
  onOpenStory,
  onOpenInfographic,
  onOpenRedesign,
  onOpenHistory,
  onSetLocked,
}: {
  canEdit: boolean;
  locked: boolean;
  hasTiles: boolean;
  dashId: string | null;
  revision: number;
  handoff: boolean;
  handoffMode: PresentationMode;
  aiRedesign: boolean;
  hygieneNotes?: string[];
  onSelectDashboardView: () => void;
  onOpenStory: () => void;
  onOpenInfographic: () => void;
  onOpenRedesign: () => void;
  onOpenHistory: () => void;
  onSetLocked: (locked: boolean) => void;
}) {
  const hygieneCount = hygieneNotes?.length ?? 0;

  if (locked) {
    return (
      <div className="document-state-bar preview" aria-label="Dashboard mode">
        <span className="mode-label">{!canEdit ? "VIEWER" : "PREVIEW"}</span>
        <div className="journey-bar preview-views" role="group" aria-label="Presentation view">
          <button
            type="button"
            className="journey-step"
            aria-pressed={!handoff}
            onClick={onSelectDashboardView}
          >
            Dashboard
          </button>
          <button
            type="button"
            className="journey-step"
            disabled={!hasTiles}
            aria-pressed={handoff && handoffMode === "story"}
            onClick={onOpenStory}
          >
            Executive Story
          </button>
          <button
            type="button"
            className="journey-step"
            disabled={!hasTiles}
            aria-pressed={handoff && handoffMode === "infographic"}
            onClick={onOpenInfographic}
          >
            Broadside Infographic
          </button>
        </div>
        {dashId && (
          <span className="state-version">
            <strong>{`Saved version ${revision}`}</strong> · Preview does not publish
          </span>
        )}
        {hygieneCount > 0 && (
          <button
            type="button"
            className="hygiene-provenance-pill"
            title={hygieneNotes!.join("\n")}
            onClick={onOpenInfographic}
          >
            ✓ {hygieneCount} {hygieneCount === 1 ? "data fix" : "data fixes"} verified
          </button>
        )}
        <span className="spacer" />
        {dashId && (
          <button
            type="button"
            title="Browse and restore saved dashboard designs"
            onClick={onOpenHistory}
          >
            Version history
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="edit-canvas-cta"
            aria-label="Edit dashboard"
            title="Unlock canvas to add, resize, or redesign tiles"
            onClick={() => onSetLocked(false)}
          >
            ✎ Edit Canvas
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="document-state-bar" aria-label="Dashboard mode">
      <span className="mode-label">{!canEdit ? "VIEWER" : "EDIT MODE"}</span>
      <div className="journey-bar" role="group" aria-label="End-to-end analytics journey">
        {canEdit && (
          <button
            type="button"
            className="journey-step"
            disabled={!hasTiles}
            aria-pressed={aiRedesign}
            title="Open the before/after AI & deterministic redesign studio"
            onClick={onOpenRedesign}
          >
            <span className="journey-num">1</span>
            Improve &amp; Arrange
          </button>
        )}
        <button
          type="button"
          className="journey-step"
          disabled={!hasTiles}
          aria-pressed={handoff && handoffMode === "story"}
          title="Open the question-led Executive Story view with supporting evidence"
          onClick={onOpenStory}
        >
          <span className="journey-num">2</span>
          Executive Story
        </button>
        <button
          type="button"
          className="journey-step"
          disabled={!hasTiles}
          aria-pressed={handoff && handoffMode === "infographic"}
          title="Open the Broadside Infographic poster view with vector SVG export"
          onClick={onOpenInfographic}
        >
          <span className="journey-num">3</span>
          Broadside Infographic
        </button>
      </div>
      <span className="state-version">
        <strong>{dashId ? `Saved version ${revision}` : "Not saved yet"}</strong>
      </span>
      {hygieneCount > 0 && (
        <button
          type="button"
          className="hygiene-provenance-pill"
          title={hygieneNotes!.join("\n")}
          onClick={onOpenInfographic}
        >
          ✓ {hygieneCount} {hygieneCount === 1 ? "data fix" : "data fixes"} verified
        </button>
      )}
      <span className="spacer" />
      <button
        disabled={!dashId}
        title={!dashId ? "Save once to start version history" : "Browse and restore saved dashboard designs"}
        onClick={onOpenHistory}
      >
        Version history
      </button>
      {canEdit && (
        <div className="mode-switch" aria-label="Dashboard viewing mode">
          <button
            aria-label="Edit dashboard"
            aria-pressed={!locked}
            onClick={() => onSetLocked(false)}
          >
            Edit
          </button>
          <button
            aria-label="Preview dashboard"
            aria-pressed={locked}
            onClick={() => onSetLocked(true)}
          >
            Preview
          </button>
        </div>
      )}
    </div>
  );
}

export function SandboxTourBar({
  step,
  hasDashboard,
  busy = false,
  onSelectStep,
  onBack,
  onNext,
  onSkip,
}: {
  step: SandboxTourStep;
  hasDashboard: boolean;
  busy?: boolean;
  onSelectStep: (target: SandboxTourStep) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const current = SANDBOX_TOUR_STEPS.find((s) => s.step === step) ?? SANDBOX_TOUR_STEPS[0];

  return (
    <header className="sandbox-tour-bar" role="region" aria-label="Interactive sandbox walkthrough">
      <div className="sandbox-tour-top">
        <span className="sandbox-tour-eyebrow">SEMANTIC CANVAS · INTERACTIVE WALKTHROUGH</span>
        <nav className="sandbox-tour-track" aria-label="Walkthrough steps">
          {SANDBOX_TOUR_STEPS.map((item) => {
            const isCurrent = item.step === step;
            const isDone = item.step < step;
            const canJump = item.step === 1 || hasDashboard;
            return (
              <button
                key={item.step}
                type="button"
                className={`sandbox-tour-step-pill${isCurrent ? " active" : isDone ? " done" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                disabled={busy || !canJump}
                onClick={() => onSelectStep(item.step)}
              >
                {isDone ? "✓ " : ""}
                {item.shortTitle}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          className="link sandbox-tour-skip"
          disabled={busy}
          onClick={onSkip}
        >
          Skip to open sandbox →
        </button>
      </div>
      <div className="sandbox-tour-bottom">
        <p className="sandbox-tour-desc">{current.description}</p>
        <div className="sandbox-tour-actions">
          {step > 1 && (
            <button
              type="button"
              className="review-action"
              disabled={busy}
              onClick={onBack}
            >
              ← Back
            </button>
          )}
          <button
            type="button"
            className="primary sandbox-tour-cta"
            disabled={busy}
            onClick={onNext}
          >
            {busy ? (current.busyLabel ?? "Loading…") : current.ctaLabel}
          </button>
        </div>
      </div>
    </header>
  );
}

export function SandboxTourStepOne({
  initialPreview = null,
  busy = false,
  onBuildDashboard,
}: {
  initialPreview?: SpreadsheetPreview | null;
  busy?: boolean;
  onBuildDashboard: () => void;
}) {
  const roasteryMeta = SAMPLE_WORKBOOKS.find((w) => w.id === "roastery-2tab-xlsx") ?? SAMPLE_WORKBOOKS[1];
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(initialPreview);
  const [joins, setJoins] = useState<SpreadsheetDetectedJoin[]>(initialPreview?.detectedJoins ?? []);
  const [loadingPreview, setLoadingPreview] = useState(initialPreview === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPreview) return;
    let cancelled = false;
    setLoadingPreview(true);
    setError(null);
    buildSampleWorkbookPayload("roastery-2tab-xlsx")
      .then((built) =>
        fetch("/api/modeler/spreadsheet/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fileName: built.fileName,
            format: built.format,
            content: built.content,
          }),
        }).then(readResponse),
      )
      .then((data: SpreadsheetPreview) => {
        if (cancelled) return;
        setPreview(data);
        setJoins(data.detectedJoins ?? []);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? "Could not load sample Excel preview.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialPreview]);

  const downloadRawWorkbook = async () => {
    try {
      const built = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
      const bin = atob(built.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = built.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // Ignore download failure in restricted environments.
    }
  };

  return (
    <section className="sandbox-tour-stage" aria-label="Step 1: Catch hidden Excel errors">
      <div className="sandbox-tour-hero">
        <div>
          <span className="broadside-eyebrow">STEP 1 OF 4 · HONESTY MADE VISIBLE</span>
          <h1>Most BI tools silently chart bad spreadsheet joins. Semantic Canvas catches them up front.</h1>
          <p className="sandbox-tour-sub">
            Pre-loaded real 2-tab Excel workbook:{" "}
            <code className="mono">{roasteryMeta.fileName}</code> (<strong>Cafe Orders</strong> +{" "}
            <strong>Store Directory</strong>)
          </p>
        </div>
        <button
          type="button"
          className="review-action"
          onClick={() => void downloadRawWorkbook()}
        >
          ⬇ Download raw .xlsx
        </button>
      </div>

      <div className="sandbox-tour-columns">
        <article className="sandbox-tour-card raw-card" aria-label="Raw 2-Tab Excel Export (3 Hidden Traps)">
          <div className="sandbox-tour-card-head">
            <span className="tour-card-kicker warn">RAW 2-TAB EXCEL EXPORT · 3 HIDDEN TRAPS</span>
            <h2>What was dropped in from Finance &amp; CRM</h2>
          </div>

          <ol className="sandbox-trap-list">
            <li>
              <strong>Trap 1 · Leading corporate title banner (Tab 1, Row 1)</strong>
              <p>
                <code className="mono">&quot;BLUEBIRD POS EXPORT — Q2–Q3 2026 (UNAUDITED)&quot;</code> sits above the
                true column headers, breaking column type detection in naive CSV/Excel loaders.
              </p>
            </li>
            <li>
              <strong>Trap 2 · Embedded Grand Total summary row (Tab 1, Row 36)</strong>
              <p>
                <code className="mono">Grand Total | $528,200 | 85,130 | $101,090</code> — importing this row alongside
                the 33 POS orders doubles every <code className="mono">SUM(Net Sales)</code> chart to{" "}
                <strong>$1,056,400</strong>.
              </p>
            </li>
            <li>
              <strong>Trap 3 · “100% matched” duplicate Store ID fan-out (Tab 2, Rows 2 &amp; 7)</strong>
              <p>
                <code className="mono">STR-101</code> (Seattle · Reserve Roastery Bar) appears{" "}
                <strong>twice</strong> in <code className="mono">Store Directory</code>. Every order still matches a
                key (“100% matched”), silently multiplying Seattle sales 2× from{" "}
                <strong>$528,200 → $688,200 (+$160,000 double-count)</strong>.
              </p>
            </li>
          </ol>

          <div className="sandbox-raw-snippet">
            <span className="mono muted sm">Raw cells inside {roasteryMeta.fileName}:</span>
            <pre className="mono">{roasteryMeta.rawSnippet.join("\n")}</pre>
          </div>
        </article>

        <article
          className="sandbox-tour-card clean-card"
          aria-label="What Semantic Canvas Caught Automatically"
        >
          <div className="sandbox-tour-card-head">
            <span className="tour-card-kicker ok">WHAT SEMANTIC CANVAS CAUGHT AUTOMATICALLY</span>
            <h2>Cleaned, N:1 verified &amp; governed in DuckDB</h2>
          </div>

          {loadingPreview && (
            <p className="conn-meta" role="status">
              Inspecting 2-sheet Excel workbook in DuckDB…
            </p>
          )}
          {error && (
            <p className="conn-err" role="alert">
              {error}
            </p>
          )}

          {preview && (
            <>
              {preview.cleaningNotes && preview.cleaningNotes.length > 0 && (
                <div className="sheet-cleaning-banner" role="status">
                  <div>
                    <strong>✨ Auto-cleaned 3 spreadsheet traps:</strong>{" "}
                    <span>{preview.cleaningNotes.join(" · ")}</span>
                  </div>
                </div>
              )}

              <SpreadsheetJoinsSection
                joins={joins}
                sheets={preview.sheets ?? null}
                onChange={setJoins}
              />

              <div className="sandbox-governed-summary" aria-label="Governed semantic model preview">
                <div className="sandbox-governed-head">
                  <strong>Governed Semantic Layer Ready</strong>
                  <span className="mono muted sm">
                    {preview.rowCount} clean orders · 5 unique stores · N:1 verified
                  </span>
                </div>
                <div className="sandbox-governed-pills">
                  <span className="sandbox-metric-pill hero">📈 Net Sales ($) · SUM (Hero)</span>
                  <span className="sandbox-metric-pill">📈 Cups Sold · SUM</span>
                  <span className="sandbox-metric-pill">📈 Bean Cost ($) · SUM</span>
                  <span className="sandbox-metric-pill dim">🏷️ Store Directory · City, Region, Format</span>
                </div>
              </div>
            </>
          )}

          <div className="sandbox-tour-stage-footer">
            <span className="muted sm">
              Next: build the clean governed dashboard in Preview mode ($528.2k true Net Sales, $0 fan-out).
            </span>
            <button
              type="button"
              className="primary sandbox-tour-cta"
              disabled={busy}
              onClick={onBuildDashboard}
            >
              {busy ? "Cleaning workbook & building dashboard…" : "Clean Workbook & Build Dashboard →"}
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export function SandboxTourPresentationStage({
  mode,
  spec,
  model,
  queryContext,
  filtersByTile,
  scopeWarnings,
  drills,
}: {
  mode: "story" | "infographic";
  spec: DashboardSpec;
  model: Model;
  queryContext: string;
  filtersByTile: Record<string, FilterSpec[]>;
  scopeWarnings: Record<string, string[]>;
  drills: Record<string, DrillEntry[]>;
}) {
  const [checks, setChecks] = useState<Record<string, Readiness>>({});
  const record = useCallback(
    (id: string, value: Readiness) =>
      setChecks((before) =>
        JSON.stringify(before[id]) === JSON.stringify(value) ? before : { ...before, [id]: value },
      ),
    [],
  );
  const label = mode === "infographic" ? "Broadside Infographic" : "Executive Story";

  return (
    <div className="sandbox-tour-presentation-wrap" aria-label={`Guided ${label}`}>
      <article className={`report-document report-${mode}`} aria-label={`${label} presentation`}>
        <header className="report-cover doc-head">
          <span className="eyebrow">Semantic Canvas · {label}</span>
          <h1>{spec.title}</h1>
          <div className="report-masthead-pills">
            <span className="masthead-pill">Partial periods hatched</span>
            <span
              className="masthead-pill"
              title="SHA-256 checks content integrity, not analytical correctness or authorship."
            >
              Snapshot with integrity checksum (SHA-256)
            </span>
            {model.hygieneNotes && model.hygieneNotes.length > 0 && (
              <span
                className="hygiene-provenance-pill static"
                title={model.hygieneNotes.join("\n")}
              >
                ✓ {model.hygieneNotes.length} {model.hygieneNotes.length === 1 ? "data fix" : "data fixes"} verified
              </span>
            )}
          </div>
          <p className="report-model">
            Model: {model.name} ({model.source}) · Governed live DuckDB metrics
          </p>
        </header>
        <MetricColorProvider tiles={spec.tiles}>
          <ReportPresentation
            key={mode}
            mode={mode}
            spec={spec}
            model={model}
            queryContext={queryContext}
            filtersByTile={filtersByTile}
            scopeWarnings={scopeWarnings}
            drills={drills}
            checks={checks}
            onReadiness={record}
          />
        </MetricColorProvider>
      </article>
    </div>
  );
}
