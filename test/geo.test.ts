import { expect, it } from "vitest";
import { COUNTRIES, coverage, prepareMap, resolveCountry, toFeatureId } from "../src/charts/geo.ts";
import { countryCodes } from "../src/charts/countryCodes.ts";
import { recommend } from "../src/suggest/recommend.ts";

it("resolves country-code aliases against actual atlas shapes", () => {
  for (const aliases of [["US", "USA", "840", 840, "United States of America"], ["MG", "MDG", "450", "Madagascar"], ["CM", "CMR", "120", "Cameroon"], ["AU", "AUS", "036", 36, "Australia"]]) {
    const id = toFeatureId(aliases[0]); expect(id).not.toBeNull();
    aliases.forEach(value => expect(toFeatureId(value)).toBe(id));
    expect(COUNTRIES.features.some((f: any) => String(f.id) === id)).toBe(true);
  }
  expect(new Set(countryCodes.map(c => c[0])).size).toBe(249);
  for (const value of ["001", 1, "999", "unknown", "New York", "US-CA", null, undefined, true]) expect(toFeatureId(value)).toBeNull();
  expect(resolveCountry("SG")).toEqual({ id: null, reason: "no-shape" });
  expect(coverage(["US", "MG", "SG", "999"])).toEqual({ matched: 2, total: 4 });
});

it("reports omitted places, preserves numeric zero, and never overwrites duplicate-country rows", () => {
  const result = prepareMap([{ place: "US", value: 0 }, { place: "MG", value: "50" }, { place: "SG", value: 9 }, { place: "unknown", value: 30 }]);
  expect([...result.values.values()]).toEqual([0, 50]); expect(result.issue).toBeUndefined();
  expect(result.caption).toContain("2 of 4 returned rows");
  expect(result.findings[0].evidence).toContain("without a shape");
  expect(result.findings[0].evidence).toContain("unrecognized");
  const duplicate = prepareMap([{ place: "US", value: 10 }, { place: "USA", value: 90 }]);
  expect(duplicate.issue).toContain("same country");
  expect(duplicate.values.get("840")).toBe(10);
  expect(duplicate.findings[0].nextStep).toContain("rates, snapshots or distinct counts");
});

it("does not draw missing/invalid results or interpret an unknown code as an arbitrary shape", () => {
  for (const value of [null, "", "bad", Infinity, true]) {
    const prepared = prepareMap([{ place: "US", value }]);
    expect(prepared.values.size).toBe(0); expect(prepared.issue).toContain("No returned rows");
  }
  const numeric = prepareMap([{ place: 36, value: 1 }]);
  expect(numeric.caption).toContain("ISO numeric country codes");
  expect(prepareMap([{ place: 1, value: 10 }]).issue).toBeTruthy();
});

it("does not call a city-only or unverified geographic sample ideal for a country map", () => {
  const options = (sample: string[]) => recommend(["revenue"], [{ field: "place", type: "string", role: "geo", cardinality: 3, sample }]);
  expect(options(["US", "MG", "CM"]).find(o => o.kind === "map")?.fit).toBe("ideal");
  expect(options(["US", "Singapore"]).find(o => o.kind === "map")?.fit).toBe("possible");
  expect(options(["New York", "London"]).find(o => o.kind === "map")?.fit).toBe("poor");
  expect(options(["US", "USA"]).find(o => o.kind === "map")?.fit).toBe("poor");
  expect(options([]).find(o => o.kind === "map")?.why).toContain("not checked");
  expect(options(["New York", "London"])[0].kind).toBe("barH");
});
