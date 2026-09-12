import type { DatePreset, FilterValue } from "../compiler/spec.ts";

/** Local calendar, inclusive ISO dates. A preset is a token in the document and a range only at query time. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (now: Date, offset = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
const since = (start: (now: Date) => Date) => (now: Date) => ({ min: iso(start(now)), max: iso(day(now)) });
const lastDays = (n: number) => since(now => day(now, 1 - n));
export const PRESETS: Record<DatePreset, { label: string; resolve: (now: Date) => { min: string; max: string } }> = {
  "last-7-days": { label: "Last 7 days", resolve: lastDays(7) },
  "last-30-days": { label: "Last 30 days", resolve: lastDays(30) },
  "last-90-days": { label: "Last 90 days", resolve: lastDays(90) },
  "this-month": { label: "This month", resolve: since(now => new Date(now.getFullYear(), now.getMonth(), 1)) },
  "this-quarter": { label: "This quarter", resolve: since(now => new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)) },
  "year-to-date": { label: "Year to date", resolve: since(now => new Date(now.getFullYear(), 0, 1)) },
};
export const PRESET_IDS = Object.keys(PRESETS) as DatePreset[];
/** Every consumer past this point sees a plain range. */
export function resolvePreset(value: FilterValue, now = new Date()): FilterValue {
  if (!value.preset) return value;
  const { preset, ...rest } = value;
  return { ...rest, ...PRESETS[preset].resolve(now) };
}
