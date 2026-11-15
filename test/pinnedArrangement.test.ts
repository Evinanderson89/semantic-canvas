import { expect, it } from "vitest";
import { applyLayout, LAYOUT_NAMES, pinnedContent, sectionsOf } from "../src/canvas/layouts.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { applyProposal } from "../src/canvas/proposals.ts";
import { dashboardSchema } from "../src/compiler/schema.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { model, tile } from "./fixtures.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { copiedTiles, mergeTab } from "../src/app/tabs.ts";

const kpi = (id: string, x: number, y: number, pinned = false): TileSpec => tile({ id, chart: "kpi", dimensions: [], pinned,
  layout: { x, y, w: 280, h: 156 } });
const chart = (id: string, y: number): TileSpec => tile({ id, title: `Authored ${id}`, dimensions: ["month:sold_on"],
  where: [{ id: "country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"] }],
  layout: { x: 150, y, w: 400, h: 300 } });
const assertFits = (tiles: TileSpec[], width: number) => {
  for (const [i, t] of tiles.entries()) {
    expect(t.layout.w).toBeGreaterThan(0);
    expect(t.layout.x).toBeGreaterThanOrEqual(24);
    expect(t.layout.x + t.layout.w).toBeLessThanOrEqual(width - 24);
    for (const other of tiles.slice(i + 1)) expect(overlaps(t.layout, other.layout), `${t.id} overlaps ${other.id}`).toBe(false);
  }
};

it.each(["exec-summary", "executive", "story"] as const)("%s gives an unpaired chart the finished row width", name => {
  const original = [kpi("metric", 24, 0), chart("trend", 200), chart("support", 600)];
  const result = applyLayout(name, original, 1120, true, model);
  const last = result.find(t => t.id === "support")!;
  // Executive uses one lead followed by an unpaired supporting chart.
  // Exec Summary can pair both charts, so assert every row fills the width.
  for (const t of result.filter(t => !result.some(o => o.id !== t.id && o.layout.y === t.layout.y))) {
    expect(t.layout.x + t.layout.w).toBe(1096);
  }
  expect(last.layout.w).toBeGreaterThan(0);
  assertFits(result, 1120);
  expect(applyLayout(name, result, 1120, true, model)).toEqual(result);
  expect(original[1].layout.w).toBe(400);
});

it.each(LAYOUT_NAMES)("%s improves loose content around a pinned KPI", name => {
  const original = [kpi("pin", 24, 24, true), kpi("loose", 600, 1800), chart("trend", 2400)];
  const result = applyLayout(name, original, 1200, true, model);
  expect(result[0]).toEqual(original[0]);
  expect(result[1].layout.y).toBe(24);
  expect(result[1].layout.x).toBeGreaterThanOrEqual(320);
  expect(result[2].layout.y).toBeLessThan(2400);
  for (const before of original) expect({ ...result.find(t => t.id === before.id), layout: before.layout }).toEqual(before);
  assertFits(result, 1200);
  expect(applyLayout(name, result, 1200, true, model)).toEqual(result);
});

it.each(LAYOUT_NAMES)("%s handles multiple obstacles and narrow canvases without moving pins", name => {
  for (const width of [640, 1200]) {
    const original = [kpi("left", 24, 24, true), kpi("right", width - 304, 600, true),
      kpi("a", 24, 900), kpi("b", 24, 1100), chart("trend", 1400), chart("support", 1800)];
    const result = applyLayout(name, original, width, true, model);
    expect(result.slice(0, 2)).toEqual(original.slice(0, 2));
    assertFits(result, width);
    expect(result.find(t => t.id === "a")!.layout.y).toBe(24);
    expect(applyLayout(name, result, width, true, model)).toEqual(result);
  }
});

it("keeps authored pinned sections and explicit loose membership stable across repeat arrangements", () => {
  const heading: TileSpec = tile({ id: "story", kind: "heading", metrics: [], text: "Our authored section", layout: { x: 24, y: 260, w: 900, h: 48 } });
  const inSection = { ...chart("pinned-chart", 340), section: heading.id, pinned: true };
  const note: TileSpec = tile({ id: "note", kind: "text", metrics: [], text: "Our conclusion", section: heading.id, layout: { x: 24, y: 660, w: 500, h: 80 } });
  const loose = { ...chart("loose", 24), layout: { x: 24, y: 24, w: 900, h: 350 } };
  const original = [loose, heading, inSection, note];
  const result = applyLayout("grid", original, 1200);
  expect(result.slice(1)).toEqual(original.slice(1));
  expect(result[0].section).toBeNull();
  expect(result[0].layout.y).toBeGreaterThan(740);
  expect(pinnedContent(result).map(t => t.id)).toEqual(["story", "pinned-chart", "note"]);
  expect(sectionsOf(result)[0].map(t => t.id)).toEqual(["loose"]);
  expect(applyLayout("grid", result, 1200)).toEqual(result);
  expect(dashboardSchema.safeParse({ title: "Pinned story", tiles: result }).success).toBe(true);
});

it("lets AI arrangement move loose neighbors but still rejects moving a pin", () => {
  const original = { title: "Revenue", tiles: [kpi("pin", 24, 24, true), kpi("loose", 600, 1800), chart("trend", 2400)] };
  const proposal = { title: "Readable layout", reason: "Bring the trend and headline into view", actions: [{ type: "arrange", layout: "executive" }] };
  const result = applyProposal(original, { ...DEFAULT_CANVAS, width: 1200 }, proposal, model);
  expect(result.spec.tiles[0]).toEqual(original.tiles[0]);
  expect(result.spec.tiles[1].layout.y).toBe(24);
  expect(() => applyProposal(original, DEFAULT_CANVAS, { ...proposal, actions: [{ type: "place", id: "pin", layout: { ...original.tiles[0].layout, y: 500 } }] }, model)).toThrow("pinned content");
});

it("preserves independent membership when a tab is edited or content is copied", () => {
  const header: TileSpec = tile({ id: "heading", kind: "heading", metrics: [], text: "Section", layout: { x: 24, y: 24, w: 900, h: 48 } });
  const loose: TileSpec = { ...chart("loose", 100), section: null };
  const spec = { title: "Two groups", tiles: [header, loose] };
  const edited = mergeTab(spec, { ...spec, tiles: [header, { ...loose, title: "Updated title" }] }, "main");
  expect(edited.tiles[1].section).toBeNull();
  expect(sectionsOf(edited.tiles)[0].map(t => t.id)).toEqual(["loose"]);
  expect(copiedTiles([header, loose], "copy")[1].section).toBeNull();
  // Copying only the section's member does not adopt the destination heading.
  expect(copiedTiles([{ ...loose, section: header.id }], "copy")[0].section).toBeNull();
});
