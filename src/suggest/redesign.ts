import { applyProposal, proposalSchema } from "../canvas/proposals.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { overlaps } from "../canvas/geometry.ts";

export const REDESIGN_INSTRUCTIONS = `Redesign this dashboard as a coherent whole. Help the reader imagine a more useful finished dashboard, then propose the concrete edits that make it real.
Use describe_model and, where useful, profile_field/query_metric to inspect available governed metrics and check the current charts. A categorical chart with only one meaningful bar may need a trend or a different governed comparison. Never invent metrics, results, causes, alerts, or integrations.
Prioritize useful chart choices, reporting periods, comparisons, layout hierarchy, and missing supporting evidence. Keep existing filters, authored commentary and pinned sections. Avoid title-only changes. Use query to change a tile's metrics, dimensions or comparison; chart to change its visualization; place to size or group tiles under headings; add for genuinely missing context; arrange for final packing. Preserve all existing charts unless removal is necessary and explained. Keep the dashboard focused rather than adding charts just to look busy.
Return one coherent propose_canvas_changes proposal, with a short title describing the intended dashboard and a reason explaining what becomes easier to understand. Then briefly explain the reader's journey and the most useful improvements. Query results are needed before asserting business findings. You may propose an empty canvas's initial charts using the available catalog. Nothing is applied until the user approves the preview.`;

export function validateRedesign(spec: DashboardSpec, canvas: CanvasSpec, raw: unknown, model: Model) {
  const proposal = proposalSchema.parse(raw);
  if (!proposal.actions.some(a => !["rename", "title", "note"].includes(a.type))) {
    throw new Error("A redesign needs a chart, comparison, layout, or supporting-context change. Wording alone is not enough.");
  }
  const next = applyProposal(spec, canvas, proposal, model);
  for (const [i, tile] of next.spec.tiles.entries()) {
    const before = spec.tiles.find(t => t.id === tile.id);
    if (tile.layout.x + tile.layout.w > next.canvas.width && (!before || JSON.stringify(before.layout) !== JSON.stringify(tile.layout))) throw new Error("Keep proposed tiles inside the canvas width.");
    if ((tile.kind ?? "metric") === "metric" && ["kpi", "stat"].includes(tile.chart ?? "") && (tile.metrics.length !== 1 || tile.dimensions.some(d => !d.includes(":")))) throw new Error("A headline card needs one metric without a categorical breakdown.");
    for (const other of next.spec.tiles.slice(i + 1)) {
      if (!overlaps(tile.layout, other.layout)) continue;
      const previousOther = spec.tiles.find(t => t.id === other.id);
      if (!before || !previousOther || !overlaps(before.layout, previousOther.layout)) throw new Error("The redesign introduces overlapping tiles. Arrange the proposal before returning it.");
    }
  }
  const analyticalShape = (dashboard: DashboardSpec) => dashboard.tiles.map(t => ({ id: t.id, metrics: t.metrics, dimensions: t.dimensions, compare: t.compare, chart: t.chart, layout: t.layout, section: t.section, kind: t.kind }));
  if (JSON.stringify(analyticalShape(spec)) === JSON.stringify(analyticalShape(next.spec))) {
    throw new Error("This redesign only changes wording. Propose a useful chart, comparison, or layout improvement.");
  }
  return next;
}
