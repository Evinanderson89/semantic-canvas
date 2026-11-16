import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json" with { type: "json" };
import { countryCodes } from "./countryCodes.ts";
import type { DataFinding } from "../suggest/resultQuality.ts";

const topo: any = world as any;
export const COUNTRIES: any = feature(topo, topo.objects.countries);
export const LAND_OUTLINE: any = { type: "Sphere" };
const code = (value: unknown) => /^\d{1,3}$/.test(String(value)) ? String(value).padStart(3, "0") : null;
const featureIds = new Set<string>(COUNTRIES.features.flatMap((f: any) => code(f.id) ? [code(f.id)!] : []));
const names = new Map<string, string>();
const normalize = (value: string) => value.trim().toLocaleLowerCase("en-US");
for (const [a2, a3, numeric, name] of countryCodes) {
  for (const key of [a2, a3, numeric, name]) names.set(normalize(key), numeric);
}
// The atlas's spelling remains an alias for the same country code.
for (const f of COUNTRIES.features) if (code(f.id) && f.properties?.name) names.set(normalize(f.properties.name), code(f.id)!);

export function resolveCountry(value: unknown): { id: string | null; reason?: "unknown" | "no-shape" } {
  if (typeof value !== "string" && typeof value !== "number") return { id: null, reason: "unknown" };
  const key = String(value).trim();
  const id = names.get(normalize(code(key) ?? key));
  if (!id) return { id: null, reason: "unknown" };
  return featureIds.has(id) ? { id } : { id: null, reason: "no-shape" };
}

/** Coverage counts drawable atlas shapes, not merely recognized country codes. */
export function toFeatureId(value: unknown): string | null { return resolveCountry(value).id; }
export function coverage(values: unknown[]) {
  return { matched: values.filter(value => toFeatureId(value) !== null).length, total: values.length };
}

/** Never aggregate a duplicate geographic key: its metric could be a rate,
 * snapshot or distinct count. Resolve that grouping in the semantic query. */
export function prepareMap(rows: readonly { place: unknown; value: unknown }[]) {
  const values = new Map<string, number>(), seen = new Set<string>(), duplicates: string[] = [];
  const unmapped: string[] = [], noShape: string[] = [], missing: string[] = [];
  let numericKeys = false;
  const label = (v: unknown) => v == null || v === "" ? "(missing place)" : String(v).slice(0, 80);
  for (const row of rows) {
    numericKeys ||= typeof row.place === "number" || /^\d{1,3}$/.test(String(row.place).trim());
    const match = resolveCountry(row.place);
    if (!match.id) { (match.reason === "no-shape" ? noShape : unmapped).push(label(row.place)); continue; }
    if (seen.has(match.id)) duplicates.push(label(row.place));
    seen.add(match.id);
    const valid = (typeof row.value === "number" || typeof row.value === "string" && !!row.value.trim()) && Number.isFinite(Number(row.value));
    if (!valid) { missing.push(label(row.place)); continue; }
    // Keep the first only for diagnostics; any duplicate blocks rendering.
    if (!values.has(match.id)) values.set(match.id, Number(row.value));
  }
  const examples = (items: string[]) => [...new Set(items)].slice(0, 5).join(", ");
  const rowCount = (n: number) => `${n} row${n === 1 ? "" : "s"}`;
  const findings: DataFinding[] = [];
  if (unmapped.length || noShape.length) findings.push({ id: "map-coverage", title: "Some places are not represented on this map",
    evidence: [unmapped.length ? `${rowCount(unmapped.length)} with unrecognized country keys: ${examples(unmapped)}.` : "", noShape.length ? `${rowCount(noShape.length)} without a shape in this map: ${examples(noShape)}.` : ""].filter(Boolean).join(" "),
    nextStep: "Inspect these rows in a table. Normalize country codes in the semantic model; use a bar or table for cities, regions, and places this atlas cannot draw." });
  if (duplicates.length) findings.push({ id: "map-duplicates", title: "Multiple rows map to one country",
    evidence: `${rowCount(duplicates.length)} resolve to an already represented country: ${examples(duplicates)}. No rows were summed or overwritten.`,
    nextStep: "Normalize aliases and group the governed metric by country in the query. Do not add rates, snapshots or distinct counts without their aggregation definition." });
  if (missing.length) findings.push({ id: "map-values", title: "Some mapped places have no numeric value",
    evidence: `${rowCount(missing.length)} cannot be filled: ${examples(missing)}.`, nextStep: "Inspect the metric result and its inputs in a table before interpreting geographic totals." });
  const issue = duplicates.length ? "Multiple rows resolve to the same country. Use a table and normalize the country grouping before drawing this map."
    : !values.size ? "No returned rows have both a drawable country and a numeric value. Use a table to inspect country keys and missing values." : undefined;
  const caption = [`Map shows ${values.size} of ${rows.length} returned rows.`,
    ...findings.map(f => f.evidence),
    numericKeys ? "Numeric keys are interpreted as ISO numeric country codes." : "",
    "Unfilled places have no mapped value; they do not mean zero."].filter(Boolean).join(" ");
  return { values, findings, issue, caption };
}
