import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { todayOf } from "../src/semantic/model.ts";
import { reportingDay } from "../src/semantic/calendar.ts";
import { resolvePreset } from "../src/app/datePresets.ts";
import { reviewDataHonesty, toUtcDay } from "../src/suggest/dataHonesty.ts";
import { checkResultQuality } from "../src/suggest/resultQuality.ts";
import { writeMessyLake } from "../src/testing/messyLake.ts";
import { model as sample, tile } from "./fixtures.ts";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "canvas-calendar-validation-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
async function load(today: string) {
  const path = join(dir, "model.yaml");
  await writeFile(path, YAML.stringify({ model: { name: "Calendar validation", calendar: { today } }, tables: {}, metrics: {} }));
  return (await duckglueAdapter.load(path))!;
}

for (const date of ["2026-02-29", "2026-02-30", "2026-04-31", "1900-02-29", "2026-13-01", "2026-01-00"]) {
  it(`rejects nonexistent pinned reporting date ${date} at model load`, async () => {
    await expect(load(date)).rejects.toThrow(/model.calendar.today/);
  });
  it(`does not normalize invalid returned date ${date} into a different reporting day`, () => {
    expect(toUtcDay(date)).toBeNull();
    expect(toUtcDay(`${date}T12:00:00Z`)).toBeNull();
  });
}

for (const date of ["2024-02-29", "2000-02-29", "2026-04-30"]) it(`keeps valid date ${date} consistent across model clocks and presets`, async () => {
  const model = await load(date);
  expect(todayOf(model).toISOString().slice(0, 10)).toBe(date);
  expect(reportingDay(new Date("2030-01-01"), model.calendar).toISOString().slice(0, 10)).toBe(date);
  expect(resolvePreset({ preset: "this-month" }, new Date("2030-01-01"), model.calendar)).toEqual({ min: `${date.slice(0, 7)}-01`, max: date });
  expect(toUtcDay(`${date}T23:59:00-05:00`)?.toISOString()).toBe(`${date}T00:00:00.000Z`);
});

it("rejects invalid fixture dates before creating any output", async () => {
  const output = join(dir, "invalid-output");
  await expect(writeMessyLake(output, "2026-02-30")).rejects.toThrow(/real date.*YYYY-MM-DD/);
  await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects arbitrary text after a date and retains the year for Date inputs below 100", () => {
  expect(toUtcDay("2026-09-13nonsense")).toBeNull();
  expect(toUtcDay(new Date("0099-09-13T12:00:00Z"))?.toISOString()).toBe("0099-09-13T00:00:00.000Z");
});

it("reports an invalid returned date without proposing a false future-date filter", () => {
  const dimensions = ["day:sold_on"], result = { columns: ["sold_on_day", "revenue"], rows: [["2026-02-30", 10]], partial: { start: false, end: false } };
  expect(checkResultQuality(["revenue"], dimensions, result).map(f => f.id)).toEqual(["invalid-dates"]);
  expect(reviewDataHonesty({ tile: tile({ dimensions }), model: sample, ...result, timeDimension: dimensions[0], today: new Date("2026-03-01T12:00:00Z") })).toEqual([]);
});
