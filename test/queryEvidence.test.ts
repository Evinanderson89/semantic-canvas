import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { queryEvidence } from "../src/suggest/queryEvidence.ts";

it("gives agents the same threshold-preserving values and explicit bucket-start basis as the report", () => {
  const governed = { ...model, metrics: { ...model.metrics, retention: { ...model.metrics.retention, unit: "percent" as const } } };
  const query = tile({ metrics: ["retention"], dimensions: ["month:fct_sales.sold_on"], compare: "prior" });
  const result = { columns: ["sold_on_month", "retention", "retention__prev"], rows: [["2026-07-01", 1.0004, 1.01], ["2026-08-01", .9996, 1.0004]] };
  const original = structuredClone({ query, result, governed });
  const evidence = queryEvidence(governed, query, result);
  expect(evidence.metrics).toEqual([{ name: "retention", label: "Net revenue retention", unit: "percent", unitSource: "declared" }]);
  expect(evidence.timeDimensions).toEqual([{ dimension: "month:fct_sales.sold_on", resultColumn: "sold_on_month", grain: "month", dateMeaning: "Start of the month bucket, not its end." }]);
  expect(evidence.observations[0].statement).toContain("was 99.96%");
  expect(evidence.observations[0].statement).toContain("from 100.04%");
  expect(evidence.observations[0].basis).toBe("month bucket starting 2026-08-01");
  expect(evidence.rowsChecked).toBe(2);
  expect({ query, result, governed }).toEqual(original);
});

it("withholds conclusions for limited or incomparable input coverage while retaining findings", () => {
  const query = tile({ dimensions: ["month:fct_sales.sold_on"] });
  const result = { columns: ["sold_on_month", "revenue"], rows: [["2026-08-01", 100]] };
  const limited = queryEvidence(model, query, { ...result, truncated: true });
  expect(limited.observations).toEqual([]);
  expect(limited.observationNote).toContain("limited");
  expect(limited.findings.map(f => f.id)).toContain("limited");
  const ratio = queryEvidence(model, query, { ...result, partial: { start: false, end: false,
    ratio: [{ period: "2026-08-01", numeratorStart: "2026-08-01", numeratorEnd: "2026-08-31", denominatorStart: "2026-08-01", denominatorEnd: "2026-08-15" }] } });
  expect(ratio.observations).toEqual([]);
  expect(ratio.findings.map(f => f.id)).toContain("ratio-coverage");
  const missing = queryEvidence(model, query, { ...result, rows: [["2026-08-01", null]] });
  expect(missing.findings.map(f => f.id)).toContain("null:revenue");
  expect(missing.observations[0].latest).toBeUndefined();
  expect(missing.observations[0].statement).toContain("no numeric value");
});

it("discloses inferred units, respects comparison none, and does not claim whole-period data from a scalar", () => {
  const result = { columns: ["sold_on_month", "retention"], rows: [["2026-07-01", .95], ["2026-08-01", .99]] };
  const evidence = queryEvidence(model, tile({ metrics: ["retention"], dimensions: ["month:fct_sales.sold_on"], compare: "none" }), result);
  expect(evidence.metrics[0].unitSource).toBe("inferred from metric naming");
  expect(evidence.observations[0].previous).toBeUndefined();
  const scalar = queryEvidence(model, tile({ dimensions: [] }), { columns: ["revenue"], rows: [[10]] });
  expect(scalar.timeDimensions).toEqual([]);
  expect(scalar.observations[0].basis).toBe("Aggregate · no time breakdown");
  expect(scalar.basis).toContain("do not establish a cause");
});
