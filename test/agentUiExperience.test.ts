import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AGENTIC_RESEARCH_STEPS,
  AgenticResearchStepper,
  AiRedesign,
  VerifiedResearchLedger,
  buildDeterministicProposal,
} from "../src/app/AiRedesign.tsx";
import {
  Interview,
  InterviewReadback,
  crossTableCompanions,
} from "../src/app/Interview.tsx";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { rationaleIssues } from "../src/canvas/rationaleChecks.ts";
import { matchModel } from "../src/suggest/match.ts";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { model as baseModel } from "./fixtures.ts";
import type { Model } from "../src/semantic/model.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

const multiTableModel: Model = {
  ...baseModel,
  tables: {
    ...baseModel.tables,
    fct_mrr_movements: {
      name: "fct_mrr_movements",
      grain: "one row per mrr movement",
      synonyms: ["movements", "bridge", "drivers"],
      partitionKeys: ["movement_date"],
      columns: [
        { name: "movement_date", type: "date" },
        { name: "movement_type", type: "string" },
        { name: "amount", type: "double" },
      ],
    },
  },
  metrics: {
    ...baseModel.metrics,
    net_new_mrr: {
      name: "net_new_mrr",
      label: "Net new MRR (USD)",
      baseTable: "fct_mrr_movements",
      expression: "SUM(fct_mrr_movements.amount)",
      filter: null,
      synonyms: ["mrr bridge", "mrr movement", "expansion"],
    },
  },
};

const noop = () => {};

describe("World-Class Agentic Dashboard Builder UI (AiRedesign & Interview)", () => {
  it("renders the 4-step Agentic Research Progress Stepper for live busy telemetry", () => {
    expect(AGENTIC_RESEARCH_STEPS).toEqual([
      "1. Inspecting governed semantic catalogue",
      "2. Profiling dimensions & querying warehouse rows",
      "3. Compiling layout & chart encodings",
      "4. Verifying rationale claims against query ledger",
    ]);
    const html = renderToStaticMarkup(React.createElement(AgenticResearchStepper));
    expect(html).toContain('class="ai-redesign-steps"');
    for (const step of AGENTIC_RESEARCH_STEPS) {
      expect(html).toContain(step.replace("&", "&amp;"));
    }
  });

  it("renders the collapsible Verified Research Ledger with governed queries, trace, and rationale discrepancy status", () => {
    const emptyHtml = renderToStaticMarkup(
      React.createElement(VerifiedResearchLedger, { research: [], trace: [], rationaleWarnings: [] }),
    );
    expect(emptyHtml).toBe("");

    const verifiedHtml = renderToStaticMarkup(
      React.createElement(VerifiedResearchLedger, {
        research: [
          { metrics: ["revenue"], dimensions: ["month:sold_on"], rowsChecked: 24 },
          { metrics: ["net_new_mrr"], dimensions: ["movement_type"], rowsChecked: 4 },
        ],
        trace: [
          { step: 1, tool: "describe_model", summary: "Inspected 9 governed metrics", status: "ok" },
          { step: 2, tool: "query_metric", summary: "Queried revenue by month:sold_on (24 rows)", status: "ok", rowsChecked: 24 },
        ],
        rationaleWarnings: [],
      }),
    );
    expect(verifiedHtml).toContain('class="ai-redesign-ledger"');
    expect(verifiedHtml).toContain("Verified Research Ledger");
    expect(verifiedHtml).toContain("0 rationale discrepancies");
    expect(verifiedHtml).toContain("revenue");
    expect(verifiedHtml).toContain("month:sold_on");
    expect(verifiedHtml).toContain("24 rows");
    expect(verifiedHtml).toContain("describe_model");

    const warnedHtml = renderToStaticMarkup(
      React.createElement(VerifiedResearchLedger, {
        research: [{ metrics: ["revenue"], dimensions: ["month:sold_on"], rowsChecked: 24 }],
        rationaleWarnings: [{ id: "row-count", message: "The rationale cites 6 rows, but the governed queries returned 24 rows." }],
      }),
    );
    expect(warnedHtml).toContain("1 rationale discrepancy flagged");
  });

  it("builds a validated deterministic redesign proposal from a suggested dashboard across blank, populated, and narrow canvases", () => {
    const suggested = suggestDashboard(multiTableModel, {
      text: "how is revenue retention trending and what drove net new mrr movement",
      audience: "exec",
      grain: "month",
    });

    // Blank canvas
    const blankSpec: DashboardSpec = { title: "Untitled dashboard", tiles: [] };
    const builtBlank = buildDeterministicProposal(blankSpec, DEFAULT_CANVAS, suggested, multiTableModel);
    const validatedBlank = validateRedesign(blankSpec, DEFAULT_CANVAS, builtBlank.proposal, multiTableModel);
    expect(validatedBlank.spec.tiles.length).toBeGreaterThan(0);
    expect(builtBlank.research.length).toBeGreaterThan(0);
    expect(builtBlank.trace).toHaveLength(3);
    expect(rationaleIssues(blankSpec, validatedBlank.spec, builtBlank.proposal.reason, [])).toEqual([]);

    // Populated messy canvas + narrow width
    const narrowCanvas = { ...DEFAULT_CANVAS, width: 1000 };
    const existingSpec: DashboardSpec = {
      title: "Messy draft",
      tiles: [
        { id: "h1", kind: "heading", title: "Old section", text: "Old section", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 900, h: 44 } },
        { id: "c1", section: "h1", title: "Old chart", metrics: ["revenue"], dimensions: ["month:sold_on"], chart: "line", layout: { x: 24, y: 80, w: 480, h: 280 } },
      ],
    };
    const builtExisting = buildDeterministicProposal(existingSpec, narrowCanvas, suggested, multiTableModel);
    const validatedExisting = validateRedesign(existingSpec, narrowCanvas, builtExisting.proposal, multiTableModel);
    expect(validatedExisting.spec.tiles.some((t) => t.id === "c1")).toBe(false);
    expect(validatedExisting.spec.tiles.every((t) => t.layout.x + t.layout.w <= narrowCanvas.width)).toBe(true);
  });

  it("renders AiRedesign with the deterministic composer fallback button and new prompt presets even when AI is unconfigured", () => {
    const html = renderToStaticMarkup(
      React.createElement(AiRedesign, {
        spec: { title: "Untitled dashboard", tiles: [] },
        canvas: DEFAULT_CANVAS,
        model: multiTableModel,
        available: false,
        canConfigure: true,
        onConfigure: noop,
        onClose: noop,
        onApply: () => true,
        queryContext: "test",
        filtersByTile: {},
        drills: {},
      }),
    );
    expect(html).toContain("Reimagine this dashboard");
    expect(html).toContain("Connect an AI provider to generate a redesign.");
    expect(html).toContain("Generate deterministic draft from prompt");
    expect(html).toContain("Revenue &amp; retention drivers");
  });

  it("detects cross-table companion metrics in Interview step 0 readback and renders the 1-click Build instant draft button", () => {
    const prompt = "how is revenue retention trending, what drove net new mrr movement, and how many users signed up";
    const matches = matchModel(multiTableModel, prompt);
    const companions = crossTableCompanions(multiTableModel, matches);
    expect(matches.subject).toBe("fct_sales");
    expect(companions.companionMetrics.map((m) => m.name)).toContain("net_new_mrr");
    expect(companions.companionTables).toContain("fct_mrr_movements");

    const readbackHtml = renderToStaticMarkup(
      React.createElement(InterviewReadback, {
        model: multiTableModel,
        matches,
        onInstantDraft: noop,
      }),
    );
    expect(readbackHtml).toContain("Reading that as:");
    expect(readbackHtml).toContain("Cross-table companions:");
    expect(readbackHtml).toContain("Net new MRR (USD)");
    expect(readbackHtml).toContain("Build instant draft →");

    const interviewHtml = renderToStaticMarkup(
      React.createElement(Interview, {
        model: multiTableModel,
        onCancel: noop,
        onDone: noop,
        initialText: prompt,
      }),
    );
    expect(interviewHtml).toContain("Step 1 of 4");
    expect(interviewHtml).toContain("What should this dashboard tell you?");
    expect(interviewHtml).toContain("Cross-table companions:");
    expect(interviewHtml).toContain("Build instant draft →");
  });
});
