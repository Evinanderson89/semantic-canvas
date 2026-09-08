import { format as d3format } from "d3-format";
import type { Model } from "../semantic/model.ts";
import type { TileSpec } from "../compiler/spec.ts";

export type NumberStyle = "auto" | "currency" | "percent" | "compact" | "plain";

export interface FormatSpec {
  number: NumberStyle;
  decimals: number | null;
  xTitle: string | null;
  yTitle: string | null;
  showX: boolean;
  showY: boolean;
  grid: boolean;
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
}

export const PALETTES: Record<string, string[]> = {
  default:  ["#5b8fb0", "#43866c", "#b18442", "#bb7460", "#9680b5", "#509b96"],
  cool:     ["#5aa9e6", "#4fb3b1", "#7c9ce8", "#57c2c8", "#8f8fe0", "#3fbf8f"],
  warm:     ["#e5934d", "#e5736a", "#d8a24d", "#cf7fa0", "#c9964f", "#e0645c"],
  mono:     ["#5aa9e6", "#7fbcea", "#a3cfee", "#c6e1f3", "#3f88bd", "#2f6b96"],
  contrast: ["#5aa9e6", "#e5736a", "#3fbf8f", "#d8a24d", "#9b8ade", "#4fb3b1"],
};

export const DEFAULT_FORMAT: FormatSpec = {
  number: "auto", decimals: null, xTitle: null, yTitle: null,
  showX: true, showY: true, grid: true, legend: "auto",
  palette: "default", padding: 12, background: true, border: true,
  backgroundColor: null, backgroundOpacity: 100,
  textSize: 16, textAlign: "left", fontFamily: "sans",
  textItalic: false, textUnderline: false, imageFit: "contain",
};

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
  const ms = tile.metrics.map((n) => model.metrics[n]).filter(Boolean);
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
  if (/(?:^|[^a-z])ratio(?:$|[^a-z])/.test(text)) return "compact";
  if (/\brate\b|retention|\bnrr\b|\bgrr\b|percent|share|conversion/.test(text)) return "percent";
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

export function makeFormatter(f: FormatSpec): (n: number) => string {
  const d = f.decimals;
  switch (f.number) {
    case "currency":
      return (n) => (Math.abs(n) >= 10000 && d == null)
        ? "$" + d3format(".3~s")(n).replace("G", "B")
        : d3format(`$,.${d ?? 2}f`)(n);
    case "percent":
      return d3format(`.${d ?? 1}%`);
    case "compact":
      return (n) => d3format(`.${d ?? 3}~s`)(n).replace("G", "B");
    case "plain":
      return d3format(`,.${d ?? 2}~f`);
    default:
      return (n) => (Math.abs(n) >= 1000 ? d3format(".3~s")(n).replace("G", "B")
                                         : d3format(",.3~f")(n));
  }
}
