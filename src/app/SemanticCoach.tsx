import { useMemo, useState, type FormEvent } from "react";
import {
  COACH_CATEGORIES,
  COACH_PRESET_QUESTIONS,
  coachSemanticModel,
  type AnalysisGoal,
  type CoachingFinding,
  type SemanticCoachReport,
} from "../semantic/coach.ts";
import {
  convertSemanticLayer,
  exportSemanticModel,
  SEMANTIC_FORMATS,
  translateSnippetToFormat,
  type SemanticLayerFormat,
} from "../semantic/convert.ts";
import type { Model } from "../semantic/model.ts";
import { StudioDialog } from "./StudioDialog.tsx";

const GOAL_TABS: { id: AnalysisGoal; label: string }[] = [
  { id: "all", label: "All Recommendations" },
  ...COACH_CATEGORIES.map((c) => ({ id: c.id as AnalysisGoal, label: c.label })),
];

export function SemanticCoachPanel({
  model,
  sourceId,
  sandboxMode = false,
  onChanged,
}: {
  model: Model;
  sourceId?: string;
  sandboxMode?: boolean;
  onChanged?: () => void;
}) {
  const [goal, setGoal] = useState<AnalysisGoal>("all");
  const [selectedFormat, setSelectedFormat] = useState<SemanticLayerFormat>("duckglue");
  const [questionInput, setQuestionInput] = useState("");
  const [evaluatedQuestion, setEvaluatedQuestion] = useState("");
  const [serverReport, setServerReport] = useState<SemanticCoachReport | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
  const [proposedSuccess, setProposedSuccess] = useState<Record<string, string>>({});
  const [proposeError, setProposeError] = useState<Record<string, string>>({});

  // Convert & Export Full Model drawer state
  const [converterOpen, setConverterOpen] = useState(false);
  const [targetFormat, setTargetFormat] = useState<SemanticLayerFormat>("snowflake");
  const [sourceFormat, setSourceFormat] = useState<SemanticLayerFormat | "auto">("auto");
  const [externalInput, setExternalInput] = useState("");
  const [conversionResult, setConversionResult] = useState<{
    filename: string;
    content: string;
    summary: { tables: number; metrics: number; joins: number; notes: string[] };
  } | null>(null);
  const [conversionError, setConversionError] = useState("");
  const [converting, setConverting] = useState(false);

  const activeFormatSpec =
    SEMANTIC_FORMATS.find((f) => f.id === selectedFormat) ?? SEMANTIC_FORMATS[0];

  const localReport = useMemo(
    () =>
      coachSemanticModel(model, {
        goal,
        ...(evaluatedQuestion.trim() ? { question: evaluatedQuestion.trim() } : {}),
      }),
    [model, goal, evaluatedQuestion],
  );

  const report = useMemo(() => {
    if (!serverReport || serverReport.modelName !== model.name) return localReport;
    const findings =
      goal === "all"
        ? localReport.findings
        : localReport.findings.filter((f) => f.category === goal);
    return {
      ...serverReport,
      overallScore: localReport.overallScore,
      categoryScores: localReport.categoryScores,
      summary: localReport.summary,
      strengths: localReport.strengths,
      findings,
      questionAnalysis: localReport.questionAnalysis ?? serverReport.questionAnalysis,
    };
  }, [localReport, serverReport, model.name, goal]);

  const runEvaluation = async (qText: string) => {
    const trimmed = qText.trim();
    setQuestionInput(qText);
    setEvaluatedQuestion(trimmed);
    setEvaluating(true);
    try {
      const r = await fetch("/api/model/coach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, question: trimmed || undefined }),
      });
      if (r.ok) {
        const json = (await r.json()) as SemanticCoachReport;
        if (json && typeof json.overallScore === "number") {
          setServerReport(json);
        }
      }
    } catch {
      // Local deterministic evaluation in localReport is already up to date.
    } finally {
      setEvaluating(false);
    }
  };

  const handleQuestionSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runEvaluation(questionInput);
  };

  const copyYaml = (id: string, snippet: string) => {
    void navigator.clipboard?.writeText(snippet);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
    }, 2000);
  };

  const handleExportActiveModel = async (fmt: SemanticLayerFormat = targetFormat) => {
    setConverting(true);
    setConversionError("");
    try {
      const r = await fetch(`/api/model/export?format=${encodeURIComponent(fmt)}`);
      if (r.ok) {
        const json = await r.json();
        setConversionResult({
          filename: json.filename,
          content: json.content,
          summary: json.summary,
        });
        return;
      }
      const localExport = exportSemanticModel(model, fmt);
      setConversionResult(localExport);
    } catch {
      const localExport = exportSemanticModel(model, fmt);
      setConversionResult(localExport);
    } finally {
      setConverting(false);
    }
  };

  const handleConvertExternal = async () => {
    setConverting(true);
    setConversionError("");
    try {
      if (!externalInput.trim()) {
        await handleExportActiveModel(targetFormat);
        return;
      }
      const r = await fetch("/api/model/convert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetFormat,
          sourceFormat,
          content: externalInput,
        }),
      });
      if (r.ok) {
        const json = await r.json();
        setConversionResult({
          filename: json.filename,
          content: json.content,
          summary: json.summary,
        });
        return;
      }
      const localConverted = convertSemanticLayer({
        content: externalInput,
        sourceFormat,
        model,
        targetFormat,
      });
      setConversionResult(localConverted);
    } catch (err: any) {
      try {
        const localConverted = convertSemanticLayer({
          content: externalInput,
          sourceFormat,
          model,
          targetFormat,
        });
        setConversionResult(localConverted);
      } catch (innerErr: any) {
        setConversionError(String(innerErr?.message ?? err?.message ?? "Could not convert semantic definition."));
      }
    } finally {
      setConverting(false);
    }
  };

  const downloadConvertedFile = () => {
    if (!conversionResult) return;
    const blob = new Blob([conversionResult.content], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = conversionResult.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const proposeInRegistry = async (finding: CoachingFinding) => {
    if (!finding.proposedMetric || !sourceId || proposingId) return;
    setProposingId(finding.id);
    setProposeError((prev) => ({ ...prev, [finding.id]: "" }));
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(finding.proposedMetric),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg =
          (Array.isArray(body.problems) && body.problems[0]) ||
          body.error ||
          "Could not propose metric.";
        setProposeError((prev) => ({ ...prev, [finding.id]: String(msg) }));
        return;
      }
      setProposedSuccess((prev) => ({
        ...prev,
        [finding.id]: finding.proposedMetric!.label,
      }));
      onChanged?.();
    } catch (err: any) {
      setProposeError((prev) => ({
        ...prev,
        [finding.id]: String(err?.message ?? err),
      }));
    } finally {
      setProposingId(null);
    }
  };

  const questionSnippet = report.questionAnalysis?.suggestedYaml
    ? report.questionAnalysis.snippetsByFormat?.[selectedFormat] ??
      translateSnippetToFormat(report.questionAnalysis.suggestedYaml, selectedFormat)
    : undefined;

  return (
    <section className="semantic-coach-panel ins-sec" aria-label="Semantic Layer Coach">
      <div className="coach-header">
        <div>
          <div className="eyebrow">Semantic Layer Coach & Multi-Dialect Converter</div>
          <h3>
            Heuristic Readiness Score: <strong>{report.overallScore}/100</strong>
          </h3>
          <p className="muted sm">{report.summary}</p>
          <p className="muted sm">
            Structural heuristic based on declared fields and joins — run a query to validate against warehouse data; not a quality certification.
          </p>
        </div>
        <div className="story-actions">
          <button
            type="button"
            className={`tgl small${converterOpen ? " on" : ""}`}
            onClick={() => {
              const next = !converterOpen;
              setConverterOpen(next);
              if (next && !conversionResult) {
                void handleExportActiveModel(targetFormat);
              }
            }}
          >
            {converterOpen ? "Hide Dialect Converter" : "Convert & Export Full Model"}
          </button>
        </div>
      </div>

      <div
        className="coach-dialect-bar ins-sec"
        role="group"
        aria-label="Semantic Layer Dialect Switcher"
      >
        <div className="mrow-top">
          <span className="sm">
            <b>Recipe Dialect:</b> {activeFormatSpec.label} (<code>{activeFormatSpec.filename}</code>)
          </span>
          <span className="muted sm">{activeFormatSpec.description}</span>
        </div>
        <div className="coach-preset-chips">
          {SEMANTIC_FORMATS.map((fmt) => (
            <button
              key={fmt.id}
              type="button"
              className={`tgl small${selectedFormat === fmt.id ? " on" : ""}`}
              onClick={() => setSelectedFormat(fmt.id)}
            >
              {fmt.label}
            </button>
          ))}
        </div>
      </div>

      {converterOpen && (
        <div className="coach-converter-drawer ins-sec" role="region" aria-label="Convert & Export Full Model">
          <div className="mrow-top">
            <b>Universal Multi-Dialect Semantic Layer Converter</b>
            <span className="active-badge modeler-status">5 Dialects</span>
          </div>
          <p className="muted sm">
            Export the active governed model into Snowflake Cortex Analyst, dbt MetricFlow, AWS Glue Data Catalog, Cube, or DuckGlue YAML — or paste an external semantic definition to translate between dialects.
          </p>
          <div className="ex-tools">
            <label className="ctl">
              <span>Target Dialect</span>
              <select
                value={targetFormat}
                onChange={(e) => {
                  const fmt = e.target.value as SemanticLayerFormat;
                  setTargetFormat(fmt);
                  if (!externalInput.trim()) {
                    void handleExportActiveModel(fmt);
                  }
                }}
              >
                {SEMANTIC_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({f.filename})
                  </option>
                ))}
              </select>
            </label>
            <label className="ctl">
              <span>Source Dialect (for pasted YAML/JSON)</span>
              <select
                value={sourceFormat}
                onChange={(e) => setSourceFormat(e.target.value as SemanticLayerFormat | "auto")}
              >
                <option value="auto">Auto-detect dialect</option>
                {SEMANTIC_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="ctl">
            <span>Optional: Paste external YAML or JSON to convert (leave blank to export active model)</span>
            <textarea
              className="txt mono"
              rows={4}
              value={externalInput}
              placeholder="Paste DuckGlue, Snowflake Cortex Analyst, dbt MetricFlow, AWS Glue, or Cube YAML/JSON…"
              onChange={(e) => setExternalInput(e.target.value)}
            />
          </label>
          <div className="story-actions">
            <button
              type="button"
              className="primary small"
              disabled={converting}
              onClick={() => void handleExportActiveModel(targetFormat)}
            >
              {converting ? "Exporting…" : "Export active model"}
            </button>
            <button
              type="button"
              className="tgl small"
              disabled={converting}
              onClick={() => void handleConvertExternal()}
            >
              Convert dialect
            </button>
            {conversionResult && (
              <>
                <button
                  type="button"
                  className="tgl small"
                  onClick={() => copyYaml("converted-full-model", conversionResult.content)}
                >
                  {copiedId === "converted-full-model" ? "Copied!" : `Copy ${conversionResult.filename}`}
                </button>
                <button type="button" className="tgl small" onClick={downloadConvertedFile}>
                  Download {conversionResult.filename}
                </button>
              </>
            )}
          </div>
          {conversionError && (
            <p className="conn-err sm" role="alert">
              {conversionError}
            </p>
          )}
          {conversionResult && (
            <div className="coach-yaml-block">
              <div className="mrow-top">
                <span className="mono sm">
                  {conversionResult.filename} · {conversionResult.summary.tables} tables ·{" "}
                  {conversionResult.summary.metrics} metrics · {conversionResult.summary.joins} joins
                </span>
              </div>
              <pre className="expr mono">{conversionResult.content}</pre>
            </div>
          )}
        </div>
      )}

      <div className="coach-category-pills" role="list" aria-label="Category readiness scores">
        {COACH_CATEGORIES.map((cat) => {
          const score = report.categoryScores[cat.id];
          const active = goal === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              role="listitem"
              className={`tgl coach-score-pill${active ? " on" : ""}`}
              onClick={() => setGoal(active ? "all" : cat.id)}
              title={`Filter findings by ${cat.label}`}
            >
              <span>{cat.label}</span>
              <strong> · {score}/100</strong>
            </button>
          );
        })}
      </div>

      {report.strengths.length > 0 && (
        <ul className="coach-strengths muted sm">
          {report.strengths.map((s) => (
            <li key={s}>✓ {s}</li>
          ))}
        </ul>
      )}

      <form className="cform coach-question-form" onSubmit={handleQuestionSubmit}>
        <label className="ctl">
          <span>Ask the Coach: What analysis do you want to run?</span>
          <div className="ex-tools">
            <input
              type="text"
              className="txt"
              value={questionInput}
              placeholder="e.g. Revenue per order by customer segment over time"
              onChange={(e) => setQuestionInput(e.target.value)}
            />
            <button type="submit" className="primary small" disabled={evaluating}>
              {evaluating ? "Evaluating…" : "Evaluate analysis"}
            </button>
          </div>
        </label>
        <div className="coach-preset-chips">
          {COACH_PRESET_QUESTIONS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="tgl small"
              onClick={() => void runEvaluation(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
      </form>

      {report.questionAnalysis && (
        <div className="coach-question-result ins-sec" role="region" aria-label="Question coaching diagnosis">
          <div className="mrow-top">
            <b>
              {report.questionAnalysis.canAnswerNow
                ? "✓ Model appears to support this question (validate with a live query)"
                : "Coaching needed to unlock this analysis"}
            </b>
            <span className={`active-badge ${report.questionAnalysis.canAnswerNow ? "modeler-status" : "warn"}`}>
              {report.questionAnalysis.canAnswerNow ? "Ready to test" : "Needs model update"}
            </span>
          </div>
          <p className="muted sm">
            Overall model completeness heuristic: <b>{report.overallScore}/100</b> (covers all tables in the workspace, not just this question — validate with a live warehouse query; not a quality certification).
          </p>
          <p className="sm">
            <b>Question:</b> “{report.questionAnalysis.question}”
          </p>
          <div className="sm muted">
            <span>
              Matched metrics:{" "}
              {report.questionAnalysis.matchedMetrics.length
                ? report.questionAnalysis.matchedMetrics.join(", ")
                : "none"}
            </span>
            {" · "}
            <span>
              Matched dimensions:{" "}
              {report.questionAnalysis.matchedDimensions.length
                ? report.questionAnalysis.matchedDimensions.join(", ")
                : "none"}
            </span>
            {" · "}
            <span>
              Matched tables:{" "}
              {report.questionAnalysis.matchedTables.length
                ? report.questionAnalysis.matchedTables.join(", ")
                : "none"}
            </span>
          </div>
          <ul className="coach-steps">
            {report.questionAnalysis.coachingSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
          {questionSnippet && (
            <div className="coach-yaml-block">
              <div className="mrow-top">
                <span className="mono sm">
                  Suggested {activeFormatSpec.filename} recipe ({activeFormatSpec.label})
                </span>
                <button
                  type="button"
                  className="tgl small"
                  onClick={() => copyYaml("question-yaml", questionSnippet)}
                >
                  {copiedId === "question-yaml" ? "Copied!" : "Copy YAML"}
                </button>
              </div>
              <pre className="expr mono">{questionSnippet}</pre>
            </div>
          )}
        </div>
      )}

      <div className="coach-goal-tabs" role="tablist" aria-label="Filter coaching findings by goal">
        {GOAL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={goal === tab.id}
            className={`tgl small${goal === tab.id ? " on" : ""}`}
            onClick={() => setGoal(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {goal === "cohorts_and_cumulative" && (
        <p className="muted sm">
          True cohort analysis requires grouping by an acquisition/signup period dimension alongside retention or activity measures (a trailing cumulative total alone only measures rolling volume, not cohort retention).
        </p>
      )}

      <div className="mlist coach-findings-list">
        {report.findings.map((finding) => {
          const displayedSnippet =
            finding.snippetsByFormat?.[selectedFormat] ??
            translateSnippetToFormat(finding.yamlSnippet, selectedFormat);
          return (
            <div key={finding.id} className="mrow coach-finding-card">
              <div className="mrow-top">
                <span className={`active-badge ${finding.priority === "high" ? "warn" : "modeler-status"}`}>
                  {finding.priority}
                </span>
                <b>{finding.title}</b>
                <code className="metric-id mono">{finding.target}</code>
              </div>
              <p>{finding.whyItMatters}</p>
              <p className="sm">
                <b>Recommendation:</b> {finding.recommendation}
              </p>
              <div className="coach-yaml-block">
                <pre className="expr mono">{displayedSnippet}</pre>
                <div className="story-actions">
                  <button
                    type="button"
                    className="tgl small"
                    onClick={() => copyYaml(finding.id, displayedSnippet)}
                  >
                    {copiedId === finding.id ? "Copied!" : `Copy ${activeFormatSpec.label}`}
                  </button>
                  {finding.proposedMetric && sourceId && (
                    sandboxMode ? (
                      <span className="muted sm">Self-host to customize model</span>
                    ) : (
                      <button
                        type="button"
                        className="primary small"
                        disabled={proposingId === finding.id || Boolean(proposedSuccess[finding.id])}
                        onClick={() => void proposeInRegistry(finding)}
                      >
                        {proposedSuccess[finding.id]
                          ? `Proposed “${proposedSuccess[finding.id]}”`
                          : proposingId === finding.id
                            ? "Proposing…"
                            : "Propose metric in Registry"}
                      </button>
                    )
                  )}
                </div>
                {proposeError[finding.id] && (
                  <p className="conn-err sm" role="alert">
                    {proposeError[finding.id]}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {report.findings.length === 0 && (
          <div className="empty">
            No structural coaching findings for this goal — model appears to support these checks (validate with a live query against warehouse data).
          </div>
        )}
      </div>
    </section>
  );
}

export function SemanticCoachDialog({
  model,
  sourceId,
  sandboxMode = false,
  onChanged,
  onClose,
}: {
  model: Model;
  sourceId?: string;
  sandboxMode?: boolean;
  onChanged?: () => void;
  onClose: () => void;
}) {
  return (
    <StudioDialog title="Semantic Layer Coach" wide onClose={onClose}>
      <SemanticCoachPanel model={model} sourceId={sourceId} sandboxMode={sandboxMode} onChanged={onChanged} />
    </StudioDialog>
  );
}
