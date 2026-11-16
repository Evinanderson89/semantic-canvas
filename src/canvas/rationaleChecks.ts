import type { DashboardSpec } from "../compiler/spec.ts";
import { proposalTextChanges } from "./documentFacts.ts";
import { proposalMetricChanges } from "./metricChanges.ts";

export interface RationaleIssue {
  id: "prior-description" | "row-count" | "existing-tile-additions";
  message: string;
}

const sentences = (text: string) =>
  text.split(/(?<!\b(?:e\.g|i\.e|vs|cf))[.!?;]\s+|\n+/).map(s => s.trim()).filter(Boolean);
const NEGATED = /\b(no(?! longer\b)|not|never|none|without|lacked|lacks|absent|didn't|hadn't|wasn't)\b/i;
const PRIOR_DESCRIPTION = new RegExp([
  String.raw`\b(prior|previous|existing|old|original|earlier|former|outdated|stale)\b[^.;]{0,60}\bdescription\b`,
  String.raw`\bdescription\b[^.;]{0,40}\b(is|was|were|has been|had been|gets?|got)\s+(replaced|rewritten|updated|corrected|revised|reworded|changed|removed|cleared)\b`,
  String.raw`\b(replac|rewr[io]t|updat|correct|revis|reword)\w*\s+(the\s+)?(dashboard(-wide)?\s+)?description\b`,
].join("|"), "i");
const ROW_COUNT = /\b(\d{1,6})\s+(?:returned\s+)?(?:(?:monthly|weekly|daily|quarterly|yearly|annual|time)\s+)?(?:rows|data points)\b/gi;
const LIMIT_CONTEXT = /\b(limit(ed)?( of| to)?|up to|at most|maximum( of)?|max( of)?|cap(ped)?( of| at)?)\s*$/i;
const NEW_TILES_ONLY = new RegExp([
  String.raw`\b(new|added|additional)\s+metrics?\b[^.;]{0,40}\bonly\b[^.;]{0,30}\bnew\s+(tiles?|charts?|cards?)\b`,
  String.raw`\bonly\s+on\s+new\s+(tiles?|charts?|cards?)\b`,
  String.raw`\bnot\s+add(ed|ing)?\s+(any\s+)?metrics?\s+to\s+(existing|retained)\s+(tiles?|charts?)\b`,
].join("|"), "i");

/**
 * Statements in an AI rationale that calculated facts contradict. This is a
 * narrow lexical check for failures seen in live review: describing wording
 * the dashboard never had, citing a row count no query in the review
 * returned, or claiming metrics were added only on new tiles when existing
 * charts gained metrics. It finds some false statements; passing it verifies
 * nothing. Pass `research` only when the review's query ledger is known (an
 * empty array means no query ran); omit it to skip the row-count check.
 */
export function rationaleIssues(
  before: DashboardSpec,
  after: DashboardSpec,
  reason: string,
  research?: { rowsChecked: number | null }[],
): RationaleIssue[] {
  const issues: RationaleIssue[] = [];
  const description = proposalTextChanges(before, after).dashboardDescription;
  if (description.before === null && sentences(reason).some(s => /\bdescription\b/i.test(s) && PRIOR_DESCRIPTION.test(s) && !NEGATED.test(s)))
    issues.push({ id: "prior-description", message: description.status === "added"
      ? "The rationale refers to an earlier dashboard description, but the dashboard had none. This proposal adds the first description."
      : "The rationale refers to an earlier dashboard description, but the dashboard has none." });
  const existingAdditions = proposalMetricChanges(before, after).additions.filter(a => !a.newTile);
  if (existingAdditions.length > 0 && sentences(reason).some(s => NEW_TILES_ONLY.test(s))) {
    const names = existingAdditions.map(a => a.title || a.id).join(", ");
    issues.push({
      id: "existing-tile-additions",
      message: `The rationale says metrics were added only to new tiles, but existing charts also received added metrics (${names}).`,
    });
  }
  if (research) {
    const returned = new Set(research.map(q => q.rowsChecked).filter((n): n is number => typeof n === "number"));
    const cited = new Set<number>();
    for (const match of reason.matchAll(ROW_COUNT)) {
      if (LIMIT_CONTEXT.test(reason.slice(Math.max(0, match.index - 24), match.index))) continue;
      const count = Number(match[1]);
      if (!returned.has(count)) cited.add(count);
    }
    if (cited.size) issues.push({ id: "row-count", message: `The rationale cites ${[...cited].join(" and ")} rows, but ${returned.size
      ? `the governed queries in this review returned ${[...returned].sort((a, b) => a - b).join(", ")} rows`
      : "no governed query was run in this review"}. A count is verified only for a query that was actually run.` });
  }
  return issues;
}
