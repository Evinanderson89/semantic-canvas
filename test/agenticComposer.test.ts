import { beforeAll, describe, expect, it } from "vitest";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import { matchModel, tokens } from "../src/suggest/match.ts";
import { composeExecutiveBrief, emptyDashboard, suggestDashboard } from "../src/suggest/suggest.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { dashboardSchema } from "../src/compiler/schema.ts";
import { validateDashboard } from "../src/app/filters.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { conn, model as fixtureModel } from "./fixtures.ts";

let warehouseModel: Model;

beforeAll(async () => {
  const loaded = await duckglueAdapter.load("sample-data/warehouse.yaml");
  if (!loaded) throw new Error("Expected sample-data/warehouse.yaml to load");
  warehouseModel = loaded;
});

describe("matchModel & token normalization", () => {
  it("normalizes executive business synonyms and stems in tokens()", () => {
    expect(
      tokens("arr bookings expansion bridge drivers plans tiers channels cac funnel")
    ).toEqual([
      "mrr",
      "mrr",
      "net_new_mrr",
      "movement",
      "movement",
      "plan",
      "tier",
      "channel",
      "cost",
      "conversion",
    ]);
  });

  it("returns empty companionTables and matchedByTable when prompt has no signal", () => {
    const res = matchModel(warehouseModel, "the and of to");
    expect(res).toEqual({
      metrics: [],
      tables: [],
      subject: null,
      companionTables: [],
      matchedByTable: {},
    });
  });

  it("matches across fct_saas_monthly, fct_mrr_movements, dim_plans and fct_subscriptions for a multi-table executive prompt", () => {
    const prompt =
      "how is recurring revenue trending, what drove August's change, and how does retention compare across plans";
    const matches = matchModel(warehouseModel, prompt);

    expect(matches.subject).toBe("fct_saas_monthly");
    expect(matches.companionTables).toEqual(
      expect.arrayContaining(["fct_mrr_movements", "fct_subscriptions", "dim_plans"])
    );
    expect(matches.matchedByTable.fct_saas_monthly?.map((m) => m.name)).toEqual(
      expect.arrayContaining(["nrr", "grr", "ending_mrr"])
    );
    expect(matches.matchedByTable.fct_mrr_movements?.map((m) => m.name)).toContain("net_new_mrr");
    expect(matches.matchedByTable.fct_subscriptions?.map((m) => m.name)).toContain("mrr");
  });
});

describe("suggestDashboard & composeExecutiveBrief", () => {
  it("composes a multi-table executive story with retention parity scale, waterfall bridge, plan mix, and methodology note", () => {
    const prompt =
      "how is recurring revenue trending, what drove August's change, and how does retention compare across plans";
    const spec = composeExecutiveBrief(warehouseModel, prompt, { width: 1440 });

    expect(dashboardSchema.safeParse(spec).success).toBe(true);
    expect(validateDashboard(warehouseModel, spec)).toEqual([]);

    // Headings include the cross-table driver section
    const headings = spec.tiles.filter((t) => t.kind === "heading").map((t) => t.title);
    expect(headings).toContain("At a glance");
    expect(headings).toContain("How it's changing");
    expect(headings).toContain("Supporting context");
    expect(headings).toContain("What is driving the change?");

    // Retention trend charts automatically get fitted scale + 100% parity reference line
    const retentionTrends = spec.tiles.filter(
      (t) =>
        t.chart === "line" &&
        (t.metrics.includes("nrr") || t.metrics.includes("grr"))
    );
    expect(retentionTrends.length).toBeGreaterThanOrEqual(1);
    for (const trend of retentionTrends) {
      expect(trend.format).toMatchObject({
        lineScale: "fit",
        referenceLines: [{ label: "100% parity", value: 1 }],
      });
    }

    // Companion waterfall chart on fct_mrr_movements
    const waterfall = spec.tiles.find((t) => t.chart === "waterfall");
    expect(waterfall).toBeDefined();
    expect(waterfall?.title).toBe("MRR movements · signed contribution");
    expect(waterfall?.metrics).toEqual(["net_new_mrr"]);
    expect(waterfall?.dimensions).toEqual(["fct_mrr_movements.movement_type"]);

    // Companion plan breakdown chart on dim_plans
    const planBreakdown = spec.tiles.find(
      (t) => t.dimensions.includes("dim_plans.plan_name") && t.chart === "barH"
    );
    expect(planBreakdown).toBeDefined();
    expect(planBreakdown?.title).toBe("Active base-subscription MRR by plan");
    expect(planBreakdown?.metrics).toEqual(["mrr"]);

    // Closing Scope & Methodology Note
    const note = spec.tiles.find((t) => t.kind === "text");
    expect(note).toBeDefined();
    expect(note?.title).toBe("Scope & methodology note");
    expect(note?.text).toContain("fct_saas_monthly");
    expect(note?.text).toContain("fct_mrr_movements");
    expect(note?.text).toContain("fct_subscriptions");
    expect(note?.text).toContain("dim_plans");
    expect(note?.text).toContain("month (monthly)");
    expect(note?.text).toContain("Snapshot and period-bound metrics");
    expect(note?.text).toContain("Signed movement bridges");

    // Every metric tile compiles cleanly and no tiles overlap
    for (let i = 0; i < spec.tiles.length; i++) {
      const a = spec.tiles[i];
      if (!a.kind || a.kind === "metric") {
        expect(validateTile(warehouseModel, a)).toEqual([]);
        expect(() => compileTile(warehouseModel, conn, a)).not.toThrow();
      }
      for (let j = i + 1; j < spec.tiles.length; j++) {
        expect(overlaps(a.layout, spec.tiles[j].layout)).toBe(false);
      }
    }
  });

  it("automatically selects a signed waterfall chart when suggesting a dashboard for fct_mrr_movements", () => {
    const spec = suggestDashboard(warehouseModel, { table: "fct_mrr_movements", width: 1440 });
    expect(validateDashboard(warehouseModel, spec)).toEqual([]);

    const waterfall = spec.tiles.find((t) => t.chart === "waterfall");
    expect(waterfall).toBeDefined();
    expect(waterfall?.title).toBe("MRR movements · signed contribution");
    expect(waterfall?.metrics).toEqual(["net_new_mrr"]);
    expect(waterfall?.dimensions).toEqual(["fct_mrr_movements.movement_type"]);
  });

  it("supports plan tier donut breakdowns, channel breakdowns, and narrow responsive layouts", () => {
    const tierSpec = composeExecutiveBrief(warehouseModel, {
      text: "how is net revenue retention trending across plan tiers and marketing channels",
      width: 640,
    });
    expect(validateDashboard(warehouseModel, tierSpec)).toEqual([]);

    const primaryRetention = tierSpec.tiles.find(
      (t) => t.chart === "line" && t.metrics.includes("nrr")
    );
    expect(primaryRetention?.format).toMatchObject({
      lineScale: "fit",
      referenceLines: [{ label: "100% parity", value: 1 }],
    });

    const tierDonut = tierSpec.tiles.find((t) => t.dimensions.includes("dim_plans.plan_tier"));
    expect(tierDonut?.chart).toBe("donut");

    const channelBar = tierSpec.tiles.find((t) =>
      t.dimensions.some((d) => d.endsWith(".channel"))
    );
    expect(channelBar?.chart).toBe("barH");

    for (let i = 0; i < tierSpec.tiles.length; i++) {
      expect(tierSpec.tiles[i].layout.x + tierSpec.tiles[i].layout.w).toBeLessThanOrEqual(616);
      for (let j = i + 1; j < tierSpec.tiles.length; j++) {
        expect(overlaps(tierSpec.tiles[i].layout, tierSpec.tiles[j].layout)).toBe(false);
      }
    }
  });

  it("adds a companion time-series chart when a prompt spans two fact tables without movement or plan columns", () => {
    const spec = composeExecutiveBrief(
      warehouseModel,
      "how are active users and new signups trending over time"
    );
    expect(validateDashboard(warehouseModel, spec)).toEqual([]);
    const companionSection = spec.tiles.find(
      (t) => t.kind === "heading" && t.title === "What is driving the change?"
    );
    expect(companionSection).toBeDefined();
    const companionTiles = spec.tiles.filter((t) => t.section === companionSection?.id);
    expect(companionTiles.length).toBeGreaterThanOrEqual(1);
    expect(emptyDashboard(fixtureModel).tiles).toEqual([]);
  });
});
