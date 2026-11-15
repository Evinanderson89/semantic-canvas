import type { DatePreset, FilterValue } from "../compiler/spec.ts";
import { DEFAULT_CALENDAR, type Calendar } from "../semantic/model.ts";
import { nextPeriod, periodStart, reportingDay } from "../semantic/calendar.ts";

/** Inclusive reporting-calendar dates. Presets remain tokens in the document;
 * their query ranges follow the model's clock, never the browser's timezone. */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const since = (start: (day: Date, calendar: Calendar) => Date) => (now: Date, calendar = DEFAULT_CALENDAR) => {
  const day = reportingDay(now, calendar);
  return { min: iso(start(day, calendar)), max: iso(day) };
};
const lastDays = (n: number) => since(day => nextPeriod(day, "day", 1 - n));
export const PRESETS: Record<DatePreset, { label: string; resolve: (now: Date, calendar?: Calendar) => { min: string; max: string } }> = {
  "last-7-days": { label: "Last 7 days", resolve: lastDays(7) },
  "last-30-days": { label: "Last 30 days", resolve: lastDays(30) },
  "last-90-days": { label: "Last 90 days", resolve: lastDays(90) },
  "this-month": { label: "This month", resolve: since((day, calendar) => periodStart(day, "month", calendar)) },
  "this-quarter": { label: "This quarter", resolve: since((day, calendar) => periodStart(day, "quarter", calendar)) },
  "year-to-date": { label: "Year to date", resolve: since((day, calendar) => periodStart(day, "year", calendar)) },
};
export const PRESET_IDS = Object.keys(PRESETS) as DatePreset[];
/** Every consumer past this point sees a plain range. */
export function resolvePreset(value: FilterValue, now = new Date(), calendar: Calendar = DEFAULT_CALENDAR): FilterValue {
  if (!value.preset) return value;
  const { preset, ...rest } = value;
  return { ...rest, ...PRESETS[preset].resolve(now, calendar) };
}
