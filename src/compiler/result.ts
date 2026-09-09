import type { QueryResult } from "../connectors/types.ts";
import type { TileSpec } from "./spec.ts";
import { parseDimension } from "./compile.ts";

export const resultLimit = (tile: Pick<TileSpec, "limit">) => Math.min(tile.limit ?? 500, 5000);

/** The extra row is evidence of truncation, never a data point. */
export function finishResult(result: QueryResult, tile: TileSpec) {
  const limit = resultLimit(tile);
  const time = tile.dimensions.find((d) => d.includes(":"));
  const truncated = result.rows.length > limit;
  const rows = truncated ? (time ? result.rows.slice(-limit) : result.rows.slice(0, limit)) : result.rows;
  const dim = time ? parseDimension(time) : null;
  const index = dim ? result.columns.indexOf(`${dim.column}_${dim.grain}`) : -1;
  const dates = index < 0 ? [] : rows.map((r) => r[index]).filter((d) => d != null).map(String).sort();
  return { ...result, rows, truncated, limit,
    window: dates.length ? { start: dates[0], end: dates.at(-1)! } : null,
    coverage: time ? "unknown" as const : undefined,
    warnings: truncated ? [`Showing ${time ? "the latest " : "the first "}${limit} result rows. Earlier or additional results are omitted; exports contain this visible window.`] : [],
  };
}
