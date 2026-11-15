import { expect, it } from "vitest";
import type { TileSpec } from "../src/compiler/spec.ts";
import { drillInto, drillQueryKey, retainDrillSessions } from "../src/app/drill.ts";
import { tile } from "./fixtures.ts";

const original = tile({ dimensions: ["month:sold_on"] });
const entry = drillInto("month", "sold_on", new Date("2026-06-01"))!;
const session = { query: drillQueryKey(original), entries: [entry] };

for (const patch of [
  { metrics: ["users"] },
  { dimensions: ["week:sold_on"] },
  { dimensions: ["month:another_date"] },
  { where: [{ id: "country", source: "dimension", field: "country", mode: "discrete", values: ["US"] }] },
] satisfies Partial<TileSpec>[]) it(`discards drill scope when the authored query changes: ${JSON.stringify(patch)}`, () => {
  const untouched = tile({ id: "untouched", dimensions: ["month:sold_on"] });
  const sessions = { [original.id]: session, untouched: session };
  expect(retainDrillSessions([{ ...original, ...patch }, untouched], sessions)).toEqual({ untouched: session });
  expect(sessions[original.id].entries).toEqual([entry]);
});

it("preserves the same session through presentation-only changes and normalized defaults", () => {
  const sessions = { [original.id]: session };
  const styled: TileSpec = { ...original, kind: "metric", where: [], title: "Clearer headline", chart: "line", layout: { x: 48, y: 100, w: 600, h: 350 }, format: { palette: "warm" } };
  expect(retainDrillSessions([styled], sessions)).toBe(sessions);
});

it("does not revive removed exploration when undo restores a tile's old ID and query", () => {
  const remaining = retainDrillSessions([], { [original.id]: session });
  expect(remaining).toEqual({});
  expect(retainDrillSessions([original], remaining)).toEqual({});
});
