import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { metricUnit } from "../format/format.ts";
import { calendarOf, metricOf, type Model } from "../semantic/model.ts";
import { dimensionAlias } from "../app/chartResult.ts";
import { queryObservations } from "./queryObservations.ts";
import { checkResultQuality, type QualityResult } from "./resultQuality.ts";

/** Explain the already-authorized, finalized result. No additional queries or
 * unfiltered rows: this runs after edge handling and removal of limit probes.
 * Callers supply the same role-visible model used by the catalog endpoint. */
export function queryEvidence(model: Model, tile: TileSpec, result: QualityResult) {
  // A query has no chart encoding or implicit KPI comparison. Summarize its
  // values with the requested comparison; never infer a display transform.
  const summary = queryObservations(model, { ...tile, chart: "table" }, result);
  return {
    basis: "Computed from the returned rows in this query's scope. Observations do not establish a cause or certify source completeness.",
    rowsChecked: result.rows.length,
    metrics: tile.metrics.map(name => {
      const metric = metricOf(model, name);
      return { name, label: metric?.label ?? name, unit: metricUnit(model, name),
        unitSource: metric?.unit ? "declared" : "inferred from metric naming" };
    }),
    timeDimensions: tile.dimensions.flatMap(dimension => {
      const parsed = parseDimension(dimension);
      return parsed.grain ? [{ dimension, resultColumn: dimensionAlias(dimension), grain: parsed.grain,
        dateMeaning: `Start of the ${parsed.grain} bucket, not its end.`,
      }] : [];
    }),
    reportingCalendar: calendarOf(model),
    observations: summary.observations,
    ...(summary.note ? { observationNote: summary.note } : {}),
    findings: checkResultQuality(tile.metrics, tile.dimensions, result),
  };
}
