import { describe, expect, it } from "vitest";
import { proposalProblems } from "../src/modeler/proposals.ts";
import { model } from "./fixtures.ts";

// What an editor may propose: one aggregate over one table's own columns, nothing else.
const ok = { name: "big_sales", label: "Big sales", baseTable: "fct_sales", expression: "COUNT(*) FILTER (WHERE fct_sales.amount > 100)" };
describe("proposed metrics", () => {
  it("accepts an aggregate over the table's columns, qualified or bare, with a row filter", () => {
    expect(proposalProblems(model, ok)).toEqual([]);
    expect(proposalProblems(model, { ...ok, expression: "SUM(amount) / NULLIF(COUNT(DISTINCT user_id), 0)" })).toEqual([]);
    expect(proposalProblems(model, { ...ok, expression: "AVG(CASE WHEN amount > 0 THEN amount ELSE NULL END)", filter: "fct_sales.plan_id = 'pro'" })).toEqual([]);
  });
  it("names each problem plainly", () => {
    expect(proposalProblems(model, { ...ok, name: "Big Sales" })[0]).toContain("Name:");
    expect(proposalProblems(model, { ...ok, name: "revenue" })[0]).toBe("There is already a metric called revenue.");
    expect(proposalProblems(model, { ...ok, baseTable: "nope" })).toEqual(["No table called nope."]);
    expect(proposalProblems(model, { ...ok, expression: "amount" })[0]).toContain("a metric is an aggregate");
    expect(proposalProblems(model, { ...ok, expression: "SUM(dim_users.amount)" })[0]).toContain("dim_users.amount is not on fct_sales");
    expect(proposalProblems(model, { ...ok, expression: "SUM(fct_sales.total)" })[0]).toBe("Expression: fct_sales has no column total.");
    expect(proposalProblems(model, { ...ok, expression: "SUM(revenue_usd)" })[0]).toContain('"revenue_usd" is not a column of fct_sales');
    expect(proposalProblems(model, { ...ok, expression: "SUM(amount); DROP TABLE x" })[0]).toContain("no statements");
    expect(proposalProblems(model, { ...ok, expression: "(SELECT MAX(amount) FROM fct_sales)" })[0]).toContain("no statements, subqueries");
    expect(proposalProblems(model, { ...ok, expression: "SUM(read_parquet('/etc/passwd'))" })[0]).toContain("file reads");
    expect(proposalProblems(model, { ...ok, filter: "SUM(amount) > 1" })).toContain("Filter: a row condition, not an aggregate (the aggregate goes in the expression).");
    expect(proposalProblems(model, { ...ok, expression: "" })[0]).toContain("say what to compute");
  });
});
