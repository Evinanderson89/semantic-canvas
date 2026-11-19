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
}

export interface SpreadsheetColumnChoice {
  name: string;
  role: SpreadsheetColumnRole;
  label?: string;
}

export interface ParsedSpreadsheet {
  sheetName: string;
  headers: string[];
  rows: string[][];
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
