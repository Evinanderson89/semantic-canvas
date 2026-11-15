import { parseDimension } from "../compiler/compile.ts";
import type { Model } from "../semantic/model.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { makeFormatter, metricUnit, resolveFormat } from "./format.ts";
import { numericValue } from "../charts/values.ts";
import { hasPrecisionRisk } from "../charts/precision.ts";

export interface TableColumnDisplay { label: string; format?: (value: number) => string }

/** Display metadata never changes the query result or CSV payload. Comparison
 * columns have their own meaning: absolute change versus relative change. */
export function tableDisplay(model: Model, spec: TileSpec): Record<string, TableColumnDisplay> {
  const result: Record<string, TableColumnDisplay> = Object.create(null);
  const human = (name: string) => name.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
  for (const dimension of spec.dimensions) {
    const { column, grain } = parseDimension(dimension);
    result[`${column}${grain ? `_${grain}` : ""}`] = { label: grain && column !== grain ? `${human(column)} · ${human(grain)}` : human(column) };
  }
  for (const metric of spec.metrics) {
    const resolved = resolveFormat(model, { ...spec, metrics: [metric] });
    const fmt = { ...resolved,
      // Tables favor readable amounts over magnitude abbreviations unless
      // the author explicitly selected compact notation.
      number: resolved.number === "compact" && spec.format?.number !== "compact" ? "plain" as const : resolved.number,
      decimals: resolved.number === "currency" && resolved.decimals === null ? 2 : resolved.decimals,
    };
    const label = model.metrics[metric]?.label ?? metric;
    const name = spec.metrics.some(other => other !== metric && (model.metrics[other]?.label ?? other) === label) ? `${label} (${metric})` : label;
    const format = makeFormatter(fmt);
    const points = metricUnit(model, metric) === "percent";
    const pointFormat = makeFormatter({ ...fmt, number: "plain", decimals: fmt.decimals ?? 1 });
    result[metric] = { label: name, format };
    result[`${metric}__prev`] = { label: `${name} · Prior period`, format };
    result[`${metric}__delta`] = { label: `${name} · Change${points ? " (pp)" : ""}`, format: points ? n => `${pointFormat(n * 100)} pp` : format };
    result[`${metric}__pct`] = { label: `${name} · Relative change`, format: makeFormatter({ ...fmt, number: "percent" }) };
  }
  return result;
}

export function tableNumber(value: unknown): number | null {
  return numericValue(value);
}

/** Break numeric-conversion ties using the original decimal digits. Comparing
 * exponent and coefficient text avoids rounding or expanding huge exponents. */
export function compareTableNumbers(a: unknown, b: unknown): number | null {
  const av = tableNumber(a), bv = tableNumber(b);
  if (av === null || bv === null) return null;
  if (av !== bv) return av < bv ? -1 : 1;
  const decimal = (value: unknown) => {
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(String(value).trim());
    if (!match) return null;
    const fraction = match[3] ?? match[4] ?? "";
    const digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
    return { digits, sign: !digits ? 0 : match[1] === "-" ? -1 : 1,
      magnitude: BigInt(digits.length - fraction.length) + BigInt(match[5] ?? 0) };
  };
  const left = decimal(a), right = decimal(b);
  if (!left || !right) return 0;
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (!left.sign) return 0;
  if (left.magnitude !== right.magnitude) return left.sign * (left.magnitude < right.magnitude ? -1 : 1);
  const length = Math.max(left.digits.length, right.digits.length);
  const l = left.digits.padEnd(length, "0"), r = right.digits.padEnd(length, "0");
  return l === r ? 0 : left.sign * (l < r ? -1 : 1);
}

export function tableCell(value: unknown, display?: TableColumnDisplay): string {
  if (value == null) return "—";
  if (hasPrecisionRisk(value)) return String(value);
  const numeric = display?.format ? tableNumber(value) : null;
  return numeric !== null && display?.format ? display.format(numeric) : String(value);
}
