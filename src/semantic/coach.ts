import {
  dimensionsOf,
  isLineage,
  isNumeric,
  isTemporal,
  isUnreviewedTable,
  joinedTableOptions,
  joinPath,
  metricsByTable,
  metricType,
  timeColumnOf,
  type Column,
  type Metric,
  type Model,
  type Table,
} from "./model.ts";

export type AnalysisGoal =
  | "all"
  | "time_series"
  | "driver_attribution"
  | "ratios_and_funnels"
  | "cohorts_and_cumulative"
  | "agent_readiness";

export type CoachCategory = Exclude<AnalysisGoal, "all">;

export interface CoachingFinding {
  id: string;
  category: CoachCategory;
  priority: "high" | "medium" | "low";
  title: string;
  target: string;
  whyItMatters: string;
  recommendation: string;
  yamlSnippet: string;
  proposedMetric?: {
    name: string;
    label: string;
    baseTable: string;
    expression: string;
    description: string;
  };
}

export interface QuestionCoaching {
  question: string;
  canAnswerNow: boolean;
  matchedMetrics: string[];
  matchedDimensions: string[];
  matchedTables: string[];
  coachingSteps: string[];
  suggestedYaml?: string;
}

export interface SemanticCoachReport {
  modelName: string;
  overallScore: number;
  categoryScores: Record<CoachCategory, number>;
  summary: string;
  strengths: string[];
  findings: CoachingFinding[];
  questionAnalysis?: QuestionCoaching;
}

export const COACH_CATEGORIES: { id: CoachCategory; label: string; shortLabel: string }[] = [
  { id: "time_series", label: "Time-Series & Honesty", shortLabel: "Time-Series" },
  { id: "driver_attribution", label: "Driver Attribution & Joins", shortLabel: "Drivers & Joins" },
  { id: "ratios_and_funnels", label: "Ratios & Funnels", shortLabel: "Ratios & Funnels" },
  { id: "cohorts_and_cumulative", label: "Cohorts & Cumulative", shortLabel: "Cohorts & Cumulative" },
  { id: "agent_readiness", label: "AI & MCP Readiness", shortLabel: "AI & MCP" },
];

export const COACH_PRESET_QUESTIONS: string[] = [
  "Revenue per order by customer segment over time",
  "Net revenue retention and churn over time",
  "Conversion rate by acquisition channel",
  "Cumulative active users by country and plan tier",
];

const ID_COL_RE = /(^|_)(id|key|code|uuid)$/i;
const TEMPORAL_NAME_RE = /(date|_at$|_on$|time|month|week|day|timestamp)/i;
const CURRENCY_METRIC_RE = /(revenue|mrr|arr|amount|sales|spend|cost|price|gmv|bookings|margin|profit|fee|usd|value)/i;
const COUNT_METRIC_RE = /\bcount\s*\(/i;
const SUM_METRIC_RE = /\bsum\s*\(/i;
const SUBSET_METRIC_RE = /(converted|conversion|paid|paying|active|retained|churn|cancelled|refund|qualified|completed|won|signup|entries)/i;
const RATIO_INTENT_RE = /\b(per|rate|ratio|average|avg|margin|conversion|cvr|nrr|grr|retention|arpu|aov|cac|ltv|roas|share)\b/i;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "over", "from", "into", "what", "how", "why", "who",
  "which", "when", "where", "are", "was", "were", "can", "show", "give", "across",
  "total", "all", "our", "their", "this", "that", "these", "those", "per", "by", "in",
  "on", "of", "to", "vs", "versus", "between", "time", "trend", "monthly", "weekly", "daily",
]);

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if ((w.endsWith("ses") || w.endsWith("xes")) && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

function tableStem(tableName: string): string {
  return tableName.replace(/^(fct|fact|dim|stg|raw|src|int|mart|rpt)_/i, "").toLowerCase();
}

function sanitizeIdentifier(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return (cleaned || "governed_metric").slice(0, 60);
}

function uniqueMetricName(model: Model, desired: string): string {
  const base = sanitizeIdentifier(desired);
  if (!model.metrics[base]) return base;
  let idx = 2;
  while (model.metrics[`${base}_${idx}`]) idx++;
  return `${base}_${idx}`;
}

function resolvedTimeColumnName(model: Model, table: Table): string | null {
  const direct = (table as Table & { timeColumn?: string | null }).timeColumn;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const resolved = timeColumnOf(model, table.name);
  if (resolved) {
    const parts = resolved.split(".");
    return parts[parts.length - 1] || null;
  }
  return null;
}

function hasReportingLag(table: Table): boolean {
  const legacy = (table as Table & { reportingLag?: number | null }).reportingLag;
  return (
    (typeof table.reportingLagDays === "number" && Number.isFinite(table.reportingLagDays)) ||
    (typeof legacy === "number" && Number.isFinite(legacy))
  );
}

function findTemporalCandidateColumn(table: Table): Column | null {
  for (const col of table.columns) {
    if (isLineage(col)) continue;
    if (isTemporal(col)) return col;
  }
  for (const col of table.columns) {
    if (isLineage(col)) continue;
    if (TEMPORAL_NAME_RE.test(col.name)) return col;
  }
  return null;
}

function isCategoricalDimension(table: Table, col: Column): boolean {
  if (isLineage(col)) return false;
  if (col.name === table.primaryKey) return false;
  if (ID_COL_RE.test(col.name)) return false;
  if (isTemporal(col) || isNumeric(col)) return false;
  return true;
}

function matchForeignKeyTarget(
  model: Model,
  leftTable: Table,
  col: Column,
): { rightTable: Table; rightColumn: string } | null {
  if (col.name === leftTable.primaryKey) return null;
  if (!ID_COL_RE.test(col.name)) return null;

  const colLower = col.name.toLowerCase();
  const fkStem = singular(colLower.replace(/_?(id|key|code|uuid)$/i, ""));
  if (!fkStem) return null;

  const otherTables = Object.values(model.tables).filter((t) => t.name !== leftTable.name);

  // 1. Exact primary key match
  const exactPk = otherTables.filter((t) => t.primaryKey?.toLowerCase() === colLower);
  if (exactPk.length > 0) {
    const preferred = exactPk.find((t) => /^dim_/i.test(t.name)) ?? exactPk[0];
    return { rightTable: preferred, rightColumn: preferred.primaryKey ?? col.name };
  }

  // 2. Table stem match (e.g. customer_id -> dim_customers.customer_id or dim_customers.id)
  for (const candidate of otherTables) {
    const tStem = singular(tableStem(candidate.name));
    if (tStem === fkStem) {
      const rightCol =
        candidate.primaryKey ??
        candidate.columns.find((c) => c.name.toLowerCase() === colLower)?.name ??
        candidate.columns.find((c) => /^id$/i.test(c.name))?.name ??
        col.name;
      return { rightTable: candidate, rightColumn: rightCol };
    }
  }

  // 3. Column with same *_id name on a dim_ table
  for (const candidate of otherTables) {
    if (!/^dim_/i.test(candidate.name)) continue;
    const matchCol = candidate.columns.find((c) => c.name.toLowerCase() === colLower);
    if (matchCol) {
      return { rightTable: candidate, rightColumn: matchCol.name };
    }
  }

  return null;
}

export function inferSmartSynonyms(name: string, label: string): string[] {
  const combined = `${name} ${label}`.toLowerCase();
  const out = new Set<string>();
  if (/(revenue|mrr|arr|sales|amount|bookings|gmv)/.test(combined)) {
    out.add("sales");
    out.add("recurring revenue");
    out.add("top line");
  }
  if (/(order|count|event|session|transaction|visit)/.test(combined)) {
    out.add("volume");
    out.add("transactions");
  }
  if (/(customer|user|subscriber|account|signup|member|client)/.test(combined)) {
    out.add("accounts");
    out.add("buyers");
    out.add("logos");
  }
  if (/(churn|cancel|attrition|lost|contraction)/.test(combined)) {
    out.add("attrition");
    out.add("cancellations");
  }
  if (/(retention|nrr|grr|renewal)/.test(combined)) {
    out.add("net dollar retention");
    out.add("cohort retention");
  }
  if (/(conversion|cvr|rate|funnel)/.test(combined)) {
    out.add("conversion rate");
    out.add("funnel efficiency");
  }
  if (/(spend|cost|cac|expense)/.test(combined)) {
    out.add("acquisition cost");
    out.add("paid spend");
  }
  if (out.size === 0) {
    const readable = name.replace(/_/g, " ").trim();
    if (readable) out.add(readable);
    out.add(`${readable || label.toLowerCase()} total`);
    out.add(`${readable || label.toLowerCase()} metric`);
  }
  return [...out].slice(0, 4);
}

function isRatioLikeMetric(m: Metric): boolean {
  return metricType(m) === "ratio" || /\//.test(m.expression);
}

function existingRatioUsesPair(model: Model, num: Metric, den: Metric): boolean {
  for (const m of Object.values(model.metrics)) {
    if (metricType(m) === "ratio") {
      if (
        (m.numerator === num.name && m.denominator === den.name) ||
        (m.numerator === den.name && m.denominator === num.name)
      ) {
        return true;
      }
    }
    if (m.baseTable === num.baseTable && /\//.test(m.expression)) {
      const exprLower = m.expression.toLowerCase();
      const numCol = extractInnerColumn(num.expression);
      const denCol = extractInnerColumn(den.expression);
      if (numCol && denCol && exprLower.includes(numCol.toLowerCase()) && exprLower.includes(denCol.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function extractInnerColumn(expr: string): string | null {
  const m = expr.match(/\(\s*(?:distinct\s+)?([a-zA-Z0-9_.]+)\s*\)/i);
  if (!m) return null;
  const parts = m[1].split(".");
  return parts[parts.length - 1] || null;
}

function buildInlineRatioExpression(num: Metric, den: Metric): string {
  const numExpr = num.filter
    ? `${num.expression} FILTER (WHERE ${num.filter})`
    : num.expression;
  const denExpr = den.filter
    ? `${den.expression} FILTER (WHERE ${den.filter})`
    : den.expression;
  return `${numExpr} / NULLIF(${denExpr}, 0)`;
}

function tokenizeQuestion(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function tokenMatchesText(tokens: string[], targetText: string): boolean {
  const targetTokens = targetText
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const targetStems = new Set(targetTokens.map(singular));
  for (const tok of tokens) {
    const stem = singular(tok);
    if (targetStems.has(stem)) return true;
    for (const tt of targetTokens) {
      if (tt.length >= 3 && stem.length >= 3 && (tt.includes(stem) || stem.includes(tt))) {
        return true;
      }
    }
  }
  return false;
}

function analyzeQuestionAgainstModel(model: Model, rawQuestion: string): QuestionCoaching {
  const question = rawQuestion.trim();
  const qLower = question.toLowerCase();
  const tokens = tokenizeQuestion(question);

  const matchedMetrics: string[] = [];
  const matchedDimensions: string[] = [];
  const matchedTablesSet = new Set<string>();

  // 1. Match metrics by name, label, and synonyms
  for (const m of Object.values(model.metrics)) {
    const phrases = [
      m.name.toLowerCase(),
      m.name.replace(/_/g, " ").toLowerCase(),
      m.label.toLowerCase(),
      ...m.synonyms.map((s) => s.toLowerCase()),
    ];
    const directPhraseMatch = phrases.some((p) => p.length >= 3 && qLower.includes(p));
    const tokenMatch = tokenMatchesText(tokens, `${m.name.replace(/^(total|avg|sum|count)_/i, "")} ${m.label} ${m.synonyms.join(" ")}`);
    if (directPhraseMatch || tokenMatch) {
      matchedMetrics.push(m.name);
      if (m.baseTable && model.tables[m.baseTable]) {
        matchedTablesSet.add(m.baseTable);
      }
    }
  }

  // 2. Match tables by name, stem, and synonyms
  for (const t of Object.values(model.tables)) {
    const stem = tableStem(t.name).replace(/_/g, " ");
    const tableText = `${t.name} ${stem} ${t.synonyms.join(" ")}`;
    if (qLower.includes(t.name.toLowerCase()) || (stem.length >= 3 && qLower.includes(stem)) || tokenMatchesText(tokens, tableText)) {
      matchedTablesSet.add(t.name);
    }
  }

  // 3. Match dimensions and raw numeric columns across tables
  const unmodelledNumericColumns: { table: Table; column: Column }[] = [];
  const allMetricExpressions = Object.values(model.metrics)
    .map((m) => `${m.baseTable}:${m.expression.toLowerCase()}`)
    .join(" ");

  for (const t of Object.values(model.tables)) {
    for (const c of t.columns) {
      if (isLineage(c)) continue;
      if (c.name === t.primaryKey || ID_COL_RE.test(c.name)) continue;

      const colReadable = c.name.replace(/_/g, " ").toLowerCase();
      const colMatches =
        qLower.includes(c.name.toLowerCase()) ||
        (colReadable.length >= 3 && qLower.includes(colReadable)) ||
        tokenMatchesText(tokens, c.name);

      if (!colMatches) continue;

      if (isNumeric(c)) {
        const exprMentioned =
          allMetricExpressions.includes(c.name.toLowerCase()) ||
          Object.values(model.metrics).some(
            (m) => m.baseTable === t.name && tokenMatchesText([c.name], `${m.name} ${m.label}`),
          );
        if (!exprMentioned) {
          unmodelledNumericColumns.push({ table: t, column: c });
          matchedTablesSet.add(t.name);
        }
      } else {
        const qualified = `${t.name}.${c.name}`;
        if (!matchedDimensions.includes(qualified)) {
          matchedDimensions.push(qualified);
        }
        matchedTablesSet.add(t.name);
      }
    }
  }

  // Also check if the question asks for "over time" / "trend" / "monthly" and add the primary metric table's time dimension if present
  if (/\b(over time|trend|monthly|weekly|daily|by month|by date|by week)\b/i.test(question)) {
    for (const tName of matchedTablesSet) {
      const t = model.tables[tName];
      if (!t) continue;
      const tc = resolvedTimeColumnName(model, t);
      if (tc) {
        const qualified = `${t.name}.${tc}`;
        if (!matchedDimensions.includes(qualified)) {
          matchedDimensions.push(qualified);
        }
      }
    }
  }

  const coachingSteps: string[] = [];
  const yamlBlocks: string[] = [];
  let hasBlockingGap = false;

  // Gap check 1: Question asks for a ratio / rate / per / average / margin / conversion / NRR, and no matching ratio metric exists
  const asksForRatio = RATIO_INTENT_RE.test(question);
  const matchedRatioMetrics = matchedMetrics
    .map((name) => model.metrics[name])
    .filter((m): m is Metric => Boolean(m) && isRatioLikeMetric(m));

  // Check if any matched ratio metric actually directly matches the question's specific ratio intent
  const hasSpecificRatioMatch = matchedRatioMetrics.some((m) => {
    const phrases = [m.name.toLowerCase(), m.name.replace(/_/g, " ").toLowerCase(), m.label.toLowerCase(), ...m.synonyms.map((s) => s.toLowerCase())];
    if (phrases.some((p) => p.length >= 3 && qLower.includes(p))) return true;
    if (m.numerator && m.denominator && matchedMetrics.includes(m.numerator) && matchedMetrics.includes(m.denominator)) {
      return true;
    }
    return false;
  });

  if (asksForRatio && !hasSpecificRatioMatch) {
    hasBlockingGap = true;
    const simpleMatches = matchedMetrics
      .map((name) => model.metrics[name])
      .filter((m): m is Metric => Boolean(m) && !isRatioLikeMetric(m));

    if (simpleMatches.length >= 2) {
      const [num, den] = simpleMatches;
      const ratioName = uniqueMetricName(model, `${num.name}_per_${den.name}`);
      const format = CURRENCY_METRIC_RE.test(num.name) ? "currency" : "percent";
      coachingSteps.push(
        `Define a governed ratio metric (${ratioName}) combining ${num.name} (numerator) and ${den.name} (denominator) so Semantic Canvas divides aggregates in SQL across every grain and dimension breakdown.`,
      );
      yamlBlocks.push(
        [
          "metrics:",
          `  ${ratioName}:`,
          `    label: ${num.label} per ${den.label}`,
          `    base_table: ${num.baseTable}`,
          `    type: ratio`,
          `    numerator: ${num.name}`,
          `    denominator: ${den.name}`,
          `    format: ${format}`,
          `    unit: ${format === "currency" ? "currency" : "percent"}`,
        ].join("\n"),
      );
    } else if (simpleMatches.length === 1) {
      const num = simpleMatches[0];
      const baseTable = model.tables[num.baseTable];
      const otherSimple = Object.values(model.metrics).find(
        (m) => m.baseTable === num.baseTable && m.name !== num.name && metricType(m) === "simple",
      );
      const denName = otherSimple?.name ?? `total_${tableStem(num.baseTable)}_count`;
      const ratioName = uniqueMetricName(model, `${num.name}_ratio`);
      coachingSteps.push(
        `Add a governed ratio metric (${ratioName}) on ${baseTable?.name ?? num.baseTable} with numerator: ${num.name} and denominator: ${denName} instead of computing ratios ad-hoc.`,
      );
      yamlBlocks.push(
        [
          "metrics:",
          `  ${ratioName}:`,
          `    label: ${num.label} Ratio`,
          `    base_table: ${num.baseTable}`,
          `    type: ratio`,
          `    numerator: ${num.name}`,
          `    denominator: ${denName}`,
          `    format: percent`,
        ].join("\n"),
      );
    } else if (unmodelledNumericColumns.length >= 2) {
      const [first, second] = unmodelledNumericColumns;
      const ratioName = uniqueMetricName(model, `${first.column.name}_to_${second.column.name}_ratio`);
      coachingSteps.push(
        `Expose ${first.table.name}.${first.column.name} and ${second.table.name}.${second.column.name} as simple metrics and combine them in a governed ratio metric (${ratioName}).`,
      );
      yamlBlocks.push(
        [
          "metrics:",
          `  ${first.column.name}:`,
          `    label: ${first.column.name.replace(/_/g, " ")}`,
          `    base_table: ${first.table.name}`,
          `    expression: SUM(${first.table.name}.${first.column.name})`,
          `  ${second.column.name}:`,
          `    label: ${second.column.name.replace(/_/g, " ")}`,
          `    base_table: ${second.table.name}`,
          `    expression: SUM(${second.table.name}.${second.column.name})`,
          `  ${ratioName}:`,
          `    label: ${first.column.name} to ${second.column.name} ratio`,
          `    base_table: ${first.table.name}`,
          `    type: ratio`,
          `    numerator: ${first.column.name}`,
          `    denominator: ${second.column.name}`,
          `    format: percent`,
        ].join("\n"),
      );
    } else {
      coachingSteps.push(
        "Add a governed ratio metric (type: ratio) declaring explicit numerator and denominator metrics so rates and unit economics roll up accurately.",
      );
      yamlBlocks.push(
        [
          "metrics:",
          "  governed_ratio_metric:",
          "    label: Governed Ratio Metric",
          "    type: ratio",
          "    numerator: <numerator_metric>",
          "    denominator: <denominator_metric>",
          "    format: percent",
        ].join("\n"),
      );
    }
  }

  // Gap check 2: Unmodelled numeric columns matched by tokens
  for (const { table, column } of unmodelledNumericColumns) {
    hasBlockingGap = true;
    const metricName = uniqueMetricName(model, `total_${column.name}`);
    coachingSteps.push(
      `Column ${table.name}.${column.name} is a raw numeric column not yet exposed in model.metrics. Expose it as a governed metric (SUM(${table.name}.${column.name})) so charts and agents use one definition.`,
    );
    yamlBlocks.push(
      [
        "metrics:",
        `  ${metricName}:`,
        `    label: Total ${column.name.replace(/_/g, " ")}`,
        `    base_table: ${table.name}`,
        `    expression: SUM(${table.name}.${column.name})`,
        `    description: Governed sum of ${table.name}.${column.name}.`,
      ].join("\n"),
    );
  }

  // Gap check 3: Matched metrics and dimensions live on tables with no join path in model.joins
  const metricBaseTables = new Set<string>(
    matchedMetrics
      .map((name) => model.metrics[name]?.baseTable)
      .filter((t): t is string => Boolean(t && model.tables[t])),
  );
  for (const { table } of unmodelledNumericColumns) {
    metricBaseTables.add(table.name);
  }
  const dimensionTables = new Set<string>(
    matchedDimensions.map((d) => d.split(".")[0]).filter((t) => Boolean(model.tables[t])),
  );
  // Also include any explicitly matched dimension table (`dim_*`) if metricBaseTables is non-empty
  for (const tName of matchedTablesSet) {
    if (!metricBaseTables.has(tName) && /^dim_/i.test(tName)) {
      dimensionTables.add(tName);
    }
  }

  for (const mTable of metricBaseTables) {
    for (const dTable of dimensionTables) {
      if (mTable === dTable) continue;
      const path = joinPath(model, mTable, dTable);
      if ("error" in path) {
        hasBlockingGap = true;
        const leftTbl = model.tables[mTable];
        const rightTbl = model.tables[dTable];
        let leftOn = `${singular(tableStem(dTable))}_id`;
        let rightOn = rightTbl?.primaryKey || leftOn;

        if (leftTbl && rightTbl) {
          for (const col of leftTbl.columns) {
            const target = matchForeignKeyTarget(model, leftTbl, col);
            if (target && target.rightTable.name === dTable) {
              leftOn = col.name;
              rightOn = target.rightColumn;
              break;
            }
          }
        }

        coachingSteps.push(
          `Add a declared join from ${mTable}.${leftOn} to ${dTable}.${rightOn} in model.joins so metrics on ${mTable} can be broken down by ${dTable} dimensions.`,
        );
        yamlBlocks.push(
          [
            "joins:",
            `  - left: ${mTable}`,
            `    leftOn: ${leftOn}`,
            `    left_on: ${leftOn}`,
            `    right: ${dTable}`,
            `    rightOn: ${rightOn}`,
            `    right_on: ${rightOn}`,
            `    type: left`,
          ].join("\n"),
        );
      }
    }
  }

  if (matchedMetrics.length === 0 && !hasBlockingGap) {
    hasBlockingGap = true;
    coachingSteps.push(
      "No governed metrics in model.metrics matched your question tokens. Add a governed metric or enrich existing metrics with domain synonyms.",
    );
  }

  const canAnswerNow = !hasBlockingGap && matchedMetrics.length > 0;
  if (canAnswerNow && coachingSteps.length === 0) {
    coachingSteps.push(
      `Ready to answer now with governed metric${matchedMetrics.length === 1 ? "" : "s"} (${matchedMetrics.join(", ")})${matchedDimensions.length > 0 ? ` segmented by ${matchedDimensions.join(", ")}` : ""}.`,
    );
  }

  return {
    question,
    canAnswerNow,
    matchedMetrics,
    matchedDimensions,
    matchedTables: [...matchedTablesSet],
    coachingSteps,
    ...(yamlBlocks.length > 0 ? { suggestedYaml: yamlBlocks.join("\n\n") } : {}),
  };
}

export function coachSemanticModel(
  model: Model,
  options?: { goal?: AnalysisGoal; question?: string },
): SemanticCoachReport {
  const byTable = metricsByTable(model);
  const allFindings: CoachingFinding[] = [];
  const strengths: string[] = [];

  const tables = Object.values(model.tables);
  const allMetrics = Object.values(model.metrics);

  // =========================================================================
  // 1. time_series
  // =========================================================================
  let tablesWithTimeColumn = 0;
  let tablesWithReportingLag = 0;

  for (const table of tables) {
    const tableMetrics = byTable[table.name] ?? [];
    const isFactLike = tableMetrics.length > 0 || /^(fct|fact)_/i.test(table.name);
    const timeCol = resolvedTimeColumnName(model, table);

    if (timeCol) {
      tablesWithTimeColumn++;
      if (isFactLike && !/^dim_/i.test(table.name)) {
        if (hasReportingLag(table)) {
          tablesWithReportingLag++;
        } else {
          allFindings.push({
            id: `time_series:reporting_lag:${table.name}`,
            category: "time_series",
            priority: "medium",
            title: `Set reportingLag on ${table.name} for partial-period hatching`,
            target: table.name,
            whyItMatters:
              "Setting reportingLag enables automatic partial-period hatching in Broadside views so incomplete current periods aren't misread as drops.",
            recommendation: `Declare reportingLag (reporting_lag: 2) on ${table.name} so charts and digests hatch unsettled current periods automatically.`,
            yamlSnippet: [
              "tables:",
              `  ${table.name}:`,
              `    timeColumn: ${timeCol}`,
              `    default_date_column: ${timeCol}`,
              `    reportingLag: 2`,
              `    reporting_lag: 2`,
            ].join("\n"),
          });
        }
      }
    } else if (tableMetrics.length > 0) {
      const candidate = findTemporalCandidateColumn(table);
      if (candidate) {
        allFindings.push({
          id: `time_series:missing_time_column:${table.name}`,
          category: "time_series",
          priority: "high",
          title: `Set timeColumn: ${candidate.name} on ${table.name}`,
          target: `${table.name}.${candidate.name}`,
          whyItMatters: `Table ${table.name} has governed metrics and temporal column ${candidate.name}, but no declared timeColumn. Trend charts, period comparisons (prior/yoy), and cumulative metrics require an explicit time axis.`,
          recommendation: `Set timeColumn: ${candidate.name} on ${table.name} so trend charts, period comparisons (prior/yoy), and cumulative metrics work automatically.`,
          yamlSnippet: [
            "tables:",
            `  ${table.name}:`,
            `    timeColumn: ${candidate.name}`,
            `    default_date_column: ${candidate.name}`,
          ].join("\n"),
        });
      } else {
        allFindings.push({
          id: `time_series:no_temporal_column:${table.name}`,
          category: "time_series",
          priority: "low",
          title: `No temporal column found on metric table ${table.name}`,
          target: table.name,
          whyItMatters: `Metrics on ${table.name} cannot be plotted over time or compared against prior/YoY periods without a date or timestamp column.`,
          recommendation: `Expose a date or timestamp column on ${table.name} and configure timeColumn.`,
          yamlSnippet: [
            "tables:",
            `  ${table.name}:`,
            "    timeColumn: event_date",
            "    default_date_column: event_date",
          ].join("\n"),
        });
      }
    }
  }

  if (tablesWithTimeColumn > 0) {
    strengths.push(
      `${tablesWithTimeColumn} table${tablesWithTimeColumn === 1 ? " has" : "s have"} an explicit time axis for trend and period-comparison charts.`,
    );
  }
  if (tablesWithReportingLag > 0) {
    strengths.push(
      `${tablesWithReportingLag} fact table${tablesWithReportingLag === 1 ? " declares" : "s declare"} reportingLag for partial-period data honesty.`,
    );
  }

  // =========================================================================
  // 2. driver_attribution
  // =========================================================================
  let tablesWithReachableDimensions = 0;
  const reportedJoinPairs = new Set<string>();

  for (const table of tables) {
    const outgoingJoins = model.joins.filter((j) => j.left === table.name);
    const tableMetrics = byTable[table.name] ?? [];

    // Detect isolated tables (0 outgoing joins) or unjoined foreign keys
    if (outgoingJoins.length === 0 || tableMetrics.length > 0) {
      for (const col of table.columns) {
        const match = matchForeignKeyTarget(model, table, col);
        if (!match) continue;
        const alreadyJoined = model.joins.some(
          (j) => j.left === table.name && j.right === match.rightTable.name,
        );
        if (alreadyJoined) continue;

        const pairKey = `${table.name}.${col.name}->${match.rightTable.name}.${match.rightColumn}`;
        if (reportedJoinPairs.has(pairKey)) continue;
        reportedJoinPairs.add(pairKey);

        allFindings.push({
          id: `driver_attribution:missing_join:${table.name}:${match.rightTable.name}`,
          category: "driver_attribution",
          priority: outgoingJoins.length === 0 ? "high" : "medium",
          title: `Connect ${table.name}.${col.name} → ${match.rightTable.name}.${match.rightColumn}`,
          target: `${table.name}.${col.name}`,
          whyItMatters: `Table ${table.name} has foreign-key column ${col.name} matching ${match.rightTable.name}.${match.rightColumn}, but no declared join in model.joins. Adding this join unlocks segment breakdowns in "Why Did This Move?" driver attribution.`,
          recommendation: `Add a left join from ${table.name}.${col.name} to ${match.rightTable.name}.${match.rightColumn} in joins.`,
          yamlSnippet: [
            "joins:",
            `  - left: ${table.name}`,
            `    leftOn: ${col.name}`,
            `    left_on: ${col.name}`,
            `    right: ${match.rightTable.name}`,
            `    rightOn: ${match.rightColumn}`,
            `    right_on: ${match.rightColumn}`,
            `    type: left`,
          ].join("\n"),
        });
      }
    }

    if (tableMetrics.length > 0) {
      const ownCatDims = dimensionsOf(table).filter((c) => isCategoricalDimension(table, c));
      const joinedReachableDims = joinedTableOptions(model, table.name)
        .filter((opt) => "joins" in opt.path)
        .flatMap((opt) =>
          dimensionsOf(opt.table).filter((c) => isCategoricalDimension(opt.table, c)),
        );

      const totalCatDims = ownCatDims.length + joinedReachableDims.length;
      if (totalCatDims > 0) {
        tablesWithReachableDimensions++;
      } else {
        allFindings.push({
          id: `driver_attribution:no_dimensions:${table.name}`,
          category: "driver_attribution",
          priority: "medium",
          title: `Add categorical dimensions or joins for ${table.name}`,
          target: table.name,
          whyItMatters: `Metrics on ${table.name} have 0 reachable categorical dimensions (string/boolean columns on ${table.name} or via model.joins), preventing automated "Why Did This Move?" driver attribution.`,
          recommendation: `Expose categorical segment columns on ${table.name} or join ${table.name} to a dimension table (e.g. dim_customers, dim_plans).`,
          yamlSnippet: [
            "joins:",
            `  - left: ${table.name}`,
            "    leftOn: customer_id",
            "    left_on: customer_id",
            "    right: dim_customers",
            "    rightOn: customer_id",
            "    right_on: customer_id",
            "    type: left",
          ].join("\n"),
        });
      }
    }
  }

  if (model.joins.length > 0 || tablesWithReachableDimensions > 0) {
    strengths.push(
      `${model.joins.length} declared join${model.joins.length === 1 ? "" : "s"} connect${model.joins.length === 1 ? "s" : ""} metrics to dimension attributes across ${tablesWithReachableDimensions} metric table${tablesWithReachableDimensions === 1 ? "" : "s"}.`,
    );
  }

  // =========================================================================
  // 3. ratios_and_funnels
  // =========================================================================
  const existingRatioCount = allMetrics.filter(
    (m) => metricType(m) === "ratio" || metricType(m) === "derived" || /\//.test(m.expression),
  ).length;
  if (existingRatioCount > 0) {
    strengths.push(
      `${existingRatioCount} governed ratio/derived metric${existingRatioCount === 1 ? " is" : "s are"} defined so division happens in SQL rather than spreadsheets.`,
    );
  }

  for (const table of tables) {
    const tableMetrics = byTable[table.name] ?? [];
    const simpleMetrics = tableMetrics.filter(
      (m) => metricType(m) === "simple" && !/\//.test(m.expression),
    );
    if (simpleMetrics.length < 2) continue;

    // 3a. Currency/revenue/amount SUM metric + COUNT / COUNT(DISTINCT) metric -> Unit-economics ratio
    const sumCurrencyMetric = simpleMetrics.find(
      (m) =>
        SUM_METRIC_RE.test(m.expression) &&
        (CURRENCY_METRIC_RE.test(m.name) ||
          CURRENCY_METRIC_RE.test(m.label) ||
          CURRENCY_METRIC_RE.test(m.expression) ||
          m.unit === "currency"),
    );
    const countMetric = simpleMetrics.find(
      (m) => COUNT_METRIC_RE.test(m.expression) && m.name !== sumCurrencyMetric?.name,
    );

    if (
      sumCurrencyMetric &&
      countMetric &&
      !existingRatioUsesPair(model, sumCurrencyMetric, countMetric)
    ) {
      const propName = uniqueMetricName(
        model,
        `avg_${sumCurrencyMetric.name}_per_${singular(countMetric.name)}`,
      );
      const propLabel = `Avg ${sumCurrencyMetric.label} per ${singular(countMetric.label)}`;
      const fallbackExpr = buildInlineRatioExpression(sumCurrencyMetric, countMetric);

      allFindings.push({
        id: `ratios_and_funnels:unit_economics:${table.name}:${sumCurrencyMetric.name}:${countMetric.name}`,
        category: "ratios_and_funnels",
        priority: "high",
        title: `Add governed unit-economics ratio: ${propLabel}`,
        target: `${table.name} (${sumCurrencyMetric.name} / ${countMetric.name})`,
        whyItMatters: `Table ${table.name} defines ${sumCurrencyMetric.name} (SUM) and ${countMetric.name} (COUNT), but no governed ratio metric combines them. Without a semantic ratio, analysts divide pre-aggregated numbers in spreadsheets or get wrong weighted averages across segments.`,
        recommendation: `Define ${propName} as type: ratio with numerator: ${sumCurrencyMetric.name} and denominator: ${countMetric.name}, or propose it directly in the Metric Registry.`,
        yamlSnippet: [
          "metrics:",
          `  ${propName}:`,
          `    label: ${propLabel}`,
          `    base_table: ${table.name}`,
          `    type: ratio`,
          `    numerator: ${sumCurrencyMetric.name}`,
          `    denominator: ${countMetric.name}`,
          `    format: currency`,
          `    unit: currency`,
          `    description: Governed unit-economics ratio of ${sumCurrencyMetric.label} divided by ${countMetric.label}.`,
        ].join("\n"),
        proposedMetric: {
          name: propName,
          label: propLabel,
          baseTable: table.name,
          expression: fallbackExpr,
          description: `Governed unit-economics ratio of ${sumCurrencyMetric.label} divided by ${countMetric.label}.`,
        },
      });
    }

    // 3b. Two COUNT metrics (e.g. total vs subset/converted) -> Conversion / share ratio metric
    const countMetrics = simpleMetrics.filter((m) => COUNT_METRIC_RE.test(m.expression));
    if (countMetrics.length >= 2) {
      // Pick subset/filtered metric as numerator and broader count as denominator
      const sorted = [...countMetrics].sort((a, b) => {
        const aSub = Boolean(a.filter) || /filter\s*\(/i.test(a.expression) || SUBSET_METRIC_RE.test(a.name) ? 1 : 0;
        const bSub = Boolean(b.filter) || /filter\s*\(/i.test(b.expression) || SUBSET_METRIC_RE.test(b.name) ? 1 : 0;
        return bSub - aSub;
      });
      const numerator = sorted[0];
      const denominator = sorted.find((m) => m.name !== numerator.name)!;

      if (!existingRatioUsesPair(model, numerator, denominator)) {
        const propName = uniqueMetricName(model, `${numerator.name}_to_${denominator.name}_rate`);
        const propLabel = `${numerator.label} to ${denominator.label} rate`;
        const fallbackExpr = buildInlineRatioExpression(numerator, denominator);

        allFindings.push({
          id: `ratios_and_funnels:conversion:${table.name}:${numerator.name}:${denominator.name}`,
          category: "ratios_and_funnels",
          priority: "medium",
          title: `Add conversion/share ratio: ${propLabel}`,
          target: `${table.name} (${numerator.name} / ${denominator.name})`,
          whyItMatters: `Table ${table.name} has multiple count metrics (${numerator.name} and ${denominator.name}) without a governed conversion/share ratio metric.`,
          recommendation: `Add ${propName} (type: ratio, format: percent) with numerator: ${numerator.name} and denominator: ${denominator.name}.`,
          yamlSnippet: [
            "metrics:",
            `  ${propName}:`,
            `    label: ${propLabel}`,
            `    base_table: ${table.name}`,
            `    type: ratio`,
            `    numerator: ${numerator.name}`,
            `    denominator: ${denominator.name}`,
            `    format: percent`,
            `    unit: percent`,
            `    description: Conversion or share ratio of ${numerator.label} to ${denominator.label}.`,
          ].join("\n"),
          proposedMetric: {
            name: propName,
            label: propLabel,
            baseTable: table.name,
            expression: fallbackExpr,
            description: `Conversion or share ratio of ${numerator.label} to ${denominator.label}.`,
          },
        });
      }
    }
  }

  // =========================================================================
  // 4. cohorts_and_cumulative
  // =========================================================================
  const cumulativeMetrics = allMetrics.filter((m) => metricType(m) === "cumulative");
  if (cumulativeMetrics.length > 0) {
    strengths.push(
      `${cumulativeMetrics.length} cumulative metric${cumulativeMetrics.length === 1 ? " supports" : "s support"} running-total and trailing-window lifecycle analysis.`,
    );
  }

  for (const table of tables) {
    const timeCol = resolvedTimeColumnName(model, table);
    if (!timeCol) continue;

    const tableMetrics = byTable[table.name] ?? [];
    const simpleMetrics = tableMetrics.filter((m) => metricType(m) === "simple");
    if (simpleMetrics.length === 0) continue;

    const hasCumulativeOnTable = allMetrics.some(
      (m) =>
        metricType(m) === "cumulative" &&
        (m.baseTable === table.name ||
          (m.metric && model.metrics[m.metric]?.baseTable === table.name)),
    );

    if (!hasCumulativeOnTable) {
      const baseMetric =
        simpleMetrics.find((m) => SUM_METRIC_RE.test(m.expression)) ?? simpleMetrics[0];
      const cumName = uniqueMetricName(model, `cumulative_${baseMetric.name}_6p`);

      allFindings.push({
        id: `cohorts_and_cumulative:missing_cumulative:${table.name}`,
        category: "cohorts_and_cumulative",
        priority: "medium",
        title: `Add trailing-window cumulative metric on ${table.name} (${baseMetric.label})`,
        target: `${table.name}.${baseMetric.name}`,
        whyItMatters: `Table ${table.name} has a declared time axis (${timeCol}) and simple metrics, but no type: cumulative metric for running totals or trailing-window cohort tracking.`,
        recommendation: `Define a cumulative metric (type: cumulative, metric: ${baseMetric.name}, window: 6) on ${table.name} for 6-period trailing lifecycle and cohort accumulation.`,
        yamlSnippet: [
          "metrics:",
          `  ${cumName}:`,
          `    label: Trailing 6-Period ${baseMetric.label}`,
          `    base_table: ${table.name}`,
          `    type: cumulative`,
          `    metric: ${baseMetric.name}`,
          `    window: 6`,
          `    description: Running 6-period cumulative total of ${baseMetric.label} along ${table.name}.${timeCol}.`,
        ].join("\n"),
      });
    }
  }

  // =========================================================================
  // 5. agent_readiness
  // =========================================================================
  let documentedTables = 0;
  let documentedMetrics = 0;

  for (const table of tables) {
    const missingGrain = !table.grain || !table.grain.trim() || /say what/i.test(table.grain);
    const unreviewed = isUnreviewedTable(table);

    if (!missingGrain && !unreviewed) {
      documentedTables++;
    }

    if (missingGrain) {
      const inferredKey = table.primaryKey ?? `${singular(tableStem(table.name))}_id`;
      allFindings.push({
        id: `agent_readiness:missing_grain:${table.name}`,
        category: "agent_readiness",
        priority: "high",
        title: `Declare explicit row grain on ${table.name}`,
        target: table.name,
        whyItMatters: `Table ${table.name} has no declared grain ("one row per ..."). AI and MCP agents rely on table grain to avoid double-counting across joins and to explain what COUNT(*) means.`,
        recommendation: `Set grain: "one row per ${inferredKey}" on ${table.name}.`,
        yamlSnippet: [
          "tables:",
          `  ${table.name}:`,
          `    grain: one row per ${inferredKey}`,
        ].join("\n"),
      });
    }

    if (unreviewed) {
      allFindings.push({
        id: `agent_readiness:unreviewed_table:${table.name}`,
        category: "agent_readiness",
        priority: "medium",
        title: `Publish connected table ${table.name} for governed AI & viewer access`,
        target: table.name,
        whyItMatters: `Connected table ${table.name} is currently unreviewed. Unreviewed tables are excluded from the governed MCP catalogue and viewer sessions until an administrator publishes them.`,
        recommendation: `Review the grain and column definitions of ${table.name} and publish it into the governed catalogue.`,
        yamlSnippet: [
          "tables:",
          `  ${table.name}:`,
          `    grain: ${table.grain?.trim() || `one row per ${singular(tableStem(table.name))}`}`,
          `    status: published`,
        ].join("\n"),
      });
    }
  }

  for (const m of allMetrics) {
    const missingDesc = !m.description || !m.description.trim();
    const missingSynonyms = !Array.isArray(m.synonyms) || m.synonyms.length === 0;

    if (!missingDesc && !missingSynonyms) {
      documentedMetrics++;
      continue;
    }

    const smartSynonyms = missingSynonyms ? inferSmartSynonyms(m.name, m.label) : m.synonyms;
    const descText =
      !missingDesc && m.description
        ? m.description.trim()
        : `Governed ${m.label.toLowerCase()} metric on ${m.baseTable}.`;

    allFindings.push({
      id: `agent_readiness:metric_metadata:${m.name}`,
      category: "agent_readiness",
      priority: missingDesc && missingSynonyms ? "medium" : "low",
      title: `Enrich ${m.label} (${m.name}) with ${missingDesc && missingSynonyms ? "description & domain synonyms" : missingDesc ? "description" : "domain synonyms"}`,
      target: m.name,
      whyItMatters: `Metric ${m.name} is missing ${missingDesc && missingSynonyms ? "a description and synonyms" : missingDesc ? "a description" : "synonyms"}. Domain synonyms and clear prose descriptions prevent LLM hallucinations when users ask natural-language questions in Claude, ChatGPT, or Canvas AI.`,
      recommendation: `Add ${missingSynonyms ? `synonyms [${smartSynonyms.map((s) => `"${s}"`).join(", ")}]` : ""}${missingDesc && missingSynonyms ? " and " : ""}${missingDesc ? "a business description" : ""} to ${m.name}.`,
      yamlSnippet: [
        "metrics:",
        `  ${m.name}:`,
        `    label: ${m.label}`,
        `    description: ${descText}`,
        `    synonyms: [${smartSynonyms.map((s) => `"${s}"`).join(", ")}]`,
      ].join("\n"),
    });
  }

  if (documentedTables > 0 || documentedMetrics > 0) {
    strengths.push(
      `${documentedTables}/${tables.length} tables have explicit grain and ${documentedMetrics}/${allMetrics.length} metrics have full AI descriptions and domain synonyms.`,
    );
  }

  // =========================================================================
  // Compute Category Scores & Overall Score
  // =========================================================================
  const categories: CoachCategory[] = [
    "time_series",
    "driver_attribution",
    "ratios_and_funnels",
    "cohorts_and_cumulative",
    "agent_readiness",
  ];

  const penaltyForPriority = (p: CoachingFinding["priority"]): number =>
    p === "high" ? 24 : p === "medium" ? 14 : 7;

  const categoryScores = {} as Record<CoachCategory, number>;
  for (const cat of categories) {
    const catFindings = allFindings.filter((f) => f.category === cat);
    const penalty = catFindings.reduce((acc, f) => acc + penaltyForPriority(f.priority), 0);
    categoryScores[cat] = Math.max(15, Math.min(100, 100 - penalty));
  }

  const overallScore = Math.round(
    categories.reduce((acc, cat) => acc + categoryScores[cat], 0) / categories.length,
  );

  // Sort findings by priority (high -> medium -> low)
  const priorityRank = { high: 0, medium: 1, low: 2 };
  allFindings.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  const goal = options?.goal ?? "all";
  const filteredFindings =
    goal !== "all" ? allFindings.filter((f) => f.category === goal) : allFindings;

  const highCount = allFindings.filter((f) => f.priority === "high").length;
  const summary =
    allFindings.length === 0
      ? `Model "${model.name}" achieved a ${overallScore}/100 analysis readiness score across all 5 coaching dimensions with zero gaps detected.`
      : `Model "${model.name}" scored ${overallScore}/100 for analysis readiness (${allFindings.length} coaching finding${allFindings.length === 1 ? "" : "s"}${highCount > 0 ? `, including ${highCount} high-priority recommendation${highCount === 1 ? "" : "s"}` : ""}).`;

  const questionText = options?.question?.trim();
  const questionAnalysis = questionText
    ? analyzeQuestionAgainstModel(model, questionText)
    : undefined;

  return {
    modelName: model.name,
    overallScore,
    categoryScores,
    summary,
    strengths,
    findings: filteredFindings,
    ...(questionAnalysis ? { questionAnalysis } : {}),
  };
}
