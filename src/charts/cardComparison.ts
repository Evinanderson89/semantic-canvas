import type { TileSpec } from "../compiler/spec.ts";

export type CardComparison = "none" | "prior" | "yoy" | "first";
export const CARD_COMPARISONS: [CardComparison, string][] = [
  ["none", "none"], ["prior", "vs prior"], ["yoy", "vs last year"], ["first", "vs first shown"],
];

/** Preserve the first-shown choice in older documents, where it overrode the
 * query comparison on the card. New edits clear the competing field. */
export function cardComparison(tile: Pick<TileSpec, "compare" | "spark" | "dimensions">): CardComparison {
  if (tile.spark?.compare === "first") return "first";
  return tile.compare ?? (tile.dimensions.some(d => d.includes(":")) ? "prior" : "none");
}

export function withCardComparison(tile: TileSpec, mode: CardComparison): TileSpec {
  return { ...tile, compare: mode === "first" ? "none" : mode, compareShow: "value",
    spark: { ...tile.spark, compare: mode === "first" ? "first" : "prior" } };
}
