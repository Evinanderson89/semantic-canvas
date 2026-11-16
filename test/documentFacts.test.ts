import { expect, it } from "vitest";
import { documentTextFacts, proposalTextChanges } from "../src/canvas/documentFacts.ts";
import { tile } from "./fixtures.ts";

const layout = { x: 0, y: 0, w: 300, h: 80 };
const note = (id: string, text: string, kind: "text" | "heading" = "text") => ({ id, kind, text, metrics: [], dimensions: [], layout });
// Shape of the captured live failure: a title that sounds like a description, and no description.
const bare = { title: "Synthetic sample — revenue trend check", tiles: [tile({ id: "sample-mrr" })] };

it("states absent wording explicitly instead of leaving an omitted key", () => {
  const facts = documentTextFacts(bare);
  expect(facts.dashboardDescription).toMatchObject({ exists: false });
  expect(JSON.stringify(facts)).toContain("has no description");
  expect(facts.basis).toContain("not a description");
  expect(facts.authoredNotes).toMatchObject({ count: 0 });
  expect(documentTextFacts({ ...bare, description: "   " }).dashboardDescription.exists).toBe(false);
  const authored = documentTextFacts({ ...bare, description: "Weekly revenue review.", tiles: [...bare.tiles, note("n1", "Read with care."), note("h1", "", "heading")] });
  expect(authored.dashboardDescription).toEqual({ exists: true, text: "Weekly revenue review." });
  expect(authored.authoredNotes).toEqual({ count: 1, tileIds: ["n1"] });
});

it("calculates added, replaced, cleared and removed wording from the documents", () => {
  const added = proposalTextChanges(bare, { ...bare, title: "New MRR", description: "Monthly new MRR.", tiles: [...bare.tiles, note("n2", "Scope.")] });
  expect(added.dashboardDescription).toEqual({ status: "added", before: null, after: "Monthly new MRR." });
  expect(added.dashboardTitle).toEqual({ status: "replaced", before: bare.title, after: "New MRR" });
  expect(added).toMatchObject({ existingNotes: [], addedNotes: ["n2"] });
  const before = { ...bare, description: "Old.", tiles: [...bare.tiles, note("keep", "Same."), note("edit", "Before."), note("drop", "Gone."), note("empty", "Was here.")] };
  const after = { ...bare, description: "", tiles: [bare.tiles[0], note("keep", "Same."), note("edit", "After."), note("empty", "")] };
  const changed = proposalTextChanges(before, after);
  expect(changed.dashboardDescription).toEqual({ status: "cleared", before: "Old.", after: null });
  expect(changed.dashboardTitle.status).toBe("unchanged");
  expect(changed.existingNotes).toEqual([
    { id: "edit", status: "replaced", before: "Before.", after: "After." },
    { id: "drop", status: "removed", before: "Gone.", after: null },
    { id: "empty", status: "cleared", before: "Was here.", after: null },
  ]);
  expect(proposalTextChanges(before, before)).toMatchObject({ dashboardDescription: { status: "unchanged" }, existingNotes: [], addedNotes: [] });
});
