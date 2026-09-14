import { z } from "zod";

export const reviewContextSchema = z.object({
  goal: z.string().max(600).default("Make this dashboard easier to understand."),
  dashboardTitle: z.string().max(1000).default(""),
  decisions: z.array(z.object({ key: z.string().max(4000), label: z.string().max(1000), status: z.enum(["applied", "dismissed"]) })).max(20).default([]),
});
export type ReviewContext = z.infer<typeof reviewContextSchema>;
export type ReviewDecision = ReviewContext["decisions"][number];
export function rememberDecision(history: ReviewDecision[], decision: ReviewDecision): ReviewDecision[] {
  return [...history.filter(item => item.key !== decision.key), decision].slice(-20);
}
export function additionKey(addition: { metrics: string[]; breakdown: string }) {
  return `add:${[...new Set(addition.metrics)].sort().join(",")}:${addition.breakdown}`;
}
export function hasEquivalentTile(tiles: { kind?: string; metrics: string[]; dimensions: string[] }[], addition: { metrics: string[]; breakdown: string }) {
  const metrics = [...new Set(addition.metrics)].sort().join(",");
  return tiles.some(tile => !["text", "heading", "divider", "image", "filter"].includes(tile.kind ?? "metric") && [...new Set(tile.metrics)].sort().join(",") === metrics &&
    (addition.breakdown === "time" ? tile.dimensions.length === 1 && /^(day|week|month|quarter|year):/.test(tile.dimensions[0]) : tile.dimensions.length === 0));
}
export const reviewGoals = [
  { label: "Improve this layout", goal: "Improve this layout: visual hierarchy, chart sizes, grouping, and reading order. Preserve my headings, authored text, pinned content, and metric definitions. Avoid title-only changes." },
  { label: "Add missing context", goal: "Identify missing context that would help answer this dashboard's question. Prefer a useful governed comparison or trend over extra tiles. Do not invent results or causes." },
  { label: "Prepare for leadership", goal: "Prepare this dashboard for leadership: lead with the decision, group supporting evidence, and identify the next question. Preserve authored content and avoid unsupported conclusions." },
] as const;
