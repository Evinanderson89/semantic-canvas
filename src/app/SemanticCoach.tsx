import { useMemo, useState, type FormEvent } from "react";
import {
  COACH_CATEGORIES,
  COACH_PRESET_QUESTIONS,
  coachSemanticModel,
  type AnalysisGoal,
  type CoachingFinding,
  type SemanticCoachReport,
} from "../semantic/coach.ts";
import type { Model } from "../semantic/model.ts";
import { StudioDialog } from "./StudioDialog.tsx";

const GOAL_TABS: { id: AnalysisGoal; label: string }[] = [
  { id: "all", label: "All Recommendations" },
  ...COACH_CATEGORIES.map((c) => ({ id: c.id as AnalysisGoal, label: c.label })),
];

export function SemanticCoachPanel({
  model,
  sourceId,
  onChanged,
}: {
  model: Model;
  sourceId?: string;
  onChanged?: () => void;
}) {
  const [goal, setGoal] = useState<AnalysisGoal>("all");
  const [questionInput, setQuestionInput] = useState("");
  const [evaluatedQuestion, setEvaluatedQuestion] = useState("");
  const [serverReport, setServerReport] = useState<SemanticCoachReport | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
  const [proposedSuccess, setProposedSuccess] = useState<Record<string, string>>({});
  const [proposeError, setProposeError] = useState<Record<string, string>>({});

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
      findings,
      questionAnalysis: serverReport.questionAnalysis ?? localReport.questionAnalysis,
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

  return (
    <section className="semantic-coach-panel ins-sec" aria-label="Semantic Layer Coach">
      <div className="coach-header">
        <div>
          <div className="eyebrow">Semantic Layer Coach & Analysis Readiness Advisor</div>
          <h3>
            Overall Readiness Score: <strong>{report.overallScore}/100</strong>
          </h3>
          <p className="muted sm">{report.summary}</p>
        </div>
      </div>

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
                ? "✓ Ready to answer now"
                : "Coaching needed to unlock this analysis"}
            </b>
            <span className={`active-badge ${report.questionAnalysis.canAnswerNow ? "modeler-status" : "warn"}`}>
              {report.questionAnalysis.canAnswerNow ? "Ready" : "Needs model update"}
            </span>
          </div>
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
          {report.questionAnalysis.suggestedYaml && (
            <div className="coach-yaml-block">
              <div className="mrow-top">
                <span className="mono sm">Suggested model.yaml recipe</span>
                <button
                  type="button"
                  className="tgl small"
                  onClick={() =>
                    copyYaml("question-yaml", report.questionAnalysis!.suggestedYaml!)
                  }
                >
                  {copiedId === "question-yaml" ? "Copied!" : "Copy YAML"}
                </button>
              </div>
              <pre className="expr mono">{report.questionAnalysis.suggestedYaml}</pre>
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

      <div className="mlist coach-findings-list">
        {report.findings.map((finding) => (
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
              <pre className="expr mono">{finding.yamlSnippet}</pre>
              <div className="story-actions">
                <button
                  type="button"
                  className="tgl small"
                  onClick={() => copyYaml(finding.id, finding.yamlSnippet)}
                >
                  {copiedId === finding.id ? "Copied!" : "Copy YAML"}
                </button>
                {finding.proposedMetric && sourceId && (
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
                )}
              </div>
              {proposeError[finding.id] && (
                <p className="conn-err sm" role="alert">
                  {proposeError[finding.id]}
                </p>
              )}
            </div>
          </div>
        ))}
        {report.findings.length === 0 && (
          <div className="empty">
            No coaching findings for this goal — your semantic model is ready!
          </div>
        )}
      </div>
    </section>
  );
}

export function SemanticCoachDialog({
  model,
  sourceId,
  onChanged,
  onClose,
}: {
  model: Model;
  sourceId?: string;
  onChanged?: () => void;
  onClose: () => void;
}) {
  return (
    <StudioDialog title="Semantic Layer Coach" wide onClose={onClose}>
      <SemanticCoachPanel model={model} sourceId={sourceId} onChanged={onChanged} />
    </StudioDialog>
  );
}
