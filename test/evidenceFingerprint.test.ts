import { expect, it } from "vitest";
import { canonicalEvidence, chartEvidence, digestEvidence, briefReviewStatus } from "../src/app/evidenceFingerprint.ts";
import { emptyBrief } from "../src/app/presentationBrief.ts";

const query = { metrics: ["retention"], dimensions: ["month:period"], where: [] };
const result = { columns: ["period_month", "retention"], rows: [["2026-08-01", 1.02]], sql: "SELECT governed_retention", ms: 3, cached: false, principal: "analyst", rlsApplied: ["region"] };

it("ignores object key order and query timing but detects actual evidence changes", async () => {
  expect(canonicalEvidence({ b: 2, a: 1 })).toBe(canonicalEvidence({ a: 1, b: 2 }));
  const original = await digestEvidence(chartEvidence(query, result));
  expect(await digestEvidence(chartEvidence(query, { ...result, ms: 300, cached: true, key: "refresh:2" }))).toBe(original);
  for (const change of [
    { rows: [["2026-08-01", .97]] }, { rows: [["2026-08-01", null]] },
    { sql: "SELECT changed_definition" }, { truncated: true }, { principal: "other" },
    { rlsApplied: ["other_rule"] }, { coverage: "unknown" }, { partial: [{ period: "2026-08-01" }] },
  ]) expect(await digestEvidence(chartEvidence(query, { ...result, ...change }))).not.toBe(original);
  expect(await digestEvidence(chartEvidence({ ...query, where: [{ field: "country", values: ["US"] }] }, result))).not.toBe(original);
});

it("never treats unavailable or still-pending evidence as a matching review", () => {
  const brief = { ...emptyBrief(), takeaway: "Retention is stable." };
  expect(briefReviewStatus(brief, "current", false)).toBe("unreviewed");
  const reviewed = { ...brief, review: { version: 1 as const, reviewedAt: "2026-11-14T12:00:00.000Z", fingerprint: "current" } };
  expect(briefReviewStatus(reviewed, "current", false)).toBe("matches");
  expect(briefReviewStatus(reviewed, "new", false)).toBe("changed");
  expect(briefReviewStatus(reviewed, undefined, false)).toBe("unavailable");
  expect(briefReviewStatus(reviewed, "current", true)).toBe("checking");
});
