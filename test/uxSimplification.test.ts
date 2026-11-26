import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BootRateLimitScreen,
  classifyComposerFile,
  Entry,
} from "../src/app/App.tsx";
import { buildBriefFromPrompt } from "../src/app/Interview.tsx";
import { Sidebar } from "../src/app/Sidebar.tsx";
import { LibraryNavigation } from "../src/app/CoreLibrary.tsx";
import { MetricRegistry } from "../src/app/Explore.tsx";
import { Modeler } from "../src/app/Modeler.tsx";
import { SemanticCoachPanel } from "../src/app/SemanticCoach.tsx";
import { AgentQuestions } from "../src/app/AgentQuestions.tsx";
import { EditBar } from "../src/app/EditBar.tsx";
import { AiRedesign } from "../src/app/AiRedesign.tsx";
import { ReferenceImport } from "../src/app/ReferenceImport.tsx";
import { Inspector } from "../src/app/Inspector.tsx";
import { Investigation } from "../src/app/Investigation.tsx";
import { tileHasLag } from "../src/app/Tile.tsx";
import { normalizeDriversPayload } from "../src/app/TileLineageAndDrivers.tsx";
import { buildLocalDigestPreview, escapeHtml } from "../src/app/CommercialDrawers.tsx";
import { resolveSvgMarkup, serializeSvgElement } from "../src/app/export.ts";
import {
  applyThemeToDocument,
  formatSourceDisplayLabel,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
} from "../src/app/themeInit.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";
import type { Model } from "../src/semantic/model.ts";

const sampleModel: Model = {
  name: "duckglue-local",
  source: "duckglue",
  calendar: { weekStart: "monday", fiscalYearStartMonth: 1, today: "2026-08-31" },
  hygieneNotes: ["Cleaned 2 duplicate rows"],
  tables: {
    fct_saas_monthly: {
      name: "fct_saas_monthly",
      grain: "One customer per month",
      synonyms: ["revenue", "subscriptions"],
      partitionKeys: [],
      columns: [
        { name: "month", type: "DATE" },
        { name: "plan_id", type: "VARCHAR" },
        { name: "ending_mrr", type: "DOUBLE" },
      ],
    },
    dim_plans: {
      name: "dim_plans",
      grain: "One subscription plan",
      synonyms: ["plan", "tier"],
      partitionKeys: [],
      columns: [
        { name: "plan_id", type: "VARCHAR" },
        { name: "plan_name", type: "VARCHAR" },
      ],
    },
  },
  metrics: {
    ending_mrr: {
      name: "ending_mrr",
      label: "Ending MRR",
      baseTable: "fct_saas_monthly",
      expression: "SUM(ending_mrr)",
      unit: "currency",
      importance: 95,
      timeGrains: ["month", "quarter", "year"],
      synonyms: ["recurring revenue", "mrr"],
    },
    nrr: {
      name: "nrr",
      label: "Net Revenue Retention",
      type: "ratio",
      numerator: "ending_mrr",
      denominator: "ending_mrr",
      baseTable: "fct_saas_monthly",
      expression: "ending_mrr / ending_mrr",
      unit: "percent",
      importance: 90,
      synonyms: ["retention"],
    },
  },
  joins: [
    {
      left: "fct_saas_monthly",
      leftOn: "plan_id",
      right: "dim_plans",
      rightOn: "plan_id",
      type: "left",
      cardinality: "many_to_one",
    },
  ],
};

describe("UX Simplification: Unified Home Entry, 2-Group Sidebar & Clean Branding", () => {
  it("renders One Unified Start Composer, 3 starter cards, and quiet footer links while preserving e2e selectors", () => {
    const html = renderToStaticMarkup(
      React.createElement(Entry, {
        model: sampleModel,
        activeSourceLabel: formatSourceDisplayLabel("duckglue on DuckDB", "duckglue-local"),
        onBuildBrief: () => {},
        onCustomize: () => {},
        onScratch: () => {},
        onReference: () => {},
        onSpreadsheet: () => {},
        onDemo: () => {},
        onOpenSaasStory: () => {},
        onQuickWorld: () => {},
        onOpenSaved: () => {},
        onImportBackup: () => {},
      }),
    );

    expect(html).toContain("Ask a question, or <em>drop your data.</em>");
    expect(html).toContain('aria-label="Ask or drop start composer"');
    expect(html).toContain("Sample SaaS Warehouse");
    expect(html).toContain("✓ 1 data fix verified");
    expect(html).toContain("⊞ Drop or upload file (.xlsx, .csv, image, PDF)");
    expect(html).toContain("Customize options…");
    expect(html).toContain("Build dashboard →");

    // 3 curated starter cards + playground & e2e aria-label
    expect(html).toContain("SaaS Revenue &amp; Story");
    expect(html).toContain("Specialty Coffee 2-Tab Excel");
    expect(html).toContain('aria-label="Recreate from reference"');
    expect(html).toContain("Recreate from Reference");
    expect(html).toContain("Try the design playground");

    // Quiet footer links
    expect(html).toContain("Start from scratch");
    expect(html).toContain("Open saved dashboard");
    expect(html).toContain("Import backup");
  });

  it("classifies dropped composer files accurately and builds instant briefs without a 4-step wizard", () => {
    expect(classifyComposerFile("Q3_Board_Pack.xlsx")).toBe("spreadsheet");
    expect(classifyComposerFile("orders.csv", "text/csv")).toBe("spreadsheet");
    expect(classifyComposerFile("export.tsv")).toBe("spreadsheet");
    expect(classifyComposerFile("whiteboard-sketch.png", "image/png")).toBe("reference");
    expect(classifyComposerFile("slide.jpg", "image/jpeg")).toBe("reference");
    expect(classifyComposerFile("board_deck.pdf", "application/pdf")).toBe("reference");
    expect(classifyComposerFile("archive.zip", "application/zip")).toBeNull();

    const brief = buildBriefFromPrompt(sampleModel, "How is recurring revenue trending by plan?");
    expect(brief.metrics).toContain("ending_mrr");
    expect(brief.table).toBe("fct_saas_monthly");
    expect(brief.text).toBe("How is recurring revenue trending by plan?");
  });

  it("groups Sidebar into Dashboards and Data & Metrics, renames Workspace Library, and hides Modeler in sandboxMode", () => {
    expect(formatSourceDisplayLabel("duckglue on DuckDB")).toBe("Sample SaaS Warehouse");
    expect(formatSourceDisplayLabel("", "duckglue-local")).toBe("Sample SaaS Warehouse");
    expect(formatSourceDisplayLabel("Specialty Coffee Orders + Stores")).toBe("Specialty Coffee Orders + Stores");

    const libraryNav = React.createElement(LibraryNavigation, {
      data: { folders: [], items: [] },
      loading: false,
      error: "",
      activeId: null,
      onBrowse: () => {},
      onOpen: () => {},
    });

    const sandboxSidebarHtml = renderToStaticMarkup(
      React.createElement(Sidebar, {
        model: sampleModel,
        view: "home",
        onView: () => {},
        collapsed: false,
        onToggle: () => {},
        onSettings: () => {},
        library: libraryNav,
        activeSource: { id: "duckglue-local", label: "duckglue on DuckDB", status: "ready" },
        sandboxMode: true,
        theme: "light",
        onToggleTheme: () => {},
      }),
    );

    expect(sandboxSidebarHtml).toContain("Dashboards");
    expect(sandboxSidebarHtml).toContain("Workspace Library");
    expect(sandboxSidebarHtml).toContain('aria-label="CoreCanvas Library"');
    expect(sandboxSidebarHtml).toContain("Data &amp; Metrics");
    expect(sandboxSidebarHtml).toContain("Metric Registry");
    expect(sandboxSidebarHtml).toContain("Data Model");
    expect(sandboxSidebarHtml).toContain("Connections");
    expect(sandboxSidebarHtml).not.toContain('aria-label="Modeler"');
    expect(sandboxSidebarHtml).toContain("Self-host to customize model");
    expect(sandboxSidebarHtml).toContain("Sample SaaS Warehouse");
  });
});

describe("UX Simplification: Sandbox 403/429 Prevention, Edit Declutter & 1-Click Reference Blueprints", () => {
  it("prevents sandbox 403s across MetricRegistry, Modeler, SemanticCoachPanel, AgentQuestions, and renders friendly 429 retry", () => {
    const registryHtml = renderToStaticMarkup(
      React.createElement(MetricRegistry, {
        model: sampleModel,
        sourceId: "duckglue-local",
        sandboxMode: true,
        onUse: () => {},
      }),
    );
    expect(registryHtml).not.toContain("Propose a metric");
    expect(registryHtml).toContain("Self-host to customize model");

    const modelerHtml = renderToStaticMarkup(
      React.createElement(Modeler, {
        sources: [],
        sandboxMode: true,
        onPublished: () => {},
        onImportSpreadsheet: () => {},
      }),
    );
    expect(modelerHtml).toContain("Self-host to customize model");
    expect(modelerHtml).not.toContain("Loading…");

    const coachHtml = renderToStaticMarkup(
      React.createElement(SemanticCoachPanel, {
        model: sampleModel,
        sourceId: "duckglue-local",
        sandboxMode: true,
      }),
    );
    expect(coachHtml).not.toContain("Propose metric in Registry");

    const questionsHtml = renderToStaticMarkup(React.createElement(AgentQuestions, { disabled: true }));
    expect(questionsHtml).toBe("");

    const rateLimitHtml = renderToStaticMarkup(
      React.createElement(BootRateLimitScreen, {
        message: "Too many requests",
        onRetry: () => {},
      }),
    );
    expect(rateLimitHtml).toContain("TEMPORARY RATE LIMIT · HTTP 429");
    expect(rateLimitHtml).toContain("Catching our breath for a moment.");
    expect(rateLimitHtml).toContain("Retry workspace →");
  });

  it("HTML-escapes executive digest titles so untrusted characters never inject raw markup", () => {
    const xssTitle = 'Q3 Brief <img src=x onerror="alert(1)"> & Notes';
    expect(escapeHtml(xssTitle)).toBe("Q3 Brief &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Notes");
    const digest = buildLocalDigestPreview({ title: xssTitle, tiles: [] }, sampleModel);
    expect(digest.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(digest.html).not.toContain("<img src=x");
  });

  it("consolidates EditBar AI buttons, labels zero-key AiRedesign as Deterministic Composer, and renders 1-click sample blueprints in ReferenceImport", () => {
    const sampleTile: TileSpec = {
      id: "t1",
      title: "Ending MRR",
      metrics: ["ending_mrr"],
      dimensions: ["month:fct_saas_monthly.month"],
      chart: "line",
      layout: { x: 24, y: 24, w: 560, h: 300 },
    };
    const editBarZeroKey = renderToStaticMarkup(
      React.createElement(EditBar, {
        canvas: DEFAULT_CANVAS,
        model: sampleModel,
        onCanvas: () => {},
        zoom: 1,
        onZoom: () => {},
        onFit: () => {},
        selected: [],
        tiles: [sampleTile],
        onTiles: () => {},
        onCompose: () => {},
        onSettings: () => {},
        onRedesign: () => {},
        aiAvailable: false,
      }),
    );
    expect(editBarZeroKey).toContain("Arrange &amp; Layout");
    expect(editBarZeroKey).toContain('aria-label="Smart arrange"');
    expect(editBarZeroKey).toContain('aria-label="Improve with AI"');
    expect(editBarZeroKey).toContain(">Improve</button>");

    const spec: DashboardSpec = { title: "Revenue", tiles: [sampleTile] };
    const redesignZeroKeyHtml = renderToStaticMarkup(
      React.createElement(AiRedesign, {
        spec,
        canvas: DEFAULT_CANVAS,
        model: sampleModel,
        available: false,
        sandboxMode: true,
        canConfigure: false,
        queryContext: "ctx",
        filtersByTile: {},
        drills: {},
        onClose: () => {},
        onConfigure: () => {},
        onApply: () => true,
      }),
    );
    expect(redesignZeroKeyHtml).toContain("Deterministic Composer");
    expect(redesignZeroKeyHtml).not.toContain("Powered by AI");
    expect(redesignZeroKeyHtml).not.toContain("Configure AI");

    const refImportHtml = renderToStaticMarkup(
      React.createElement(ReferenceImport, {
        model: sampleModel,
        aiAvailable: false,
        sandboxMode: true,
        width: 1200,
        onCreate: () => {},
        onClose: () => {},
        onConnections: () => {},
      }),
    );
    expect(refImportHtml).toContain("Try a sample reference blueprint (no API key needed):");
    expect(refImportHtml).toContain("Board Revenue &amp; Retention Slide");
    expect(refImportHtml).toContain("Store Operations &amp; Margin Sketch");
    expect(refImportHtml).not.toContain("Open Connections");
  });
});

describe("UX Simplification: Vector SVG Export, Lag Detection, Preview Story Arcs & Driver Formatting", () => {
  it("resolves CSS tokens (--pos, --neg, --warn, --surface-2) and skips [data-export-ignore] icons during SVG serialization", () => {
    const rawChartSvg =
      '<svg width="640" height="320"><rect fill="var(--surface-2, #eee)"/><path stroke="var(--pos)"/><path stroke="var(--neg)"/><text fill="var(--warn)">Note</text></svg>';
    const resolved = resolveSvgMarkup(rawChartSvg);
    expect(resolved).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(resolved).not.toContain("var(--");
    expect(resolved).toContain("#059669");
    expect(resolved).toContain("#e11d48");
    expect(resolved).toContain("#d97706");

    const tinyIgnoredIcon = {
      outerHTML: '<svg width="14" height="14"><path d="M0 0"/></svg>',
      closest: (sel: string) => (sel === "[data-export-ignore]" ? {} : null),
    };
    const chartNode = {
      outerHTML: rawChartSvg,
      closest: () => null,
    };
    const picked = serializeSvgElement({
      querySelectorAll: () => [tinyIgnoredIcon, chartNode],
    });
    expect(picked).toContain('width="640"');
    expect(picked).not.toContain('width="14"');
  });

  it("computes tileHasLag accurately without false positives on { start: false, end: false }", () => {
    expect(
      tileHasLag(sampleModel, { metrics: ["ending_mrr"] }, ["month:fct_saas_monthly.month"], {
        partial: { start: false, end: false },
        columns: ["month_month", "ending_mrr"],
        rows: [["2026-08-01", 120000]],
      }),
    ).toBe(false);

    expect(
      tileHasLag(sampleModel, { metrics: ["ending_mrr"] }, ["month:fct_saas_monthly.month"], {
        partial: { start: false, end: true },
        columns: ["month_month", "ending_mrr"],
        rows: [["2026-08-01", 120000]],
      }),
    ).toBe(true);

    const laggedModel: Model = {
      ...sampleModel,
      calendar: { weekStart: "monday", fiscalYearStartMonth: 1, today: "2026-09-01" },
      tables: {
        ...sampleModel.tables,
        fct_saas_monthly: {
          ...sampleModel.tables.fct_saas_monthly,
          reportingLagDays: 3,
        },
      },
    };
    expect(
      tileHasLag(laggedModel, { metrics: ["ending_mrr"] }, ["month:fct_saas_monthly.month"], {
        partial: { start: false, end: false },
        columns: ["month_month", "ending_mrr"],
        rows: [["2026-08-01", 120000]],
      }),
    ).toBe(true);
  });

  it("allows Smart-add story details & 1-Click Story Arcs in Preview mode (canKeep=false), suppresses invalid driver shares, and populates heading Inspector text", async () => {
    const saasModel = (await duckglueAdapter.load("./sample-data/warehouse.yaml"))!;
    const sourceTile: TileSpec = {
      id: "kpi-mrr",
      title: "Ending MRR",
      metrics: ["ending_mrr"],
      dimensions: ["month:fct_saas_monthly.month"],
      chart: "kpi",
      layout: { x: 24, y: 24, w: 360, h: 156 },
    };
    const invHtml = renderToStaticMarkup(
      React.createElement(Investigation, {
        source: sourceTile,
        result: {
          columns: ["month_month", "ending_mrr"],
          rows: [
            ["2026-07-01", 110000],
            ["2026-08-01", 125000],
          ],
        },
        model: saasModel,
        filters: [],
        drill: [],
        queryContext: "ctx",
        scopeWarnings: [],
        canKeep: false,
        initialMode: "smart",
        onConfigure: () => {},
        onKeep: () => {},
        onClose: () => {},
      }),
    );
    expect(invHtml).toContain("Smart-add story details");
    expect(invHtml).toContain("1-Click Story Arcs");
    expect(invHtml).not.toContain("Customize this dashboard");
    expect(invHtml).not.toContain("Add to main dashboard");

    const normalizedDrivers = normalizeDriversPayload({
      metric: "ending_mrr",
      label: "Ending MRR",
      priorPeriod: "2026-07-01",
      latestPeriod: "2026-08-01",
      delta: 1000,
      additive: true,
      dimensions: [
        {
          dimension: "dim_plans.plan_name",
          label: "Plan",
          topDrivers: [
            { value: "Enterprise", contribution: 2500, share: 2.5 },
            { value: "Growth", contribution: 600, share: 0.6 },
            { value: "Starter", contribution: -2100, share: -2.1 },
          ],
        },
      ],
    });
    expect(normalizedDrivers.dimensions[0].topDrivers[0].hasValidShare).toBe(false);
    expect(normalizedDrivers.dimensions[0].topDrivers[1].hasValidShare).toBe(true);
    expect(normalizedDrivers.dimensions[0].topDrivers[2].hasValidShare).toBe(false);

    const headingInspectorHtml = renderToStaticMarkup(
      React.createElement(Inspector, {
        model: sampleModel,
        tile: {
          id: "h-exec",
          kind: "heading",
          title: "Executive Summary",
          metrics: [],
          dimensions: [],
          layout: { x: 24, y: 24, w: 1152, h: 48 },
        },
        onChange: () => {},
        onClose: () => {},
      }),
    );
    expect(headingInspectorHtml).toContain("Executive Summary</textarea>");

    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null };
    expect(resolveInitialTheme(store, true)).toBe("dark");
    expect(resolveInitialTheme(store, false)).toBe("light");
    mem.set(THEME_STORAGE_KEY, "dark");
    expect(resolveInitialTheme(store, false)).toBe("dark");
    const fakeDoc = { documentElement: { dataset: {} as Record<string, string | undefined> } };
    applyThemeToDocument("dark", fakeDoc);
    expect(fakeDoc.documentElement.dataset.theme).toBe("dark");
  });
});
