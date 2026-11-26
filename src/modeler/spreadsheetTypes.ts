export type SpreadsheetColumnRole = "date" | "id" | "metric" | "category";
export type SpreadsheetValueType = "DATE" | "DOUBLE" | "BIGINT" | "VARCHAR";
export type SpreadsheetFormatHint = "currency" | "percent" | "number" | "date" | "text";

export interface SpreadsheetColumnProfile {
  name: string;
  originalHeader: string;
  label: string;
  sqlType: SpreadsheetValueType;
  formatHint: SpreadsheetFormatHint;
  role: SpreadsheetColumnRole;
  uniqueCount: number;
  nonEmptyCount: number;
  samples: string[];
  /** Detected whole-period coverage grain when every row represents a full month or quarter. */
  periodGrain?: "month" | "quarter";
}

export type SpreadsheetJoinResolution = "deduplicate" | "one_to_many" | "exclude";

export interface SpreadsheetDuplicateKeyDetail {
  key: string;
  rightRows: number;
  rowNumbers: number[];
  exactDuplicate: boolean;
  conflictingColumns: string[];
}

export interface SpreadsheetJoinFanoutImpact {
  metricColumn: string;
  metricLabel: string;
  trueTotal: number;
  inflatedTotal: number;
  delta: number;
  multiplier: number;
}

export interface SpreadsheetDetectedJoin {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  matchRate: number;
  include: boolean;
  rightKeyUnique: boolean;
  duplicateKeyCount?: number;
  duplicateRightRows?: number;
  allExactDuplicates?: boolean;
  duplicateKeys?: SpreadsheetDuplicateKeyDetail[];
  fanoutImpact?: SpreadsheetJoinFanoutImpact;
  resolution?: SpreadsheetJoinResolution;
  unmatchedLeftRows?: number;
  orphanLeftDollarTotal?: number;
  orphanMetricLabel?: string;
}

/** Formats a [0, 1] join matchRate honestly: never rounds <1 up to 100% or >0 down to 0%. */
export function formatSpreadsheetMatchRate(matchRate: number): string {
  if (!Number.isFinite(matchRate) || matchRate <= 0) return "0%";
  if (matchRate >= 1) return "100%";
  const pct = matchRate * 100;
  const oneDec = Number(pct.toFixed(1));
  if (oneDec >= 100) return "<100%";
  if (oneDec <= 0) return ">0%";
  return Number.isInteger(oneDec) ? `${oneDec}%` : `${oneDec}%`;
}

export interface SpreadsheetSheetPreview {
  sheetName: string;
  tableName: string;
  rowCount: number;
  columns: SpreadsheetColumnProfile[];
  previewRows: string[][];
  suggestedGrain: string;
  suggestedTimeColumn: string | null;
  suggestedPrimaryKey: string | null;
  suggestedPeriod?: { column: string; grain: "month" | "quarter" } | null;
  kind: "fact" | "dimension";
}

export interface SpreadsheetPreview {
  sourceId: string;
  label: string;
  tableName: string;
  sheetName: string;
  rowCount: number;
  columns: SpreadsheetColumnProfile[];
  previewRows: string[][];
  suggestedGrain: string;
  suggestedTimeColumn: string | null;
  suggestedPrimaryKey: string | null;
  suggestedPeriod?: { column: string; grain: "month" | "quarter" } | null;
  /** All sheets in the workbook (1 for CSV, 1..N for multi-sheet .xlsx). */
  sheets?: SpreadsheetSheetPreview[];
  /** Auto-detected cross-sheet foreign-key joins (when workbook has 2+ sheets). */
  detectedJoins?: SpreadsheetDetectedJoin[];
  /** Plain-English summary of automatic messy-spreadsheet cleanups applied. */
  cleaningNotes?: string[];
}

export interface SpreadsheetColumnChoice {
  name: string;
  role: SpreadsheetColumnRole;
  label?: string;
}

export interface SpreadsheetSheetChoice {
  tableName: string;
  grain?: string;
  timeColumn?: string | null;
  reportingLag?: number;
  choices?: SpreadsheetColumnChoice[];
}

export interface ParsedSpreadsheet {
  sheetName: string;
  headers: string[];
  rows: string[][];
  cleaningNotes?: string[];
  unpivotedGrain?: "month" | "quarter";
}

export const SAMPLE_SPREADSHEET_NAME = "Q3_Sales_Performance.csv";
export const SAMPLE_SPREADSHEET_CSV = [
  "Order Date,Order ID,Region,Plan Tier,Sales Rep,Revenue ($),Discount (%),Seats",
  "2026-04-04,ORD-1001,North America,Enterprise,Maya Lin,$18400,5%,42",
  "2026-04-12,ORD-1002,Europe,Growth,Liam Patel,$6200,0%,18",
  "2026-04-19,ORD-1003,North America,Starter,Chloe Park,$1450,0%,6",
  "2026-04-26,ORD-1004,APAC,Enterprise,Noah Kim,$21000,8%,50",
  "2026-05-03,ORD-1005,North America,Enterprise,Maya Lin,$24500,4%,55",
  "2026-05-11,ORD-1006,Europe,Growth,Liam Patel,$7800,2%,22",
  "2026-05-18,ORD-1007,North America,Growth,Chloe Park,$8900,0%,25",
  "2026-05-25,ORD-1008,APAC,Starter,Noah Kim,$1950,0%,8",
  "2026-06-05,ORD-1009,North America,Enterprise,Maya Lin,$29200,3%,68",
  "2026-06-14,ORD-1010,Europe,Enterprise,Liam Patel,$23600,5%,52",
  "2026-06-21,ORD-1011,North America,Growth,Chloe Park,$10400,2%,30",
  "2026-06-28,ORD-1012,APAC,Growth,Noah Kim,$9100,0%,26",
  "2026-07-06,ORD-1013,North America,Enterprise,Maya Lin,$34800,4%,80",
  "2026-07-15,ORD-1014,Europe,Growth,Liam Patel,$11200,3%,31",
  "2026-07-22,ORD-1015,North America,Starter,Chloe Park,$2200,0%,9",
  "2026-07-29,ORD-1016,APAC,Enterprise,Noah Kim,$27400,6%,62",
  "2026-08-04,ORD-1017,North America,Enterprise,Maya Lin,$41500,2%,96",
  "2026-08-12,ORD-1018,Europe,Enterprise,Liam Patel,$28900,4%,64",
  "2026-08-19,ORD-1019,North America,Growth,Chloe Park,$13100,1%,38",
  "2026-08-27,ORD-1020,APAC,Growth,Noah Kim,$11800,0%,34",
].join("\n");

export type SampleWorkbookId = "messy-roastery-pnl" | "roastery-2tab-xlsx" | "grid-renewables";

export interface SampleWorkbookMeta {
  id: SampleWorkbookId;
  badge: string;
  title: string;
  fileName: string;
  format: "csv" | "xlsx";
  preferredSourceId: string;
  defaultLag: number;
  summary: string;
  trapsFixed: string[];
  rawSnippet: string[];
}

export const MESSY_ROASTERY_PNL_CSV = [
  '"BLUEBIRD SPECIALTY ROASTERS — BOARD REVENUE PACK (CONFIDENTIAL)",,,,,,,',
  '"Exported from NetSuite · Unaudited USD","Prepared by FP&A",,,,,,',
  "Region,Cafe Format,Mar 2026,Apr 2026,May 2026,Jun 2026,Jul 2026,Aug 2026",
  "Pacific Northwest,Reserve Roastery Bar,$48200,$51400,$55800,$61200,$68900,$76400",
  "Pacific Northwest,Neighborhood Cafe,$34600,$36100,$38900,$41500,$45200,$49800",
  "Pacific Northwest,Wholesale Grocery,$22400,$24100,#N/A,$27800,$31400,$35600",
  "Northeast,Reserve Roastery Bar,$41800,$44200,$47600,$52900,$59400,$67200",
  "Northeast,Neighborhood Cafe,$29500,$31200,$33800,$36400,$39800,$44100",
  "Midwest,Neighborhood Cafe,$24800,$26400,$28100,$30500,$33200,$36900",
  "Midwest,Wholesale Grocery,$18900,$19800,$21400,#DIV/0!,$25600,$28400",
  "Southwest,Reserve Roastery Bar,$31200,$33900,$37400,$42800,$49600,$56800",
  "Southwest,Neighborhood Cafe,$21600,$23100,$25400,$28900,$33400,$38200",
  "Subtotal: Retail Cafes,,$231700,$246300,$267000,$294200,$329500,$369400",
  "Grand Total,,$273000,$290200,$310400,$322000,$386500,$433400",
].join("\n");

export const GRID_RENEWABLES_CSV = [
  '"U.S. BALANCING AUTHORITIES — MONTHLY RENEWABLES & SPOT PRICE EXPORT",,,,,,,',
  '"Source: EIA-930 Regional Dispatch · Settlement Lag 2 Days",,,,,,,',
  "Dispatch Month,Settlement ID,Grid Region,Weather Regime,Solar Generation (MWh),Wind Generation (MWh),Wholesale Price ($),Curtailment (MWh)",
  "2026-03-01,ISO-2603-ER,ERCOT Texas,Mild Spring,3120000,9840000,$28.40,142000",
  "2026-03-01,ISO-2603-CA,CAISO California,Sunny Mild,4280000,1920000,$31.20,318000",
  "2026-03-01,ISO-2603-PJ,PJM Mid-Atlantic,Late Cold Snap,1180000,3410000,$42.80,24000",
  "2026-03-01,ISO-2603-SP,SPP Plains,High Wind Corridor,640000,8920000,$21.50,196000",
  "2026-04-01,ISO-2604-ER,ERCOT Texas,Spring Wind Peak,3680000,10420000,$26.10,188000",
  "2026-04-01,ISO-2604-CA,CAISO California,Duck Curve Surplus,4890000,2140000,$24.80,412000",
  "2026-04-01,ISO-2604-PJ,PJM Mid-Atlantic,Mild Spring,1540000,3180000,$36.40,19000",
  "2026-04-01,ISO-2604-SP,SPP Plains,High Wind Corridor,790000,9460000,$19.80,234000",
  "2026-05-01,ISO-2605-ER,ERCOT Texas,Early Warmup,4390000,9120000,$34.90,154000",
  "2026-05-01,ISO-2605-CA,CAISO California,Duck Curve Surplus,5420000,2380000,$27.40,448000",
  "2026-05-01,ISO-2605-PJ,PJM Mid-Atlantic,Mild Spring,1920000,2840000,$38.10,#N/A",
  "2026-05-01,ISO-2605-SP,SPP Plains,Storm Fronts,910000,8740000,$25.60,172000",
  "2026-06-01,ISO-2606-ER,ERCOT Texas,Summer Cooling Ramp,5180000,7940000,$52.60,98000",
  "2026-06-01,ISO-2606-CA,CAISO California,Clear Solstice,6120000,2210000,$35.90,326000",
  "2026-06-01,ISO-2606-PJ,PJM Mid-Atlantic,Humid Load,2280000,2310000,$46.20,14000",
  "2026-06-01,ISO-2606-SP,SPP Plains,Summer Cooling Ramp,1080000,7620000,$33.40,118000",
  "2026-07-01,ISO-2607-ER,ERCOT Texas,Heat Dome Peak,5840000,6820000,$78.40,64000",
  "2026-07-01,ISO-2607-CA,CAISO California,Evening Ramp Tight,6480000,1980000,$54.20,214000",
  "2026-07-01,ISO-2607-PJ,PJM Mid-Atlantic,Heat Dome Peak,2460000,1940000,$63.80,11000",
  "2026-07-01,ISO-2607-SP,SPP Plains,Summer Cooling Ramp,1190000,6980000,$44.90,89000",
  "2026-08-01,ISO-2608-ER,ERCOT Texas,Heat Dome Peak,6190000,7150000,$86.20,58000",
  "2026-08-01,ISO-2608-CA,CAISO California,Evening Ramp Tight,6340000,2060000,$58.70,192000",
  "2026-08-01,ISO-2608-PJ,PJM Mid-Atlantic,Humid Load,2390000,2080000,$61.40,12000",
  "2026-08-01,ISO-2608-SP,SPP Plains,Late Summer Calm,1150000,6540000,$48.10,76000",
  "Grand Total,,,,78460000,128020000,$1019.20,3584000",
].join("\n");

export const SAMPLE_WORKBOOKS: SampleWorkbookMeta[] = [
  {
    id: "messy-roastery-pnl",
    badge: "Messy Finance Sheet",
    title: "Coffee Roastery Board P&L",
    fileName: "Bluebird_Roastery_Board_Revenue.csv",
    format: "csv",
    preferredSourceId: "coffee-roastery-pnl",
    defaultLag: 0,
    summary: "NetSuite export with 2 title banners, wide Mar–Aug columns, #DIV/0! errors, and Subtotal/Grand Total rows.",
    trapsFixed: ["2 banner rows skipped", "6 wide months unpivoted", "2 Total rows stripped", "2 #DIV/0! cells scrubbed"],
    rawSnippet: [
      'Row 1: "BLUEBIRD SPECIALTY ROASTERS — BOARD REVENUE PACK (CONFIDENTIAL)"',
      'Row 2: "Exported from NetSuite · Unaudited USD", "Prepared by FP&A"',
      "Row 3: Region | Cafe Format | Mar 2026 | Apr 2026 | May 2026 | Jun 2026 | Jul 2026 | Aug 2026",
      "Row 6: Pacific Northwest | Wholesale Grocery | $22400 | $24100 | #N/A | $27800 | ...",
      "Row 14: Grand Total | | $273000 | $290200 | $310400 | $322000 | $386500 | $433400",
    ],
  },
  {
    id: "roastery-2tab-xlsx",
    badge: "2-Tab .xlsx Auto-Join",
    title: "Specialty Coffee Orders + Stores",
    fileName: "Bluebird_Roastery_2Tab_Workbook.xlsx",
    format: "xlsx",
    preferredSourceId: "coffee-roastery-2tab",
    defaultLag: 0,
    summary: "Real 2-sheet Excel workbook joining 33 POS Cafe Orders to a 5-city Store Directory with a duplicate STR-101 CRM export row.",
    trapsFixed: [
      "Real 2-sheet .xlsx binary",
      "Banner & Grand Total stripped",
      "Duplicate Store ID fan-out caught ($160k)",
      "Auto-joined Store ID (100%)",
    ],
    rawSnippet: [
      'Tab 1 [Cafe Orders] Row 1: "BLUEBIRD POS EXPORT — Q2–Q3 2026 (UNAUDITED)"',
      "Tab 1 [Cafe Orders] Row 2: Order Date | Order ID | Store ID | Drink Category | Net Sales ($) | Cups Sold",
      "Tab 1 [Cafe Orders] Row 36: Grand Total | | | | $528,200 | 85,130",
      "Tab 2 [Store Directory]: Store ID (STR-101..STR-105) | City | Region | Roastery Format",
      "Tab 2 [Store Directory] Row 7: STR-101 | Seattle | Pacific Northwest | Reserve Roastery Bar (duplicate CRM row)",
    ],
  },
  {
    id: "grid-renewables",
    badge: "Energy & Climate",
    title: "U.S. Grid Renewables & Spot Prices",
    fileName: "US_Grid_Renewables_Spot_Prices_2026.csv",
    format: "csv",
    preferredSourceId: "us-grid-renewables",
    defaultLag: 2,
    summary: "ERCOT, CAISO, PJM & SPP solar/wind generation, curtailment, and summer heat-dome wholesale price spikes.",
    trapsFixed: ["2 EIA banner rows skipped", "Grand Total stripped", "#N/A scrubbed", "2-day settlement lag"],
    rawSnippet: [
      'Row 1: "U.S. BALANCING AUTHORITIES — MONTHLY RENEWABLES & SPOT PRICE EXPORT"',
      "Row 3: Dispatch Month | Settlement ID | Grid Region | Weather Regime | Solar (MWh) | Spot Price ($)",
      "Row 15: 2026-05-01 | ISO-2605-PJ | PJM Mid-Atlantic | Mild Spring | 1920000 | #N/A",
      "Row 28: Grand Total | | | | 78460000 | 128020000 | $1019.20 | 3584000",
    ],
  },
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Builds a real, downloadable/uploadable payload for any of the 3 curated sample workbooks. */
export async function buildSampleWorkbookPayload(id: SampleWorkbookId): Promise<{
  meta: SampleWorkbookMeta;
  fileName: string;
  format: "csv" | "xlsx";
  content: string;
}> {
  const meta = SAMPLE_WORKBOOKS.find((w) => w.id === id) ?? SAMPLE_WORKBOOKS[0];
  if (meta.id === "messy-roastery-pnl") {
    return { meta, fileName: meta.fileName, format: "csv", content: MESSY_ROASTERY_PNL_CSV };
  }
  if (meta.id === "grid-renewables") {
    return { meta, fileName: meta.fileName, format: "csv", content: GRID_RENEWABLES_CSV };
  }
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  const s = (value: string) => ({ value, type: String as typeof String });
  const n = (value: number) => ({ value, type: Number as typeof Number });
  const ordersRows: [string, string, string, string, number, number, number][] = [
    // March 2026 (3 orders)
    ["2026-03-01", "POS-301", "STR-101", "Espresso & Milk", 14200, 2680, 2410],
    ["2026-03-15", "POS-302", "STR-103", "Espresso & Milk", 11400, 2190, 1960],
    ["2026-03-28", "POS-303", "STR-104", "Whole Bean Bags", 9600, 520, 3120],
    // April 2026 (4 orders)
    ["2026-04-04", "POS-401", "STR-101", "Espresso & Milk", 15100, 2840, 2560],
    ["2026-04-12", "POS-402", "STR-102", "Cold Brew & Seasonal", 10800, 1960, 1780],
    ["2026-04-19", "POS-403", "STR-104", "Espresso & Milk", 13200, 2480, 2240],
    ["2026-04-27", "POS-404", "STR-105", "Cold Brew & Seasonal", 11900, 2160, 1950],
    // May 2026 (5 orders)
    ["2026-05-03", "POS-501", "STR-101", "Cold Brew & Seasonal", 16800, 3040, 2740],
    ["2026-05-10", "POS-502", "STR-102", "Espresso & Milk", 11600, 2180, 1940],
    ["2026-05-16", "POS-503", "STR-103", "Whole Bean Bags", 10400, 560, 3380],
    ["2026-05-22", "POS-504", "STR-104", "Cold Brew & Seasonal", 14900, 2690, 2420],
    ["2026-05-29", "POS-505", "STR-105", "Cold Brew & Seasonal", 14600, 2640, 2380],
    // June 2026 (6 orders)
    ["2026-06-03", "POS-601", "STR-101", "Cold Brew & Seasonal", 19400, 3510, 3160],
    ["2026-06-08", "POS-602", "STR-102", "Whole Bean Bags", 11800, 640, 3840],
    ["2026-06-14", "POS-603", "STR-103", "Espresso & Milk", 13600, 2560, 2310],
    ["2026-06-19", "POS-604", "STR-104", "Cold Brew & Seasonal", 16200, 2940, 2650],
    ["2026-06-24", "POS-605", "STR-105", "Cold Brew & Seasonal", 17800, 3210, 2890],
    ["2026-06-29", "POS-606", "STR-101", "Whole Bean Bags", 12400, 680, 3960],
    // July 2026 (8 orders — summer cold-brew surge)
    ["2026-07-03", "POS-701", "STR-101", "Cold Brew & Seasonal", 22600, 4080, 3680],
    ["2026-07-07", "POS-702", "STR-102", "Cold Brew & Seasonal", 15900, 2880, 2590],
    ["2026-07-11", "POS-703", "STR-103", "Cold Brew & Seasonal", 14200, 2580, 2320],
    ["2026-07-15", "POS-704", "STR-104", "Cold Brew & Seasonal", 18700, 3380, 3040],
    ["2026-07-19", "POS-705", "STR-105", "Cold Brew & Seasonal", 21400, 3860, 3480],
    ["2026-07-23", "POS-706", "STR-101", "Espresso & Milk", 16400, 3090, 2780],
    ["2026-07-27", "POS-707", "STR-104", "Whole Bean Bags", 13100, 710, 4190],
    ["2026-07-30", "POS-708", "STR-105", "Espresso & Milk", 14800, 2790, 2510],
    // August 2026 (7 orders — late-summer finish)
    ["2026-08-04", "POS-801", "STR-101", "Cold Brew & Seasonal", 26800, 4820, 4340],
    ["2026-08-09", "POS-802", "STR-102", "Cold Brew & Seasonal", 18500, 3340, 3010],
    ["2026-08-14", "POS-803", "STR-103", "Whole Bean Bags", 15900, 860, 5120],
    ["2026-08-19", "POS-804", "STR-104", "Cold Brew & Seasonal", 22900, 4140, 3720],
    ["2026-08-24", "POS-805", "STR-105", "Cold Brew & Seasonal", 25800, 4650, 4190],
    ["2026-08-28", "POS-806", "STR-101", "Whole Bean Bags", 16300, 890, 5210],
    ["2026-08-31", "POS-807", "STR-104", "Espresso & Milk", 19200, 3580, 3220],
  ];
  const blob = await writeXlsxFile([
    {
      sheet: "Cafe Orders",
      data: [
        [s("BLUEBIRD POS EXPORT — Q2–Q3 2026 (UNAUDITED)"), s(""), s(""), s(""), s(""), s(""), s("")],
        [s("Order Date"), s("Order ID"), s("Store ID"), s("Drink Category"), s("Net Sales ($)"), s("Cups Sold"), s("Bean Cost ($)")],
        ...ordersRows.map(([dt, oid, sid, cat, sales, cups, cost]) => [s(dt), s(oid), s(sid), s(cat), n(sales), n(cups), n(cost)]),
        [s("Grand Total"), s(""), s(""), s(""), n(528200), n(85130), n(101090)],
      ],
    },
    {
      sheet: "Store Directory",
      data: [
        [s("Store ID"), s("City"), s("Region"), s("Roastery Format")],
        [s("STR-101"), s("Seattle"), s("Pacific Northwest"), s("Reserve Roastery Bar")],
        [s("STR-102"), s("Portland"), s("Pacific Northwest"), s("Neighborhood Cafe")],
        [s("STR-103"), s("Chicago"), s("Midwest"), s("Neighborhood Cafe")],
        [s("STR-104"), s("Brooklyn"), s("Northeast"), s("Reserve Roastery Bar")],
        [s("STR-105"), s("Austin"), s("Southwest"), s("Cold Brew Taproom")],
        [s("STR-101"), s("Seattle"), s("Pacific Northwest"), s("Reserve Roastery Bar")],
      ],
    },
  ]).toBlob();
  return {
    meta,
    fileName: meta.fileName,
    format: "xlsx",
    content: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  };
}
