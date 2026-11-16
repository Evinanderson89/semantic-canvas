import { expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { rationaleIssues } from "../src/canvas/rationaleChecks.ts";
import { tile } from "./fixtures.ts";

const bare = { title: "Synthetic sample — revenue trend check", tiles: [tile({ id: "sample-mrr" })] };
const described = { ...bare, description: "Monthly new MRR." };
const ids = (...args: Parameters<typeof rationaleIssues>) => rationaleIssues(...args).map(issue => issue.id);

it("flags a rationale that describes or replaces a description the dashboard never had", () => {
  // The sentence from the captured live failure.
  const captured = "Headings name the reporting period. The dashboard description is replaced because the prior one described a single isolated revenue trend check; no references to other tabs existed in it.";
  expect(rationaleIssues(bare, described, captured)).toEqual([{ id: "prior-description", message: expect.stringContaining("adds the first description") }]);
  for (const reason of ["I updated the dashboard description to match.", "The old description no longer fit the charts.", "Rewrote the description for executives.", "The existing description was corrected."])
    expect(ids(bare, described, reason), reason).toEqual(["prior-description"]);
  // No describe action at all, but the rationale still invents prior wording.
  expect(rationaleIssues(bare, bare, "The previous description stays accurate.")[0].message).toContain("has none");
});

it("accepts accurate wording about descriptions", () => {
  for (const reason of ["Added a dashboard description naming the reporting period.", "The dashboard had no description; this adds one.", "There was no prior description, so a short one is added.",
    "A description is added because the charts need a stated scope.", "Each metric's description comes from the governed catalog."])
    expect(ids(bare, described, reason), reason).toEqual([]);
  // A real prior description may be described and replaced.
  expect(ids(described, { ...described, description: "New MRR by month." }, "The dashboard description is replaced because the prior one described a single total.")).toEqual([]);
});

it("flags a cited row count that no query in the review returned, and skips the check without a ledger", () => {
  const research = [{ rowsChecked: 23 }, { rowsChecked: 1 }, { rowsChecked: null }];
  const reason = "Three period KPIs are from 6 returned monthly rows; the trend carries 23 returned monthly rows with a limit of 36 rows.";
  expect(rationaleIssues(bare, bare, reason, research)).toEqual([{ id: "row-count", message: expect.stringMatching(/cites 6 rows.*returned 1, 23 rows/) }]);
  expect(ids(bare, bare, "The trend has 23 rows and the total has 1 rows.", research)).toEqual([]);
  expect(ids(bare, bare, "Capped at 500 rows, up to 24 rows per KPI.", research)).toEqual([]);
  expect(rationaleIssues(bare, bare, "The trend shows 12 data points.", [])[0].message).toContain("no governed query was run");
  // Unknown ledger: do not guess.
  expect(ids(bare, bare, reason)).toEqual([]);
  // Values and dates are not row counts.
  expect(ids(bare, bare, "August 2026 was $20,001.26, up 3.7% across 764 customers in 2 sections.", research)).toEqual([]);
});

it("flags claims that metrics were added only on new tiles when an existing tile gained metrics, and keeps abbreviations in one sentence", () => {
  const existingGainedMetric = {
    ...bare,
    tiles: [
      tile({ id: "sample-mrr", title: "MRR overview", metrics: ["new_mrr", "churned_mrr"] }),
      tile({ id: "new-card", title: "Net MRR", metrics: ["net_mrr"] }),
    ],
  };
  const onlyNewTileGainedMetric = {
    ...bare,
    tiles: [
      tile({ id: "sample-mrr", title: "MRR overview" }),
      tile({ id: "new-card", title: "Net MRR", metrics: ["net_mrr"] }),
    ],
  };
  for (const reason of [
    "Added metrics appear only on new tiles.",
    "New metrics were placed only on new charts.",
    "We did not add any metrics to existing tiles.",
  ]) {
    expect(rationaleIssues(bare, existingGainedMetric, reason)).toEqual([
      {
        id: "existing-tile-additions",
        message: expect.stringContaining("MRR overview"),
      },
    ]);
    expect(ids(bare, onlyNewTileGainedMetric, reason)).toEqual([]);
  }
  // Abbreviations like e.g. or i.e. must not split a negated sentence in two.
  expect(ids(bare, described, "There was no prior description, e.g. an old description was absent.")).toEqual([]);
  expect(ids(bare, described, "No description existed before, i.e. the previous description was missing.")).toEqual([]);
});

it("flags the preserved failed live capture and leaves its accepted sibling alone", () => {
  const dir = "../../outputs/semantic-canvas-local/ai-acceptance-2026-11-15-explanation/";
  if (!existsSync(dir + "scope-and-coverage-2.response.json")) return; // evidence lives outside the repository
  const check = (n: number) => {
    const before = JSON.parse(readFileSync(`${dir}scope-and-coverage-${n}.request.json`, "utf8")).document.spec;
    const proposal = JSON.parse(readFileSync(`${dir}scope-and-coverage-${n}.response.json`, "utf8")).response.proposal;
    const after = structuredClone(before);
    for (const action of proposal.actions) if (action.type === "describe") after.description = action.description;
    return ids(before, after, proposal.reason);
  };
  expect(check(2)).toEqual(["prior-description"]);
  expect(check(1)).toEqual([]);
});
