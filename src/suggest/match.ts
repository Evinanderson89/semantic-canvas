import type { ChartKind } from "../compiler/spec.ts";
import { joinedTableOptions, metricsByTable, type Metric, type Model, type Table, type TimeGrain } from "../semantic/model.ts";

/**
 * Match free text against the semantic model.
 *
 * This is why a semantic layer beats text-to-SQL for this job: the model
 * already carries synonyms, labels, grain and descriptions, so "how is revenue
 * retention trending" can be resolved to actual metric names by scoring, with
 * no LLM and no chance of inventing something that does not exist. The
 * interview then confirms rather than guesses.
 */

const STOP = new Set(("a an and are as at be by for from how i in is it me my of on or our " +
  "show see want like need dashboard chart graph over the to us we with what which do does " +
  "give build make please can you where").split(" "));

const TOKEN_SYNONYMS: Record<string, string> = {
  // SaaS & customer lifecycle
  losing: "lose",
  lost: "lose",
  losses: "lose",
  customers: "customer",
  revenues: "revenue",
  churned: "churn",
  churning: "churn",
  arr: "mrr",
  booking: "mrr",
  bookings: "mrr",
  expansion: "net_new_mrr",
  expansions: "net_new_mrr",
  bridge: "movement",
  bridges: "movement",
  driver: "movement",
  drivers: "movement",
  drove: "movement",
  driving: "movement",
  movements: "movement",
  plans: "plan",
  tiers: "tier",
  channels: "channel",
  cac: "cost",
  costs: "cost",
  funnel: "conversion",
  funnels: "conversion",
  conversions: "conversion",
  converted: "conversion",
  converting: "conversion",
  retained: "retention",
  retaining: "retention",
  retentions: "retention",
  changes: "change",
  changed: "change",
  changing: "change",
  trending: "trend",
  trends: "trend",
  subscriptions: "subscription",
  subscribers: "subscriber",

  // Retail & commerce
  sale: "sales",
  gmv: "sales",
  receipts: "sales",
  billings: "sales",
  order: "orders",
  ordered: "orders",
  ordering: "orders",
  purchase: "orders",
  purchases: "orders",
  transaction: "orders",
  transactions: "orders",
  unit: "units",
  items: "units",
  quantities: "units",
  qty: "units",
  cup: "cups",
  drinks: "drink",
  beverage: "drink",
  beverages: "drink",
  coffees: "coffee",
  beans: "bean",
  bags: "bag",
  stores: "store",
  shop: "store",
  shops: "store",
  outlet: "store",
  outlets: "store",
  branch: "store",
  branches: "store",
  cafes: "cafe",
  locations: "location",
  sites: "location",
  cities: "city",
  metro: "city",
  metros: "city",
  categories: "category",
  segments: "segment",
  formats: "format",
  regions: "region",
  regional: "region",
  countries: "country",
  markets: "market",
  territories: "territory",
  products: "product",
  skus: "sku",
  discounts: "discount",
  discounted: "discount",
  markdowns: "discount",

  // Finance & P&L
  margins: "margin",
  markup: "margin",
  profits: "profit",
  profitability: "profit",
  profitable: "profit",
  earnings: "profit",
  ebit: "ebitda",
  cogs: "cost",
  costing: "cost",
  expenses: "expense",
  opex: "expense",
  expenditure: "expense",
  expenditures: "expense",
  outlay: "expense",
  budgets: "budget",
  budgeted: "budget",
  forecast: "budget",
  forecasts: "budget",
  quota: "budget",
  spending: "spend",
  spent: "spend",

  // Energy, supply chain & operations
  generated: "generation",
  generating: "generation",
  generations: "generation",
  photovoltaic: "solar",
  turbines: "wind",
  turbine: "wind",
  prices: "price",
  pricing: "price",
  spot: "price",
  tariffs: "price",
  tariff: "price",
  curtailed: "curtailment",
  curtailments: "curtailment",
  shipment: "shipments",
  shipped: "shipments",
  shipping: "shipments",
  delivery: "shipments",
  deliveries: "shipments",
  freight: "shipments",
  inventories: "inventory",
  stock: "inventory",
  stocks: "inventory",
  headcounts: "headcount",
  employees: "headcount",
  staff: "headcount",
};

const normalizeToken = (word: string) => TOKEN_SYNONYMS[word] ?? word;
export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 2 && !STOP.has(t)).map(normalizeToken);
}

function score(needle: string[], haystacks: { text: string; weight: number }[]): number {
  let total = 0;
  for (const { text, weight } of haystacks) {
    const rawIdentifiers = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    const hay = new Set([...tokens(text), ...rawIdentifiers]);
    for (const t of new Set(needle)) if (hay.has(t)) total += weight;
  }
  return total;
}

export interface Matches {
  metrics: { metric: Metric; score: number }[];
  tables: { table: Table; score: number }[];
  /** Highest-scoring base table across matched metrics, if any. */
  subject: string | null;
  /** Secondary tables matched by the prompt, ordered by relevance score. */
  companionTables: string[];
  /** Matched metrics grouped by their governed baseTable. */
  matchedByTable: Record<string, Metric[]>;
}

export function matchModel(model: Model, text: string): Matches {
  const q = tokens(text);
  if (!q.length) return { metrics: [], tables: [], subject: null, companionTables: [], matchedByTable: {} };

  const metrics = Object.values(model.metrics)
    .map((m) => ({ metric: m, score: score(q, [
      { text: m.name, weight: 3 },
      { text: m.label, weight: 3 },
      { text: m.synonyms.join(" "), weight: 2.5 },
      { text: m.description ?? "", weight: 1 },
      ...(m.importance ? [{ text: model.tables[m.baseTable]?.description ?? "", weight: 0.5 }] : []),
    ]) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.metric.importance ?? 0) - (a.metric.importance ?? 0));

  const tables = Object.values(model.tables)
    .map((t) => ({ table: t, score: score(q, [
      { text: t.name, weight: 2 },
      { text: t.synonyms.join(" "), weight: 2.5 },
      { text: t.grain ?? "", weight: 1 },
      { text: t.description ?? "", weight: 0.8 },
    ]) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const matchedByTable: Record<string, Metric[]> = {};
  for (const { metric } of metrics) {
    (matchedByTable[metric.baseTable] ??= []).push(metric);
  }

  // The subject is where the matched metrics actually live, weighted by score --
  // more reliable than matching a table name directly, because people name
  // measures ("churn") far more often than tables ("fct_mrr_movements").
  const byBase = new Map<string, number>();
  for (const { metric, score: s } of metrics) {
    const weighted = s * (1 + (metric.importance ?? 0) / 100);
    byBase.set(metric.baseTable, (byBase.get(metric.baseTable) ?? 0) + weighted);
  }
  for (const { table, score: s } of tables)
    byBase.set(table.name, (byBase.get(table.name) ?? 0) + s * 0.6);

  const rankedTables = [...byBase.entries()].sort((a, b) => b[1] - a[1]);
  const subject = rankedTables.find(([t]) => matchedByTable[t]?.length)?.[0]
    ?? rankedTables[0]?.[0]
    ?? null;
  const companionTables = rankedTables
    .map(([t]) => t)
    .filter((t) => t !== subject);

  return { metrics, tables, subject, companionTables, matchedByTable };
}

/** Presentation/polish words that should not hijack metric selection away from top-importance KPIs. */
const GENERIC_PROMPT_TOKENS = new Set([
  "executive", "exec", "overview", "summary", "summarize", "story", "coherent",
  "establish", "question", "questions", "sequence", "evidence", "clear", "clearer",
  "useful", "room", "lead", "leading", "headline", "headlines", "number", "numbers",
  "compact", "next", "decision", "decisions", "matter", "matters", "explain",
  "trend", "obvious", "improve", "better", "best", "polish", "clean", "redesign",
  "reimagine", "find", "charts", "hide", "hidden", "information", "info",
  "reporting", "period", "periods", "breakdown", "breakdowns", "comparison", "comparisons",
  "compare", "using", "governed", "metric", "metrics", "measure", "measures", "kpi", "kpis",
  "add", "only", "context", "needed", "understand", "them", "their", "this", "that", "these", "those",
  "current", "view", "views", "report", "reports", "canvas", "layout", "tile", "tiles",
  "visual", "visuals", "card", "cards", "section", "sections", "glance",
  "day", "daily", "week", "weekly", "month", "monthly", "quarter", "quarterly", "year", "yearly", "annual", "annually",
  "time", "date", "dates", "top", "bottom", "limit", "table", "tables", "include", "including",
  "bar", "bars", "stacked", "grouped", "clustered", "donut", "doughnut", "pie", "area", "line", "lines",
  "horizontal", "vertical", "column", "columns", "total", "totals", "usd", "dollar", "dollars", "percent", "percentage",
]);

const PHRASE_FILLERS = new Set(["the", "a", "an", "each", "every", "all", "different", "various", "our", "their", "its"]);
const TIME_GRAIN_NOUNS = new Set(["day", "days", "daily", "week", "weeks", "weekly", "month", "months", "monthly", "quarter", "quarters", "quarterly", "year", "years", "yearly", "annual", "time", "date", "dates", "period", "periods"]);

function stemWord(word: string): string {
  const syn = normalizeToken(word);
  if (syn.endsWith("ies") && syn.length > 4) return `${syn.slice(0, -3)}y`;
  if ((syn.endsWith("ses") || syn.endsWith("xes")) && syn.length > 4) return syn.slice(0, -2);
  if (syn.endsWith("s") && !syn.endsWith("ss") && syn.length > 3) return syn.slice(0, -1);
  return syn;
}

function phraseTokens(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !PHRASE_FILLERS.has(w))
    .map(stemWord);
}

function categoricalColumnsOf(table: Table): string[] {
  return table.columns
    .filter((c) => /^(string|varchar|text|bool)/i.test(c.type) && !/(_id$|^id$)/.test(c.name) && !/^_(import_id|loaded_at|source)$/.test(c.name))
    .map((c) => c.name);
}

function parseTimeGrainHint(text: string): TimeGrain | undefined {
  if (/\b(?:daily|by\s+day|per\s+day|day[-\s]over[-\s]day|each\s+day)\b/i.test(text)) return "day";
  if (/\b(?:weekly|by\s+week|per\s+week|week[-\s]over[-\s]week|each\s+week)\b/i.test(text)) return "week";
  if (/\b(?:quarterly|by\s+quarter|per\s+quarter|quarter[-\s]over[-\s]quarter|each\s+quarter|qoq)\b/i.test(text)) return "quarter";
  if (/\b(?:yearly|annual|annually|by\s+year|per\s+year|year[-\s]over[-\s]year|each\s+year)\b/i.test(text)) return "year";
  if (/\b(?:monthly|by\s+month|per\s+month|month[-\s]over[-\s]month|each\s+month|mom)\b/i.test(text)) return "month";
  return undefined;
}

function parseChartHint(text: string): ChartKind | undefined {
  if (/\bstacked\s+(?:bar|bars|column|columns)\b/i.test(text)) return "barStacked";
  if (/\b(?:grouped|clustered|side[-\s]by[-\s]side)\s+(?:bar|bars|column|columns)\b/i.test(text)) return "barGrouped";
  if (/\bhorizontal\s+(?:bar|bars)\b/i.test(text)) return "barH";
  if (/\b(?:donut|doughnut|pie\s+chart|pie|share)\b/i.test(text)) return "donut";
  if (/\b(?:waterfall|bridge)\b/i.test(text)) return "waterfall";
  if (/\bstacked\s+area\b/i.test(text)) return "areaStacked";
  if (/\barea(?:\s+chart|\s+graph|\s+plot)?\b/i.test(text)) return "area";
  return undefined;
}

function resolveDimensionPhrase(
  model: Model,
  phrase: string,
  reachableTables: Set<string>,
): string | null {
  const cleaned = phrase.trim().replace(/^(?:each|every|all|the)\s+/i, "");
  if (!cleaned) return null;
  const rawWords = cleaned.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (!rawWords.length || rawWords.every((w) => TIME_GRAIN_NOUNS.has(w))) return null;

  const pTokens = phraseTokens(cleaned);
  if (!pTokens.length) return null;
  const normPhrase = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");

  let bestField: string | null = null;
  let bestScore = 0;

  for (const table of Object.values(model.tables)) {
    const catCols = categoricalColumnsOf(table);
    if (!catCols.length) continue;
    const reachBonus = reachableTables.has(table.name) ? 3 : 0;
    const cleanTableName = table.name.replace(/^(?:dim|fct)_/i, "");
    const tableTokens = new Set([
      ...phraseTokens(cleanTableName),
      ...table.synonyms.flatMap((s) => phraseTokens(s)),
    ]);

    for (const col of catCols) {
      const qualified = `${table.name}.${col}`;
      const normCol = col.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normQual = qualified.toLowerCase().replace(/[^a-z0-9]/g, "");
      const strippedCol = col.replace(/_(?:name|label|title|type)$/i, "");
      const normStripped = strippedCol.toLowerCase().replace(/[^a-z0-9]/g, "");
      const colTokens = phraseTokens(col);
      const colSet = new Set(colTokens);
      const combinedSet = new Set([...tableTokens, ...colTokens]);

      const colHits = pTokens.filter((t) => colSet.has(t)).length;
      const combinedHits = pTokens.filter((t) => combinedSet.has(t)).length;

      let baseScore = 0;
      if (normPhrase === normCol || normPhrase === normQual) {
        baseScore = 20;
      } else if (normStripped && normPhrase === normStripped) {
        baseScore = /_name$/i.test(col) ? 17 : 16;
      } else if (colHits === pTokens.length && colHits === colTokens.length) {
        baseScore = 19;
      } else if (colHits === pTokens.length) {
        baseScore = 14 + (/_name$/i.test(col) ? 0.5 : 0);
      } else if (colHits >= 1 && combinedHits === pTokens.length) {
        baseScore = 15;
      } else if (colHits >= 1 && colHits / pTokens.length >= 0.5 && colHits / colTokens.length >= 0.5) {
        baseScore = 10 * (colHits / pTokens.length);
      } else if (
        col === (catCols.find((c) => /_name$|^name$|^city$|^title$/i.test(c)) ?? catCols[0]) &&
        pTokens.every((t) => tableTokens.has(t))
      ) {
        // Entity-level breakdown such as "per store" -> store_directory's primary label column
        baseScore = 7;
      }

      if (baseScore >= 6) {
        const total = baseScore + reachBonus;
        if (total > bestScore) {
          bestScore = total;
          bestField = qualified;
        }
      }
    }
  }

  return bestField;
}

export interface PromptIntent {
  grain?: TimeGrain;
  dimensions: string[];
  chart?: ChartKind;
  includeTable?: boolean;
  limit?: number;
  isGenericPrompt: boolean;
}

/** Deterministically parse grain, explicit breakdowns, chart hints, Top-N limits, and generic-polish intent. */
export function parsePromptIntent(model: Model, text: string): PromptIntent {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return { dimensions: [], isGenericPrompt: true };

  const grain = parseTimeGrainHint(trimmed);
  const chart = parseChartHint(trimmed);
  const includeTable = /\b(?:include|with|add|show)\s+(?:a\s+|the\s+|raw\s+|detail\s+|data\s+)?tables?\b/i.test(trimmed)
    ? true
    : undefined;
  const limitMatch = trimmed.match(/\b(?:top|limit)\s+(\d{1,3})\b/i);
  const parsedLimit = limitMatch ? Number(limitMatch[1]) : NaN;
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 500 ? parsedLimit : undefined;

  const matched = matchModel(model, trimmed);
  const byTable = metricsByTable(model);
  const defaultSubject =
    matched.subject && byTable[matched.subject]
      ? matched.subject
      : Object.entries(byTable)
          .sort(
            (a, b) =>
              Math.max(0, ...b[1].map((m) => m.importance ?? 0)) -
                Math.max(0, ...a[1].map((m) => m.importance ?? 0)) ||
              b[1].length - a[1].length,
          )[0]?.[0] ?? null;

  const reachableTables = new Set<string>();
  if (defaultSubject) {
    reachableTables.add(defaultSubject);
    for (const opt of joinedTableOptions(model, defaultSubject)) {
      if (!("error" in opt.path)) reachableTables.add(opt.table.name);
    }
  }

  const dimensions: string[] = [];
  const prepRe =
    /\b(?:broken\s+down\s+by|split\s+by|grouped\s+by|segmented\s+by|by|per|across)\s+([a-z0-9_][a-z0-9_\s/-]{0,48}?)(?=\s+(?:(?:and\s+)?(?:broken\s+down\s+by|split\s+by|grouped\s+by|by|per|across)|(?:and\s+)?(?:include|with|show|add)\s+(?:a\s+|the\s+|detail\s+)?table|top\s+\d+|limit\s+\d+|stacked\s+|grouped\s+|clustered\s+|horizontal\s+|donut\b|doughnut\b|waterfall\b|bridge\b|area\s+chart|bar\s+chart|line\s+chart|over\s+time|in\s+\d{4}|for\s+|from\s+|during\s+|where\b|what\b|how\b)|[,.?;!]|$)/gi;

  for (const m of trimmed.matchAll(prepRe)) {
    const rawClause = m[1]?.trim();
    if (!rawClause) continue;
    const subParts = rawClause.includes(" and ") || rawClause.includes("/")
      ? rawClause.split(/\s*(?:\/|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)
      : [rawClause];

    // If the whole clause matches a single column directly, prefer it; otherwise resolve each sub-part.
    const wholeMatch = subParts.length > 1 ? resolveDimensionPhrase(model, rawClause, reachableTables) : null;
    const candidates = wholeMatch && !subParts.every((p) => resolveDimensionPhrase(model, p, reachableTables))
      ? [wholeMatch]
      : subParts.map((p) => resolveDimensionPhrase(model, p, reachableTables)).filter((d): d is string => Boolean(d));

    for (const dim of candidates) {
      if (!dimensions.includes(dim)) dimensions.push(dim);
    }
  }

  const q = tokens(trimmed);
  const domainTokens = q.filter((t) => !GENERIC_PROMPT_TOKENS.has(t));
  const strongDomainHits = domainTokens.length
    ? Object.values(model.metrics).filter(
        (m) =>
          score(domainTokens, [
            { text: m.name, weight: 3 },
            { text: m.label, weight: 3 },
            { text: m.synonyms.join(" "), weight: 2.5 },
          ]) >= 2.5,
      ).length
    : 0;
  const isGenericPrompt = strongDomainHits === 0;

  return {
    ...(grain ? { grain } : {}),
    dimensions,
    ...(chart ? { chart } : {}),
    ...(includeTable ? { includeTable } : {}),
    ...(limit !== undefined ? { limit } : {}),
    isGenericPrompt,
  };
}

export interface Brief {
  text?: string;
  table?: string | null;
  metrics?: string[];
  grain?: string;
  audience?: "exec" | "operator" | "analyst";
  compare?: "prior" | "first";
  includeBreakdowns?: boolean;
  includeTable?: boolean;
}

export const DEFAULT_BRIEF: Brief = {
  audience: "exec", grain: "month", compare: "prior",
  includeBreakdowns: true, includeTable: false,
};
