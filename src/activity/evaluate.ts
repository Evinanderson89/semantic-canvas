import type { AlertInput, Evaluation } from "./model.ts";
import type { TimeGrain } from "../semantic/model.ts";

export function periodStart(input: Date, grain: TimeGrain) {
  const d = new Date(input); d.setUTCHours(0, 0, 0, 0);
  if (grain === "week") d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  if (["month", "quarter", "year"].includes(grain)) d.setUTCDate(1);
  if (grain === "quarter") d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3);
  if (grain === "year") d.setUTCMonth(0);
  return d;
}
export function nextPeriod(input: Date, grain: TimeGrain, n = 1) {
  const d = new Date(input);
  if (grain === "day" || grain === "week") d.setUTCDate(d.getUTCDate() + n * (grain === "week" ? 7 : 1));
  else d.setUTCMonth(d.getUTCMonth() + n * (grain === "year" ? 12 : grain === "quarter" ? 3 : 1));
  return d;
}
const median = (values: number[]) => { const a = [...values].sort((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
const numeric = (v: unknown): number | null => v === null || v === undefined || typeof v === "boolean" || typeof v === "string" && !v.trim() ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** A robust outlier heuristic, not a confidence interval or proof of causation.
 * Scaled MAD: https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/mad.htm
 * Fit historical changes only; the observation being tested never enters its baseline. */
export function evaluateAlert(rule: AlertInput, result: { columns: string[]; rows: unknown[][] }, timeDimension?: string, now = new Date()): Evaluation {
  const checkedAt = now.toISOString();
  const waiting = (reason: string): Evaluation => ({ state: "waiting", reason, checkedAt });
  const metricIndex = result.columns.indexOf(rule.metric);
  if (metricIndex < 0) return waiting("The selected metric is missing from this result.");
  let value: number | null, period = "Current total", points: { date: Date; value: number | null }[] = [];
  let grain: TimeGrain | undefined;
  if (timeDimension) {
    const [g, field] = timeDimension.split(":"); grain = g as TimeGrain;
    if (!["day", "week", "month", "quarter", "year"].includes(grain)) return waiting("Choose a supported reporting period.");
    const index = result.columns.indexOf(`${field.split(".").at(-1)}_${g}`);
    if (index < 0) return waiting("A reporting date is needed to check this chart.");
    const cutoff = periodStart(now, grain);
    for (const row of result.rows) {
      const raw = row[index]; if (raw == null) return waiting("A reporting date is missing. No alert was raised.");
      const literal = raw instanceof Date ? raw.toISOString() : String(raw);
      const date = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(literal) ? literal.replace(" ", "T") + "Z" : literal);
      if (!Number.isFinite(+date)) return waiting("A reporting date could not be read.");
      if (+date < +cutoff) points.push({ date, value: numeric(row[metricIndex]) });
    }
    points.sort((a, b) => +a.date - +b.date);
    if (!points.length) return waiting("Waiting for a closed reporting period. The current period is excluded.");
    if (new Set(points.map(p => +p.date)).size !== points.length) return waiting("This chart has multiple values per period. Remove its category breakdown before watching it.");
    const last = points.at(-1)!; value = last.value; period = last.date.toISOString().slice(0, 10);
    if (+last.date !== +nextPeriod(cutoff, grain, -1)) return { ...waiting(`Latest data is ${period}. Waiting for the most recently closed ${grain}.`), period };
  } else {
    if (result.rows.length !== 1) return waiting("Watch a total or a time series with no category breakdown.");
    value = numeric(result.rows[0][metricIndex]);
  }
  if (value === null) return { ...waiting("The latest value is missing. Missing data is never treated as zero."), period };
  if (rule.mode === "threshold") {
    const triggered = rule.operator === "above" ? value > rule.threshold! : value < rule.threshold!;
    return { state: triggered ? "triggered" : "normal", value, period, checkedAt,
      reason: triggered ? `The value is ${rule.operator} your threshold.` : "The value is within your threshold." };
  }
  if (!grain) return waiting("Anomaly checks need a time-series chart.");
  // At most 60 historical observations. Daily series use week-over-week changes
  // once four weeks of history exist; shorter series use consecutive changes.
  points = points.slice(-61);
  if (points.length < 14) return waiting(`Building a baseline: ${points.length} of at least 14 closed periods available.`);
  if (points.some(p => p.value === null)) return waiting("The baseline contains missing values. No anomaly was inferred.");
  if (points.some((p, i) => i > 0 && +p.date !== +nextPeriod(points[i - 1].date, grain!))) return waiting("The baseline has gaps between periods. Fill those gaps before checking for anomalies.");
  const history = points.slice(0, -1).map(p => p.value!);
  const lag = grain === "day" && history.length >= 28 ? 7 : 1;
  const changes = history.slice(lag).map((v, i) => v - history[i]);
  const drift = median(changes), mad = median(changes.map(v => Math.abs(v - drift)));
  const expected = history[history.length - lag] + drift;
  const multiplier = { sensitive: 2.5, balanced: 3.5, conservative: 5 }[rule.sensitivity];
  // A flat baseline still needs a meaningful move: a 1% floor avoids floating-point noise.
  const width = Math.max(multiplier * mad / 0.6745, Math.abs(expected) * .01, 1e-9);
  if (![expected, width].every(Number.isFinite)) return waiting("The baseline could not be calculated safely.");
  const lower = expected - width, upper = expected + width;
  if (![lower, upper].every(Number.isFinite)) return waiting("The expected range exceeds supported numeric values.");
  const triggered = (rule.direction !== "below" && value > upper) || (rule.direction !== "above" && value < lower);
  return { state: triggered ? "triggered" : "normal", value, period, checkedAt, expected, lower, upper, baselinePoints: history.length, seasonal: lag === 7,
    reason: triggered ? "An unusual move outside the expected range. Review the business context before acting." : "The latest value is within its expected range." };
}
