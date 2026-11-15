import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { queryObservations } from "../src/suggest/queryObservations.ts";
import { checkResultQuality } from "../src/suggest/resultQuality.ts";

it("does not draft unchanged revenue when neighboring integer results round to the same number", () => {
  const result = { columns: ["sold_on_month", "revenue"], rows: [["2026-07-01", "9007199254740992"], ["2026-08-01", "9007199254740993"]] };
  const summary = queryObservations(model, tile({ dimensions: ["month:fct_sales.sold_on"] }), result);
  expect(summary.observations).toEqual([]);
  expect(summary.note).toContain("precision");
  const findings = checkResultQuality(["revenue"], ["month:fct_sales.sold_on"], result);
  expect(findings[0].id).toBe("precision:revenue");
  expect(findings[0].evidence).toContain("9007199254740993");
});

it("does not manufacture a category tie or an exact scalar observation from rounded values", () => {
  const result = { columns: ["country", "revenue"], rows: [["US", "9007199254740992"], ["GB", "9007199254740993"]] };
  expect(queryObservations(model, tile({ dimensions: ["dim_users.country"] }), result).observations).toEqual([]);
  expect(queryObservations(model, tile({ dimensions: [] }), { columns: ["revenue"], rows: [["1.0000000000000001"]] }).observations).toEqual([]);
});

it("checks requested prior values and preserves unrelated safe metrics in the same chart", () => {
  const result = { columns: ["sold_on_month", "revenue", "revenue__prev", "retention", "retention__prev"],
    rows: [["2026-08-01", 100, "9007199254740993", .95, .96]] };
  const summary = queryObservations(model, tile({ metrics: ["revenue", "retention"], dimensions: ["month:fct_sales.sold_on"], compare: "prior" }), result);
  expect(summary.observations.map(o => o.metric)).toEqual(["retention"]);
  expect(summary.note).toContain("Revenue");
});

it("distinguishes numeric display precision from invalid values without mutating source text", () => {
  const rows = [["9007199254740993"], ["1.0000000000000001"], ["1e-400"], [9007199254740992], ["0.1"], ["1.2300"], ["1e3"], ["9007199254740991"], [null], [false]];
  const original = structuredClone(rows);
  const findings = checkResultQuality(["revenue"], [], { columns: ["revenue"], rows });
  expect(findings.find(f => f.id === "precision:revenue")?.evidence).toContain("4 of 10");
  expect(findings.find(f => f.id === "invalid:revenue")?.evidence).toContain("1 of 10");
  expect(rows).toEqual(original);
});
