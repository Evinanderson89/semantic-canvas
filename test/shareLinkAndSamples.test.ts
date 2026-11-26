import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildShareUrl,
  parseShareLink,
  resolveStarterName,
  slugStarter,
  stripShareLink,
} from "../src/app/shareLink.ts";
import {
  buildSampleWorkbookPayload,
  SAMPLE_WORKBOOKS,
} from "../src/modeler/spreadsheetTypes.ts";
import {
  buildWorkbookProposal,
  parseCsv,
  parseXlsxWorkbook,
  prepareWorkbookImport,
  profileWorkbook,
} from "../src/modeler/spreadsheet.ts";
import { proposalIssues, proposalToYaml } from "../src/modeler/yaml.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";

describe("shareLink deep-link parser and builder", () => {
  it("parses and strips starter, mode, detail, story, sample, and window parameters", () => {
    expect(parseShareLink("")).toBeNull();
    expect(parseShareLink("?foo=bar")).toBeNull();

    const parsed = parseShareLink("?starter=saas-overview&mode=infographic&detail=ending_mrr&story=1&window=90d");
    expect(parsed).toEqual({
      starter: "saas-overview",
      dash: null,
      mode: "infographic",
      detail: "ending_mrr",
      story: true,
      sample: null,
      auto: false,
      window: "last-90-days",
    });

    const sampleLink = parseShareLink("?sample=roastery-2tab-xlsx&auto=1");
    expect(sampleLink?.sample).toBe("roastery-2tab-xlsx");
    expect(sampleLink?.auto).toBe(true);

    expect(stripShareLink("https://try.semanticcanvas.ai/?starter=saas-overview&detail=ending_mrr&story=1&keep=yes"))
      .toBe("https://try.semanticcanvas.ai/?keep=yes");
  });

  it("resolves starter slugs and builds clean share URLs", () => {
    const names = ["SaaS overview", "MRR movements", "Marketing performance"];
    expect(slugStarter("SaaS overview")).toBe("saas-overview");
    expect(resolveStarterName("saas-overview", names)).toBe("SaaS overview");
    expect(resolveStarterName("MRR movements", names)).toBe("MRR movements");
    expect(resolveStarterName("unknown-pack", names)).toBeNull();

    expect(
      buildShareUrl("https://try.semanticcanvas.ai/?old=1", {
        starterTitle: "SaaS overview",
        detail: "ending_mrr",
        story: true,
        dateWindow: "last-90-days",
      }),
    ).toBe("https://try.semanticcanvas.ai/?old=1&starter=saas-overview&window=last-90-days&detail=ending_mrr&story=1");

    expect(
      buildShareUrl("https://try.semanticcanvas.ai/", {
        sample: "messy-roastery-pnl",
        auto: true,
      }),
    ).toBe("https://try.semanticcanvas.ai/?sample=messy-roastery-pnl&auto=1");
  });
});

describe("curated messy & multi-tab sample workbooks", () => {
  it("cleans all 4 corporate spreadsheet traps on messy-roastery-pnl", async () => {
    const built = await buildSampleWorkbookPayload("messy-roastery-pnl");
    const sheet = parseCsv(built.content, built.fileName.replace(/\.csv$/i, ""));
    expect(sheet.cleaningNotes).toBeDefined();
    const joinedNotes = (sheet.cleaningNotes ?? []).join(" | ");
    expect(joinedNotes).toMatch(/Skipped 2 leading title\/banner rows/);
    expect(joinedNotes).toMatch(/Excluded 2 Total\/Subtotal summary rows/);
    expect(joinedNotes).toMatch(/Cleaned 2 formula error cells/);
    expect(joinedNotes).toMatch(/Unpivoted 6 wide period columns/);

    const preview = profileWorkbook(built.fileName, [sheet]);
    expect(preview.suggestedTimeColumn).toBe("period_date");
    expect(preview.suggestedPeriod).toEqual({ column: "period_date", grain: "month" });
    const proposal = buildWorkbookProposal({
      sourceId: built.meta.preferredSourceId,
      label: built.meta.title,
      sheets: preview.sheets ?? [],
      joins: preview.detectedJoins ?? [],
      primaryGrain: preview.suggestedGrain,
      primaryTimeColumn: preview.suggestedTimeColumn,
      primaryReportingLag: built.meta.defaultLag,
    });
    expect(proposalIssues(proposal)).toEqual([]);
    expect(proposalToYaml(proposal)).toContain("period:\n      column: period_date\n      grain: month");
  });

  it("builds a real 2-tab .xlsx workbook with banner/total stripping and 100% foreign-key auto-join", async () => {
    expect(SAMPLE_WORKBOOKS).toHaveLength(3);
    const built = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
    expect(built.format).toBe("xlsx");
    const bytes = Uint8Array.from(Buffer.from(built.content, "base64"));
    const sheets = parseXlsxWorkbook(bytes);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].sheetName).toBe("Cafe Orders");
    expect(sheets[1].sheetName).toBe("Store Directory");
    expect((sheets[0].cleaningNotes ?? []).join(" | ")).toMatch(/Skipped 1 leading title\/banner row/);
    expect((sheets[0].cleaningNotes ?? []).join(" | ")).toMatch(/Excluded 1 Total\/Subtotal summary row/);

    const preview = profileWorkbook(built.fileName, sheets);
    expect(sheets[0].rows).toHaveLength(33);
    // Monthly order counts ramp naturally across Mar..Aug (3, 4, 5, 6, 8, 7 — never a flat 4-4-4-4)
    const monthCounts = new Map<string, number>();
    for (const r of sheets[0].rows) {
      const ym = r[0].slice(0, 7);
      monthCounts.set(ym, (monthCounts.get(ym) ?? 0) + 1);
    }
    expect([...monthCounts.values()]).toEqual([3, 4, 5, 6, 8, 7]);

    expect(sheets[1].rows).toHaveLength(6); // 5 unique stores + 1 duplicate STR-101 CRM export row
    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins?.[0]).toMatchObject({
      leftTable: "cafe_orders",
      leftColumn: "store_id",
      rightTable: "store_directory",
      rightColumn: "store_id",
      matchRate: 1,
      include: true,
      rightKeyUnique: false,
      duplicateKeyCount: 1,
      duplicateRightRows: 1,
      allExactDuplicates: true,
      resolution: "deduplicate",
      fanoutImpact: {
        metricColumn: "net_sales",
        metricLabel: "Net Sales",
        trueTotal: 528200,
        inflatedTotal: 688200,
        delta: 160000,
      },
    });
    expect((preview.cleaningNotes ?? []).join(" | ")).toMatch(
      /Store Directory: Deduplicated 1 duplicate Store ID row \(STR-101\) — prevented \$528,200 → \$688,200 Net Sales double-count/,
    );

    const prepared = prepareWorkbookImport({ parsedSheets: sheets, preview });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.sheets[1].rowCount).toBe(5);
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
      expect(yaml).toContain("hygiene_notes:");
      expect(yaml).toContain("$528,200 → $688,200");

      const dir = await mkdtemp(join(tmpdir(), "sc-roastery-suggest-"));
      try {
        const yamlFile = join(dir, "roastery.yaml");
        await writeFile(yamlFile, yaml, "utf8");
        const model = await duckglueAdapter.load(yamlFile);
        expect(model).not.toBeNull();
        expect(model!.metrics.net_sales.importance).toBe(100);
        expect(model!.metrics.net_sales.unit).toBe("currency");
        expect(model!.metrics.cups_sold.importance).toBe(85);
        expect(model!.metrics.cups_sold.unit).toBeUndefined();
        expect(model!.metrics.bean_cost.importance).toBe(75);
        expect(model!.metrics.bean_cost.unit).toBe("currency");
        expect(model!.metrics.record_count.importance).toBe(15);

        for (const callOpts of [
          { table: "cafe_orders", text: "Specialty Coffee Orders + Stores", audience: "exec" as const, grain: "month" },
          { table: "cafe_orders", metrics: ["net_sales", "cups_sold", "bean_cost", "record_count"], audience: "operator" as const, grain: "month", text: "Overview of Specialty Coffee Orders + Stores" },
        ]) {
          const suggested = suggestDashboard(model!, callOpts);
          const kpis = suggested.tiles.filter((t) => t.chart === "kpi" || t.chart === "stat");
          expect(kpis.map((t) => t.metrics[0])).toEqual(["net_sales", "cups_sold", "bean_cost"]);

          const lines = suggested.tiles.filter((t) => t.chart === "line");
          expect(lines.map((t) => t.title)).toEqual([
            "Net Sales over time",
            "Cups Sold over time",
            "Bean Cost over time",
          ]);
          expect(lines[1].layout.y).toBe(lines[2].layout.y);
          expect(suggested.tiles.some((t) => t.title === "Total orders over time")).toBe(false);

          const bars = suggested.tiles.filter((t) => t.chart === "barH");
          expect(bars.map((t) => t.title)).toEqual(["Net Sales by city", "Net Sales by region"]);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    const grid = await buildSampleWorkbookPayload("grid-renewables");
    const gridSheet = parseCsv(grid.content, "Grid");
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Skipped 2 leading title\/banner rows/);
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Excluded 1 Total\/Subtotal summary row/);
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Cleaned 1 formula error cell/);
    const gridPreview = profileWorkbook(grid.fileName, [gridSheet]);
    expect(gridPreview.suggestedGrain).toBe("One monthly summary");
    expect(gridPreview.suggestedPeriod).toEqual({ column: "dispatch_month", grain: "month" });
    const solarCol = gridPreview.columns.find((c) => c.name === "solar_generation_mwh");
    expect(solarCol?.formatHint).toBe("number");
  });
});
