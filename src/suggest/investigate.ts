import { tileSchema } from "../compiler/schema.ts";
import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { validateTile } from "../compiler/compile.ts";
import {
  dimensionsOf,
  fieldReachable,
  isAdditiveMetric,
  isNumeric,
  isTemporal,
  metricComponents,
  metricOf,
  metricType,
  timeColumnOf,
  type Model,
} from "../semantic/model.ts";
import { visibleQuery } from "../app/query.ts";
import type { DrillEntry } from "../app/drill.ts";
import { humanDimensionName, isDimensionReferencedInMetric } from "./drivers.ts";
import { requiredDimensions } from "./prepareTile.ts";

export type InvestigationResult = { columns: string[]; rows: unknown[][] };

export type SubdetailRole = "headline" | "bridge" | "mix" | "pace" | "ledger";

export interface InvestigationOption {
  id: string;
  label: string;
  reason: string;
  tile: TileSpec;
  summary?: string;
  period?: string;
  role: SubdetailRole;
  kicker: string;
  question: string;
  chartLabel: string;
  dimensionField?: string;
}

export interface StoryArc {
  id: "executive-pulse" | "why-it-moved" | "stakeholder-audit";
  label: string;
  audience: string;
  description: string;
  title: string;
  subtitle: string;
  layout: "grid" | "focus";
  views: string[];
}

export interface RankedSubdetail {
  option: InvestigationOption;
  active: boolean;
  driverBadge?: string;
  score: number;
}

/** Human-friendly period label (`2026-08-01` at `month` -> `Aug 2026`). */
export function formatPeriodHuman(isoDate: string, grain = "month"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(+dt)) return isoDate;
  if (grain === "year") return String(dt.getUTCFullYear());
  if (grain === "quarter") {
    const q = Math.floor(dt.getUTCMonth() / 3) + 1;
    return `Q${q} ${dt.getUTCFullYear()}`;
  }
  if (grain === "day" || grain === "week") {
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  return dt.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Humanize raw warehouse enum/boolean segment tokens (`true` on `is_active` -> `Active accounts`, `ios` -> `iOS`). */
export function humanSegmentLabel(rawValue: string, dimensionField?: string): string {
  const col = dimensionField?.split(".").at(-1) ?? "";
  const lower = rawValue.trim().toLowerCase();
  if (lower === "true" || lower === "false") {
    if (col === "is_active") return lower === "true" ? "Active accounts" : "Inactive accounts";
    if (col === "converted") return lower === "true" ? "Converted" : "Did not convert";
    return lower === "true" ? "Yes" : "No";
  }
  const known: Record<string, string> = {
    ios: "iOS",
    android: "Android",
    web: "Web",
    paid_search: "Paid search",
    organic: "Organic",
    social: "Social",
    referral: "Referral",
    direct: "Direct",
    email: "Email",
    us: "US",
    uk: "UK",
    gb: "GB",
    ca: "CA",
    au: "AU",
    de: "DE",
    fr: "FR",
  };
  if (known[lower]) return known[lower];
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(rawValue)) {
    const words = rawValue.replace(/_/g, " ");
    return words[0].toUpperCase() + words.slice(1);
  }
  if (/^[a-z]{3,}$/.test(rawValue)) {
    return rawValue[0].toUpperCase() + rawValue.slice(1);
  }
  return rawValue;
}

/** Freeze the displayed time window as well as the filters. Changing a GROUP BY
 * must not turn a limited latest window into a different reporting period. */
export function investigationContext(
  model: Model,
  source: TileSpec,
  filters: FilterSpec[],
  drill: DrillEntry[],
  result: InvestigationResult,
) {
  const needsHistory = source.metrics.some((name) => {
    const metric = metricOf(model, name);
    return (
      metric &&
      (metricType(metric) === "cumulative" ||
        [metric, ...metricComponents(model, metric)].some((m) => /\bOVER\s*\(/i.test(m.expression)))
    );
  });
  if (needsHistory) {
    throw new Error(
      "This metric depends on earlier periods. A new reporting window could reset its calculation. Inspect or export the original chart’s values instead.",
    );
  }
  const query = visibleQuery(model, source, filters, drill);
  const time = query.dimensions.find((d) => d.includes(":"));
  const where = structuredClone(query.where);
  let latestWindow: FilterSpec | undefined;
  let period = "No time period on the original chart";
  let grain: string | undefined;
  let dateStart: string | undefined;
  let dateEnd: string | undefined;
  if (time) {
    const [parsedGrain, field] = time.split(":");
    grain = parsedGrain;
    const alias = `${field.split(".").at(-1)}_${parsedGrain}`;
    const index = result.columns.indexOf(alias);
    const dates = result.rows
      .map((r) => String(r[index] ?? "").slice(0, 10))
      .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)))
      .sort();
    if (!dates.length) {
      throw new Error("The chart has no readable reporting dates. Refresh it before investigating.");
    }
    dateStart = dates[0];
    dateEnd = dates.at(-1)!;
    const end = new Date(`${dateEnd}T00:00:00Z`);
    if (parsedGrain === "day" || parsedGrain === "week") end.setUTCDate(end.getUTCDate() + (parsedGrain === "day" ? 1 : 7));
    else if (parsedGrain === "month" || parsedGrain === "quarter") end.setUTCMonth(end.getUTCMonth() + (parsedGrain === "month" ? 1 : 3));
    else if (parsedGrain === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
    else throw new Error("This reporting period is not supported for investigation.");
    where.push({
      id: "investigation:window",
      field,
      source: "dimension",
      mode: "range",
      min: dates[0],
      max: end.toISOString().slice(0, 10),
      maxExclusive: true,
    });
    latestWindow = { ...where.at(-1)!, id: "investigation:latest", min: dateEnd };
    period = `${parsedGrain} reporting · ${dates[0]} through ${dateEnd} (period starts)`;
  }
  return { query, where, period, latestWindow, grain, dateStart, dateEnd };
}

/**
 * Align filters from the source chart's date column onto a cross-table exploration's
 * date column without truncating whole-period buckets to day 1 or widening excluded sub-periods.
 */
function alignExplorationWhere(
  model: Model,
  contextWhere: FilterSpec[],
  latestWindow: FilterSpec,
  sourceTime: string,
  sourceGrain: string | undefined,
  targetTime: string,
  qualify: (field: string) => string,
): FilterSpec[] | null {
  const [sourceTable, sourceCol] = sourceTime.split(".");
  const declaredPeriod = model.tables[sourceTable]?.period;
  const coarsePeriodicSource =
    sourceTime !== targetTime && Boolean(declaredPeriod && declaredPeriod.column === sourceCol);

  if (coarsePeriodicSource) {
    // Only substitute `latestWindow` when the source query runs at the table's native
    // period grain (e.g. `month` on `fct_saas_monthly.month`) and no `exclude` predicate
    // carved out sub-buckets inside a coarser rollup.
    if (sourceGrain && declaredPeriod && sourceGrain !== declaredPeriod.grain) return null;
    if (
      contextWhere.some(
        (f) => f.source !== "metric" && qualify(f.field) === sourceTime && f.exclude,
      )
    ) {
      return null;
    }
  }

  const retained = contextWhere.flatMap((f) => {
    if (f.source === "metric") return [{ ...f }];
    const qualified = qualify(f.field);
    if (qualified !== sourceTime) return [{ ...f, field: qualified }];
    if (f.id === "investigation:window") return [];
    if (coarsePeriodicSource) return [];
    return [{ ...f, field: targetTime }];
  });

  return [...retained, { ...latestWindow, field: targetTime }];
}

function chartBadgeFor(chart: TileSpec["chart"]): string {
  switch (chart) {
    case "kpi":
    case "stat":
      return "KPI Card";
    case "waterfall":
      return "Waterfall";
    case "bar":
    case "barH":
    case "barHorizontal":
      return "Bar Chart";
    case "line":
    case "area":
      return "Trend Line";
    default:
      return "Data Table";
  }
}

export function investigationOptions(
  model: Model,
  source: TileSpec,
  context: ReturnType<typeof investigationContext>,
): InvestigationOption[] {
  const title = source.title ?? source.metrics.map((n) => metricOf(model, n)?.label ?? n).join(", ");
  const primaryMetric = metricOf(model, source.metrics[0]);
  const base = primaryMetric?.baseTable;
  const options: InvestigationOption[] = [];
  const seenIds = new Set<string>();

  const uniqueId = (preferred: string): string => {
    if (!seenIds.has(preferred)) {
      seenIds.add(preferred);
      return preferred;
    }
    let suffix = 2;
    while (seenIds.has(`${preferred}:${suffix}`)) suffix++;
    const next = `${preferred}:${suffix}`;
    seenIds.add(next);
    return next;
  };

  const make = (
    rawId: string,
    label: string,
    reason: string,
    patch: Partial<TileSpec>,
    meta: { role: SubdetailRole; kicker: string; question: string; dimensionField?: string; period?: string; summary?: string },
  ) => {
    const id = uniqueId(rawId);
    const tile: TileSpec = {
      id: `investigation:${id}`,
      metrics: [...source.metrics],
      dimensions: [...context.query.dimensions],
      where: structuredClone(context.where),
      compare: context.query.compare,
      compareShow: "value",
      chart: "table",
      title: `${title} — ${label}`.slice(0, 1000),
      layout: { x: 0, y: 0, w: 850, h: 430 },
      ...patch,
    };
    if (
      context.where.some((f) => f.source === "metric") &&
      JSON.stringify(tile.dimensions) !== JSON.stringify(context.query.dimensions)
    ) {
      return;
    }
    let required: string[];
    try {
      required = requiredDimensions(model, tile.metrics, tile.dimensions);
    } catch {
      return;
    }
    if (tile.chart === "bar" && required.length !== 1) return;
    tile.dimensions = required;
    if (tileSchema.safeParse(tile).success && !validateTile(model, tile).length) {
      options.push({
        id,
        label,
        reason,
        tile,
        role: meta.role,
        kicker: meta.kicker,
        question: meta.question,
        chartLabel: tile.compare && tile.compare !== "none" && tile.chart === "table" ? "Comparison Table" : chartBadgeFor(tile.chart),
        dimensionField: meta.dimensionField,
        period: meta.period,
        summary: meta.summary,
      });
    }
  };

  const latestHuman = context.latestWindow
    ? formatPeriodHuman(String(context.latestWindow.min ?? ""), context.grain)
    : "the latest period";

  // Only model-authored paths may switch metrics/tables. Unsupported filters
  // suppress the path rather than widening the source scope silently.
  if (source.metrics.length === 1 && context.latestWindow) {
    const metric = primaryMetric;
    const qualify = (field: string) => (field.includes(".") ? field : `${base}.${field}`);
    for (const path of metric?.explorations ?? []) {
      const target = metricOf(model, path.metric);
      const sourceTime = qualify(context.latestWindow.field);
      if (
        !target ||
        target.reviewed === false ||
        metric?.reviewed === false ||
        !fieldReachable(model, target.baseTable, path.dimension) ||
        !fieldReachable(model, target.baseTable, path.timeDimension)
      ) {
        continue;
      }
      if (
        context.query.dimensions.some((d) => !d.includes(":")) ||
        context.query.dimensions.filter((d) => d.includes(":")).length > 1
      ) {
        continue;
      }
      if (
        context.where.some((f) =>
          f.source === "metric"
            ? true
            : qualify(f.field) !== sourceTime && !fieldReachable(model, target.baseTable, qualify(f.field)),
        )
      ) {
        continue;
      }
      const where = alignExplorationWhere(
        model,
        context.where,
        context.latestWindow,
        sourceTime,
        context.grain,
        path.timeDimension,
        qualify,
      );
      if (!where) continue;
      const chart = path.chart ?? "waterfall";
      const prefix = chart === "waterfall" ? "waterfall" : "bridge";
      const period = `${context.latestWindow.min} to ${context.latestWindow.max} (end excluded), intersected with the original filters`;
      const dimReadable = humanDimensionName(path.dimension.split(".").at(-1) ?? path.dimension).toLowerCase();
      make(
        `${prefix}:${path.metric}:${path.dimension}`,
        path.label,
        `${path.description} Latest displayed period: ${period}.`,
        {
          metrics: [path.metric],
          dimensions: [path.dimension],
          where,
          compare: "none",
          chart,
          title: `${path.label} · ${latestHuman}`,
          limit: 5000,
        },
        {
          role: "bridge",
          kicker: chart === "waterfall" ? "MOVEMENT BRIDGE" : "REVENUE BRIDGE",
          question:
            chart === "waterfall"
              ? `Which additions and losses produced the net shift in ${latestHuman}?`
              : `How did signed ${target.label.toLowerCase()} break down by ${dimReadable} in ${latestHuman}?`,
          dimensionField: path.dimension,
          period,
          summary: "Signed revenue contributions in the latest displayed period.",
        },
      );
    }
  }

  const times = context.query.dimensions.filter((d) => d.includes(":"));
  const time = times[0] ?? (base && timeColumnOf(model, base) ? `month:${timeColumnOf(model, base)}` : null);
  if (time) {
    if (source.metrics.length === 1 && !context.query.dimensions.some((d) => !d.includes(":")) && times.length <= 1) {
      make(
        "headline",
        "Latest value",
        "The latest value and comparison within the original reporting scope.",
        {
          dimensions: [time],
          chart: "kpi",
          compare: "prior",
          layout: { x: 0, y: 0, w: 850, h: 210 },
        },
        {
          role: "headline",
          kicker: "HEADLINE PULSE",
          question: "Where does this metric stand in the latest closed period versus the prior period?",
        },
      );
    }
    make(
      "trend",
      "Follow the trend",
      "See how the same metric changes within this scope. Existing breakdowns stay visible in a table.",
      {
        dimensions: times.length ? context.query.dimensions : [...context.query.dimensions, time],
        chart: context.query.dimensions.some((d) => !d.includes(":")) || times.length > 1 ? "table" : "line",
      },
      {
        role: "pace",
        kicker: "PACE & TRAJECTORY",
        question: "Is the latest reading a single-period blip or a sustained multi-period trajectory?",
      },
    );
    make(
      "compare",
      "Compare with the previous period",
      "Match each period to its calendar predecessor. Missing comparisons stay empty.",
      {
        dimensions: times.length ? context.query.dimensions : [...context.query.dimensions, time],
        compare: "prior",
        chart: "table",
      },
      {
        role: "pace",
        kicker: "PERIOD COMPARISONS",
        question: "How much did each period gain or lose against its immediate calendar predecessor?",
      },
    );
  }

  // Visual single-period segment bar breakdown (`mix:<field>`) when a single metric has
  // a latest period, ordered with business categoricals ahead of boolean flags.
  if (
    base &&
    primaryMetric &&
    source.metrics.length === 1 &&
    context.latestWindow &&
    !context.where.some((f) => f.source === "metric") &&
    !context.query.dimensions.some((d) => !d.includes(":"))
  ) {
    const latestOnlyWhere = [
      ...context.where.filter((f) => f.id !== "investigation:window"),
      structuredClone(context.latestWindow),
    ];
    const latestPeriodText = `${context.latestWindow.min} to ${context.latestWindow.max} (end excluded), intersected with the original filters`;
    const additive = isAdditiveMetric(model, primaryMetric);
    const isSignedDelta = /\bdelta\b|^net_new/i.test(`${primaryMetric.name} ${primaryMetric.expression}`);
    const isDistinct = /\bcount\s*\(\s*distinct\b/i.test(primaryMetric.expression);

    const candidateCols: { field: string; columnName: string; isBool: boolean }[] = [];
    for (const table of Object.values(model.tables)) {
      for (const column of dimensionsOf(table)) {
        const field = `${table.name}.${column.name}`;
        if (isNumeric(column) || isTemporal(column) || !fieldReachable(model, base, field)) continue;
        if (options.some((o) => o.dimensionField === field && o.tile.metrics[0] === source.metrics[0])) continue;
        if (isDimensionReferencedInMetric(model, primaryMetric, field)) continue;
        const isBool = /^bool/i.test(column.type) || column.name.startsWith("is_");
        candidateCols.push({ field, columnName: column.name, isBool });
      }
    }
    candidateCols.sort((a, b) => Number(a.isBool) - Number(b.isBool));

    for (const { field, columnName } of candidateCols) {
      const humanDim = humanDimensionName(columnName);
      const lowerDim = humanDim.toLowerCase();
      const kicker = isSignedDelta
        ? "NET SEGMENT SHIFT"
        : isDistinct
          ? "SEGMENT REACH"
          : additive
            ? "LATEST PERIOD MIX"
            : "SEGMENT COMPARISON";
      const question = isSignedDelta
        ? `How did net gains and losses split across ${lowerDim} in ${latestHuman}?`
        : isDistinct
          ? `How many distinct records did each ${lowerDim} reach in ${latestHuman}?`
          : additive
            ? `How did ${latestHuman} break down across ${lowerDim}?`
            : primaryMetric.direction === "lower"
              ? `Which ${lowerDim} was lowest versus highest in ${latestHuman}?`
              : `How did ${primaryMetric.label} compare across ${lowerDim} in ${latestHuman}?`;

      make(
        `mix:${field}`,
        `Latest period by ${lowerDim}`,
        `Compare ${lowerDim} within ${latestHuman}. Latest displayed period: ${latestPeriodText}.`,
        {
          dimensions: [field],
          where: structuredClone(latestOnlyWhere),
          compare: "none",
          chart: "bar",
          title: `${title} by ${lowerDim} · ${latestHuman}`.slice(0, 1000),
        },
        {
          role: "mix",
          kicker,
          question,
          dimensionField: field,
          period: latestPeriodText,
        },
      );
    }
  }

  make(
    "values",
    "Inspect the values",
    "See the aggregated values behind the chart; these are not individual customer records.",
    {},
    {
      role: "ledger",
      kicker: "SUMMARY TABLE",
      question: "What are the exact period figures behind this chart for finance or stakeholder review?",
    },
  );

  if (base) {
    for (const table of Object.values(model.tables)) {
      for (const column of dimensionsOf(table)) {
        const field = `${table.name}.${column.name}`;
        if (isNumeric(column) || isTemporal(column) || !fieldReachable(model, base, field)) continue;
        if (context.query.dimensions.some((d) => d === field || `${base}.${d}` === field)) continue;
        const label = column.name.replace(/_/g, " ");
        const humanDim = humanDimensionName(column.name).toLowerCase();
        make(
          `by:${field}`,
          `Break down by ${label}`,
          "Keep the reporting period and filters while comparing groups. A table keeps rates and periods separate.",
          {
            dimensions: [...context.query.dimensions, field],
            chart: "table",
          },
          {
            role: "ledger",
            kicker: "MULTI-PERIOD TABLE",
            question: `How did each ${humanDim} perform across every period in the reporting window?`,
            dimensionField: field,
          },
        );
      }
    }
  }

  return options;
}

export function describeFilter(filter: FilterSpec): string {
  return `${filter.field} ${filter.exclude ? "excluding " : ""}${
    filter.mode === "discrete"
      ? (filter.values ?? []).map((v) => (v === null ? "missing" : String(v))).join(", ")
      : `${filter.min ?? "any start"} to ${filter.max ?? "any end"}${filter.maxExclusive ? " (end excluded)" : ""}`
  }`;
}

/** Stable defaults are view definitions, never copies of query results. */
export function defaultDetailViews(options: InvestigationOption[]): string[] {
  const preferred = [
    options.find((o) => o.id === "headline"),
    options.find((o) => o.id.startsWith("waterfall:")),
    options.find((o) => o.id === "trend"),
  ].filter((o): o is InvestigationOption => !!o);
  for (const option of options) {
    if (preferred.length < 3 && !preferred.includes(option)) preferred.push(option);
  }
  return preferred.map((o) => o.id);
}

export function rankStorySubdetails(
  options: InvestigationOption[],
  activeViews: string[],
  driverBadgesByDimension: Record<string, string> = {},
): RankedSubdetail[] {
  const activeSet = new Set(activeViews);
  return options
    .map((option, index) => {
      const driverBadge = option.dimensionField ? driverBadgesByDimension[option.dimensionField] : undefined;
      const isBoolDim = Boolean(option.dimensionField && /(^|\.)is_/i.test(option.dimensionField));
      let score = 0;
      if (option.role === "bridge") score += option.tile.chart === "waterfall" ? 96 : 90;
      else if (option.role === "mix") score += isBoolDim ? 58 : 80;
      else if (option.id === "compare") score += 72;
      else if (option.id === "trend") score += 70;
      else if (option.id === "headline") score += 66;
      else if (option.id === "values") score += 55;
      else score += 40;
      if (driverBadge) score += isBoolDim ? 8 : 24;
      return {
        option,
        active: activeSet.has(option.id),
        driverBadge,
        score: score - index * 0.01,
      };
    })
    .sort((a, b) => Number(a.active) - Number(b.active) || b.score - a.score);
}

/**
 * Build up to three 1-click Story Arcs tailored to the chart's actual options
 * and optional factual takeaway. Only offers "Why Did It Move?" when a genuine
 * bridge or segment breakdown option exists.
 */
export function storyArcsForOptions(
  sourceTitle: string,
  options: InvestigationOption[],
  topDriverDimension?: string,
  factualTakeaway?: string,
): StoryArc[] {
  if (!options.length) return [];
  const byId = (id: string) => options.find((o) => o.id === id);
  const pickUnique = (candidates: (InvestigationOption | undefined)[], max = 4): string[] => {
    const out: string[] = [];
    for (const c of candidates) {
      if (c && !out.includes(c.id) && out.length < max) out.push(c.id);
    }
    if (!out.length && options[0]) out.push(options[0].id);
    return out;
  };

  const headline = byId("headline");
  const primaryBridge = options.find((o) => o.id.startsWith("waterfall:")) ?? options.find((o) => o.role === "bridge");
  const secondaryBridge = options.find((o) => o.role === "bridge" && o.id !== primaryBridge?.id);
  const driverMix = topDriverDimension
    ? options.find((o) => o.dimensionField === topDriverDimension && (o.role === "mix" || o.role === "bridge")) ??
      options.find((o) => o.dimensionField === topDriverDimension)
    : undefined;
  const firstMix = driverMix ?? secondaryBridge ?? options.find((o) => o.role === "mix");
  const secondMix = options.find(
    (o) => (o.role === "mix" || o.role === "bridge") && o.id !== primaryBridge?.id && o.id !== firstMix?.id,
  );
  const trend = byId("trend");
  const compare = byId("compare");
  const values = byId("values") ?? options.find((o) => o.id.startsWith("by:"));

  const cleanBase = sourceTitle.trim().slice(0, 90) || "Metric";
  const leadFact = factualTakeaway?.trim() ? `${factualTakeaway.trim()} ` : "";
  const arcs: StoryArc[] = [];

  const pulseViews = pickUnique([headline, primaryBridge ?? firstMix, trend, primaryBridge && firstMix ? firstMix : undefined], 4);
  arcs.push({
    id: "executive-pulse",
    label: "Executive Pulse",
    audience: "For leadership",
    description: "Headline standing, primary driver of the latest period, and multi-period trajectory.",
    title: `${cleanBase} — Executive pulse`.slice(0, 120),
    subtitle: `${leadFact}Headline standing alongside latest-period drivers and trajectory.`.slice(0, 320),
    layout: "focus",
    views: pulseViews,
  });

  if (primaryBridge || firstMix) {
    const driverCandidates = pickUnique([primaryBridge, firstMix, secondMix, compare, trend], 4);
    arcs.push({
      id: "why-it-moved",
      label: "Why Did It Move?",
      audience: "For root-cause review",
      description: "Decomposes the latest period by movement and segment alongside period-over-period shifts.",
      title: `${cleanBase} — Movement & drivers`.slice(0, 120),
      subtitle: `${leadFact}Decomposes the latest displayed period by movement and segment alongside period-over-period comparisons.`.slice(0, 320),
      layout: "focus",
      views: driverCandidates,
    });
  }

  const auditViews = pickUnique([headline, trend, compare, values], 4);
  arcs.push({
    id: "stakeholder-audit",
    label: "Stakeholder & Finance Pack",
    audience: "For finance & ops",
    description: "Multi-period trend, calendar comparisons, and the period summary table for export.",
    title: `${cleanBase} — Verification & summary`.slice(0, 120),
    subtitle: `${leadFact}Pairs period-over-period comparisons with the underlying period figures under active filters.`.slice(0, 320),
    layout: "grid",
    views: auditViews,
  });

  return arcs;
}
