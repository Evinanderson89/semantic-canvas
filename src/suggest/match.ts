import type { Metric, Model, Table } from "../semantic/model.ts";

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
