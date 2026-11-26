import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import {
  DEFAULT_BRIEF,
  matchModel,
  parsePromptIntent,
  tokens,
} from "../src/suggest/match.ts";
import { composeExecutiveBrief, suggestDashboard } from "../src/suggest/suggest.ts";
import {
  blueprintSchema,
  buildReference,
  fieldMatches,
  initialMapping,
  metricMatches,
  REFERENCE_CHART_KINDS,
  referenceItemSchema,
  SAMPLE_REFERENCE_BLUEPRINTS,
  type Blueprint,
} from "../src/reference/blueprint.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { dashboardSchema } from "../src/compiler/schema.ts";
import { validateDashboard } from "../src/app/filters.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { buildSampleWorkbookPayload } from "../src/modeler/spreadsheetTypes.ts";
import {
  buildWorkbookProposal,
  parseXlsxWorkbook,
  prepareWorkbookImport,
  profileWorkbook,
} from "../src/modeler/spreadsheet.ts";
import { proposalToYaml } from "../src/modeler/yaml.ts";
import { conn, model as fixtureModel } from "./fixtures.ts";

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
import { analyzeReference } from "../src/reference/analyze.ts";

let warehouseModel: Model;
let roasteryModel: Model;

beforeAll(async () => {
  const loaded = await duckglueAdapter.load("sample-data/warehouse.yaml");
  if (!loaded) throw new Error("Expected sample-data/warehouse.yaml to load");
  warehouseModel = loaded;

  const built = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
  const bytes = Uint8Array.from(Buffer.from(built.content, "base64"));
  const sheets = parseXlsxWorkbook(bytes);
  const preview = profileWorkbook(built.fileName, sheets);
  const prepared = prepareWorkbookImport({ parsedSheets: sheets, preview });
  if (!prepared.ok) throw new Error("Expected roastery-2tab-xlsx to prepare cleanly");
  const proposal = buildWorkbookProposal({
    sourceId: built.meta.preferredSourceId,
    label: built.meta.title,
    sheets: prepared.sheets,
    joins: prepared.joins,
    primaryGrain: preview.suggestedGrain,
    primaryTimeColumn: preview.suggestedTimeColumn,
    hygieneNotes: prepared.hygieneNotes,
  });
  const yaml = proposalToYaml(proposal);
  const dir = await mkdtemp(join(tmpdir(), "sc-creation-recreation-"));
  try {
    const yamlPath = join(dir, "roastery.yaml");
    await writeFile(yamlPath, yaml, "utf8");
    const loadedRoastery = await duckglueAdapter.load(yamlPath);
    if (!loadedRoastery) throw new Error("Expected roastery model to load");
    roasteryModel = loadedRoastery;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Deterministic Dashboard Creation — Synonyms & Intent Parsing", () => {
  it("expands TOKEN_SYNONYMS across retail/commerce, finance/P&L, and energy/ops while keeping SaaS synonyms intact", () => {
    // Backwards-compatible SaaS tokens
    expect(tokens("arr bookings expansion bridge drivers plans tiers channels cac funnel")).toEqual([
      "mrr", "mrr", "net_new_mrr", "movement", "movement", "plan", "tier", "channel", "cost", "conversion",
    ]);
    expect(DEFAULT_BRIEF).toEqual({
      audience: "exec",
      grain: "month",
      compare: "prior",
      includeBreakdowns: true,
      includeTable: false,
    });

    // Retail & commerce
    expect(tokens("gmv sale purchases items cup shops cities categories")).toEqual([
      "sales", "sales", "orders", "units", "cups", "store", "city", "category",
    ]);

    // Finance & P&L
    expect(tokens("margins profitability ebit cogs opex forecasts")).toEqual([
      "margin", "profit", "ebitda", "cost", "expense", "budget",
    ]);

    // Energy & ops
    expect(tokens("generated photovoltaic turbines tariffs deliveries stocks")).toEqual([
      "generation", "solar", "wind", "price", "shipments", "inventory",
    ]);

    // Matches retail synonyms directly against roastery model
    const retailMatch = matchModel(roasteryModel, "how are gmv, cup volume, and bean cogs trending across shops");
    expect(retailMatch.subject).toBe("cafe_orders");
    expect(retailMatch.matchedByTable.cafe_orders?.map((m) => m.name)).toEqual(
      expect.arrayContaining(["net_sales", "cups_sold", "bean_cost"]),
    );
  });

  it("parses time grain hints and applies them in composeExecutiveBrief unless explicitly overridden", () => {
    expect(parsePromptIntent(roasteryModel, "daily net sales").grain).toBe("day");
    expect(parsePromptIntent(roasteryModel, "sales by day").grain).toBe("day");
    expect(parsePromptIntent(roasteryModel, "weekly store sales").grain).toBe("week");
    expect(parsePromptIntent(roasteryModel, "orders by week").grain).toBe("week");
    expect(parsePromptIntent(roasteryModel, "monthly net sales").grain).toBe("month");
    expect(parsePromptIntent(roasteryModel, "quarterly sales by region").grain).toBe("quarter");
    expect(parsePromptIntent(roasteryModel, "sales by quarter").grain).toBe("quarter");
    expect(parsePromptIntent(roasteryModel, "annual net sales").grain).toBe("year");
    expect(parsePromptIntent(roasteryModel, "yearly net sales").grain).toBe("year");

    const weeklySpec = composeExecutiveBrief(roasteryModel, "weekly net sales and cups sold");
    expect(validateDashboard(roasteryModel, weeklySpec)).toEqual([]);
    const kpiDims = weeklySpec.tiles.filter((t) => t.chart === "kpi").flatMap((t) => t.dimensions);
    expect(kpiDims.every((d) => d.startsWith("week:"))).toBe(true);

    // Explicit grain override wins over prompt hint
    const overridden = composeExecutiveBrief(roasteryModel, "weekly net sales", { grain: "quarter" });
    const overriddenDims = overridden.tiles.filter((t) => t.chart === "kpi").flatMap((t) => t.dimensions);
    expect(overriddenDims.every((d) => d.startsWith("quarter:"))).toBe(true);
  });

  it("parses explicit breakdown dimensions and prioritizes them in 'A closer look'", () => {
    expect(parsePromptIntent(roasteryModel, "net sales by drink category").dimensions).toEqual([
      "cafe_orders.drink_category",
    ]);
    expect(parsePromptIntent(roasteryModel, "net sales by city").dimensions).toEqual([
      "store_directory.city",
    ]);
    expect(parsePromptIntent(roasteryModel, "net sales by region").dimensions).toEqual([
      "store_directory.region",
    ]);
    expect(parsePromptIntent(roasteryModel, "cups sold per store").dimensions).toEqual([
      "store_directory.city",
    ]);
    expect(parsePromptIntent(warehouseModel, "mrr by plan").dimensions).toEqual([
      "dim_plans.plan_name",
    ]);

    const byDrinkSpec = composeExecutiveBrief(roasteryModel, "net sales by drink category");
    expect(validateDashboard(roasteryModel, byDrinkSpec)).toEqual([]);
    const closerHeading = byDrinkSpec.tiles.find((t) => t.kind === "heading" && t.title === "A closer look");
    expect(closerHeading).toBeDefined();
    const closerTiles = byDrinkSpec.tiles.filter((t) => t.section === closerHeading!.id);
    expect(closerTiles[0]?.dimensions).toEqual(["cafe_orders.drink_category"]);

    const byRegionAndCategory = composeExecutiveBrief(
      roasteryModel,
      "net sales by region and drink category",
    );
    const closerBoth = byRegionAndCategory.tiles.filter(
      (t) => t.section === byRegionAndCategory.tiles.find((h) => h.title === "A closer look")?.id,
    );
    expect(closerBoth.slice(0, 2).map((t) => t.dimensions[0])).toEqual([
      "store_directory.region",
      "cafe_orders.drink_category",
    ]);
  });

  it("parses chart-type hints, Top-N limits, and includeTable requests into valid non-overlapping tiles", () => {
    const stackedTop5 = composeExecutiveBrief(
      roasteryModel,
      "weekly net sales by drink category as a stacked bar, top 5, include table",
    );
    expect(dashboardSchema.safeParse(stackedTop5).success).toBe(true);
    expect(validateDashboard(roasteryModel, stackedTop5)).toEqual([]);

    const closer = stackedTop5.tiles.find((t) => t.dimensions.includes("cafe_orders.drink_category"));
    expect(closer?.chart).toBe("barStacked");
    expect(closer?.limit).toBe(5);

    const tableSection = stackedTop5.tiles.find((t) => t.kind === "heading" && t.title === "Behind the numbers");
    expect(tableSection).toBeDefined();
    const tableTile = stackedTop5.tiles.find((t) => t.chart === "table");
    expect(tableTile?.limit).toBe(5);

    expect(parsePromptIntent(roasteryModel, "grouped bar of sales by city").chart).toBe("barGrouped");
    expect(parsePromptIntent(roasteryModel, "sales share by drink category").chart).toBe("donut");
    expect(parsePromptIntent(roasteryModel, "donut chart of cups by city").chart).toBe("donut");
    expect(parsePromptIntent(warehouseModel, "net new mrr bridge").chart).toBe("waterfall");
    expect(parsePromptIntent(roasteryModel, "area chart of monthly net sales with table").chart).toBe("area");
    expect(parsePromptIntent(roasteryModel, "top 10 stores by net sales with table").limit).toBe(10);
    expect(parsePromptIntent(roasteryModel, "top 10 stores by net sales with table").includeTable).toBe(true);

    const areaDonut = composeExecutiveBrief(roasteryModel, "area chart of net sales over time");
    expect(areaDonut.tiles.find((t) => t.title === "Net Sales over time")?.chart).toBe("area");
  });

  it("preserves top-importance headline metrics (Ending MRR, NRR, CAC) on generic polish/redesign prompts", () => {
    const genericPrompts = [
      "Make this an executive dashboard: show what matters, explain the trend, and make the next question obvious.",
      "Build an executive dashboard with clear headline numbers, a leading trend, and compact evidence for the next decision.",
      "Tell a coherent story: establish the question, sequence the evidence, and make the next question clear. Give the most useful chart room to lead.",
      "Find charts that hide useful information. Improve their reporting periods, breakdowns and comparisons using governed metrics. Add only the context needed to understand them.",
    ];

    for (const prompt of genericPrompts) {
      expect(parsePromptIntent(warehouseModel, prompt).isGenericPrompt).toBe(true);
      const spec = suggestDashboard(warehouseModel, { text: prompt, audience: "exec", grain: "month" });
      expect(validateDashboard(warehouseModel, spec)).toEqual([]);
      const kpis = spec.tiles.filter((t) => t.chart === "kpi" || t.chart === "stat");
      expect(kpis.map((t) => t.metrics[0])).toEqual(["ending_mrr", "nrr", "cac"]);
      expect(spec.tiles.some((t) => t.title === "Ending MRR (USD) over time")).toBe(true);
    }
  });
});

describe("Dashboard Recreation — 18 Charts, Fuzzy Matching, 12-Col Snapping & Sample Blueprints", () => {
  it("supports all 18 chart kinds and optional compare & limit in referenceItemSchema and buildReference", () => {
    expect(REFERENCE_CHART_KINDS).toHaveLength(18);
    expect(new Set(REFERENCE_CHART_KINDS)).toEqual(
      new Set([
        "kpi", "stat", "line", "area", "areaStacked",
        "bar", "barGrouped", "barStacked", "barH",
        "donut", "waterfall", "funnel", "heatmap", "combo",
        "map", "smallMultiples", "table", "scatter",
      ]),
    );

    for (const chart of REFERENCE_CHART_KINDS) {
      const parsed = referenceItemSchema.safeParse({
        id: `item-${chart}`,
        kind: "metric",
        label: `Chart ${chart}`,
        metrics: ["revenue"],
        dimensions: ["fct_sales.sold_on"],
        grain: "month",
        chart,
        x: 0,
        y: 0.1,
        w: 0.5,
        h: 0.3,
      });
      expect(parsed.success, `Expected ${chart} to validate`).toBe(true);
    }

    const withCompareAndLimit: Blueprint = {
      title: "Compare & Limit",
      pages: [
        {
          title: "Page 1",
          aspectRatio: 1.6,
          items: [
            {
              id: "kpi-prior",
              kind: "metric",
              label: "Monthly Revenue",
              metrics: ["revenue"],
              dimensions: ["fct_sales.sold_on"],
              grain: "month",
              chart: "kpi",
              compare: "prior",
              x: 0,
              y: 0.05,
              w: 0.5,
              h: 0.2,
            },
            {
              id: "kpi-first",
              kind: "metric",
              label: "Revenue vs First",
              metrics: ["revenue"],
              dimensions: ["fct_sales.sold_on"],
              grain: "month",
              chart: "kpi",
              compare: "first",
              x: 0.5,
              y: 0.05,
              w: 0.5,
              h: 0.2,
            },
            {
              id: "top-countries",
              kind: "metric",
              label: "Top 5 Countries",
              metrics: ["revenue"],
              dimensions: ["dim_users.country"],
              grain: "none",
              chart: "barStacked",
              limit: 5,
              x: 0,
              y: 0.35,
              w: 1,
              h: 0.4,
            },
          ],
        },
      ],
    };

    const built = buildReference(withCompareAndLimit, initialMapping(withCompareAndLimit, fixtureModel), fixtureModel, 1200);
    expect(built.notes.every((n) => n.status === "ready")).toBe(true);
    expect(built.spec.tiles[0].compare).toBe("prior");
    expect(built.spec.tiles[0].spark?.compare).toBe("prior");
    expect(built.spec.tiles[1].spark?.compare).toBe("first");
    expect(built.spec.tiles[2].chart).toBe("barStacked");
    expect(built.spec.tiles[2].limit).toBe(5);
  });

  it("instructs the vision model on all 18 chart kinds, prior comparisons, and Top-N limits in analyzeReference", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const data = Buffer.from(await pdf.save()).toString("base64");
    const cfg = { provider: "anthropic" as const, model: "test-model", apiKey: "test-only" };
    const mockOut: Blueprint = {
      title: "Extracted",
      pages: [
        {
          title: "Slide 1",
          aspectRatio: 1.6,
          items: [
            {
              id: "wf-1",
              kind: "metric",
              label: "MRR Waterfall",
              metrics: ["net_new_mrr"],
              dimensions: ["fct_mrr_movements.movement_type"],
              grain: "none",
              chart: "waterfall",
              limit: 10,
              compare: "prior",
              x: 0,
              y: 0.1,
              w: 1,
              h: 0.5,
            },
          ],
        },
      ],
    };
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", name: "record_reference", input: mockOut }],
      stop_reason: "tool_use",
    });

    const result = await analyzeReference({ mime: "application/pdf", data }, warehouseModel, cfg);
    expect(result).toEqual(mockOut);
    const req = anthropicCreate.mock.calls[0][0];
    expect(req.system).toContain("waterfall");
    expect(req.system).toContain("smallMultiples");
    expect(req.system).toContain("Top 5");
    expect(req.system).toContain('compare to "prior"');
  });

  it("auto-matches noisy screenshot labels and 'by <dimension>' titles via fuzzy + synonym scoring", () => {
    expect(metricMatches(roasteryModel, "Total Net Sales ($)")).toEqual(["net_sales"]);
    expect(metricMatches(roasteryModel, "Bean Cost ($)")).toEqual(["bean_cost"]);
    expect(fieldMatches(roasteryModel, "Sales by Store City")).toEqual(["store_directory.city"]);
    expect(fieldMatches(roasteryModel, "Store City")).toEqual(["store_directory.city"]);
    expect(fieldMatches(roasteryModel, "Drink Category")).toEqual(["cafe_orders.drink_category"]);

    expect(metricMatches(warehouseModel, "Total Ending MRR ($)")).toEqual(["ending_mrr"]);
    expect(fieldMatches(warehouseModel, "Active MRR by Plan")).toEqual(["dim_plans.plan_name"]);

    // Unrelated labels remain unresolved rather than hallucinating a match
    expect(metricMatches(fixtureModel, "Profit forecast")).toEqual([]);
    expect(fieldMatches(fixtureModel, "Warehouse Postal Zip")).toEqual([]);
  });

  it("snaps items onto clean 12-column rails and aligns row bands (|y1 - y2| <= 0.045) with zero overlaps", () => {
    const jitteredSketch: Blueprint = {
      title: "Hand Sketch",
      pages: [
        {
          title: "Overview",
          aspectRatio: 1.6,
          items: [
            {
              id: "k1",
              kind: "metric",
              label: "Net Sales",
              metrics: ["Total Net Sales ($)"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              x: 0.01,
              y: 0.08,
              w: 0.35,
              h: 0.14,
            },
            {
              id: "k2",
              kind: "metric",
              label: "Cups Sold",
              metrics: ["Cups Sold"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              x: 0.33,
              y: 0.11, // |0.11 - 0.08| = 0.03 <= 0.045 -> same row band!
              w: 0.36,
              h: 0.16,
            },
            {
              id: "k3",
              kind: "metric",
              label: "Bean Cost",
              metrics: ["Bean Cost ($)"],
              dimensions: ["cafe_orders.order_date"],
              grain: "month",
              chart: "kpi",
              x: 0.66,
              y: 0.095, // |0.095 - 0.08| = 0.015 <= 0.045 -> same row band!
              w: 0.34,
              h: 0.13,
            },
            {
              id: "c1",
              kind: "metric",
              label: "Sales by City",
              metrics: ["Total Net Sales ($)"],
              dimensions: ["Sales by Store City"],
              grain: "none",
              chart: "barH",
              x: 0.02,
              y: 0.19, // Close vertically so minimum KPI height expansion must push this row down cleanly
              w: 0.52,
              h: 0.32,
            },
            {
              id: "c2",
              kind: "metric",
              label: "Cost by Drink Category",
              metrics: ["Bean Cost ($)"],
              dimensions: ["cafe_orders.drink_category"],
              grain: "none",
              chart: "donut",
              x: 0.49,
              y: 0.22, // |0.22 - 0.19| = 0.03 <= 0.045 -> same row band!
              w: 0.51,
              h: 0.35,
            },
          ],
        },
      ],
    };

    const width = 1200;
    const pad = 24;
    const gap = 16;
    const avail = width - pad * 2;
    const validRailXs = new Set(
      Array.from({ length: 12 }, (_, col) => Math.round(pad + (col * (avail + gap)) / 12)),
    );

    const plan = buildReference(jitteredSketch, initialMapping(jitteredSketch, roasteryModel), roasteryModel, width);
    expect(plan.notes.every((n) => n.status === "ready")).toBe(true);

    const [t1, t2, t3, c1, c2] = plan.spec.tiles;
    // Uniform y and h across Row Band 1
    expect(t1.layout.y).toBe(t2.layout.y);
    expect(t2.layout.y).toBe(t3.layout.y);
    expect(t1.layout.h).toBe(t2.layout.h);
    expect(t2.layout.h).toBe(t3.layout.h);

    // Uniform y and h across Row Band 2, pushed below Row Band 1 + 16px gap
    expect(c1.layout.y).toBe(c2.layout.y);
    expect(c1.layout.h).toBe(c2.layout.h);
    expect(c1.layout.y).toBeGreaterThanOrEqual(t1.layout.y + t1.layout.h + gap);

    // Every tile sits on 12-column rails with exact 16px gaps and zero overlaps
    for (let i = 0; i < plan.spec.tiles.length; i++) {
      const a = plan.spec.tiles[i];
      expect(validRailXs.has(a.layout.x)).toBe(true);
      expect(a.layout.x).toBeGreaterThanOrEqual(pad);
      expect(a.layout.x + a.layout.w).toBeLessThanOrEqual(width - pad);
      for (let j = i + 1; j < plan.spec.tiles.length; j++) {
        expect(overlaps(a.layout, plan.spec.tiles[j].layout)).toBe(false);
      }
    }
    expect(t2.layout.x - (t1.layout.x + t1.layout.w)).toBe(gap);
    expect(t3.layout.x - (t2.layout.x + t2.layout.w)).toBe(gap);
    expect(c2.layout.x - (c1.layout.x + c1.layout.w)).toBe(gap);
  });

  it("ships 2 1-click SAMPLE_REFERENCE_BLUEPRINTS that auto-map, validate, and compile with 0 unresolved items", () => {
    expect(SAMPLE_REFERENCE_BLUEPRINTS).toHaveLength(2);

    const saasSample = SAMPLE_REFERENCE_BLUEPRINTS.find((s) => s.id === "saas-board-slide")!;
    expect(saasSample).toBeDefined();
    expect(saasSample.label).toBe("Board Revenue & Retention Slide");
    expect(saasSample.targetModelHint).toBe("saas");
    expect(blueprintSchema.safeParse(saasSample.blueprint).success).toBe(true);

    const saasPlan = buildReference(
      saasSample.blueprint,
      initialMapping(saasSample.blueprint, warehouseModel),
      warehouseModel,
      1440,
    );
    expect(saasPlan.notes.filter((n) => n.status === "unresolved")).toEqual([]);
    expect(validateDashboard(warehouseModel, saasPlan.spec)).toEqual([]);
    expect(saasPlan.spec.tiles.flatMap((t) => t.metrics)).toEqual(
      expect.arrayContaining(["ending_mrr", "nrr", "cac", "net_new_mrr", "mrr"]),
    );
    expect(saasPlan.spec.tiles.some((t) => t.chart === "waterfall" && t.metrics[0] === "net_new_mrr")).toBe(true);
    expect(saasPlan.spec.tiles.some((t) => t.dimensions.includes("dim_plans.plan_name") && t.metrics[0] === "mrr")).toBe(true);
    for (let i = 0; i < saasPlan.spec.tiles.length; i++) {
      const tile = saasPlan.spec.tiles[i];
      if (!tile.kind || tile.kind === "metric") {
        expect(validateTile(warehouseModel, tile)).toEqual([]);
        expect(() => compileTile(warehouseModel, conn, tile)).not.toThrow();
      }
      for (let j = i + 1; j < saasPlan.spec.tiles.length; j++) {
        expect(overlaps(tile.layout, saasPlan.spec.tiles[j].layout)).toBe(false);
      }
    }

    const roasterySample = SAMPLE_REFERENCE_BLUEPRINTS.find((s) => s.id === "roastery-weekly-ops")!;
    expect(roasterySample).toBeDefined();
    expect(roasterySample.label).toBe("Store Operations & Margin Sketch");
    expect(roasterySample.targetModelHint).toBe("roastery");
    expect(blueprintSchema.safeParse(roasterySample.blueprint).success).toBe(true);

    const roasteryPlan = buildReference(
      roasterySample.blueprint,
      initialMapping(roasterySample.blueprint, roasteryModel),
      roasteryModel,
      1440,
    );
    expect(roasteryPlan.notes.filter((n) => n.status === "unresolved")).toEqual([]);
    expect(validateDashboard(roasteryModel, roasteryPlan.spec)).toEqual([]);
    expect(roasteryPlan.spec.tiles.flatMap((t) => t.metrics)).toEqual(
      expect.arrayContaining(["net_sales", "cups_sold", "bean_cost"]),
    );
    expect(roasteryPlan.spec.tiles.flatMap((t) => t.dimensions)).toEqual(
      expect.arrayContaining(["store_directory.city", "cafe_orders.drink_category"]),
    );
    for (let i = 0; i < roasteryPlan.spec.tiles.length; i++) {
      const tile = roasteryPlan.spec.tiles[i];
      if (!tile.kind || tile.kind === "metric") {
        expect(validateTile(roasteryModel, tile)).toEqual([]);
        expect(() => compileTile(roasteryModel, conn, tile)).not.toThrow();
      }
      for (let j = i + 1; j < roasteryPlan.spec.tiles.length; j++) {
        expect(overlaps(tile.layout, roasteryPlan.spec.tiles[j].layout)).toBe(false);
      }
    }
  });
});
