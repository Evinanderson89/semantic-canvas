import type { TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { applyLayout } from "../canvas/layouts.ts";
import { suggestStoryStructure } from "./storyStructure.ts";

/** Give a loose collection a structure; preserve an author's existing sections. */
export function arrangeForPurpose(tiles: TileSpec[], model: Model, width: number, purpose: "story" | "executive") {
  const original = new Map(tiles.map(t => [t.id, t]));
  const structure = !tiles.some(t => t.kind === "heading" || t.pinned)
    ? suggestStoryStructure({ title: "Dashboard", tiles }, model, width) : null;
  const structured = (structure?.spec.tiles ?? tiles)
    .filter(t => purpose !== "executive" || original.has(t.id) || t.kind !== "text")
    .map(t => original.has(t.id) ? { ...t, title: original.get(t.id)!.title } : t);
  return applyLayout(purpose, structured, width);
}
