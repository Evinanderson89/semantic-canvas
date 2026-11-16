import { createHash } from "node:crypto";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { Model } from "../src/semantic/model.ts";
import { calendarOf, todayOf } from "../src/semantic/model.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { compileTile, splitPartialPeriods } from "../src/compiler/compile.ts";
import { finishResult, resultLimit } from "../src/compiler/result.ts";
import { filtersForTile, validateDashboard } from "../src/app/filters.ts";
import { visibleQuery } from "../src/app/query.ts";
import { chartUnits } from "../src/app/chartResult.ts";
import { redesignImpact } from "../src/app/redesignImpact.ts";
import { chartShapeIssue } from "../src/charts/capabilities.ts";
import { inferChart, tileChartShape } from "../src/suggest/chartRules.ts";
import { demoDashboard } from "../src/suggest/demo.ts";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { checkResultQuality } from "../src/suggest/resultQuality.ts";
import { queryObservations } from "../src/suggest/queryObservations.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { proposalSchema } from "../src/canvas/proposals.ts";
import { narrativeInventory } from "./narrative.ts";

const canvas = { ...DEFAULT_CANVAS, preset: "custom", width: 1120, height: 1000 };
const metric = (id: string, name: string, dimensions: string[] = []): TileSpec => ({
  id, title: name, metrics: [name], dimensions, chart: dimensions.length ? "line" : "stat",
  layout: { x: 24, y: 24, w: 600, h: 300 },
});
const references = [metric("reference-mrr", "ending_mrr", ["month:fct_saas_monthly.month"]),
  metric("reference-nrr", "nrr", ["month:fct_saas_monthly.month"]),
  metric("reference-cac", "cac", ["month:fct_saas_monthly.month"])];

export const redesignCases = [
  {
    id: "messy-executive", spec: demoDashboard(1120), canvas,
    goal: "Improve this rough SaaS dashboard for an executive reviewing growth, retention and acquisition efficiency. Fix unhelpful chart choices and layout, establish a reading order, and preserve the governed definitions. Explain useful changes using queried evidence; do not invent causes.",
    criteria: ["Resolve overlapping and inconsistent tile placement.", "Replace or explain the degenerate New MRR movement-type breakdown.", "Make revenue and retention understandable together, with explicit reporting periods.", "Keep changes focused; explain removals and preserve authored work."],
    references,
  },
  {
    id: "blank-executive", spec: { title: "Synthetic executive review", tiles: [] } as DashboardSpec, canvas,
    goal: "Build an executive SaaS dashboard from this empty canvas. Help leadership assess recurring revenue growth, retention and acquisition efficiency using the available semantic catalog. Choose headline metrics, one leading trend and focused supporting evidence. Distinguish measured changes from questions requiring investigation.",
    criteria: ["Produce a usable first dashboard from an empty document.", "Select governed headline metrics and a trend relevant to the decision.", "Give each section a clear role and readable visual hierarchy.", "Do not add unrelated charts merely to fill the canvas."],
    references,
  },
  {
    id: "scope-and-coverage", spec: { title: "Synthetic sample — revenue trend check", tiles: [
      { ...metric("sample-mrr", "new_mrr"), title: "New MRR", layout: { x: 24, y: 24, w: 420, h: 180 } },
    ] } as DashboardSpec, canvas: { ...canvas, width: 1000, height: 900, grid: 12 },
    goal: "Turn this isolated New MRR total into a useful executive view with a monthly trend and a descriptive heading. Make aggregate and trend reporting scopes explicit. Check query results before writing findings. Do not infer missing source data or a cause from a low month or an excluded edge bucket.",
    criteria: ["Explain that excluded partial edge buckets are absent from the displayed trend.", "Do not label the first returned month partial solely because partial.start is true.", "Do not call an unfiltered scalar the total of displayed months unless the scopes reconcile.", "Captions must describe the actual chart type; unsupported explanations remain questions."],
    references: [metric("reference-total", "new_mrr"), metric("reference-trend", "new_mrr", ["month:movement_date"])],
  },
];
export type RedesignCase = typeof redesignCases[number];
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function requestFor(testCase: RedesignCase) {
  return { conversationId: `evaluation-${testCase.id}`, mode: "redesign", message: testCase.goal,
    document: { spec: testCase.spec, canvas: testCase.canvas, selected: [] },
    review: { goal: testCase.goal, dashboardTitle: testCase.spec.title, decisions: [] } };
}

/** Only used with the checked-in sample lake. This is an unrestricted synthetic
 * baseline, not a substitute for company-mode permission or browser tests. */
export async function queryEvidence(model: Model, connector: Connector, spec: DashboardSpec) {
  const issues = validateDashboard(model, spec);
  if (issues.length) throw new Error(issues.map(i => `${i.tile}: ${i.problem}`).join("; "));
  const evidence = [];
  for (const tile of spec.tiles.filter(t => (t.kind ?? "metric") === "metric")) {
    const query = visibleQuery(model, tile, [...(spec.crossFilters ?? []), ...filtersForTile(spec, tile, {}, todayOf(model), calendarOf(model))]);
    const effective = { ...tile, ...query }, kind = tile.chart ?? inferChart(model, tile);
    try {
      const raw = await connector.execute(compileTile(model, connector, effective, { probe: true }), resultLimit(effective) + 1);
      const { columns, rows, partial } = splitPartialPeriods(raw);
      const result = { ...finishResult({ ...raw, columns, rows }, effective), partial };
      evidence.push({ id: tile.id, title: tile.title, query, result,
        chartIssue: chartShapeIssue(kind, tileChartShape(model, effective)) ?? chartUnits({ ...effective, chart: kind }, model).issue ?? null,
        dataFindings: checkResultQuality(query.metrics, query.dimensions, result),
        observations: queryObservations(model, effective, result),
      });
    } catch (error) {
      evidence.push({ id: tile.id, title: tile.title, query, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return evidence;
}

const overlapPairs = (spec: DashboardSpec) => spec.tiles.flatMap((a, i) => spec.tiles.slice(i + 1)
  .filter(b => (a.tabId ?? "main") === (b.tabId ?? "main") && overlaps(a.layout, b.layout)).map(b => [a.id, b.id]));
export const requiredReviews = [
  "Review every narrativeInventory entry, including retained descriptions, chart titles, presentation briefs and the assistant explanation. Trace factual claims to metric identity, exact returned values, reporting dates and filters; candidate evidence IDs are context, not proof.",
  "Check that uncertainty, missing values, truncation and excluded edge periods are represented honestly.",
  "Reject unsupported causes, annualized rates presented as observed outcomes, and claims of actions not executed.",
  "Inspect the real before/after preview for hierarchy, legibility and useful chart choices; then check Story and Infographic.",
  "Decide whether the result answers the business question and is materially better than the starting dashboard.",
];

export async function assessResponse(testCase: RedesignCase, response: unknown, model: Model, connector: Connector) {
  const captured = response as { proposal?: unknown; text?: string };
  const modelBefore = digest(model), inputBefore = digest(testCase);
  const pendingReview = { status: "required", criteria: [...testCase.criteria, ...requiredReviews], decisions: [] };
  try {
    const after = validateRedesign(testCase.spec, testCase.canvas, captured?.proposal, model);
    const beforeEvidence = await queryEvidence(model, connector, testCase.spec);
    const evidence = await queryEvidence(model, connector, after.spec);
    const failures = evidence.filter(e => "error" in e || e.chartIssue);
    if (modelBefore !== digest(model) || inputBefore !== digest(testCase)) throw new Error("Evaluation mutated its input model or document");
    return { caseId: testCase.id, responseHash: digest(response), modelHash: modelBefore,
      mechanicalStatus: failures.length ? "failed" : "passed", failures,
      qualityVerdict: "not-assessed", review: pendingReview, rendering: "requires-browser-review",
      before: { overlaps: overlapPairs(testCase.spec) }, after: { ...after, overlaps: overlapPairs(after.spec) },
      impact: redesignImpact(testCase.spec, after.spec, model), beforeEvidence, evidence,
      narrativeInventory: narrativeInventory(testCase.spec, after.spec, proposalSchema.parse(captured.proposal), captured.text),
      authoredText: after.spec.tiles.filter(t => ["heading", "text"].includes(t.kind ?? "")).map(t => ({ id: t.id, kind: t.kind, title: t.title, text: t.text })),
    };
  } catch (error) {
    return { caseId: testCase.id, responseHash: digest(response), modelHash: modelBefore,
      mechanicalStatus: "failed", error: error instanceof Error ? error.message : String(error),
      qualityVerdict: "not-assessed", review: pendingReview, rendering: "not-checked" };
  }
}
