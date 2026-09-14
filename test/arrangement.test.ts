import { expect, it } from "vitest";
import { arrangeForPurpose } from "../src/suggest/arrangement.ts";
import { applyLayout } from "../src/canvas/layouts.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { model, tile } from "./fixtures.ts";
import { dashboardSchema } from "../src/compiler/schema.ts";

const draft = () => [
  tile({ id: "headline", chart: "kpi", dimensions: ["month:sold_on"] }),
  ...["lead", "support-1", "support-2"].map((id, i) => tile({ id, chart: "line", title: `Authored ${id}`, dimensions: ["month:sold_on"], layout: { x: 24, y: 200 + i * 320, w: 1100, h: 300 } })),
  tile({ id: "commentary", kind: "text", title: "Our decision", text: "Keep our original decision here.", metrics: [], layout: { x: 24, y: 1400, w: 800, h: 80 } }),
];

it("offers distinct story and executive compositions without changing the analysis", () => {
  const original = draft();
  const story = arrangeForPurpose(original, model, 1440, "story");
  const executive = arrangeForPurpose(original, model, 1440, "executive");
  expect(story.find(t => t.id === "support-1")!.layout.w).toBe(1392);
  expect(executive.find(t => t.id === "support-1")!.layout.w).toBe(688);
  expect(executive.find(t => t.id === "support-1")!.layout.y).toBe(executive.find(t => t.id === "support-2")!.layout.y);
  expect(story.find(t => t.id === "support-1")!.layout.y).not.toBe(story.find(t => t.id === "support-2")!.layout.y);
  for (const result of [story, executive]) {
    for (const before of original) {
      const after = result.find(t => t.id === before.id)!;
      expect({ ...after, layout: before.layout, section: before.section }).toEqual({ ...before, section: before.section });
    }
    expect(result.some(t => t.kind === "heading")).toBe(true);
    expect(dashboardSchema.safeParse({ title: "Draft", tiles: result }).success).toBe(true);
  }
});

it.each(["story", "executive"] as const)("%s is repeatable, fits narrow canvases and preserves pinned sections", purpose => {
  for (const width of [640, 1440]) {
    const first = arrangeForPurpose(draft(), model, width, purpose);
    expect(arrangeForPurpose(first, model, width, purpose)).toEqual(first);
    first.forEach((t, i) => {
      expect(t.layout.x + t.layout.w).toBeLessThanOrEqual(width);
      expect(first.slice(i + 1).some(other => overlaps(t.layout, other.layout))).toBe(false);
    });
    first.find(t => t.id === "lead")!.pinned = true;
    const pinnedSection = first.find(t => t.id === "lead")!.section;
    const changed = applyLayout(purpose, first, width);
    expect(changed.filter(t => t.section === pinnedSection || t.id === pinnedSection)).toEqual(first.filter(t => t.section === pinnedSection || t.id === pinnedSection));
  }
});
