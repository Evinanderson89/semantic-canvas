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
  "give build make please can you").split(" "));

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function score(needle: string[], haystacks: { text: string; weight: number }[]): number {
  let total = 0;
  for (const { text, weight } of haystacks) {
    const hay = text.toLowerCase();
    for (const t of needle) {
      if (!hay.includes(t)) continue;
      // Whole-word hits count for more than substring hits.
      total += new RegExp(`\\b${t}\\b`).test(hay) ? weight : weight * 0.4;
    }
  }
  return total;
}

export interface Matches {
  metrics: { metric: Metric; score: number }[];
  tables: { table: Table; score: number }[];
  /** Highest-scoring base table across matched metrics, if any. */
  subject: string | null;
}

export function matchModel(model: Model, text: string): Matches {
  const q = tokens(text);
  if (!q.length) return { metrics: [], tables: [], subject: null };

  const metrics = Object.values(model.metrics)
    .map((m) => ({ metric: m, score: score(q, [
      { text: m.name, weight: 3 },
      { text: m.label, weight: 3 },
      { text: m.synonyms.join(" "), weight: 2.5 },
      { text: m.description ?? "", weight: 1 },
    ]) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const tables = Object.values(model.tables)
    .map((t) => ({ table: t, score: score(q, [
      { text: t.name, weight: 2 },
      { text: t.synonyms.join(" "), weight: 2.5 },
      { text: t.grain ?? "", weight: 1 },
      { text: t.description ?? "", weight: 0.8 },
    ]) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // The subject is where the matched metrics actually live, weighted by score --
  // more reliable than matching a table name directly, because people name
  // measures ("churn") far more often than tables ("fct_mrr_movements").
  const byBase = new Map<string, number>();
  for (const { metric, score: s } of metrics)
    byBase.set(metric.baseTable, (byBase.get(metric.baseTable) ?? 0) + s);
  for (const { table, score: s } of tables)
    byBase.set(table.name, (byBase.get(table.name) ?? 0) + s * 0.6);

  const subject = [...byBase.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { metrics, tables, subject };
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
