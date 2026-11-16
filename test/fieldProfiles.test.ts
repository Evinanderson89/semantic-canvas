import { expect, it } from "vitest";
import { dimensionProfiles } from "../src/app/useFieldProfiles.ts";

const country = { field: "country", type: "varchar", cardinality: 2, sample: ["US", "DE"], role: "geo" };
const date = { field: "created_at", type: "varchar", cardinality: 24, sample: ["2026-01-01"], role: "categorical" };
it("matches each dimension by identity and applies its time role regardless of response order", () => {
  expect(dimensionProfiles({ fields: [date, country] }, ["country", "month:created_at"]))
    .toEqual([country, { ...date, role: "temporal" }]);
});
it("reuses deduplicated evidence for multiple time grains without losing dimension identity", () => {
  expect(dimensionProfiles({ fields: [country, date] }, ["month:created_at", "country", "year:created_at"]))
    .toEqual([{ ...date, role: "temporal" }, country, { ...date, role: "temporal" }]);
});
it("does not mistake an omitted dimension or an error body for a scalar chart", () => {
  expect(() => dimensionProfiles({ fields: [country] }, ["country", "month:created_at"])).toThrow("created_at");
  expect(() => dimensionProfiles({ fields: [] }, ["country"])).toThrow("country");
  expect(() => dimensionProfiles({ error: "Unavailable" }, ["country"])).toThrow("invalid field profiles");
  expect(() => dimensionProfiles({ fields: [country, country] }, ["country"])).toThrow("ambiguous");
});
it("keeps unknown cardinality distinct from zero and rejects malformed field evidence", () => {
  expect(dimensionProfiles({ fields: [{ ...country, cardinality: null, warning: "Field evidence unavailable" }] }, ["country"])[0].warning).toBe("Field evidence unavailable");
  expect(dimensionProfiles({ fields: [{ ...country, cardinality: null, sample: [] }] }, ["country"])[0].cardinality).toBeNull();
  expect(dimensionProfiles({ fields: [{ ...country, cardinality: 0, sample: [] }] }, ["country"])[0].cardinality).toBe(0);
  for (const bad of [{ ...country, role: "unexpected" }, { ...country, cardinality: -1 }, { ...country, sample: "US" }]) {
    expect(() => dimensionProfiles({ fields: [bad] }, ["country"])).toThrow("invalid field profiles");
  }
});
