import { expect, it, vi } from "vitest";
import { breakdownStatement, reviewBreakdown } from "../src/suggest/breakdownReview.ts";
import { detectDegenerate } from "../src/suggest/recommend.ts";

const columns = ["country", "revenue"];
const selection = { id: "cross", field: "country", source: "dimension" as const, mode: "discrete" as const, values: ["US"] };
const query = { metrics: ["revenue"], dimensions: ["country"], where: [selection] };
const result = { columns, rows: [["US", 100]] };

it.each([null, undefined, "", " ", false, Infinity, NaN, "unknown"])("does not call unknown value %s a zero in an unhelpful breakdown", value => {
  expect(detectDegenerate([["US", 10], ["DE", value]], columns, "country", "revenue")).toBeNull();
  expect(detectDegenerate([["US", value]], columns, "country", "revenue")).toBeNull();
});

it("rejects repeated categories and missing category keys", () => {
  expect(detectDegenerate([["US", 10], ["US", 0]], columns, "country", "revenue")).toBeNull();
  expect(detectDegenerate([[null, 10]], columns, "country", "revenue")).toBeNull();
});

it("describes a single zero-valued category without calling its value nonzero", () => {
  const found = detectDegenerate([["US", "0"]], columns, "country", "revenue")!;
  expect(found.basis).toBe("single-category");
  expect(breakdownStatement(found)).not.toContain("nonzero");
});

it("suppresses a selection-only edit while retaining authored query filters in the confirmation", async () => {
  const own = { ...selection, id: "authored", field: "region", values: ["Americas"] };
  const read = vi.fn(async () => ({ columns, rows: [["US", 100], ["CA", 80]] }));
  const before = structuredClone(query);
  const review = await reviewBreakdown({ where: [own] }, { ...query, where: [own, selection] }, result, read);
  expect(read).toHaveBeenCalledWith({ ...query, where: [own] });
  expect(review.finding).toBeNull();
  expect(review.scopeNote).toContain("specific to this selection");
  expect(query).toEqual(before);
});

it("retains a confirmed governed one-category finding and discloses its broader basis", async () => {
  const review = await reviewBreakdown({}, query, result, async () => ({ columns, rows: [["US", 100], ["CA", 0]] }));
  expect(review.finding?.basis).toBe("single-nonzero");
  expect(review.scopeNote).toContain("Applying this changes the chart for every selection");
});

it("does not issue a redundant confirmation when the visible scope is already the authored scope", async () => {
  const read = vi.fn();
  const review = await reviewBreakdown({ where: query.where }, query, result, read);
  expect(review.finding).not.toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it("never recommends removing a breakdown using a truncated or failed confirmation", async () => {
  const read = vi.fn();
  expect((await reviewBreakdown({}, query, { ...result, truncated: true }, read)).finding).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(await reviewBreakdown({}, query, result, async () => ({ ...result, truncated: true }))).toMatchObject({ finding: null, limited: true });
  expect(await reviewBreakdown({}, query, result, async () => { throw new Error("unavailable"); })).toMatchObject({ finding: null, unavailable: true });
});
