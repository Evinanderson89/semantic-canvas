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
  profileWorkbook,
} from "../src/modeler/spreadsheet.ts";
import { proposalIssues } from "../src/modeler/yaml.ts";

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
    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins?.[0]).toMatchObject({
      leftTable: "cafe_orders",
      leftColumn: "store_id",
      rightTable: "store_directory",
      rightColumn: "store_id",
      matchRate: 1,
      include: true,
    });

    const grid = await buildSampleWorkbookPayload("grid-renewables");
    const gridSheet = parseCsv(grid.content, "Grid");
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Skipped 2 leading title\/banner rows/);
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Excluded 1 Total\/Subtotal summary row/);
    expect((gridSheet.cleaningNotes ?? []).join(" | ")).toMatch(/Cleaned 1 formula error cell/);
  });
});
