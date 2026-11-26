import type { ChartKind, DashboardSpec, TileSpec } from "../compiler/spec.ts";
import { metricOf, timeColumnOf, metricsByTable, prettifyModelName, reviewedModel, isLineage, joinedTableOptions, periodRollupAllowed, isCrossTableRatio, fieldReachable, type Model, type Metric, type Table } from "../semantic/model.ts";
import { DEFAULT_BRIEF, matchModel, parsePromptIntent, tokens, type Brief } from "./match.ts";
import { requiredDimensions } from "./prepareTile.ts";

function categoricalDims(t: Table | undefined): string[] {
  return (t?.columns ?? []).filter(c => /^(string|varchar|text|bool)/i.test(c.type) && !/(_id$|^id$)/.test(c.name) && !isLineage(c)).map(c => c.name);
}

function isRetentionMetric(m: Metric): boolean {
  const hay = [m.name, m.label, ...(m.synonyms ?? [])].join(" ").toLowerCase();
  return /(?:^|[^a-z])(?:nrr|grr|ndr)(?:$|[^a-z])|retention/.test(hay);
}

function trendFormatForMetric(m: Metric): TileSpec["format"] | undefined {
  if (isRetentionMetric(m)) {
    return { lineScale: "fit", referenceLines: [{ label: "100% parity", value: 1 }] };
  }
  return undefined;
}

function effectiveImportance(m: Metric): number {
  return m.importance ?? 50;
}

function rankFallbackSubject(byTable: Record<string, Metric[]>): string | undefined {
  return Object.entries(byTable).sort(
    (a, b) =>
      Math.max(0, ...b[1].map((m) => m.importance ?? 0)) -
        Math.max(0, ...a[1].map((m) => m.importance ?? 0)) ||
      b[1].length - a[1].length,
  )[0]?.[0];
}

const BREAKDOWN_CHART_HINTS = new Set<ChartKind>(["barStacked", "barGrouped", "donut", "waterfall", "bar", "barH"]);
const TREND_CHART_HINTS = new Set<ChartKind>(["area", "areaStacked", "line"]);

/** A useful first draft has a subject, a focal point and supporting sections. */
export function suggestDashboard(full: Model, opts: { table?: string | null; grain?: string; width?: number } & Brief = {}): DashboardSpec {
  // Ingested-but-unreviewed tables never make it into a proposal, whoever asks.
  const model = reviewedModel(full);
  const width = opts.width ?? 1440, available = width - 48, gap = 16;
  const byTable = metricsByTable(model);
  const hasPrompt = Boolean(opts.text?.trim());
  const intent = hasPrompt ? parsePromptIntent(model, opts.text!) : null;
  const matched = hasPrompt && !intent?.isGenericPrompt ? matchModel(model, opts.text!) : null;
  const effectiveGrain = opts.grain ?? intent?.grain ?? "month";
  const includeTable = Boolean(opts.includeTable || intent?.includeTable);

  const subject = opts.table && byTable[opts.table]
    ? opts.table
    : matched?.subject && byTable[matched.subject]
      ? matched.subject
      : rankFallbackSubject(byTable);
  if (!subject) return { title: prettifyModelName(model.name), tiles: [] };
  const allSubjectMetrics = [...byTable[subject]].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const realSubjectMetrics = allSubjectMetrics.filter((m) => effectiveImportance(m) > 20);
  const metrics = realSubjectMetrics.length >= 2 ? realSubjectMetrics : allSubjectMetrics;
  const rawSelected = (opts.metrics ?? []).map(n => metricOf(model, n)).filter((m): m is Metric => Boolean(m));
  const realSelected = rawSelected.filter((m) => effectiveImportance(m) > 20);
  // Keep explicit selection order among real business metrics, demoting/excluding synthetic fallback row counts (importance <= 20)
  // whenever >= 2 business metrics exist (while honoring a fallback metric when explicitly requested on its own).
  const selected =
    rawSelected.length === 0
      ? []
      : realSelected.length >= 2
        ? realSelected
        : realSelected.length === 1 && rawSelected.length > 1
          ? [...realSelected, ...rawSelected.filter((m) => effectiveImportance(m) <= 20)]
          : rawSelected;
  const cap = opts.audience === "analyst" ? 6 : opts.audience === "operator" ? 4 : 3;
  const rawMatchedOnSubject = matched?.matchedByTable[subject] ?? [];
  const matchedOnSubject =
    realSubjectMetrics.length >= 2 && rawMatchedOnSubject.some((m) => effectiveImportance(m) > 20)
      ? rawMatchedOnSubject.filter((m) => effectiveImportance(m) > 20)
      : realSubjectMetrics.length >= 2 && rawMatchedOnSubject.every((m) => effectiveImportance(m) <= 20)
        ? []
        : rawMatchedOnSubject;
  const headline = selected.length
    ? selected
    : matchedOnSubject.length
      ? [...matchedOnSubject].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, cap)
      : metrics.slice(0, cap);
  const tiles: TileSpec[] = [];
  let y = 24, sequence = 0, section = "";
  const id = () => `t${++sequence}`;
  const begin = (text: string) => {
    section = id();
    tiles.push({ id: section, kind: "heading", title: text, text, metrics: [], dimensions: [],
      format: { textSize: 21, background: false, border: false }, layout: { x: 24, y, w: available, h: 44 } });
    y += 56;
  };
  const dimensions = (m: Metric) => {
    const time = m.timeDimension ?? (isCrossTableRatio(model, m) ? metricOf(model, m.numerator!)?.timeDimension : undefined) ?? timeColumnOf(model, m.baseTable);
    const requested = ["day", "week", "month", "quarter", "year"].includes(effectiveGrain) ? effectiveGrain : "month";
    const required = requiredDimensions(model, [m.name], [], requested);
    if (required.length) return required;
    let grain = m.timeGrains ? m.timeGrains.find(g => g === requested) ?? m.timeGrains[0] : requested;
    const period = model.tables[m.baseTable]?.period;
    if (period && time === `${m.baseTable}.${period.column}` && !periodRollupAllowed(period.grain, grain)) grain = period.grain;
    return time ? [`${grain}:${time}`] : [];
  };
  begin("At a glance");
  const cols = Math.max(1, Math.min(headline.length, Math.floor((available + gap) / 196)));
  headline.forEach((m, i) => {
    const count = Math.min(cols, headline.length - Math.floor(i / cols) * cols);
    const w = Math.floor((available - gap * (count - 1)) / count);
    tiles.push({ id: id(), section, title: m.label, metrics: [m.name], dimensions: dimensions(m),
      chart: dimensions(m).length ? "kpi" : "stat", spark: opts.compare ? { compare: opts.compare } : undefined,
      layout: { x: 24 + (i % cols) * (w + gap), y: y + Math.floor(i / cols) * 172, w, h: 156 } });
  });
  y += Math.ceil(headline.length / cols) * 172 + 24;

  // Pre-compute breakdown eligibility so chart hints without categorical targets can fall back to the primary trend.
  const breakdownMetric = [...headline.filter(m => !requiredDimensions(model, [m.name], []).length)]
    .sort((a, b) => effectiveImportance(b) - effectiveImportance(a))[0];
  const explicitCats = breakdownMetric
    ? (intent?.dimensions ?? []).filter((d) => fieldReachable(model, breakdownMetric.baseTable, d))
    : [];
  const defaultCats = breakdownMetric
    ? (() => {
        const base = breakdownMetric.baseTable;
        const localCats = categoricalDims(model.tables[base]);
        const joinedCats = joinedTableOptions(model, base).flatMap(({ table, path }) =>
          "error" in path ? [] : categoricalDims(table).map(c => `${table.name}.${c}`));
        return [
          ...localCats.filter(c => c === "movement_type"),
          ...joinedCats,
          ...localCats.filter(c => c !== "movement_type"),
        ];
      })()
    : [];
  const canonicalDim = (base: string, d: string) => (d.includes(".") ? d : `${base}.${d}`);
  const mergedCats: string[] = [];
  if (opts.includeBreakdowns !== false && breakdownMetric) {
    const seen = new Set<string>();
    for (const d of [...explicitCats, ...defaultCats]) {
      const key = canonicalDim(breakdownMetric.baseTable, d);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedCats.push(d);
    }
  }
  const cats = mergedCats.slice(0, Math.min(3, Math.max(2, explicitCats.length)));

  const trendChart: ChartKind =
    intent?.chart && TREND_CHART_HINTS.has(intent.chart)
      ? intent.chart
      : !cats.length && !matched?.companionTables.length && (intent?.chart === "barStacked" || intent?.chart === "barGrouped")
        ? intent.chart
        : "line";

  const trendableHeadline = headline.filter(m => dimensions(m).length);
  const primary = [...trendableHeadline].sort((a, b) => effectiveImportance(b) - effectiveImportance(a))[0];
  if (primary) {
    begin("How it's changing");
    const fmt = trendFormatForMetric(primary);
    tiles.push({ id: id(), section, title: `${primary.label} over time`, metrics: [primary.name], dimensions: dimensions(primary),
      chart: trendChart, ...(fmt ? { format: fmt } : {}), layout: { x: 24, y, w: available, h: 320 } });
    y += 360;
  }
  const hasMultipleBusinessMetrics =
    realSubjectMetrics.length >= 2 || headline.filter((m) => effectiveImportance(m) > 20).length >= 2;
  const supporting = headline.filter(
    m => m !== primary && dimensions(m).length && !(hasMultipleBusinessMetrics && effectiveImportance(m) <= 20),
  );
  if (supporting.length) {
    begin("Supporting context");
    const count = width < 960 ? 1 : 2;
    supporting.forEach((m, i) => {
      const rowCount = Math.min(count, supporting.length - Math.floor(i / count) * count);
      const w = Math.floor((available - gap * (rowCount - 1)) / rowCount);
      const fmt = trendFormatForMetric(m);
      const supChart: ChartKind = intent?.chart && TREND_CHART_HINTS.has(intent.chart) ? intent.chart : "line";
      tiles.push({ id: id(), section, title: `${m.label} over time`, metrics: [m.name], dimensions: dimensions(m),
        chart: supChart, ...(fmt ? { format: fmt } : {}), layout: { x: 24 + (i % count) * (w + gap), y: y + Math.floor(i / count) * 316, w, h: 300 } });
    });
    y += Math.ceil(supporting.length / count) * 316 + 24;
  }

  // Snapshot metrics cannot be summed across all dates into a categorical total.
  if (opts.includeBreakdowns !== false && breakdownMetric && cats.length) {
    const base = breakdownMetric.baseTable;
    begin("A closer look");
    for (const dim of cats) {
      const isMovementDim = dim === "movement_type" || dim.endsWith(".movement_type");
      const signedMovementMetric = isMovementDim
        ? (model.metrics.net_new_mrr?.baseTable === base ? model.metrics.net_new_mrr : breakdownMetric)
        : breakdownMetric;
      const chartKind: ChartKind = isMovementDim
        ? "waterfall"
        : intent?.chart && BREAKDOWN_CHART_HINTS.has(intent.chart)
          ? intent.chart
          : "barH";
      const qualifiedDim = isMovementDim && !dim.includes(".") ? `${base}.${dim}` : dim;
      const title = isMovementDim
        ? (base === "fct_mrr_movements" ? "MRR movements · signed contribution" : `${prettyTitle(base)} · signed contribution`)
        : `${signedMovementMetric.label} by ${dim.split(".").at(-1)?.replace(/_/g, " ")}`;
      tiles.push({
        id: id(),
        section,
        title,
        metrics: [signedMovementMetric.name],
        dimensions: [qualifiedDim],
        chart: chartKind,
        ...(intent?.limit !== undefined && !isMovementDim ? { limit: intent.limit } : {}),
        layout: { x: 24, y, w: available, h: 280 },
      });
      y += 296;
    }
  }

  // Cross-table companion charts when a natural-language prompt spans multiple tables
  // or asks about drivers / movements / bridges / plans / tiers / channels.
  if (matched) {
    const qTokens = new Set(tokens(opts.text ?? ""));
    const companions: Omit<TileSpec, "id" | "section" | "layout">[] = [];
    const alreadyHas = (metricName: string, dimName: string) =>
      tiles.some(t => t.metrics[0] === metricName && (t.dimensions[0] === dimName || t.dimensions[0] === dimName.split(".").at(-1)))
      || companions.some(c => c.metrics[0] === metricName && c.dimensions[0] === dimName);

    // 1. Movement bridge (waterfall) if a companion table or prompt asks about movements/drivers/changes
    const wantsMovement = qTokens.has("movement") || qTokens.has("change") || qTokens.has("churn")
      || qTokens.has("net_new_mrr") || qTokens.has("waterfall")
      || matched.companionTables[0] === "fct_mrr_movements" && !qTokens.has("channel");
    const movementTable = wantsMovement
      ? Object.values(model.tables).find(t =>
          t.columns.some(c => c.name === "movement_type") &&
          (matched.companionTables.includes(t.name) || qTokens.has("movement") || qTokens.has("change") || qTokens.has("net_new_mrr") || intent?.chart === "waterfall")
        )
      : undefined;
    if (movementTable && companions.length < 2) {
      const movMetrics = byTable[movementTable.name] ?? [];
      const movMetric = movMetrics.find(m => m.name === "net_new_mrr")
        ?? movMetrics.find(m => /net_new|movement|delta/.test(m.name) && !requiredDimensions(model, [m.name], []).length)
        ?? movMetrics.find(m => !requiredDimensions(model, [m.name], []).length);
      const movDim = `${movementTable.name}.movement_type`;
      if (movMetric && !alreadyHas(movMetric.name, movDim)) {
        companions.push({
          title: movementTable.name === "fct_mrr_movements"
            ? "MRR movements · signed contribution"
            : `${prettyTitle(movementTable.name)} · signed contribution`,
          metrics: [movMetric.name],
          dimensions: [movDim],
          chart: "waterfall",
        });
      }
    }

    // 2. Plan / tier / channel breakdown from companion table or joined dimension
    if (companions.length < 2) {
      const wantsPlanOrTier = matched.companionTables.includes("dim_plans") ||
        matched.companionTables.includes("fct_subscriptions") ||
        qTokens.has("plan") || qTokens.has("tier") ||
        Boolean(intent?.dimensions.some(d => d.startsWith("dim_plans.")));
      const planTable = model.tables.dim_plans;
      if (wantsPlanOrTier && planTable) {
        const explicitPlanDim = intent?.dimensions.find(d => d.startsWith("dim_plans."));
        const planCol = explicitPlanDim
          ?? (qTokens.has("tier") && planTable.columns.some(c => c.name === "plan_tier")
            ? "dim_plans.plan_tier"
            : planTable.columns.some(c => c.name === "plan_name")
              ? "dim_plans.plan_name"
              : planTable.columns.some(c => c.name === "plan_tier")
                ? "dim_plans.plan_tier"
                : categoricalDims(planTable)[0]
                  ? `dim_plans.${categoricalDims(planTable)[0]}`
                  : null);
        const candidates = [
          model.metrics.mrr,
          ...(matched.matchedByTable.fct_subscriptions ?? []),
          ...Object.values(model.metrics),
        ].filter((m): m is Metric => Boolean(m));
        const planMetric = candidates.find(m =>
          !requiredDimensions(model, [m.name], []).length &&
          fieldReachable(model, m.baseTable, planCol ?? "")
        );
        if (planCol && planMetric && !alreadyHas(planMetric.name, planCol)) {
          const isTier = planCol.endsWith("tier");
          const title = planMetric.name === "mrr" && planCol === "dim_plans.plan_name"
            ? "Active base-subscription MRR by plan"
            : `${planMetric.label} by ${planCol.split(".").at(-1)?.replace(/_/g, " ")}`;
          const compChart: ChartKind =
            intent?.chart && BREAKDOWN_CHART_HINTS.has(intent.chart) && intent.chart !== "waterfall"
              ? intent.chart
              : isTier ? "donut" : "barH";
          companions.push({
            title,
            metrics: [planMetric.name],
            dimensions: [planCol],
            chart: compChart,
            ...(intent?.limit !== undefined ? { limit: intent.limit } : {}),
          });
        }
      }
    }

    if (companions.length < 2) {
      const wantsChannel = matched.companionTables.includes("fct_marketing_spend") ||
        matched.companionTables.includes("fct_web_sessions") ||
        qTokens.has("channel") || qTokens.has("conversion");
      if (wantsChannel) {
        const channelTable = [model.tables.fct_marketing_spend, model.tables.fct_web_sessions]
          .find(t => t && t.columns.some(c => c.name === "channel") && (byTable[t.name]?.length ?? 0) > 0);
        const channelMetric = channelTable
          ? (matched.matchedByTable[channelTable.name]?.[0] ?? byTable[channelTable.name]?.[0])
          : undefined;
        if (channelTable && channelMetric && !requiredDimensions(model, [channelMetric.name], []).length) {
          const channelDim = `${channelTable.name}.channel`;
          if (!alreadyHas(channelMetric.name, channelDim)) {
            const compChart: ChartKind =
              intent?.chart && BREAKDOWN_CHART_HINTS.has(intent.chart) && intent.chart !== "waterfall" && intent.chart !== "donut"
                ? intent.chart
                : "barH";
            companions.push({
              title: `${channelMetric.label} by channel`,
              metrics: [channelMetric.name],
              dimensions: [channelDim],
              chart: compChart,
              ...(intent?.limit !== undefined ? { limit: intent.limit } : {}),
            });
          }
        }
      }
    }

    // 3. Any remaining companion table with matched metrics
    for (const compTable of matched.companionTables) {
      if (companions.length >= 2) break;
      const compMetric = matched.matchedByTable[compTable]?.[0] ?? byTable[compTable]?.[0];
      if (!compMetric) continue;
      if (companions.some(c => metricOf(model, c.metrics[0])?.baseTable === compTable)) continue;
      const compDims = dimensions(compMetric);
      if (compDims.length && !alreadyHas(compMetric.name, compDims[0])) {
        const fmt = trendFormatForMetric(compMetric);
        companions.push({
          title: `${compMetric.label} over time`,
          metrics: [compMetric.name],
          dimensions: compDims,
          chart: intent?.chart && TREND_CHART_HINTS.has(intent.chart) ? intent.chart : "line",
          ...(fmt ? { format: fmt } : {}),
        });
      }
    }

    if (companions.length) {
      begin("What is driving the change?");
      const count = width < 960 ? 1 : Math.min(2, companions.length);
      companions.slice(0, 2).forEach((c, i) => {
        const total = Math.min(2, companions.length);
        const rowCount = Math.min(count, total - Math.floor(i / count) * count);
        const w = Math.floor((available - gap * (rowCount - 1)) / rowCount);
        tiles.push({
          ...c,
          id: id(),
          section,
          layout: { x: 24 + (i % count) * (w + gap), y: y + Math.floor(i / count) * 336, w, h: 320 },
        });
      });
      y += Math.ceil(Math.min(2, companions.length) / count) * 336 + 24;
    }
  }

  if (includeTable) {
    begin("Behind the numbers");
    // Separate queries preserve each metric's native grain instead of forcing a mixed table.
    for (const m of headline) {
      tiles.push({
        id: id(),
        section,
        title: `${m.label} detail`,
        metrics: [m.name],
        dimensions: dimensions(m),
        chart: "table",
        ...(intent?.limit !== undefined ? { limit: intent.limit } : {}),
        layout: { x: 24, y, w: available, h: 300 },
      });
      y += 316;
    }
  }
  // Describe the generated headline queries, not the requested grain: metric
  // restrictions may change it, and an undated metric has no reporting period.
  const grainLabels: Record<string, string> = { day: "daily", week: "weekly", month: "monthly", quarter: "quarterly", year: "yearly" };
  const scope = tiles.filter(t => t.chart === "kpi" || t.chart === "stat").map(t => {
    const grain = t.dimensions.map(d => d.match(/^(day|week|month|quarter|year):/)?.[1]).find(Boolean);
    return `${t.title}: ${grain ? grainLabels[grain] : "no time grouping"}`;
  });

  if (tiles.length) {
    const usedBaseTables = [...new Set(
      tiles.flatMap(t => t.metrics).map(m => metricOf(model, m)?.baseTable).filter((t): t is string => Boolean(t))
    )];
    const joinedTables = [...new Set(
      tiles.flatMap(t => t.dimensions)
        .filter(d => !/^(day|week|month|quarter|year):/.test(d) && d.includes("."))
        .map(d => d.split(".")[0])
        .filter(t => !usedBaseTables.includes(t))
    )];
    const usedGrains = [...new Set(
      tiles.flatMap(t => t.dimensions)
        .map(d => d.match(/^(day|week|month|quarter|year):/)?.[1])
        .filter((g): g is string => Boolean(g))
    )];
    const hasSnapshotRules = tiles.flatMap(t => t.metrics).some(m => requiredDimensions(model, [m], []).length > 0);
    const hasWaterfall = tiles.some(t => t.chart === "waterfall");
    const tablesSummary = `Base tables: ${usedBaseTables.join(", ")}${joinedTables.length ? ` (joined with ${joinedTables.join(", ")})` : ""}.`;
    const grainsSummary = `Time grains: ${usedGrains.length ? usedGrains.map(g => `${g} (${grainLabels[g] ?? g})`).join(", ") : "no time grouping"}.`;
    const rulesSummary = [
      hasSnapshotRules
        ? "Snapshot and period-bound metrics are evaluated at their declared reporting grain and cannot be summed across periods into categorical totals."
        : "Metrics aggregate across their governed base table grain without cross-table fan-out.",
      hasWaterfall
        ? "Signed movement bridges keep contraction and churn negative to reconcile net changes."
        : "",
    ].filter(Boolean).join(" ");
    tiles.push({
      id: id(),
      section,
      kind: "text",
      title: "Scope & methodology note",
      text: `SCOPE & METHODOLOGY · ${tablesSummary} ${grainsSummary} ${rulesSummary}`,
      metrics: [],
      dimensions: [],
      format: { textSize: 14, background: false, border: false },
      layout: { x: 24, y, w: available, h: 76 },
    });
    y += 92;
  }

  return {
    title: opts.text?.trim() ? opts.text.trim().replace(/^\w/, c => c.toUpperCase()).slice(0, 70) : `${prettyTitle(subject)} Dashboard`,
    description: `${scope.join("; ")}. Reporting windows and filters can differ between charts.`, tiles,
  };
}

/** Compose a multi-table executive story dashboard from a natural-language prompt or Brief. */
export function composeExecutiveBrief(
  full: Model,
  promptOrOpts: string | ({ table?: string | null; grain?: string; width?: number } & Brief) = {},
  extraOpts: { table?: string | null; grain?: string; width?: number } & Brief = {},
): DashboardSpec {
  const explicitGrain = typeof promptOrOpts === "string" ? extraOpts.grain : promptOrOpts.grain;
  const opts = typeof promptOrOpts === "string"
    ? { ...DEFAULT_BRIEF, ...extraOpts, grain: explicitGrain, text: promptOrOpts }
    : { ...DEFAULT_BRIEF, ...promptOrOpts, grain: explicitGrain };
  return suggestDashboard(full, opts);
}

export function emptyDashboard(_model: Model): DashboardSpec { return { title: "Untitled dashboard", description: "", tiles: [] }; }
function prettyTitle(name: string) {
  return name.replace(/^(fct|dim)_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSaas\b/g, "SaaS").replace(/\bMrr\b/g, "MRR");
}
