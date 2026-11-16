import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

const present = (value: string | null | undefined): value is string => !!value?.trim();
const narrative = (tile: TileSpec) => tile.kind === "text" || tile.kind === "heading";
type TextStatus = "unchanged" | "added" | "replaced" | "cleared";
const status = (before: string | null | undefined, after: string | null | undefined): TextStatus =>
  !present(before) ? present(after) ? "added" : "unchanged" : !present(after) ? "cleared" : before === after ? "unchanged" : "replaced";

/** Calculated facts about wording that exists in the current document.
 * Absence is stated explicitly: an omitted JSON key reads as unknown, and a
 * title is not a description. An explanation may characterize prior wording
 * only from these facts, never from an assumed earlier version. */
export function documentTextFacts(spec: DashboardSpec) {
  const notes = spec.tiles.filter(tile => narrative(tile) && present(tile.text));
  return {
    basis: "Calculated from the current document. No other prior wording exists. The dashboard title is a title, not a description.",
    dashboardTitle: spec.title,
    dashboardDescription: present(spec.description) ? { exists: true as const, text: spec.description }
      : { exists: false as const, statement: "This dashboard has no description. A describe action adds the first one; nothing is replaced, corrected or made inaccurate." },
    authoredNotes: notes.length ? { count: notes.length, tileIds: notes.map(tile => tile.id) }
      : { count: 0, statement: "No text or heading tile has authored content." },
  };
}

/** Derive wording changes from the final documents, never from an AI's explanation. */
export function proposalTextChanges(before: DashboardSpec, after: DashboardSpec) {
  const text = (value: string | null | undefined) => present(value) ? value : null;
  return {
    dashboardTitle: { status: status(before.title, after.title), before: text(before.title), after: text(after.title) },
    dashboardDescription: { status: status(before.description, after.description), before: text(before.description), after: text(after.description) },
    existingNotes: before.tiles.filter(narrative).flatMap(tile => {
      const next = after.tiles.find(candidate => candidate.id === tile.id);
      const change = next ? status(tile.text, next.text) : present(tile.text) ? "removed" as const : "unchanged" as const;
      return change === "unchanged" ? [] : [{ id: tile.id, status: change, before: text(tile.text), after: text(next?.text) }];
    }),
    addedNotes: after.tiles.filter(tile => narrative(tile) && !before.tiles.some(old => old.id === tile.id)).map(tile => tile.id),
  };
}
