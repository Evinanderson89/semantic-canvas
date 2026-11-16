import { parseDimension } from "../compiler/compile.ts";
import { numericValue } from "../charts/values.ts";
import { hasPrecisionRisk } from "../charts/precision.ts";
import type { PartialEdges } from "../compiler/compile.ts";

export interface DataFinding {
  id: string;
  title: string;
  evidence: string;
  impact?: string;
  nextStep: string;
}
export interface QualityResult {
  columns: string[];
  rows: unknown[][];
  truncated?: boolean;
  partial?: PartialEdges;
}

/** Excluding a known partial bucket describes query scope, not missing data.
 * A result limit remains a review finding because it can hide categories. */
export function isScopeNote(finding: DataFinding): boolean {
  return finding.id === "partial" || finding.id === "selected-partial";
}

/** These are observations about the returned query, never a warehouse audit.
 * In particular, absence is not zero and a gap does not prove a failed load. */
export function checkResultQuality(metrics: string[], dimensions: string[], result: QualityResult): DataFinding[] {
  const findings: DataFinding[] = [], { columns, rows } = result;
  if (result.truncated) findings.push({ id: "limited", title: "Only part of the result is visible",
    evidence: `${rows.length} rows were returned with a result-limit flag. Checks and exports cover this window only.`,
    impact: "Totals, rankings and category shares may describe only the returned window, rather than the full reporting scope.",
    nextStep: "Narrow the reporting window or increase the query limit before comparing totals or category shares." });
  if (result.partial?.start || result.partial?.end) findings.push({ id: "partial", title: "Edge periods were left out",
    evidence: `The query excluded the ${result.partial.start && result.partial.end ? "first and last" : result.partial.start ? "first" : "last"} partial period. These rows are not in the displayed result.`,
    nextStep: "Check the displayed reporting window before comparing this chart with another period or report." });
  if (result.partial?.selected?.start || result.partial?.selected?.end) findings.push({ id: "selected-partial", title: "Selected edge periods have partial observed coverage",
    evidence: "The selected date window is retained. Its first or last period does not have observed coverage through the whole bucket; quiet dates can also explain an observed edge. These rows remain visible, with period comparisons involving them unavailable.",
    nextStep: "Use complete reporting periods or a finer grain before interpreting growth. This check does not prove missing source data." });
  if (result.partial?.ratio?.length) {
    const inputs = result.partial.ratio;
    const range = (start: string | null, end: string | null) => start && end ? `${start} to ${end}` : "no observed period";
    findings.push({ id: "ratio-coverage", title: "Ratio input periods need review",
      evidence: `${inputs.length} returned ratio row${inputs.length === 1 ? " has" : "s have"} missing, different or partial input coverage. ${inputs.slice(0, 3).map(r => `${r.period ?? "Undated bucket"}${r.dimensions ? ` (${Object.entries(r.dimensions).map(([k, v]) => `${k}: ${v ?? "missing"}`).join(", ")})` : ""}: numerator ${range(r.numeratorStart, r.numeratorEnd)}; denominator ${range(r.denominatorStart, r.denominatorEnd)}.`).join(" ")}`,
      impact: "The calculated values are retained for inspection, but comparisons involving these periods are unavailable. A rate can look stable even when its inputs cover different dates.",
      nextStep: "Inspect both input definitions and reporting dates. Choose a supported common reporting window or correct the source-period declarations before drawing a conclusion. Quiet event dates can also explain an observed edge; matching boundaries do not certify complete data." });
  }
  if (!rows.length) findings.push({ id: "empty", title: "No rows in this scope",
    evidence: "The query returned no rows. This is not a measured zero.",
    impact: "This scope cannot establish a total, trend or comparison.",
    nextStep: "Review filters, the reporting period and source availability before interpreting the result." });
  for (const metric of metrics) {
    const index = columns.indexOf(metric);
    if (index < 0) {
      findings.push({ id: `missing:${metric}`, title: `Missing result: ${metric}`,
        evidence: "The requested metric is absent from the result columns.", nextStep: "Refresh the query and check the metric definition if the result is still missing." });
      continue;
    }
    const missing = rows.filter(row => row[index] == null).length;
    const precisionColumns = [index, columns.indexOf(`${metric}__prev`)].filter(i => i >= 0);
    const precisionRows = rows.filter(row => precisionColumns.some(i => hasPrecisionRisk(row[i])));
    if (precisionRows.length) {
      const values = precisionRows.flatMap(row => precisionColumns.map(i => row[i]).filter(hasPrecisionRisk));
      const examples = [...new Set(values.map(String))].slice(0, 2);
      findings.push({ id: `precision:${metric}`, title: `Numeric precision needs review: ${metric}`,
        evidence: `${precisionRows.length} of ${rows.length} returned rows contain a metric or prior value beyond reliable browser numeric precision. Examples: ${examples.join("; ")}.`,
        impact: "Chart positions and formatted values may round together. Local changes and rankings could imply equality that the returned values do not support. This is a display limitation, not proof of a source-data defect.",
        nextStep: "Export the returned CSV values for inspection and calculate exact differences or rankings in the warehouse before writing a conclusion." });
    }
    const invalid = rows.filter(row => {
      const v = row[index];
      return v != null && numericValue(v) === null;
    }).length;
    if (missing) findings.push({ id: `null:${metric}`, title: `Missing values: ${metric}`,
      evidence: `${missing} of ${rows.length} returned rows have no value for this metric. A missing value is distinct from a measured zero.`,
      impact: "Comparisons involving these rows are unavailable; treating them as zero would change the interpretation.",
      nextStep: "Inspect the metric's inputs, joins and denominator. A null can mean unavailable data or an undefined calculation." });
    if (invalid) findings.push({ id: `invalid:${metric}`, title: `Non-numeric values: ${metric}`,
      evidence: `${invalid} of ${rows.length} returned rows contain values that cannot be read as finite numbers.`,
      impact: "These values cannot support numeric comparisons or totals.",
      nextStep: "Check the source column types and metric expression before using this chart's totals or comparisons." });
  }
  const parsed = dimensions.map(parseDimension), temporal = parsed.filter(d => d.grain);
  const segments = parsed.filter(d => !d.grain).map(d => ({ label: d.table ? `${d.table}.${d.column}` : d.column, index: columns.indexOf(d.column) }));
  const absentSegments = segments.filter(s => s.index < 0);
  if (absentSegments.length) findings.push({ id: "segment-columns", title: "A requested breakdown is missing",
    evidence: `The result is missing ${absentSegments.map(s => s.label).join(", ")}.`,
    impact: "Rows cannot be assigned reliably to the requested categories. Segment comparisons and per-segment continuity checks are unavailable.",
    nextStep: "Refresh the query and inspect the requested breakdown columns before comparing segments." });
  for (const segment of segments) {
    if (segment.index < 0) continue;
    const missing = rows.filter(row => row[segment.index] == null).length;
    const blank = rows.filter(row => typeof row[segment.index] === "string" && !(row[segment.index] as string).trim()).length;
    if (!missing && !blank) continue;
    const counts = [missing ? `${missing} missing (null or absent)` : "", blank ? `${blank} blank text` : ""].filter(Boolean).join("; ");
    findings.push({ id: `category-values:${segment.label}`, title: `Unassigned breakdown values: ${segment.label}`,
      evidence: `${missing + blank} of ${rows.length} returned rows have no usable category label: ${counts}. These are result-row counts, not counts of customers or source records.`,
      impact: "The measures on these rows cannot be attributed to a named category. Excluding the rows may change totals, rankings or category shares.",
      nextStep: "Check the source labels and join keys, and whether an unassigned group is intentional. Keep its measures visible until its meaning is understood; do not silently drop, rename or merge these rows." });
  }
  // Check each full breakdown independently. Another segment's observation
  // cannot fill a gap, and different segment windows are not missing data.
  if (temporal.length !== 1) return findings;
  const { grain, column } = temporal[0];
  if (!grain || !["day", "week", "month", "quarter", "year"].includes(grain)) return findings;
  const index = columns.indexOf(`${column}_${grain}`);
  if (index < 0) {
    findings.push({ id: "time-column", title: "Reporting period is missing",
      evidence: "The requested time dimension is absent from the result columns.", nextStep: "Refresh the query and check its output before reading the trend." });
    return findings;
  }
  if (absentSegments.length) return findings;
  const dates = rows.map(row => resultDate(row[index]));
  const invalidDates = dates.filter(date => !date).length;
  if (invalidDates) findings.push({ id: "invalid-dates", title: "Some reporting dates are missing or invalid",
    evidence: `${invalidDates} of ${rows.length} returned rows have no valid reporting date.`,
    impact: "These rows cannot be placed on a timeline or used to establish continuity.",
    nextStep: "Check the time dimension's source type and values. These rows cannot establish continuity." });
  const groups = new Map<string, { label: string; dates: (Date | null)[] }>();
  rows.forEach((row, i) => {
    const values = segments.map(s => row[s.index]);
    const key = JSON.stringify(values.map(v => [typeof v, v]));
    let group = groups.get(key);
    if (!group) {
      group = { label: segments.map((s, n) => `${s.label}=${values[n] == null ? "(missing)" : JSON.stringify(values[n])}`).join(", "), dates: [] };
      groups.set(key, group);
    }
    group.dates.push(dates[i]);
  });
  let duplicates = 0, missing = 0, affectedSegments = 0;
  const duplicateExamples: string[] = [], examples: string[] = [];
  // Limiting a result can hide intermediate observations. Do not ascribe
  // gaps to the underlying series when the returned window is incomplete.
  for (const group of groups.values()) {
    const valid = group.dates.filter((d): d is Date => d !== null);
    const unique = [...new Set(valid.map(d => d.getTime()))].sort((a, b) => a - b);
    const repeated = valid.length - unique.length;
    duplicates += repeated;
    if (repeated && duplicateExamples.length < 3 && group.label) duplicateExamples.push(group.label);
    if (result.truncated || valid.length !== group.dates.length || repeated) continue;
    let groupMissing = 0;
    for (let i = 1; i < unique.length; i++) {
      const a = new Date(unique[i - 1]), b = new Date(unique[i]);
      const distance = grain === "day" || grain === "week" ? (b.getTime() - a.getTime()) / (86_400_000 * (grain === "week" ? 7 : 1))
        : ((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()) / ({ month: 1, quarter: 3, year: 12 }[grain]!);
      if (Number.isInteger(distance) && distance > 1) {
        groupMissing += distance - 1;
        if (examples.length < 3) examples.push(`${group.label ? `${group.label}: ` : ""}${a.toISOString().slice(0, 10)} → ${b.toISOString().slice(0, 10)}`);
      }
    }
    missing += groupMissing;
    if (groupMissing) affectedSegments++;
  }
  if (duplicates) findings.push({ id: "duplicate-periods", title: segments.length ? "Repeated periods within a segment" : "Repeated periods in a single series",
    evidence: `${duplicates} extra row${duplicates === 1 ? " repeats" : "s repeat"} a reporting date${segments.length ? " within the same breakdown combination" : ", with no categorical breakdown requested"}.${duplicateExamples.length ? ` Examples: ${duplicateExamples.join("; ")}.` : ""}`,
    impact: "A period has more than one result. Summing or choosing a row could misstate rates, snapshots or distinct counts.",
    nextStep: "Inspect the query's grouping and joins before interpreting the chart. This alone does not prove duplicate source records." });
  if (missing) findings.push({ id: "gaps", title: "Gaps in the returned time series",
    evidence: `${missing} ${grain} period${missing === 1 ? "" : "s"}${segments.length ? ` across ${affectedSegments} segment${affectedSegments === 1 ? "" : "s"}` : ""} between returned dates ${missing === 1 ? "has" : "have"} no row. Examples: ${examples.join("; ")}.`,
    impact: segments.length ? "Each affected segment has an incomplete observed timeline. Other segments' rows do not establish its missing values."
      : "The returned rows cannot establish what happened during the missing periods. A connected line or zero-filled value would imply evidence that is absent.",
    nextStep: "Check whether the gaps reflect filters, periods with no activity, or missing loads. Use a date spine when every period should be represented; do not fill gaps with zero by default." });
  return findings;
}

function resultDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(+value) ? new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) : null;
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value);
  if (!parts) return null;
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? date : null;
}
