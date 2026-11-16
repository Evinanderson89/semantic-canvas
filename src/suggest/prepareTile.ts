import type { TileSpec } from "../compiler/spec.ts";
import { metricOf, metricComponents, isCrossTableRatio, timeColumnOf, type Model } from "../semantic/model.ts";

/** Supply declared reporting requirements for a new chart. Explicit unsupported
 * grains remain errors: preparing a draft must not silently reinterpret them. */
export function requiredDimensions(model: Model, metrics: string[], dimensions: string[], preferredGrain = "month"): string[] {
  const next = [...dimensions];
  const requirements = metrics.flatMap(name => { const m = metricOf(model, name); return m ? [m, ...metricComponents(model, m)] : []; });
  const ratio = metrics.length === 1 ? metricOf(model, metrics[0]) : undefined;
  if (ratio && isCrossTableRatio(model, ratio)) {
    const restricted = requirements.filter(m => m.timeGrains?.length);
    if (!restricted.length || next.some(d => d.includes(":"))) return next;
    const grain = [preferredGrain, ...restricted.flatMap(m => m.timeGrains!)].find(g => restricted.every(m => m.timeGrains!.includes(g as any)));
    if (!grain) throw new Error("These metrics do not share a supported reporting period. Put them on separate charts.");
    const numerator = metricOf(model, ratio.numerator!);
    const date = ratio.timeDimension ?? numerator.timeDimension ?? timeColumnOf(model, numerator.baseTable);
    if (!date) throw new Error(`${numerator.baseTable} has no date column to align ${ratio.label} on`);
    return [...next, `${grain}:${date}`];
  }
  for (const m of requirements) {
    if (!m?.timeGrains?.length || !m.timeDimension) continue;
    const present = next.some(d => {
      const field = d.split(":")[1];
      return field && (field.includes(".") ? field : `${m.baseTable}.${field}`) === m.timeDimension;
    });
    if (!present) {
      const peers = requirements.filter(p => p?.timeDimension === m.timeDimension && p.timeGrains?.length);
      const grain = [preferredGrain, ...m.timeGrains].find(g => peers.every(p => p.timeGrains!.includes(g as any)));
      if (!grain) throw new Error("These metrics do not share a supported reporting period. Put them on separate charts.");
      next.push(`${grain}:${m.timeDimension}`);
    }
  }
  return next;
}

export function prepareNewTile(model: Model, tile: TileSpec): TileSpec {
  if (tile.kind === "heading") return { ...tile, text: tile.text?.trim() ? tile.text : tile.title };
  if (tile.kind && tile.kind !== "metric") return tile;
  const dimensions = requiredDimensions(model, tile.metrics, tile.dimensions);
  return { ...tile, dimensions, chart: tile.chart === "stat" && dimensions.some(d => d.includes(":")) ? "kpi" : tile.chart };
}
