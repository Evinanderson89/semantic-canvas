import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  canSwitchToSaasSource,
  DashboardModeBar,
  hasIncomingDeepLink,
  isSandboxTourCompleted,
  markSandboxTourCompleted,
  resetSandboxTourCompleted,
  resolvePosterQuestAction,
  SANDBOX_TOUR_STEPS,
  SANDBOX_TOUR_STORAGE_KEY,
  SandboxTourBar,
  SandboxTourPresentationStage,
  SandboxTourStepOne,
  shouldAutoStartSandboxTour,
  starterNeedsSaasSwitch,
} from "../src/app/SandboxTour.tsx";
import { validateDashboard } from "../src/app/filters.ts";
import { parseLink } from "../src/app/link.ts";
import { parseShareLink } from "../src/app/shareLink.ts";
import { showcaseStarters } from "../src/library/showcase.ts";
import { buildSampleWorkbookPayload } from "../src/modeler/spreadsheetTypes.ts";
import { parseXlsxWorkbook, profileWorkbook } from "../src/modeler/spreadsheet.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import type { Model } from "../src/semantic/model.ts";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

const sampleRoasteryModel: Model = {
  name: "coffee-roastery-2tab",
  source: "coffee-roastery-2tab",
  hygieneNotes: [
    "Cafe Orders: Skipped 1 leading title/banner row",
    "Cafe Orders: Excluded 1 Total/Subtotal summary row to prevent double-counting",
    "Store Directory: Deduplicated 1 duplicate Store ID row (STR-101) — prevented $528,200 → $688,200 Net Sales double-count",
  ],
  tables: {
    cafe_orders: {
      name: "cafe_orders",
      grain: "One order",
      synonyms: [],
      partitionKeys: [],
      columns: [
        { name: "month", type: "DATE" },
        { name: "net_sales", type: "DOUBLE" },
      ],
    },
  },
  metrics: {
    net_sales: {
      name: "net_sales",
      baseTable: "cafe_orders",
      expression: "SUM(net_sales)",
      label: "Net Sales",
      importance: 95,
      synonyms: [],
    },
  },
  joins: [],
};

const sampleRoasterySpec: DashboardSpec = {
  title: "Coffee Roastery · 2-Tab POS & Store Master",
  tiles: [
    {
      id: "h1",
      kind: "heading",
      title: "Executive Summary",
      metrics: [],
      dimensions: [],
      layout: { x: 0, y: 0, w: 1200, h: 48, z: 1 },
    },
  ],
};

describe("Guided 4-Step Sandbox Tour & Clean Preview Mode UI", () => {
  it("auto-starts on first sandbox visit, skips when deep-linked or marked done, and replays on reset", () => {
    const store = createMemoryStorage();
    const emptyLink = parseLink("");
    const emptyShare = parseShareLink("");
    expect(emptyLink).toEqual({ source: null, table: null });
    expect(emptyShare).toBeNull();
    expect(hasIncomingDeepLink("")).toBe(false);
    expect(hasIncomingDeepLink("?utm_source=github")).toBe(false);
    expect(hasIncomingDeepLink("?source=duckglue-local")).toBe(true);
    expect(hasIncomingDeepLink("?table=orders")).toBe(true);
    expect(hasIncomingDeepLink("?starter=SaaS+overview")).toBe(true);
    expect(hasIncomingDeepLink("?sample=roastery-2tab-xlsx")).toBe(true);
    expect(hasIncomingDeepLink("?mode=infographic")).toBe(true);

    expect(isSandboxTourCompleted(store)).toBe(false);
    expect(
      shouldAutoStartSandboxTour({
        sandboxMode: true,
        hasDeepLink: hasIncomingDeepLink(""),
        storage: store,
      }),
    ).toBe(true);
    expect(shouldAutoStartSandboxTour({ sandboxMode: false, hasDeepLink: false, storage: store })).toBe(false);
    expect(
      shouldAutoStartSandboxTour({
        sandboxMode: true,
        hasDeepLink: hasIncomingDeepLink("?starter=SaaS+overview"),
        storage: store,
      }),
    ).toBe(false);

    markSandboxTourCompleted(store);
    expect(store.getItem(SANDBOX_TOUR_STORAGE_KEY)).toBe("done");
    expect(isSandboxTourCompleted(store)).toBe(true);
    expect(shouldAutoStartSandboxTour({ sandboxMode: true, hasDeepLink: false, storage: store })).toBe(false);

    resetSandboxTourCompleted(store);
    expect(isSandboxTourCompleted(store)).toBe(false);
    expect(shouldAutoStartSandboxTour({ sandboxMode: true, hasDeepLink: false, storage: store })).toBe(true);
  });

  it("renders SandboxTourBar across all 4 steps with progress pills, Skip link, Back button, and primary CTAs", () => {
    expect(SANDBOX_TOUR_STEPS).toHaveLength(4);

    const step1Html = renderToStaticMarkup(
      React.createElement(SandboxTourBar, {
        step: 1,
        hasDashboard: false,
        onSelectStep: () => {},
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
      }),
    );
    expect(step1Html).toContain("SEMANTIC CANVAS · INTERACTIVE WALKTHROUGH");
    expect(step1Html).toContain("1. Catch Excel Errors");
    expect(step1Html).toContain("2. Governed Dashboard");
    expect(step1Html).toContain("3. Executive Story");
    expect(step1Html).toContain("4. Broadside Poster");
    expect(step1Html).toContain("Clean Workbook &amp; Build Dashboard →");
    expect(step1Html).toContain("Skip to open sandbox →");
    expect(step1Html).not.toContain("← Back");

    const step2Html = renderToStaticMarkup(
      React.createElement(SandboxTourBar, {
        step: 2,
        hasDashboard: true,
        onSelectStep: () => {},
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
      }),
    );
    expect(step2Html).toContain("✓ 1. Catch Excel Errors");
    expect(step2Html).toContain("← Back");
    expect(step2Html).toContain("Shape into Executive Story →");

    const step3Html = renderToStaticMarkup(
      React.createElement(SandboxTourBar, {
        step: 3,
        hasDashboard: true,
        onSelectStep: () => {},
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
      }),
    );
    expect(step3Html).toContain("Render Broadside Infographic →");

    const step4Html = renderToStaticMarkup(
      React.createElement(SandboxTourBar, {
        step: 4,
        hasDashboard: true,
        theme: "light",
        onToggleTheme: () => {},
        onSelectStep: () => {},
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
      }),
    );
    expect(step4Html).toContain("Unlock Full Sandbox →");
    expect(step4Html).toContain('aria-label="Switch to dark appearance"');
    expect(step4Html).toContain("◐");
  });

  it("renders Step 1 side-by-side raw Excel traps vs live DuckDB hygiene & duplicate join callout", async () => {
    const built = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
    const sheets = parseXlsxWorkbook(Uint8Array.from(Buffer.from(built.content, "base64")));
    const preview = profileWorkbook(built.fileName, sheets);

    const html = renderToStaticMarkup(
      React.createElement(SandboxTourStepOne, {
        initialPreview: preview,
        onBuildDashboard: () => {},
      }),
    );

    expect(html).toContain("RAW 2-TAB EXCEL EXPORT · 3 HIDDEN TRAPS");
    expect(html).toContain("Bluebird_Roastery_2Tab_Workbook.xlsx");
    expect(html).toContain("Grand Total | $528,200 | 85,130 | $101,090");
    expect(html).toContain("$528,200 → $688,200 (+$160,000 double-count)");
    expect(html).toContain("WHAT SEMANTIC CANVAS CAUGHT AUTOMATICALLY");
    expect(html).toContain("✨ Auto-cleaned 3 spreadsheet traps:");
    expect(html).toContain("DATA ERROR CAUGHT · EXACT DUPLICATE LOOKUP ROW");
    expect(html).toContain("Caught 1 duplicate ID (STR-101) in Store Directory.Store ID");
    expect(html).toContain("33 clean orders · 5 unique stores · N:1 verified");
    expect(html).toContain("$528.2k cumulative Mar–Aug Net Sales · $145.4k in latest month Aug 2026");
    expect(html).toContain("Clean Workbook &amp; Build Dashboard →");
  });

  it("renders Steps 3 & 4 inline presentation stages (Executive Story and Broadside Infographic with verified colophon)", () => {
    const storyHtml = renderToStaticMarkup(
      React.createElement(SandboxTourPresentationStage, {
        mode: "story",
        spec: sampleRoasterySpec,
        model: sampleRoasteryModel,
        queryContext: "roastery:analyst:1",
        filtersByTile: {},
        scopeWarnings: {},
        drills: {},
      }),
    );
    expect(storyHtml).toContain("Semantic Canvas · Executive Story");
    expect(storyHtml).toContain("Coffee Roastery · 2-Tab POS &amp; Store Master");

    const posterHtml = renderToStaticMarkup(
      React.createElement(SandboxTourPresentationStage, {
        mode: "infographic",
        spec: sampleRoasterySpec,
        model: sampleRoasteryModel,
        queryContext: "roastery:analyst:1",
        filtersByTile: {},
        scopeWarnings: {},
        drills: {},
        digestOverride: "9f8e7d6c5b4a3210fedcba98",
      }),
    );
    expect(posterHtml).toContain("Semantic Canvas · Broadside Infographic");
    expect(posterHtml).toContain("✓ 3 data fixes verified");
    expect(posterHtml).toContain("✓ Data hygiene &amp; join safety verified");
    expect(posterHtml).toContain("prevented $528,200 → $688,200 Net Sales double-count");
    expect(posterHtml).toContain("sha256: 9f8e7d6c5b4a…");
  });

  it("renders clean Preview mode bar without noisy Unsaved/Not-saved labels, while preserving saved-dashboard & edit-mode contracts", () => {
    const unsavedPreviewHtml = renderToStaticMarkup(
      React.createElement(DashboardModeBar, {
        canEdit: true,
        locked: true,
        hasTiles: true,
        dashId: null,
        revision: 0,
        handoff: false,
        handoffMode: "dashboard",
        aiRedesign: false,
        hygieneNotes: sampleRoasteryModel.hygieneNotes,
        onSelectDashboardView: () => {},
        onOpenStory: () => {},
        onOpenInfographic: () => {},
        onOpenRedesign: () => {},
        onOpenHistory: () => {},
        onSetLocked: () => {},
      }),
    );
    expect(unsavedPreviewHtml).toContain("PREVIEW");
    expect(unsavedPreviewHtml).toContain("Dashboard");
    expect(unsavedPreviewHtml).toContain("Executive Story");
    expect(unsavedPreviewHtml).toContain("Broadside Infographic");
    expect(unsavedPreviewHtml).toContain("✓ 3 data fixes verified");
    expect(unsavedPreviewHtml).toContain("✎ Edit Canvas");
    expect(unsavedPreviewHtml).toContain('aria-label="Edit dashboard"');
    expect(unsavedPreviewHtml).not.toContain("Not saved yet");
    expect(unsavedPreviewHtml).not.toContain("Version history");

    const savedPreviewHtml = renderToStaticMarkup(
      React.createElement(DashboardModeBar, {
        canEdit: true,
        locked: true,
        hasTiles: true,
        dashId: "dash-123",
        revision: 2,
        handoff: false,
        handoffMode: "dashboard",
        aiRedesign: false,
        onSelectDashboardView: () => {},
        onOpenStory: () => {},
        onOpenInfographic: () => {},
        onOpenRedesign: () => {},
        onOpenHistory: () => {},
        onSetLocked: () => {},
      }),
    );
    expect(savedPreviewHtml).toContain("Saved version 2");
    expect(savedPreviewHtml).toContain("Preview does not publish");
    expect(savedPreviewHtml).toContain("Version history");

    const editModeHtml = renderToStaticMarkup(
      React.createElement(DashboardModeBar, {
        canEdit: true,
        locked: false,
        hasTiles: true,
        dashId: null,
        revision: 0,
        handoff: false,
        handoffMode: "dashboard",
        aiRedesign: false,
        onSelectDashboardView: () => {},
        onOpenStory: () => {},
        onOpenInfographic: () => {},
        onOpenRedesign: () => {},
        onOpenHistory: () => {},
        onSetLocked: () => {},
      }),
    );
    expect(editModeHtml).toContain("EDIT MODE");
    expect(editModeHtml).toContain("Improve &amp; Arrange");
    expect(editModeHtml).toContain("Not saved yet");
    expect(editModeHtml).toContain('aria-label="Preview dashboard"');
  });

  it("prevents SaaS overview / Broadside Poster from ever mounting ending_mrr tiles onto non-SaaS spreadsheet models", async () => {
    const saasModel = await duckglueAdapter.load("./sample-data/warehouse.yaml");
    expect(saasModel).not.toBeNull();
    const starters = showcaseStarters();
    const saasOverview = starters["SaaS overview"];
    const readySources = [
      { id: "duckglue-local", status: "ready" },
      { id: "coffee-roastery-2tab", status: "ready" },
    ];

    expect(validateDashboard(saasModel!, saasOverview)).toEqual([]);
    expect(validateDashboard(sampleRoasteryModel, saasOverview).length).toBeGreaterThan(0);

    // Every built-in SaaS starter triggers a source switch to duckglue-local when on coffee-roastery-2tab
    for (const starterSpec of Object.values(starters)) {
      expect(
        starterNeedsSaasSwitch({
          model: sampleRoasteryModel,
          starterSpec,
          activeSourceId: "coffee-roastery-2tab",
          sources: readySources,
        }),
      ).toBe(true);
      expect(
        starterNeedsSaasSwitch({
          model: saasModel,
          starterSpec,
          activeSourceId: "duckglue-local",
          sources: readySources,
        }),
      ).toBe(false);
    }

    // If duckglue-local is unavailable, starterNeedsSaasSwitch returns false so openStarterByName blocks with a notice
    expect(
      canSwitchToSaasSource([{ id: "coffee-roastery-2tab", status: "ready" }]),
    ).toBe(false);
    expect(
      starterNeedsSaasSwitch({
        model: sampleRoasteryModel,
        starterSpec: saasOverview,
        activeSourceId: "coffee-roastery-2tab",
        sources: [{ id: "coffee-roastery-2tab", status: "ready" }],
      }),
    ).toBe(false);

    // Broadside Poster quest pill routing across active dash vs Workspace on Coffee Roastery vs SaaS
    expect(
      resolvePosterQuestAction({
        hasDashTiles: true,
        model: sampleRoasteryModel,
        saasStarterSpec: saasOverview,
        activeSourceId: "coffee-roastery-2tab",
        sources: readySources,
      }),
    ).toBe("open_current_dash_poster");

    expect(
      resolvePosterQuestAction({
        hasDashTiles: false,
        model: sampleRoasteryModel,
        saasStarterSpec: saasOverview,
        activeSourceId: "coffee-roastery-2tab",
        sources: readySources,
      }),
    ).toBe("build_current_model_poster");

    expect(
      resolvePosterQuestAction({
        hasDashTiles: false,
        model: saasModel,
        saasStarterSpec: saasOverview,
        activeSourceId: "duckglue-local",
        sources: readySources,
      }),
    ).toBe("open_saas_starter_poster");

    expect(
      resolvePosterQuestAction({
        hasDashTiles: false,
        model: { ...sampleRoasteryModel, tables: {}, metrics: {} },
        saasStarterSpec: saasOverview,
        activeSourceId: "empty-source",
        sources: readySources,
      }),
    ).toBe("switch_to_saas_poster");
  });
});
