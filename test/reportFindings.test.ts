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

it("shares repeated scope guidance without claiming that different chart scopes are the same", () => {
  const partial = { id: "partial", title: "Edge periods were left out", evidence: "The first partial period is excluded.", nextStep: "Check each chart's reporting window." };
  const first = { ...source, findings: [partial], scope: { metrics: ["new_mrr"], dimensions: ["month:movement_date"], compare: "prior", limit: 24 } };
  const second = { ...first, id: "trend", title: "Gross additions", scope: { metrics: ["new_mrr", "expansion_mrr"], dimensions: ["month:movement_date"], compare: "none", limit: 36 } };
  const filtered = { ...second, id: "filtered", title: "Regional additions", scope: { ...second.scope, where: [{ country: "US" }] } };
  const sources = [first, second, filtered], before = structuredClone(sources);
  expect(reportFindings(sources)).toEqual([{ finding: partial, number: 1, independentScopes: 3,
    charts: sources.map(({ id, title }) => ({ id, title })) }]);
  expect(sources).toEqual(before);
  // Different excluded edges remain different notes, even with the same ID.
  expect(reportFindings([first, { ...second, findings: [{ ...partial, evidence: "The last partial period is excluded." }] }])).toHaveLength(2);
  // Repeated null observations still cannot be combined across these scopes.
  expect(reportFindings(sources.map(s => ({ ...s, findings: [finding] })))).toHaveLength(3);
});
