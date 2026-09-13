import type { DatePreset, FilterValue } from "../compiler/spec.ts";
import { DEFAULT_CALENDAR, type Calendar } from "../semantic/model.ts";

/** Local calendar, inclusive ISO dates. A preset is a token in the document and a range only at query time. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (now: Date, offset = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
const since = (start: (now: Date) => Date) => (now: Date) => ({ min: iso(start(now)), max: iso(day(now)) });
const lastDays = (n: number) => since(now => day(now, 1 - n));
/** The first day of the fiscal year and quarter that hold `now`, on a calendar whose year starts in month `start` (1-12). */
const fiscal = (now: Date, start: number) => {
  const shift = start - 1, months = now.getFullYear() * 12 + now.getMonth() - shift; // months since the fiscal epoch
  const toDate = (m: number) => new Date(Math.floor(m / 12), m % 12, 1);
  return { yearStart: toDate(Math.floor(months / 12) * 12 + shift), quarterStart: toDate(Math.floor(months / 3) * 3 + shift) };
};
export const PRESETS: Record<DatePreset, { label: string; resolve: (now: Date, calendar?: Calendar) => { min: string; max: string } }> = {
  "last-7-days": { label: "Last 7 days", resolve: lastDays(7) },
  "last-30-days": { label: "Last 30 days", resolve: lastDays(30) },
  "last-90-days": { label: "Last 90 days", resolve: lastDays(90) },
  "this-month": { label: "This month", resolve: since(now => new Date(now.getFullYear(), now.getMonth(), 1)) },
  "this-quarter": { label: "This quarter", resolve: (now, calendar = DEFAULT_CALENDAR) => ({ min: iso(fiscal(now, calendar.fiscalYearStartMonth).quarterStart), max: iso(day(now)) }) },
  "year-to-date": { label: "Year to date", resolve: (now, calendar = DEFAULT_CALENDAR) => ({ min: iso(fiscal(now, calendar.fiscalYearStartMonth).yearStart), max: iso(day(now)) }) },
};
export const PRESET_IDS = Object.keys(PRESETS) as DatePreset[];
/** Every consumer past this point sees a plain range. */
export function resolvePreset(value: FilterValue, now = new Date(), calendar: Calendar = DEFAULT_CALENDAR): FilterValue {
  if (!value.preset) return value;
  const { preset, ...rest } = value;
  return { ...rest, ...PRESETS[preset].resolve(now, calendar) };
}
