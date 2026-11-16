import type { DashboardSpec } from "../src/compiler/spec.ts";
import type { CanvasProposal } from "../src/canvas/proposals.ts";
import { tabOf } from "../src/app/tabs.ts";

interface Wording {
  location: string;
  text: string;
  // Context to inspect, never a claim that a query supports this wording.
  candidateEvidenceIds: string[];
}

function documentWording(spec: DashboardSpec) {
  const entries = new Map<string, Wording>();
  const charts = spec.tiles.filter(t => (t.kind ?? "metric") === "metric");
  const add = (path: string[], text: string | undefined, ids: string[]) => {
    if (text?.trim()) entries.set(JSON.stringify(path), { location: path.join(" / "), text, candidateEvidenceIds: ids });
  };
  const all = charts.map(t => t.id);
  add(["dashboard", "title"], spec.title, all);
  add(["dashboard", "description"], spec.description, all);
  for (const tile of spec.tiles) {
    const ids = (tile.kind ?? "metric") === "metric" ? [tile.id]
      : charts.filter(t => tabOf(spec, t) === tabOf(spec, tile)).map(t => t.id);
    add(["tile", tile.id, "title"], tile.title, ids);
    add(["tile", tile.id, "text"], tile.text, ids);
    if (tile.evidence) for (const field of ["sourceTitle", "question", "period"] as const)
      add(["tile", tile.id, "investigation", field], tile.evidence[field], ids);
  }
  for (const tab of spec.tabs ?? []) {
    const ids = charts.filter(t => tabOf(spec, t) === tab.id).map(t => t.id);
    add(["tab", tab.id, "title"], tab.title, ids);
    if (tab.brief) for (const field of ["question", "takeaway", "nextStep"] as const)
      add(["tab", tab.id, "brief", field], tab.brief[field], tab.brief.evidenceIds ?? ids);
  }
  for (const filter of spec.filters ?? [])
    add(["filter", filter.id, "label"], filter.label, filter.bindings.map(b => b.tileId));
  return entries;
}

/** Inventory every authored text surface, including unchanged copy that can
 * become stale after query edits. Matching text to evidence is a separate,
 * explicit review; successful queries cannot establish narrative truth. */
export function narrativeInventory(before: DashboardSpec, after: DashboardSpec, proposal: CanvasProposal, explanation?: string) {
  const left = documentWording(before), right = documentWording(after);
  const document = [...new Set([...left.keys(), ...right.keys()])].map(id => {
    const a = left.get(id), b = right.get(id);
    return { id, location: (b ?? a)!.location, source: "document" as const,
      change: !a ? "added" : !b ? "removed" : a.text === b.text ? "retained" : "changed",
      before: a?.text ?? null, after: b?.text ?? null,
      beforeCandidateEvidenceIds: a?.candidateEvidenceIds ?? [], candidateEvidenceIds: b?.candidateEvidenceIds ?? [],
      reviewStatus: "required" as const };
  });
  const explanationText = { title: proposal.title, reason: proposal.reason, explanation };
  const assistant = Object.entries(explanationText).filter(([, text]) => text?.trim()).map(([field, text]) => ({
    id: JSON.stringify(["assistant", field]), location: `assistant / ${field}`, source: "assistant" as const,
    change: "added", before: null, after: text!, beforeCandidateEvidenceIds: [],
    candidateEvidenceIds: after.tiles.filter(t => (t.kind ?? "metric") === "metric").map(t => t.id),
    reviewStatus: "required" as const,
  }));
  return [...document, ...assistant];
}
