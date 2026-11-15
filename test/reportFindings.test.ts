import { expect, it } from "vitest";
import { reportFindings, type ReportFindingSource } from "../src/app/reportFindings.ts";

const finding = { id: "null:nrr", title: "Missing values: nrr", evidence: "1 of 24 returned rows is missing.", impact: "Missing is not zero.", nextStep: "Check the denominator." };
const source: ReportFindingSource = { id: "headline", title: "Retention", scope: { dimensions: ["month:month"], where: [], window: { start: "2024-09-01", end: "2026-08-01" }, rowRules: ["company"], exceptions: [] }, findings: [finding] };

it("shares identical evidence notes while retaining references to every affected chart", () => {
  const sources = [source, { ...source, id: "trend", title: "Retention trend" }];
  const before = structuredClone(sources), result = reportFindings(sources);
  expect(result).toEqual([{ finding, number: 1, charts: [{ id: "headline", title: "Retention" }, { id: "trend", title: "Retention trend" }] }]);
  expect(sources).toEqual(before);
});
it.each([
  { dimensions: ["week:month"] }, { where: [{ country: "US" }] }, { rowRules: ["regional"] },
  { window: { start: "2025-09-01", end: "2026-08-01" } }, { exceptions: ["Country"] },
  { metrics: ["cac"] }, { limit: 500 }, { compare: "previous" },
])("keeps matching observation text separate when reporting scope differs: %j", change => {
  expect(reportFindings([source, { ...source, id: "other", scope: { ...source.scope as object, ...change } }])).toHaveLength(2);
});
it("does not conflate changed counts, missing values, or excluded periods", () => {
  const partial = { id: "partial", title: "Edge periods excluded", evidence: "The first partial period is absent.", nextStep: "Compare reporting windows." };
  const notes = reportFindings([{ ...source, findings: [partial, finding] }, { ...source, id: "other", findings: [{ ...finding, evidence: "2 of 24 returned rows are missing." }] }]);
  expect(notes.map(n => n.finding.evidence)).toEqual([finding.evidence, "2 of 24 returned rows are missing.", partial.evidence]);
  expect(notes.map(n => n.number)).toEqual([1, 2, 3]);
  expect(reportFindings([{ ...source, findings: [] }])).toEqual([]);
});
