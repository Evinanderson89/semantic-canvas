import { numericValue } from "../charts/values.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { metricUnit } from "../format/format.ts";
import { calendarOf, metricComponents, metricOf, metricType, type Metric, type Model } from "../semantic/model.ts";
import { dimensionAlias } from "../app/chartResult.ts";
import { queryObservations } from "./queryObservations.ts";
import { checkResultQuality, type QualityResult } from "./resultQuality.ts";

/** Preserve authored semantics rather than guessing a population from SQL or
 * a metric label. A null standalone filter does not mean an expression lacks
 * FILTER/CASE conditions. Computed metrics retain their component definitions. */
function definition(model: Model, metric: Metric) {
  return {
    name: metric.name, label: metric.label, type: metricType(metric),
    baseTable: metric.baseTable, tableGrain: model.tables[metric.baseTable]?.grain ?? null,
    description: metric.description ?? null, expression: metric.expression,
    filter: metric.filter ?? null,
    ...(metric.numerator ? { numerator: metric.numerator } : {}),
    ...(metric.denominator ? { denominator: metric.denominator } : {}),
    ...(metric.metric ? { metric: metric.metric } : {}),
    ...(metric.window !== undefined ? { window: metric.window } : {}),
  };
}

/** Explain the already-authorized, finalized result. No additional queries or
 * unfiltered rows: this runs after edge handling and removal of limit probes.
 * Callers supply the same role-visible model used by the catalog endpoint. */
export function queryEvidence(model: Model, tile: TileSpec, result: QualityResult) {
  // A query has no chart encoding or implicit KPI comparison. Summarize its
  // values with the requested comparison; never infer a display transform.
  const summary = queryObservations(model, { ...tile, chart: "table" }, result);
  return {
    basis: "Computed from the returned rows in this query's scope. Observations do not establish a cause or certify source completeness.",
    populationGuidance: "Definitions are semantic metadata, not additional query results. Shared tables, periods or units do not establish that metrics count the same population or that one total came from another metric's customers. Read expressions, standalone filters and component definitions together; a null filter does not rule out conditions inside the expression. Query filters and row-level policies still apply. State totals separately unless population-matched evidence supports the relationship.",
    rowsChecked: result.rows.length,
    availabilityGuidance: "Counts describe returned metric values, not source records or input availability. A measured zero is available data. A null result does not prove missing inputs: a zero denominator can make a ratio undefined. Query the governed inputs in the same scope before attributing a null to a cause; otherwise state that the cause is unverified.",
    metrics: tile.metrics.map(name => {
      const metric = metricOf(model, name);
      const index = result.columns.indexOf(name);
      const values = index < 0 ? [] : result.rows.map(row => row[index]);
      const numbers = values.map(numericValue);
      const availability = { columnPresent: index >= 0,
        numericValues: numbers.filter(value => value !== null).length,
        zeroValues: numbers.filter(value => value === 0).length,
        nullValues: values.filter(value => value == null).length,
        nonNumericValues: values.filter((value, i) => value != null && numbers[i] === null).length,
      };
      return { name, availability, label: metric?.label ?? name, unit: metricUnit(model, name),
        unitSource: metric?.unit ? "declared" : "inferred from metric naming",
        ...(metric ? { definition: definition(model, metric),
          ...(metricType(metric) !== "simple" ? { components: metricComponents(model, metric).map(component => definition(model, component)) } : {}),
        } : {}),
      };
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
