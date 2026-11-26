import { z } from "zod";
import { dashboardSchema } from "../compiler/schema.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import { metricOf, fieldReachable, timeColumnOf, type Model } from "../semantic/model.ts";
import { validateTile } from "../compiler/compile.ts";
import { fieldKind, suggestedBindings, validateDashboard } from "../app/filters.ts";
import { matchModel, tokens } from "../suggest/match.ts";

export const REFERENCE_CHART_KINDS = [
  "kpi", "stat", "line", "area", "areaStacked",
  "bar", "barGrouped", "barStacked", "barH",
  "donut", "waterfall", "funnel", "heatmap", "combo",
  "map", "smallMultiples", "table", "scatter",
] as const;

const label = z.string().max(500);
export const referenceItemSchema = z.object({
  id: z.string().min(1).max(100), kind: z.enum(["metric", "heading", "text", "filter"]), label,
  metrics: z.array(label).max(6), dimensions: z.array(label).max(6),
  grain: z.enum(["none", "day", "week", "month", "quarter", "year"]),
  chart: z.enum(REFERENCE_CHART_KINDS),
  compare: z.enum(["none", "prior", "first"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1),
}).strict();
export const blueprintSchema = z.object({ title: z.string().min(1).max(300), pages: z.array(z.object({
  title: z.string().min(1).max(100), aspectRatio: z.number().min(0.15).max(6), items: z.array(referenceItemSchema).max(60),
}).strict()).min(1).max(6) }).strict().refine(b => {
  const ids = b.pages.flatMap(p => p.items.map(i => i.id)); return new Set(ids).size === ids.length;
}, "Reference item IDs must be unique");
export type Blueprint = z.infer<typeof blueprintSchema>;
export type ReferenceItem = z.infer<typeof referenceItemSchema>;
export type ReferenceMapping = Record<string, string>;

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const METRIC_CHROME_WORDS = new Set([
  "total", "totals", "sum", "avg", "average", "mean", "usd", "eur", "gbp", "cad", "aud",
  "mwh", "kwh", "gwh", "pct", "percent", "percentage", "dollar", "dollars", "currency",
  "kpi", "stat", "card", "chart", "trend", "daily", "weekly", "monthly", "quarterly", "yearly", "annual",
]);

const FIELD_CHROME_WORDS = new Set([
  "by", "per", "across", "in", "of", "the", "a", "an", "each", "every", "all",
  "total", "sum", "top", "bottom", "breakdown", "split", "grouped", "mix", "share",
]);

function stemLabelToken(word: string): string {
  const norm = tokens(word)[0] ?? word;
  if (norm.endsWith("ies") && norm.length > 4) return `${norm.slice(0, -3)}y`;
  if ((norm.endsWith("ses") || norm.endsWith("xes")) && norm.length > 4) return norm.slice(0, -2);
  if (norm.endsWith("s") && !norm.endsWith("ss") && norm.length > 3) return norm.slice(0, -1);
  return norm;
}

function cleanMetricTokens(s: string): string[] {
  const raw = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const filtered = raw.filter((w) => w.length >= 2 && !METRIC_CHROME_WORDS.has(w) && !/^(of|in|by|on|at|to|for|the|and)$/.test(w));
  return [...new Set(filtered.map(stemLabelToken))];
}

function stripMetricChromeNorm(s: string): string {
  const raw = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return raw.filter((w) => !METRIC_CHROME_WORDS.has(w) && w !== "of").join("");
}

export function metricMatches(model: Model, text: string): string[] {
  if (metricOf(model, text)) return [text];
  const norm = normalize(text);
  if (!norm) return [];
  const exact = Object.values(model.metrics)
    .filter(m => [m.name, m.label, ...m.synonyms].some(s => normalize(s) === norm))
    .map(m => m.name);
  if (exact.length) return exact;

  // Strip presentation chrome like "Total ... ($)" or "(USD)" before falling back to fuzzy scoring.
  const stripped = stripMetricChromeNorm(text);
  if (stripped.length >= 2) {
    const chromeExact = Object.values(model.metrics)
      .filter(m => [m.name, m.label, ...m.synonyms].some(s => stripMetricChromeNorm(s) === stripped))
      .map(m => m.name);
    if (chromeExact.length) return chromeExact;
  }

  const qTokens = cleanMetricTokens(text);
  if (!qTokens.length) return [];
  const wantsRecordCount = /\b(?:records?|rows?)\b/i.test(text);
  const modelScored = new Map(matchModel(model, text).metrics.map(r => [r.metric.name, r.score]));

  const ranked = Object.values(model.metrics)
    .filter(m => wantsRecordCount || (m.importance ?? 50) > 20)
    .map(m => {
      let bestF1 = 0;
      let bestRecall = 0;
      for (const cand of [m.name, m.label, ...m.synonyms]) {
        const cTokens = cleanMetricTokens(cand);
        if (!cTokens.length) continue;
        const cSet = new Set(cTokens);
        const overlap = qTokens.filter(t => cSet.has(t)).length;
        if (!overlap) continue;
        const precision = overlap / qTokens.length;
        const recall = overlap / cTokens.length;
        const f1 = (2 * precision * recall) / (precision + recall);
        if (f1 > bestF1 || (f1 === bestF1 && recall > bestRecall)) {
          bestF1 = f1;
          bestRecall = recall;
        }
      }
      const mScore = modelScored.get(m.name) ?? 0;
      const confidence = bestF1 + (bestRecall === 1 ? 0.08 : 0) + Math.min(0.08, mScore * 0.01);
      return { metric: m, f1: bestF1, recall: bestRecall, confidence };
    })
    .filter(r => r.f1 >= 0.6 || (r.recall === 1 && r.f1 >= 0.5))
    .sort((a, b) => b.confidence - a.confidence || (b.metric.importance ?? 0) - (a.metric.importance ?? 0));

  if (!ranked.length) return [];
  const [first, second] = ranked;
  if (second && first.confidence - second.confidence < 0.12 && (first.metric.importance ?? 50) === (second.metric.importance ?? 50)) {
    return ranked.filter(r => first.confidence - r.confidence < 0.12).map(r => r.metric.name);
  }
  return [first.metric.name];
}

function cleanFieldTokens(s: string): string[] {
  const raw = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(raw.filter(w => w.length >= 2 && !FIELD_CHROME_WORDS.has(w) && !/^\d+$/.test(w)).map(stemLabelToken))];
}

export function fieldMatches(model: Model, text: string): string[] {
  const fields = Object.values(model.tables).flatMap(t => t.columns.map(c => `${t.name}.${c.name}`));
  if (fields.includes(text)) return [text];
  const norm = normalize(text);
  if (!norm) return [];
  const exact = fields.filter(f => normalize(f) === norm || normalize(f.split(".")[1]) === norm);
  if (exact.length) return exact;

  // Extract dimension target from chart titles like "Sales by Store City" or "Active MRR by Plan".
  const afterBy = text.match(/\b(?:broken\s+down\s+by|split\s+by|grouped\s+by|by|per|across)\s+(.+)$/i)?.[1]?.trim();
  const candidatesToTry = afterBy ? [afterBy, text] : [text];
  const wantsId = /\b(?:id|ids|key|code|uuid)\b/i.test(afterBy ?? text);

  for (const phrase of candidatesToTry) {
    const pNorm = normalize(phrase);
    if (pNorm) {
      const subExact = fields.filter(f => normalize(f) === pNorm || normalize(f.split(".")[1]) === pNorm);
      if (subExact.length) return subExact;
    }

    const qTokens = cleanFieldTokens(phrase);
    if (!qTokens.length) continue;

    const scored: { field: string; score: number }[] = [];
    for (const table of Object.values(model.tables)) {
      const cleanTable = table.name.replace(/^(?:dim|fct)_/i, "");
      const tTokens = new Set([
        ...cleanFieldTokens(cleanTable),
        ...table.synonyms.flatMap(s => cleanFieldTokens(s)),
      ]);
      for (const col of table.columns) {
        if (/^_(import_id|loaded_at|source)$/.test(col.name)) continue;
        const isIdCol = /(?:^id$|_id$)/i.test(col.name);
        if (isIdCol && !wantsId) continue;

        const field = `${table.name}.${col.name}`;
        const strippedCol = col.name.replace(/_(?:name|label|title)$/i, "");
        const colTokens = cleanFieldTokens(col.name);
        const coreColTokens = cleanFieldTokens(strippedCol);
        const effectiveColTokens = coreColTokens.length ? coreColTokens : colTokens;
        if (!effectiveColTokens.length) continue;

        const colSet = new Set([...colTokens, ...effectiveColTokens]);
        const tableAndColSet = new Set([...tTokens, ...colSet]);
        const colOverlap = qTokens.filter(t => colSet.has(t)).length;
        const fullOverlap = qTokens.filter(t => tableAndColSet.has(t)).length;
        if (!colOverlap) continue;

        const colRecall = Math.min(1, colOverlap / effectiveColTokens.length);
        const precision = fullOverlap / qTokens.length;
        const f1 = (2 * precision * colRecall) / (precision + colRecall);
        if (f1 < 0.6) continue;

        const nameBonus = /_name$/i.test(col.name) && !qTokens.includes("tier") ? 0.05 : 0;
        const tableMatchBonus = fullOverlap > colOverlap ? 0.12 : 0;
        scored.push({ field, score: f1 + tableMatchBonus + nameBonus });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length) {
      const [first, second] = scored;
      if (second && first.score - second.score < 0.08) {
        return scored.filter(s => first.score - s.score < 0.08).map(s => s.field);
      }
      return [first.field];
    }
  }

  return [];
}

export function initialMapping(blueprint: Blueprint, model: Model): ReferenceMapping {
  const mapping: ReferenceMapping = {};
  for (const item of blueprint.pages.flatMap(p => p.items)) {
    item.metrics.forEach((m, i) => { const matches = metricMatches(model, m); mapping[`${item.id}:m${i}`] = matches.length === 1 ? matches[0] : ""; });
    item.dimensions.forEach((d, i) => { const matches = fieldMatches(model, d); mapping[`${item.id}:d${i}`] = matches.length === 1 ? matches[0] : ""; });
  }
  return mapping;
}

const GRID_COLS = 12;
const ROW_BAND_TOLERANCE = 0.045;

function snapPageLayout(
  items: { item: ReferenceItem; minH: number }[],
  width: number,
  height: number,
  pad = 24,
  gap = 16,
): Map<string, { x: number; y: number; w: number; h: number }> {
  const layouts = new Map<string, { x: number; y: number; w: number; h: number }>();
  if (!items.length) return layouts;

  const avail = Math.max(100, width - pad * 2);
  const railX = (col: number) => Math.round(pad + (col * (avail + gap)) / GRID_COLS);
  const minSpan = Math.min(GRID_COLS, Math.max(1, Math.ceil(((100 + gap) * GRID_COLS) / (avail + gap))));

  // Sort by normalized y, then x, to detect horizontal row bands cleanly.
  const ordered = [...items].sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);
  const bands: { item: ReferenceItem; minH: number }[][] = [];

  for (const entry of ordered) {
    const prevBand = bands[bands.length - 1];
    if (!prevBand) {
      bands.push([entry]);
      continue;
    }
    const anchorY = prevBand[0].item.y;
    const withinY = Math.abs(entry.item.y - anchorY) <= ROW_BAND_TOLERANCE;
    const headingCollision =
      withinY &&
      prevBand.some(p => {
        const xOverlap = Math.min(p.item.x + p.item.w, entry.item.x + entry.item.w) - Math.max(p.item.x, entry.item.x);
        return (p.item.kind === "heading" || entry.item.kind === "heading") && xOverlap > 0.1;
      });
    if (withinY && !headingCollision) {
      prevBand.push(entry);
    } else {
      bands.push([entry]);
    }
  }

  let prevBottom = pad - gap;
  for (const band of bands) {
    band.sort((a, b) => a.item.x - b.item.x);
    // Split into sub-rows only when more items share a band than can fit at minSpan across 12 columns.
    const maxPerRow = Math.max(1, Math.floor(GRID_COLS / minSpan));
    for (let offset = 0; offset < band.length; offset += maxPerRow) {
      const subRow = band.slice(offset, offset + maxPerRow);
      const rawY = Math.round(Math.min(...subRow.map(e => e.item.y)) * height) + pad;
      const rowY = Math.max(rawY, prevBottom + gap);
      const rowH = Math.max(...subRow.map(e => Math.max(e.minH, Math.round(e.item.h * height))));

      // Snap each item's normalized (x, w) onto 12-column spans [c0, c1), then resolve any column collisions.
      const desired = subRow.map(({ item }) => {
        const c0 = Math.max(0, Math.min(GRID_COLS - minSpan, Math.round(item.x * GRID_COLS)));
        const rawEnd = Math.round((item.x + Math.min(item.w, 1 - item.x)) * GRID_COLS);
        const c1 = Math.max(c0 + minSpan, Math.min(GRID_COLS, rawEnd));
        return { id: item.id, c0, c1, span: c1 - c0, rawW: item.w };
      });

      const hasColOverlap = desired.some((d, i) => i > 0 && d.c0 < desired[i - 1].c1);
      if (hasColOverlap) {
        const totalDesiredSpan = desired.reduce((s, d) => s + d.span, 0);
        if (totalDesiredSpan <= GRID_COLS) {
          // Shift colliding spans right first, then clamp from the right edge backward so spans stay intact.
          for (let i = 1; i < desired.length; i++) {
            if (desired[i].c0 < desired[i - 1].c1) {
              desired[i].c0 = desired[i - 1].c1;
              desired[i].c1 = desired[i].c0 + desired[i].span;
            }
          }
          if (desired[desired.length - 1].c1 > GRID_COLS) {
            desired[desired.length - 1].c1 = GRID_COLS;
            desired[desired.length - 1].c0 = GRID_COLS - desired[desired.length - 1].span;
            for (let i = desired.length - 2; i >= 0; i--) {
              if (desired[i].c1 > desired[i + 1].c0) {
                desired[i].c1 = desired[i + 1].c0;
                desired[i].c0 = desired[i].c1 - desired[i].span;
              }
            }
          }
        } else {
          // Proportionally distribute all 12 columns across the row items according to their sketched widths.
          const weightSum = desired.reduce((s, d) => s + d.rawW, 0) || desired.length;
          const spans = desired.map(d => Math.max(minSpan, Math.round((d.rawW / weightSum) * GRID_COLS)));
          let excess = spans.reduce((a, b) => a + b, 0) - GRID_COLS;
          while (excess > 0) {
            let widestIdx = -1;
            for (let i = 0; i < spans.length; i++) {
              if (spans[i] > minSpan && (widestIdx === -1 || spans[i] > spans[widestIdx])) widestIdx = i;
            }
            if (widestIdx === -1) break;
            spans[widestIdx]--;
            excess--;
          }
          let deficit = GRID_COLS - spans.reduce((a, b) => a + b, 0);
          for (let i = 0; deficit > 0; i = (i + 1) % spans.length) {
            spans[i]++;
            deficit--;
          }
          let cursor = 0;
          for (let i = 0; i < desired.length; i++) {
            desired[i].c0 = cursor;
            desired[i].c1 = cursor + spans[i];
            cursor += spans[i];
          }
        }
      }

      for (const d of desired) {
        const x = railX(d.c0);
        const w = Math.max(100, Math.min(width - x - pad, railX(d.c1) - gap - x));
        layouts.set(d.id, { x, y: rowY, w, h: rowH });
      }
      prevBottom = rowY + rowH;
    }
  }

  return layouts;
}

/** Every rendered chart compiles against the catalogue. Unresolved content stays visibly unresolved. */
export function buildReference(blueprint: Blueprint, mapping: ReferenceMapping, model: Model, width = 1200) {
  const notes: { id: string; status: "ready" | "adjusted" | "unresolved"; message: string }[] = [];
  const spec: DashboardSpec = { title: blueprint.title, tabs: blueprint.pages.map((p, i) => ({ id: `reference-page-${i + 1}`, title: p.title })), tiles: [], filters: [] };

  for (const [pageIndex, page] of blueprint.pages.entries()) {
    const tabId = spec.tabs![pageIndex].id, height = width / page.aspectRatio;
    const prepared: { item: ReferenceItem; tile: Omit<TileSpec, "layout">; minH: number }[] = [];

    for (const item of page.items) {
      const tileId = `reference-${item.id}`;
      const base: Omit<TileSpec, "layout"> = { id: tileId, tabId, title: item.label, metrics: [], dimensions: [] };
      if (item.kind === "heading" || item.kind === "text") {
        prepared.push({
          item,
          minH: item.kind === "heading" ? 48 : 100,
          tile: { ...base, kind: item.kind, text: item.label, format: { textSize: item.kind === "heading" ? 26 : 14, background: false, border: false } },
        });
        continue;
      }
      if (item.kind === "filter") {
        const field = mapping[`${item.id}:d0`], control = fieldKind(model, field ?? "");
        if (control) {
          spec.filters!.push({ id: tileId, label: item.label.slice(0, 100) || "Filter", field, control, scope: "tab", tabId, bindings: [] });
          notes.push({ id: item.id, status: "ready", message: "Filter matched. Connections use this field on this tab." });
          prepared.push({ item, minH: 150, tile: { ...base, kind: "filter", filterId: tileId } });
          continue;
        }
      } else {
        const metrics = item.metrics.map((_, i) => mapping[`${item.id}:m${i}`]), fields = item.dimensions.map((_, i) => mapping[`${item.id}:d${i}`]);
        const valid = metrics.length > 0 && metrics.every(m => !!metricOf(model, m)) && fields.every(f => !!f && fieldReachable(model, metricOf(model, metrics[0])?.baseTable ?? "", f));
        if (valid) {
          const dimensions = fields.map(f => fieldKind(model, f) === "date" && item.grain !== "none" ? `${item.grain}:${f}` : f);
          const candidate: TileSpec = {
            ...base,
            metrics,
            dimensions,
            chart: item.chart,
            ...(item.limit !== undefined ? { limit: item.limit } : {}),
            layout: { x: 24, y: 24, w: 200, h: 200 },
          };
          const native = metricOf(model, metrics[0]).timeGrains;
          let adjusted = "";
          if (!dimensions.length && native?.length) {
            const time = timeColumnOf(model, metricOf(model, metrics[0]).baseTable);
            if (time) { candidate.dimensions = [`${native[0]}:${time}`]; adjusted = `Uses the metric’s native ${native[0]} reporting period.`; }
          }
          const timeDims = candidate.dimensions.filter(d => d.includes(":"));
          if (item.compare === "none") {
            candidate.compare = "none";
          } else if (item.compare === "prior" && timeDims.length === 1) {
            candidate.compare = "prior";
            if (item.chart === "kpi" || item.chart === "stat") candidate.spark = { compare: "prior" };
          } else if (item.compare === "first") {
            candidate.spark = { compare: "first" };
          }

          const issues = validateTile(model, candidate);
          if (!issues.length) {
            const { layout: _tmpLayout, ...rest } = candidate;
            notes.push({ id: item.id, status: adjusted ? "adjusted" : "ready", message: adjusted || "Matched to the semantic catalogue." });
            prepared.push({ item, minH: item.chart === "kpi" || item.chart === "stat" ? 156 : 240, tile: rest });
            continue;
          }
          notes.push({ id: item.id, status: "unresolved", message: issues[0].problem });
        }
      }
      if (!notes.some(n => n.id === item.id)) notes.push({ id: item.id, status: "unresolved", message: "Choose catalogue matches, or keep this space as a placeholder." });
      prepared.push({
        item,
        minH: 100,
        tile: { ...base, kind: "text", text: `Needs a catalogue match\n${item.label}`, format: { textSize: 16 } },
      });
    }

    const snapped = snapPageLayout(
      prepared.map(({ item, minH }) => ({ item, minH })),
      width,
      height,
    );
    for (const { item, tile } of prepared) {
      spec.tiles.push({ ...tile, layout: snapped.get(item.id)! });
    }
  }
  for (const f of spec.filters!) f.bindings = suggestedBindings(spec, model, f.field, f.scope, f.tabId!);
  const parsed = dashboardSchema.parse(spec), issues = validateDashboard(model, parsed);
  if (issues.length) throw new Error(issues[0].problem);
  return { spec: parsed, notes, height: Math.ceil(Math.max(800, ...parsed.tiles.map(t => t.layout.y + t.layout.h + 24))) };
}

/** Built-in sample blueprints so users without an AI key can test Recreate-from-Reference in 1 click. */
export const SAMPLE_REFERENCE_BLUEPRINTS: {
  id: string;
  label: string;
  summary: string;
  targetModelHint: "saas" | "roastery" | "any";
  blueprint: Blueprint;
}[] = [
  {
    id: "saas-board-slide",
    label: "Board Revenue & Retention Slide",
    summary: "Executive SaaS board slide with Ending MRR, NRR & CAC KPIs, Net New MRR waterfall bridge, and active MRR by plan.",
    targetModelHint: "saas",
    blueprint: {
      title: "Board Revenue & Retention Slide",
      pages: [
        {
          title: "Board Summary",
          aspectRatio: 1.6,
          items: [
            {
              id: "saas-slide-heading",
              kind: "heading",
              label: "Board Revenue & Retention Overview",
              metrics: [],
              dimensions: [],
              grain: "none",
              chart: "kpi",
              x: 0,
              y: 0.02,
              w: 1,
              h: 0.06,
            },
            {
              id: "saas-kpi-ending-mrr",
              kind: "metric",
              label: "Ending MRR",
              metrics: ["Total Ending MRR ($)"],
              dimensions: ["fct_saas_monthly.month"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0,
              y: 0.1,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "saas-kpi-nrr",
              kind: "metric",
              label: "Net Revenue Retention",
              metrics: ["Net revenue retention"],
              dimensions: ["fct_saas_monthly.month"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0.335,
              y: 0.11,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "saas-kpi-cac",
              kind: "metric",
              label: "Customer Acquisition Cost",
              metrics: ["CAC (USD)"],
              dimensions: ["fct_saas_monthly.month"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0.67,
              y: 0.105,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "saas-ending-mrr-trend",
              kind: "metric",
              label: "Ending MRR Trajectory",
              metrics: ["Ending MRR (USD)"],
              dimensions: ["fct_saas_monthly.month"],
              grain: "month",
              chart: "area",
              x: 0,
              y: 0.31,
              w: 1,
              h: 0.3,
            },
            {
              id: "saas-mrr-waterfall",
              kind: "metric",
              label: "Net New MRR Bridge",
              metrics: ["Net new MRR (USD)"],
              dimensions: ["fct_mrr_movements.movement_type"],
              grain: "none",
              chart: "waterfall",
              x: 0,
              y: 0.64,
              w: 0.5,
              h: 0.34,
            },
            {
              id: "saas-mrr-by-plan",
              kind: "metric",
              label: "Active MRR by Plan",
              metrics: ["MRR (USD)"],
              dimensions: ["dim_plans.plan_name"],
              grain: "none",
              chart: "barH",
              limit: 10,
              x: 0.5,
              y: 0.65,
              w: 0.5,
              h: 0.34,
            },
          ],
        },
      ],
    },
  },
  {
    id: "roastery-weekly-ops",
    label: "Store Operations & Margin Sketch",
    summary: "Specialty coffee whiteboard sketch pairing Net Sales, Cups Sold & Bean Cost with Store City and Drink Category breakdowns.",
    targetModelHint: "roastery",
    blueprint: {
      title: "Store Operations & Margin Sketch",
      pages: [
        {
          title: "Store Operations",
          aspectRatio: 1.6,
          items: [
            {
              id: "roastery-sketch-heading",
              kind: "heading",
              label: "Store Operations & Margin",
              metrics: [],
              dimensions: [],
              grain: "none",
              chart: "kpi",
              x: 0,
              y: 0.02,
              w: 1,
              h: 0.06,
            },
            {
              id: "roastery-kpi-sales",
              kind: "metric",
              label: "Total Net Sales ($)",
              metrics: ["Total Net Sales ($)"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0,
              y: 0.1,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "roastery-kpi-cups",
              kind: "metric",
              label: "Cups Sold",
              metrics: ["Cups Sold"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0.335,
              y: 0.115,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "roastery-kpi-bean-cost",
              kind: "metric",
              label: "Bean Cost ($)",
              metrics: ["Bean Cost ($)"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0.67,
              y: 0.105,
              w: 0.33,
              h: 0.18,
            },
            {
              id: "roastery-sales-trend",
              kind: "metric",
              label: "Monthly Net Sales Trend",
              metrics: ["Total Net Sales ($)"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "line",
              x: 0,
              y: 0.31,
              w: 1,
              h: 0.3,
            },
            {
              id: "roastery-sales-by-city",
              kind: "metric",
              label: "Sales by Store City",
              metrics: ["Total Net Sales ($)"],
              dimensions: ["Sales by Store City"],
              grain: "none",
              chart: "barH",
              limit: 5,
              x: 0,
              y: 0.64,
              w: 0.5,
              h: 0.34,
            },
            {
              id: "roastery-cost-by-category",
              kind: "metric",
              label: "Bean Cost by Drink Category",
              metrics: ["Bean Cost ($)"],
              dimensions: ["cafe_orders.drink_category"],
              grain: "none",
              chart: "donut",
              x: 0.5,
              y: 0.65,
              w: 0.5,
              h: 0.34,
            },
          ],
        },
      ],
    },
  },
];
