import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import writeXlsxFile from "write-excel-file/universal";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import {
  buildSpreadsheetProposal,
  buildWorkbookProposal,
  normalizeDateValue,
  parseCsv,
  parseNumericValue,
  parseWidePeriodHeader,
  parseXlsxBuffer,
  parseXlsxWorkbook,
  profileSpreadsheet,
  profileWorkbook,
  SAMPLE_SPREADSHEET_CSV,
  SAMPLE_SPREADSHEET_NAME,
  slugifySourceId,
  writeSpreadsheetParquet,
} from "../src/modeler/spreadsheet.ts";
import { proposalIssues, proposalToYaml } from "../src/modeler/yaml.ts";
import { showcaseStarters } from "../src/library/showcase.ts";
import { PALETTES } from "../src/format/format.ts";

describe("spreadsheet parser, profiler & DuckDB Parquet writer", () => {
  it("parses RFC 4180 CSV with quoted commas, escaped quotes, BOM, and tabs/semicolons", () => {
    const csv = '\uFEFF"Order Date","Customer, Name","Notes",Amount\r\n2026-04-01,"Acme, ""Inc.""","Line 1", "$1,250.50"\r\n\r\n2026-04-02,"Beta Co","Simple","$800.00"';
    const parsed = parseCsv(csv, "Orders");
    expect(parsed.sheetName).toBe("Orders");
    expect(parsed.headers).toEqual(["Order Date", "Customer, Name", "Notes", "Amount"]);
    expect(parsed.rows).toEqual([
      ["2026-04-01", 'Acme, "Inc."', "Line 1", "$1,250.50"],
      ["2026-04-02", "Beta Co", "Simple", "$800.00"],
    ]);

    const semi = parseCsv("Date;Region;Sales\n2026-05-01;EMEA;450\n2026-05-02;NA;900");
    expect(semi.headers).toEqual(["Date", "Region", "Sales"]);
    expect(semi.rows[1]).toEqual(["2026-05-02", "NA", "900"]);

    const tsv = parseCsv("Date\tPlan\tMRR\n2026-06-01\tPro\t2500");
    expect(tsv.rows[0]).toEqual(["2026-06-01", "Pro", "2500"]);

    expect(() => parseCsv("OnlyHeader\n")).toThrow(/at least one data row/i);
  });

  it("parses real .xlsx workbooks including dates, strings, and numbers", async () => {
    const blob = await writeXlsxFile([
      {
        sheet: "Q3 Sales",
        data: [
          [
            { value: "Order Date", type: String },
            { value: "Order ID", type: String },
            { value: "Region", type: String },
            { value: "Revenue", type: String },
            { value: "Active", type: String },
          ],
          [
            { value: new Date("2026-07-04T00:00:00Z"), type: Date, format: "yyyy-mm-dd" },
            { value: "ORD-9001", type: String },
            { value: "North America", type: String },
            { value: 18400, type: Number },
            { value: true, type: Boolean },
          ],
          [
            { value: new Date("2026-07-12T00:00:00Z"), type: Date, format: "yyyy-mm-dd" },
            { value: "ORD-9002", type: String },
            { value: "Europe", type: String },
            { value: 9250.5, type: Number },
            { value: false, type: Boolean },
          ],
        ],
      },
    ]).toBlob();

    const parsed = parseXlsxBuffer(new Uint8Array(await blob.arrayBuffer()));
    expect(parsed.sheetName).toBe("Q3 Sales");
    expect(parsed.headers).toEqual(["Order Date", "Order ID", "Region", "Revenue", "Active"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual(["2026-07-04", "ORD-9001", "North America", "18400", "true"]);
    expect(parsed.rows[1]).toEqual(["2026-07-12", "ORD-9002", "Europe", "9250.5", "false"]);
  });

  it("profiles sample sales CSV into date, ID, metrics, categories, and a valid DuckGlue proposal", async () => {
    const parsed = parseCsv(SAMPLE_SPREADSHEET_CSV, "Q3 Sales");
    const preview = profileSpreadsheet(SAMPLE_SPREADSHEET_NAME, parsed);

    expect(preview.sourceId).toBe("q3-sales-performance");
    expect(preview.rowCount).toBe(20);
    expect(preview.previewRows).toHaveLength(5);
    expect(preview.suggestedTimeColumn).toBe("order_date");
    expect(preview.suggestedPrimaryKey).toBe("order_id");
    expect(preview.suggestedGrain).toBe("One sale or order");

    const byName = Object.fromEntries(preview.columns.map((c) => [c.name, c]));
    expect(byName.order_date.role).toBe("date");
    expect(byName.order_id.role).toBe("id");
    expect(byName.revenue.role).toBe("metric");
    expect(byName.revenue.formatHint).toBe("currency");
    expect(byName.discount.role).toBe("metric");
    expect(byName.discount.formatHint).toBe("percent");
    expect(byName.region.role).toBe("category");

    const proposal = buildSpreadsheetProposal({
      sourceId: preview.sourceId,
      label: preview.label,
      tableName: preview.tableName,
      rowCount: preview.rowCount,
      grain: preview.suggestedGrain,
      timeColumn: preview.suggestedTimeColumn,
      reportingLag: 2,
      columns: preview.columns,
    });

    expect(proposalIssues(proposal)).toEqual([]);
    const yaml = proposalToYaml(proposal);
    expect(yaml).toContain("SUM(revenue)");
    expect(yaml).toContain("AVG(discount)");
    expect(yaml).toContain("reporting_lag: 2");

    const dir = await mkdtemp(join(tmpdir(), "sc-sheet-test-"));
    try {
      await writeSpreadsheetParquet(dir, preview.tableName, preview.columns, parsed.rows);
      const conn = await duckdbConnector(dir);
      try {
        const res = await conn.execute(
          `SELECT COUNT(*) AS n, SUM(revenue) AS rev FROM ${conn.relation(preview.tableName)}`,
        );
        expect(res.rows[0][0]).toBe(20);
        expect(Number(res.rows[0][1])).toBeCloseTo(333400, 2);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes dates, numeric strings, and source slugs cleanly", () => {
    expect(normalizeDateValue("2026-08-15")).toBe("2026-08-15");
    expect(normalizeDateValue("2026-08")).toBe("2026-08-01");
    expect(normalizeDateValue("8/5/2026")).toBe("2026-08-05");
    expect(normalizeDateValue("not-a-date")).toBeNull();

    expect(parseNumericValue("$1,250.50")).toMatchObject({ value: 1250.5, isCurrency: true });
    expect(parseNumericValue("14.5%")).toMatchObject({ value: 0.145, isPercent: true });
    expect(parseNumericValue("($420)")).toMatchObject({ value: -420, isCurrency: true });
    expect(slugifySourceId("2026 Q3 Revenue.xlsx")).toBe("q3-revenue");
  });

  it("keeps SaaS overview showcase takeaway aligned with live DuckDB figures and calm default palette order", () => {
    const saas = showcaseStarters()["SaaS overview"];
    const takeaway = saas.tabs?.[0]?.brief?.takeaway ?? "";
    expect(takeaway).toContain("$202.8k");
    expect(takeaway).toContain("+14.4% MoM");
    expect(takeaway).not.toContain("$203.3k");
    // Default neutral palette keeps vermilion red last so positive metrics like NRR don't turn alarm red.
    expect(PALETTES.default.indexOf("#e11d48")).toBe(PALETTES.default.length - 1);
  });

  it("parses multi-sheet .xlsx workbooks, auto-detects cross-sheet joins, builds multi-table YAML, and executes live cross-sheet DuckDB joins", async () => {
    const blob = await writeXlsxFile([
      {
        sheet: "Orders",
        data: [
          [
            { value: "Order Date", type: String },
            { value: "Order ID", type: String },
            { value: "Customer ID", type: String },
            { value: "Revenue", type: String },
          ],
          [
            { value: new Date("2026-07-04T00:00:00Z"), type: Date, format: "yyyy-mm-dd" },
            { value: "ORD-1", type: String },
            { value: "CUST-10", type: String },
            { value: 12000, type: Number },
          ],
          [
            { value: new Date("2026-07-08T00:00:00Z"), type: Date, format: "yyyy-mm-dd" },
            { value: "ORD-2", type: String },
            { value: "CUST-20", type: String },
            { value: 8500, type: Number },
          ],
          [
            { value: new Date("2026-07-15T00:00:00Z"), type: Date, format: "yyyy-mm-dd" },
            { value: "ORD-3", type: String },
            { value: "CUST-10", type: String },
            { value: 4500, type: Number },
          ],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [
            { value: "Customer ID", type: String },
            { value: "Company", type: String },
            { value: "Segment", type: String },
          ],
          [
            { value: "CUST-10", type: String },
            { value: "Acme Corp", type: String },
            { value: "Enterprise", type: String },
          ],
          [
            { value: "CUST-20", type: String },
            { value: "Beta Labs", type: String },
            { value: "Growth", type: String },
          ],
        ],
      },
    ]).toBlob();

    const parsedSheets = parseXlsxWorkbook(new Uint8Array(await blob.arrayBuffer()));
    expect(parsedSheets.map((s) => s.sheetName)).toEqual(["Orders", "Customers"]);

    const preview = profileWorkbook("Q3_Workbook.xlsx", parsedSheets);
    expect(preview.sheets).toHaveLength(2);
    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins![0]).toMatchObject({
      leftTable: "orders",
      leftColumn: "customer_id",
      rightTable: "customers",
      rightColumn: "customer_id",
      matchRate: 1,
      include: true,
    });

    const proposal = buildWorkbookProposal({
      sourceId: preview.sourceId,
      label: preview.label,
      sheets: preview.sheets!,
      joins: preview.detectedJoins!,
      primaryGrain: "One sale or order",
      primaryTimeColumn: preview.suggestedTimeColumn,
      primaryReportingLag: 0,
    });
    expect(proposalIssues(proposal)).toEqual([]);
    const yaml = proposalToYaml(proposal);
    expect(yaml).toContain("orders:");
    expect(yaml).toContain("customers:");
    expect(yaml).toContain("left: orders");
    expect(yaml).toContain("right: customers");

    const dir = await mkdtemp(join(tmpdir(), "sc-multisheet-test-"));
    try {
      for (let i = 0; i < preview.sheets!.length; i++) {
        await writeSpreadsheetParquet(dir, preview.sheets![i].tableName, preview.sheets![i].columns, parsedSheets[i].rows);
      }
      const conn = await duckdbConnector(dir);
      try {
        const res = await conn.execute(
          `SELECT c.segment, SUM(o.revenue) AS rev
           FROM ${conn.relation("orders")} o
           LEFT JOIN ${conn.relation("customers")} c ON o.customer_id = c.customer_id
           GROUP BY 1 ORDER BY rev DESC`,
        );
        expect(res.rows).toEqual([
          ["Enterprise", 16500],
          ["Growth", 8500],
        ]);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto-cleans messy corporate spreadsheets: skips title banners, scrubs #N/A errors, strips Total rows, and unpivots wide monthly columns", async () => {
    expect(parseWidePeriodHeader("Jan 2026")).toBe("2026-01-01");
    expect(parseWidePeriodHeader("Mar-26")).toBe("2026-03-01");
    expect(parseWidePeriodHeader("Q3 2026")).toBe("2026-07-01");
    expect(parseWidePeriodHeader("2026-Q4")).toBe("2026-10-01");
    expect(parseWidePeriodHeader("05/2026")).toBe("2026-05-01");
    expect(parseWidePeriodHeader("Region")).toBeNull();

    const messyCsv = [
      "Acme Corp — Q1 Regional Revenue Pack,,,",
      "Prepared by Finance · Confidential,,,",
      "Region,Segment,Jan 2026,Feb 2026,Mar 2026",
      "North America,Enterprise,$40000,$45000,$50000",
      "Europe,Growth,$20000,#N/A,$25000",
      "Grand Total,,$60000,$45000,$75000",
    ].join("\n");

    const parsed = parseCsv(messyCsv, "Regional Revenue");
    expect(parsed.headers).toEqual(["Region", "Segment", "Period Date", "Revenue ($)"]);
    // 2 regions * 3 months - 1 #N/A cell = 5 tidy rows; Grand Total row was stripped!
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.cleaningNotes).toEqual([
      "Skipped 2 leading title/banner rows",
      "Excluded 1 Total/Subtotal summary row to prevent double-counting",
      "Cleaned 1 formula error cell (#N/A, #DIV/0!)",
      "Unpivoted 3 wide period columns into tidy time-series rows",
    ]);

    const preview = profileSpreadsheet("Regional_Revenue.csv", parsed);
    expect(preview.suggestedTimeColumn).toBe("period_date");
    expect(preview.cleaningNotes).toHaveLength(4);

    const dir = await mkdtemp(join(tmpdir(), "sc-messy-sheet-"));
    try {
      await writeSpreadsheetParquet(dir, preview.tableName, preview.columns, parsed.rows);
      const conn = await duckdbConnector(dir);
      try {
        const res = await conn.execute(`SELECT SUM(revenue) FROM ${conn.relation(preview.tableName)}`);
        // Exact sum without double-counting Grand Total: 40k+45k+50k+20k+25k = 180,000 (NOT 360,000!)
        expect(Number(res.rows[0][0])).toBe(180000);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
