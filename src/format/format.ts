import { format as d3format } from "d3-format";
import type { Model } from "../semantic/model.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { metricOf } from "../semantic/model.ts";

export type NumberStyle = "auto" | "currency" | "percent" | "compact" | "plain";

export interface FormatSpec {
  number: NumberStyle;
  decimals: number | null;
  xTitle: string | null;
  yTitle: string | null;
  showX: boolean;
  showY: boolean;
  grid: boolean;
  /** Line charts only. Fitted axes always disclose their displayed range. */
  lineScale: "zero" | "fit";
  legend: "auto" | "hide";
  palette: string;
  padding: number;
  background: boolean;
  border: boolean;
  /** Overrides the theme's default panel color when `background` is on. */
  backgroundColor: string | null;
  /** 0-100. Blends `backgroundColor` (or the default) toward transparent. */
  backgroundOpacity: number;
  /** Text elements only, in pixels. */
  textSize: number;
  textAlign: "left" | "center" | "right";
  fontFamily: "sans" | "serif" | "mono" | "arial" | "times" | "courier"
    | "verdana" | "trebuchet" | "palatino" | "impact";
  textItalic: boolean;
  textUnderline: boolean;
  /** Image tiles only. */
  imageFit: "contain" | "cover";
  targetValue?: number | null;
  targetLabel?: string | null;
  annotations?: { at: string; label: string; kind?: "policy" | "launch" | "note" }[];
  referenceLines?: { label: string; value: number }[];
}

export type EditorialThemeId = "broadside" | "newsroom-dark" | "swiss-grid" | "studio-warm";

export interface EditorialTheme {
  id: EditorialThemeId;
  label: string;
  ground: string;
  surface: string;
  ink: string;
  accent: string;
  displayFont: string;
  bodyFont: string;
  monoFont: string;
  palette: string;
}

export const PALETTES: Record<string, string[]> = {
  default:   ["#2563eb", "#059669", "#d97706", "#e11d48", "#7c3aed", "#0891b2"],
  cool:      ["#2563eb", "#1d4ed8", "#0284c7", "#059669", "#4f46e5", "#0891b2"],
  warm:      ["#d97706", "#e11d48", "#ea580c", "#be123c", "#b45309", "#dc2626"],
  mono:      ["#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#1e40af", "#1e3a8a"],
  contrast:  ["#1d4ed8", "#e11d48", "#059669", "#d97706", "#7c3aed", "#0891b2"],
  broadside: ["#1d4ed8", "#0f766e", "#b45309", "#be123c", "#4338ca", "#334155"],
  swiss:     ["#dc2626", "#171717", "#525252", "#2563eb", "#ca8a04", "#737373"],
  editorial: ["#2f6b96", "#3d7a5a", "#b86b35", "#a84448", "#6d598a", "#4a8580"],
};

export const EDITORIAL_THEMES: Record<EditorialThemeId, EditorialTheme> = {
  broadside: {
    id: "broadside",
    label: "Broadside",
    ground: "#ffffff",
    surface: "#ffffff",
    ink: "#111827",
    accent: "#1d4ed8",
    displayFont: '"Bricolage Grotesque", Georgia, serif',
    bodyFont: '"Source Serif 4", Georgia, serif',
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    palette: "broadside",
  },
  "newsroom-dark": {
    id: "newsroom-dark",
    label: "Newsroom Dark",
    ground: "#0f141c",
    surface: "#161d28",
    ink: "#f3f4f6",
    accent: "#38bdf8",
    displayFont: '"Bricolage Grotesque", Georgia, serif',
    bodyFont: '"Source Serif 4", Georgia, serif',
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    palette: "cool",
  },
  "swiss-grid": {
    id: "swiss-grid",
    label: "Swiss Grid",
    ground: "#ffffff",
    surface: "#fafafa",
    ink: "#0a0a0a",
    accent: "#dc2626",
    displayFont: "Helvetica, Arial, sans-serif",
    bodyFont: "Helvetica, Arial, sans-serif",
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    palette: "swiss",
  },
  "studio-warm": {
    id: "studio-warm",
    label: "Studio Warm",
    ground: "#faf7f2",
    surface: "#f3ede2",
    ink: "#1c1917",
    accent: "#b45309",
    displayFont: '"Bricolage Grotesque", Georgia, serif',
    bodyFont: '"Source Serif 4", Georgia, serif',
    monoFont: '"JetBrains Mono", ui-monospace, monospace',
    palette: "editorial",
  },
};

export function resolveEditorialTheme(id?: string): EditorialTheme {
  if (id && id in EDITORIAL_THEMES) {
    return EDITORIAL_THEMES[id as EditorialThemeId];
  }
  return EDITORIAL_THEMES.broadside;
}

export const DEFAULT_FORMAT: FormatSpec = {
  number: "auto", decimals: null, xTitle: null, yTitle: null,
  showX: true, showY: true, grid: true, lineScale: "zero", legend: "auto",
  palette: "default", padding: 12, background: true, border: true,
  backgroundColor: null, backgroundOpacity: 100,
  textSize: 16, textAlign: "left", fontFamily: "sans",
  textItalic: false, textUnderline: false, imageFit: "contain",
  targetValue: null, targetLabel: null, annotations: [],
};

export interface NormalizedChartAnnotations {
  target: { value: number; label: string; style: "dashed" } | null;
  callouts: { at: string; label: string; kind: "policy" | "launch" | "note" }[];
}

export function buildChartAnnotations(
  format: Partial<FormatSpec> | undefined,
  domainValues?: unknown[],
): NormalizedChartAnnotations {
  const firstRef = Array.isArray(format?.referenceLines) ? format.referenceLines[0] : undefined;
  const rawTarget = format?.targetValue ?? firstRef?.value;
  const rawLabel = format?.targetLabel ?? firstRef?.label;
  const target = typeof rawTarget === "number" && Number.isFinite(rawTarget)
    ? {
        value: rawTarget,
        label: typeof rawLabel === "string" && rawLabel.trim()
          ? rawLabel.trim()
          : `Target ${rawTarget}`,
        style: "dashed" as const,
      }
    : null;

  const domainSet = domainValues ? new Set(domainValues.map((v) => String(v))) : null;
  const callouts: { at: string; label: string; kind: "policy" | "launch" | "note" }[] = [];
  if (Array.isArray(format?.annotations)) {
    for (const item of format.annotations) {
      const at = typeof item?.at === "string" ? item.at.trim() : "";
      const label = typeof item?.label === "string" ? item.label.trim() : "";
      if (!at || !label) continue;
      if (domainSet && !domainSet.has(at)) continue;
      const kind = item.kind === "policy" || item.kind === "launch" || item.kind === "note"
        ? item.kind
        : "note";
      callouts.push({ at, label, kind });
    }
  }

  return { target, callouts };
}

/** Web-safe stacks only -- no @font-face, so nothing to load and nothing
 *  that can render as a broken fallback if a font isn't installed. */
export const FONT_STACKS: Record<FormatSpec["fontFamily"], string> = {
  sans: "inherit",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Menlo, monospace",
  arial: "Arial, Helvetica, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  verdana: "Verdana, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', sans-serif",
  palatino: "'Palatino Linotype', Palatino, serif",
  impact: "Impact, 'Arial Narrow Bold', sans-serif",
};
export const FONT_LABELS: Record<FormatSpec["fontFamily"], string> = {
  sans: "Sans", serif: "Serif", mono: "Mono", arial: "Arial", times: "Times New Roman",
  courier: "Courier", verdana: "Verdana", trebuchet: "Trebuchet MS",
  palatino: "Palatino", impact: "Impact",
};

const LEGACY_TEXT_SIZE: Record<string, number> = { s: 13, m: 19, l: 26, xl: 34 };

/**
 * Text/heading/divider/image tiles merge format this way rather than through
 * resolveFormat() below, which also infers a number style from the model --
 * these tiles have no metric to infer anything from. Normalizes textSize in
 * case it's the old "s"/"m"/"l"/"xl" preset from a dashboard saved before
 * sizing became a plain pixel number.
 */
export function mergeTextFormat(raw: unknown): FormatSpec {
  const f: any = { ...DEFAULT_FORMAT, ...(raw as object ?? {}) };
  if (typeof f.textSize !== "number") f.textSize = LEGACY_TEXT_SIZE[f.textSize] ?? DEFAULT_FORMAT.textSize;
  return f as FormatSpec;
}

/**
 * The tile chrome's actual fill: transparent when Background is off, the
 * custom color (or the theme default) otherwise, blended toward transparent
 * by backgroundOpacity. color-mix() works against a CSS variable just as
 * well as a literal hex, so the default panel color gets the same treatment
 * as a custom one with no special-casing.
 */
export function tileFill(f: FormatSpec, defaultColor = "var(--surface)"): string {
  if (!f.background) return "transparent";
  const base = f.backgroundColor ?? defaultColor;
  const opacity = f.backgroundOpacity ?? 100;
  return opacity >= 100 ? base : `color-mix(in srgb, ${base} ${opacity}%, transparent)`;
}

/**
 * Infer how a tile's numbers should read, from the semantic layer.
 *
 * This is the advantage a chart library does not have: the model already says a
 * metric is "MRR (USD)" or "Net revenue retention", so currency and percent are
 * knowable before anyone opens a format panel. Being right by default is most
 * of what "smart" means here.
 */
export function inferNumberStyle(model: Model, tile: TileSpec): NumberStyle {
  const ms = tile.metrics.map((n) => metricOf(model, n)).filter(Boolean);
  if (!ms.length) return "auto";
  // The FIRST selected metric decides, not every metric's label text
  // pooled together -- the same convention a combo chart's "first measure
  // is the bar" already relies on. A tile pairing a currency measure with
  // a rate one (exactly what a combo is for) used to see "rate" in the
  // pooled text and format the whole axis -- including the currency bars
  // -- as a percent, turning $480,000 into a nonsense "48000000.0%".
  //
  // Includes synonyms, not just name/label -- curated short alternate names
  // for what the metric IS, same spirit as the "read the model's own
  // words" source `semanticHints()` already draws chart-kind hints from.
  // Regression: logo_churn_annualized's own LABEL, "Logo churn
  // (annualized)", drops the word "rate" that its sibling logo_churn_rate
  // has, so name+label alone matched none of the percent keywords and it
  // fell through to "compact" -- a real value of 0.6 rendered via
  // SI-prefix notation as "600m" (600 milli-units), reading like six
  // hundred million. Its synonyms (["...", "yearly churn rate"]) already
  // say the word. `description` deliberately excluded, unlike
  // semanticHints() -- free prose explaining what a metric depends on
  // ("ARPA divided by logo churn RATE") reads fine to a person but plants
  // a false keyword for a metric (ltv, a currency amount) that isn't
  // itself that thing; a synonym is curated to BE another name for the
  // metric, not a sentence about it, so it doesn't carry that risk.
  const ms0 = ms[0];
  if (ms0.unit) return ms0.unit === "currency" || ms0.unit === "percent" ? ms0.unit : "plain";
  const text = [ms0.name, ms0.label, ...ms0.synonyms].join(" ").toLowerCase();
  // Checked before either regex below: a metric literally named/labeled as
  // a ratio is a unitless multiple (LTV/CAC, SaaS quick ratio -- read as
  // "5.85x", not "585%"), even when it's built from currency inputs or
  // reads like a fraction. Otherwise "ltv_cac_ratio" would fall through to
  // the currency check on "ltv"/"cac" alone and read as "$5.85" -- right
  // about as wrong as the percent misread this exists to avoid, just from
  // the opposite regex. Bounded by "not a letter" rather than `\b` --
  // `\bratio\b` treats the underscore in a snake_case NAME as part of the
  // word, so it silently fails to match "ltv_cac_ratio" -- but a plain
  // unbounded substring match is too loose the other way: it fires inside
  // an unrelated word sharing those five letters, like "new_signups"'s own
  // synonym "regisTRATIOns".
  if (/(?:^|[^a-z])(months?|days?|seconds?)(?:$|[^a-z])/.test(text)) return "plain";
  if (/(?:^|[^a-z])ratio(?:$|[^a-z])/.test(text)) return "compact";
  // Underscores separate semantic-name tokens just like spaces and hyphens;
  // JavaScript's \b considers them word characters and misses attach_rate.
  if (/(?:^|[^a-z])(?:rate|nrr|grr)(?:$|[^a-z])|retention|percent|share|conversion/.test(text)) return "percent";
  if (/usd|\$|revenue|mrr|arr|spend|cost|price|cac|ltv|arpa|arpu/.test(text)) return "currency";
  return "compact";
}

export function resolveFormat(model: Model, tile: TileSpec): FormatSpec {
  // Goes through mergeTextFormat rather than its own spread so a dashboard
  // saved before textSize became a plain pixel number (it used to be
  // "s"/"m"/"l"/"xl") still gets a valid number here too, not just on
  // heading/text tiles.
  const f = mergeTextFormat(tile.format);
  if (f.number === "auto") f.number = inferNumberStyle(model, tile);
  return f;
}

/** Unit compatibility is semantic, not a choice of number formatting. */
export function metricUnit(model: Model, name: string): string {
  const metric = metricOf(model, name);
  if (metric?.unit) return metric.unit;
  const text = [metric?.name, metric?.label, ...(metric?.synonyms ?? [])].join(" ").toLowerCase();
  for (const [pattern, unit] of [[/(?:^|[^a-z])months?(?:$|[^a-z])/, "months"], [/(?:^|[^a-z])days?(?:$|[^a-z])/, "days"], [/(?:^|[^a-z])seconds?(?:$|[^a-z])/, "seconds"], [/(?:^|[^a-z])ratio(?:$|[^a-z])/, "ratio"]] as const) if (pattern.test(text)) return unit;
  const style = inferNumberStyle(model, { id: "units", metrics: [name], dimensions: [], layout: { x: 0, y: 0, w: 100, h: 100 } });
  return style === "currency" || style === "percent" ? style : "number";
}

/** Precision changes retain the formatter's units instead of inferring them from text. */
export type NumberFormatter = ((n: number) => string) & {
  withPrecision?: (digits: number) => (n: number) => string;
  exact?: (n: number) => string;
};

export function makeFormatter(f: FormatSpec): NumberFormatter {
  return Object.assign(numberFormatter(f), {
    withPrecision: (digits: number) => numberFormatter({ ...f, decimals: Math.max(1, digits) }),
    exact: (n: number) => f.number === "percent" ? `${d3format(".17~g")(n * 100)}%`
      : `${f.number === "currency" ? "$" : ""}${d3format(".17~g")(n)}`,
  });
}

/** Default rounding must not turn a rate below/above parity into exactly 100%.
 * Explicit user-selected precision is still respected by numberFormatter. */
export function preservePercentBoundary(n: number, rounded: string): string {
  const percent = n * 100;
  if (n !== 1 && Number(percent.toFixed(1)) === 100) {
    for (let decimals = 2; decimals <= 6; decimals++) {
      if (Number(percent.toFixed(decimals)) !== 100) return d3format(`.${decimals}~%`)(n);
    }
    return `${n < 1 ? "<" : ">"}100%`;
  }
  return rounded;
}

function numberFormatter(f: FormatSpec): (n: number) => string {
  const d = f.decimals;
  switch (f.number) {
    case "currency":
      return (n) => (Math.abs(n) >= 10000 && d == null)
        ? "$" + d3format(".3~s")(n).replace("G", "B")
        : d3format(`$,.${d ?? 2}f`)(n);
    case "percent":
      return d == null ? n => preservePercentBoundary(n, d3format(".1%")(n)) : d3format(`.${d}%`);
    case "compact":
      return (n) => d3format(`.${d ?? 3}~s`)(n).replace("G", "B");
    case "plain":
      return d3format(`,.${d ?? 2}~f`);
    default:
      return (n) => (Math.abs(n) >= 1000 ? d3format(`.${d ?? 3}~s`)(n).replace("G", "B")
                                         : d3format(`,.${d ?? 3}~f`)(n));
  }
}

/** Decide scale once for an axis, not independently for each tick. */
export function makeAxisFormatter(f: FormatSpec, values: unknown[]): NumberFormatter {
  if (f.number !== "currency" || f.decimals != null) return makeFormatter(f);
  const max = Math.max(0, ...values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).map(Math.abs));
  const unit = max >= 1e9 ? 1e9 : max >= 1e6 ? 1e6 : max >= 1e4 ? 1e3 : 1;
  const suffix = unit === 1e9 ? "B" : unit === 1e6 ? "M" : unit === 1e3 ? "k" : "";
  const withPrecision = (digits: number) => {
    const format = unit === 1 ? d3format(`$,.${digits}f`) : d3format(`,.${digits}~f`);
    return (n: number) => unit === 1 ? format(n) : `$${format(n / unit)}${suffix}`;
  };
  return Object.assign(withPrecision(2), { withPrecision, exact: (n: number) => `$${d3format(".17~g")(n / unit)}${suffix}` });
}
