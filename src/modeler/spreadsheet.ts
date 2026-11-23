import { existsSync } from "node:fs";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { fansOut, type JoinCardinality, type Metric, type Model } from "../semantic/model.ts";
import type { Proposal, ProposedMetric } from "./propose.ts";
import {
  formatSpreadsheetMatchRate,
  SAMPLE_SPREADSHEET_CSV,
  SAMPLE_SPREADSHEET_NAME,
  type ParsedSpreadsheet,
  type SpreadsheetColumnChoice,
  type SpreadsheetColumnProfile,
  type SpreadsheetColumnRole,
  type SpreadsheetDetectedJoin,
  type SpreadsheetDuplicateKeyDetail,
  type SpreadsheetFormatHint,
  type SpreadsheetJoinFanoutImpact,
  type SpreadsheetJoinResolution,
  type SpreadsheetPreview,
  type SpreadsheetSheetChoice,
  type SpreadsheetSheetPreview,
  type SpreadsheetValueType,
} from "./spreadsheetTypes.ts";

export {
  formatSpreadsheetMatchRate,
  SAMPLE_SPREADSHEET_CSV,
  SAMPLE_SPREADSHEET_NAME,
  type ParsedSpreadsheet,
  type SpreadsheetColumnChoice,
  type SpreadsheetColumnProfile,
  type SpreadsheetColumnRole,
  type SpreadsheetDetectedJoin,
  type SpreadsheetDuplicateKeyDetail,
  type SpreadsheetFormatHint,
  type SpreadsheetJoinFanoutImpact,
  type SpreadsheetJoinResolution,
  type SpreadsheetPreview,
  type SpreadsheetSheetChoice,
  type SpreadsheetSheetPreview,
  type SpreadsheetValueType,
};

const MAX_ROWS = 25_000;
const MAX_COLS = 100;
const MAX_ZIP_ENTRY_BYTES = 12 * 1024 * 1024;

export function slugifySourceId(name: string): string {
  const base = name.replace(/\.(csv|tsv|xlsx|xls)$/i, "");
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 36);
  return cleaned.length >= 2 ? cleaned : "sheet-data";
}

export function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[%$€£]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!cleaned) return fallback;
  return /^[a-z_]/.test(cleaned) ? cleaned : `c_${cleaned}`;
}

export function friendlyLabel(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (cleaned) return cleaned.slice(0, 120);
  return "Column";
}

function detectDelimiter(sampleText: string): "," | "\t" | ";" {
  const lines = sampleText.split(/\r?\n/).slice(0, 10);
  let bestDelim: "," | "\t" | ";" = ",";
  let bestScore = 0;
  for (const line of lines) {
    let commas = 0, tabs = 0, semis = 0, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes) {
        if (ch === ",") commas++;
        else if (ch === "\t") tabs++;
        else if (ch === ";") semis++;
      }
    }
    const top = Math.max(commas, tabs, semis);
    if (top > bestScore) {
      bestScore = top;
      bestDelim = tabs > commas && tabs >= semis ? "\t" : semis > commas && semis > tabs ? ";" : ",";
    }
  }
  return bestDelim;
}

const EXCEL_ERROR_RE = /^#(N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!|SPILL!|CALC!)$/i;
const SUMMARY_ROW_LABEL_RE = /^(grand\s+total|sub\s*-?\s*total|total|totals|net\s+total|ytd\s+total|overall\s+total)(\s*[:\-–—].*)?$/i;
const MONTH_MAP: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

/** Parses wide spreadsheet period headers like "Jan 2026", "2026-03", "Q2 2026", "Mar-26" into YYYY-MM-DD. */
export function parseWidePeriodHeader(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return normalizeDateValue(s);
  if (/^\d{4}-\d{2}$/.test(s)) return normalizeDateValue(s);
  const slashYm = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashYm) {
    const m = Number(slashYm[1]), y = Number(slashYm[2]);
    if (m >= 1 && m <= 12 && y >= 1990 && y <= 2100) return `${y}-${String(m).padStart(2, "0")}-01`;
  }
  const m1 = s.match(/^([A-Za-z]{3,9})[\s\-_'/]+(\d{2}|\d{4})$/);
  if (m1) {
    const mon = MONTH_MAP[m1[1].toLowerCase()];
    if (mon) {
      const yr = m1[2].length === 2 ? 2000 + Number(m1[2]) : Number(m1[2]);
      if (yr >= 1990 && yr <= 2100) return `${yr}-${mon}-01`;
    }
  }
  const q1 = s.match(/^(?:Q([1-4])[\s\-_'/]+(\d{2}|\d{4})|(\d{4})[\s\-_]*Q([1-4]))$/i);
  if (q1) {
    const q = Number(q1[1] ?? q1[4]);
    const rawYr = q1[2] ?? q1[3];
    const yr = rawYr.length === 2 ? 2000 + Number(rawYr) : Number(rawYr);
    if (yr >= 1990 && yr <= 2100) {
      const mon = String((q - 1) * 3 + 1).padStart(2, "0");
      return `${yr}-${mon}-01`;
    }
  }
  return null;
}

function inferWideValueHeader(sheetName: string): string {
  const lower = sheetName.toLowerCase();
  if (/rev|mrr|arr/.test(lower)) return "Revenue ($)";
  if (/sale/.test(lower)) return "Sales ($)";
  if (/cost|spend|expense/.test(lower)) return "Spend ($)";
  if (/headcount|employee|seat/.test(lower)) return "Seats";
  return "Value";
}

/**
 * Cleans real-world "messy corporate spreadsheets":
 * 1. Scrubs Excel formula errors (#N/A, #DIV/0!, etc.) to empty cells so numeric columns stay numeric.
 * 2. Skips leading title/banner/metadata rows (when rows 1..N have <=2 cells above a real >=3-col header row).
 * 3. Strips Total / Subtotal / Grand Total summary rows so SUM() never double-counts.
 * 4. Auto-unpivots wide month/quarter columns (e.g. Region | Jan 2026 | Feb 2026 | Mar 2026) into tidy time-series rows.
 */
export function cleanTabularGrid(sheetName: string, rawRecords: string[][], maxCols = MAX_COLS): ParsedSpreadsheet {
  const cleaningNotes: string[] = [];
  let scrubbedErrors = 0;

  const cleanedRecords = rawRecords
    .map((r) =>
      r.slice(0, maxCols).map((cell) => {
        const t = (cell ?? "").trim();
        if (EXCEL_ERROR_RE.test(t) || /^N\/A$/i.test(t)) {
          scrubbedErrors++;
          return "";
        }
        return t;
      }),
    )
    .filter((r) => r.some((c) => c !== ""));

  if (cleanedRecords.length < 2) {
    throw Object.assign(new Error("Spreadsheet must include a header row and at least one data row."), { status: 400 });
  }

  // 1. Detect leading banner/title rows above the true table header.
  const countNonEmpty = (r: string[]) => r.filter((c) => c !== "").length;
  const looksLikeHeaderRow = (r: string[]) => {
    const nonEmpty = r.filter((c) => c !== "");
    if (nonEmpty.length < 3) return false;
    // Headers should be mostly text labels or wide period headers, not raw standalone numbers.
    const validHeaderCells = nonEmpty.filter((c) => parseWidePeriodHeader(c) !== null || parseNumericValue(c) === null);
    return validHeaderCells.length / nonEmpty.length >= 0.8 && new Set(nonEmpty.map((x) => x.toLowerCase())).size >= nonEmpty.length - 1;
  };

  let headerIdx = 0;
  if (countNonEmpty(cleanedRecords[0]) <= 2) {
    const maxScan = Math.min(8, cleanedRecords.length - 2);
    for (let k = 1; k <= maxScan; k++) {
      const candidateCols = countNonEmpty(cleanedRecords[k]);
      const nextRowCols = countNonEmpty(cleanedRecords[k + 1] ?? []);
      if (
        candidateCols >= Math.max(3, countNonEmpty(cleanedRecords[0]) + 2) &&
        looksLikeHeaderRow(cleanedRecords[k]) &&
        nextRowCols >= Math.max(2, candidateCols - 2)
      ) {
        headerIdx = k;
        break;
      }
    }
  }
  if (headerIdx > 0) {
    cleaningNotes.push(`Skipped ${headerIdx} leading title/banner row${headerIdx === 1 ? "" : "s"}`);
  }

  const width = Math.min(
    maxCols,
    Math.max(...cleanedRecords.slice(headerIdx, headerIdx + 25).map((r) => r.length)),
  );
  let headers = Array.from({ length: width }, (_, i) => cleanedRecords[headerIdx][i] || `Column ${i + 1}`);
  let rows = cleanedRecords
    .slice(headerIdx + 1, headerIdx + 1 + MAX_ROWS)
    .map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));

  // 2. Strip Total / Subtotal / Grand Total summary rows so aggregations never double-count.
  let droppedTotals = 0;
  const filteredRows = rows.filter((r) => {
    const firstText = r.find((c) => c !== "" && parseNumericValue(c) === null) ?? "";
    const hasNumeric = r.some((c) => parseNumericValue(c) !== null);
    if (hasNumeric && SUMMARY_ROW_LABEL_RE.test(firstText.trim())) {
      droppedTotals++;
      return false;
    }
    return true;
  });
  if (filteredRows.length >= 1 && droppedTotals > 0) {
    rows = filteredRows;
    cleaningNotes.push(`Excluded ${droppedTotals} Total/Subtotal summary row${droppedTotals === 1 ? "" : "s"} to prevent double-counting`);
  }

  if (scrubbedErrors > 0) {
    cleaningNotes.push(`Cleaned ${scrubbedErrors} formula error cell${scrubbedErrors === 1 ? "" : "s"} (#N/A, #DIV/0!)`);
  }

  // 3. Auto-unpivot wide period columns (e.g. Region | Segment | Jan 2026 | Feb 2026 | Mar 2026).
  const periodByCol = headers.map((h) => parseWidePeriodHeader(h));
  const periodIndices = periodByCol.map((iso, idx) => (iso ? idx : -1)).filter((idx) => idx >= 0);
  const dimIndices = periodByCol.map((iso, idx) => (iso ? -1 : idx)).filter((idx) => idx >= 0);
  const existingDateCol = dimIndices.some((idx) => {
    const nonEmpty = rows.slice(0, 30).map((r) => r[idx]).filter(Boolean);
    return nonEmpty.length > 0 && nonEmpty.filter((v) => normalizeDateValue(v) !== null).length / nonEmpty.length >= 0.8;
  });

  if (periodIndices.length >= 3 && dimIndices.length >= 1 && !existingDateCol) {
    const unpivotedRows: string[][] = [];
    for (const r of rows) {
      const dimVals = dimIndices.map((idx) => r[idx] ?? "");
      for (const pIdx of periodIndices) {
        const cellVal = (r[pIdx] ?? "").trim();
        if (cellVal === "") continue;
        unpivotedRows.push([...dimVals, periodByCol[pIdx]!, cellVal]);
        if (unpivotedRows.length >= MAX_ROWS) break;
      }
      if (unpivotedRows.length >= MAX_ROWS) break;
    }
    if (unpivotedRows.length >= 2) {
      headers = [...dimIndices.map((idx) => headers[idx]), "Period Date", inferWideValueHeader(sheetName)];
      rows = unpivotedRows;
      cleaningNotes.push(`Unpivoted ${periodIndices.length} wide period columns into tidy time-series rows`);
    }
  }

  if (rows.length === 0) {
    throw Object.assign(new Error("Spreadsheet must include at least one non-summary data row."), { status: 400 });
  }

  return { sheetName, headers, rows, ...(cleaningNotes.length ? { cleaningNotes } : {}) };
}

export function parseCsv(rawText: string, sheetName = "Sheet1"): ParsedSpreadsheet {
  const text = rawText.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.some((cell) => cell !== "")) {
        records.push(row);
        if (records.length > MAX_ROWS + 12) break;
      }
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((cell) => cell !== "") && records.length <= MAX_ROWS + 12) {
    records.push(row);
  }

  return cleanTabularGrid(sheetName, records, MAX_COLS);
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate End of Central Directory signature (0x06054b50) from the tail.
  let eocd = -1;
  const minOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let i = bytes.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw Object.assign(new Error("Invalid .xlsx file: ZIP directory header not found."), { status: 400 });
  }
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const files = new Map<string, Uint8Array>();

  let pos = centralOffset;
  for (let i = 0; i < totalEntries && pos + 46 <= bytes.byteLength; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name.startsWith("xl/") || name.endsWith("/")) continue;
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw Object.assign(new Error("Spreadsheet worksheet exceeds the 12 MB safety limit."), { status: 413 });
    }
    if (localHeaderOffset + 30 > bytes.byteLength) continue;
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      files.set(name, slice);
    } else if (method === 8) {
      const inflated = inflateRawSync(slice, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      files.set(name, new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength));
    }
  }
  return files;
}

function columnRefToIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, "").toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function excelSerialToIsoDate(serial: number): string {
  // Excel epoch is 1899-12-30 (accounting for Excel's 1900 leap-year bug).
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  return Number.isFinite(+d) ? d.toISOString().slice(0, 10) : String(serial);
}

function extractDateStyleIndices(stylesXml: string): Set<number> {
  const builtinDateFmtIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const customDateFmtIds = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]+)"/g)) {
    const id = Number(m[1]);
    const code = m[2].toLowerCase().replace(/"[^"]*"/g, "");
    if (/[ymd]/.test(code) && !/^[0#.,%$]+$/.test(code)) customDateFmtIds.add(id);
  }
  const dateStyleIndices = new Set<number>();
  const xfsMatch = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return dateStyleIndices;
  let idx = 0;
  for (const xf of xfsMatch[1].matchAll(/<xf\b[^>]*>/g)) {
    const numFmtMatch = xf[0].match(/numFmtId="(\d+)"/);
    const numFmtId = numFmtMatch ? Number(numFmtMatch[1]) : 0;
    if (builtinDateFmtIds.has(numFmtId) || customDateFmtIds.has(numFmtId)) {
      dateStyleIndices.add(idx);
    }
    idx++;
  }
  return dateStyleIndices;
}

function parseWorksheetXml(
  sheetXml: string,
  sheetName: string,
  sharedStrings: string[],
  dateStyleIndices: Set<number>,
): ParsedSpreadsheet | null {
  const rawRows: string[][] = [];
  let maxCol = 0;
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowValues: string[] = [];
    let autoCol = 0;
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const refMatch = attrs.match(/\br="([A-Za-z]+\d+)"/);
      const colIdx = refMatch ? columnRefToIndex(refMatch[1]) : autoCol;
      autoCol = colIdx + 1;
      if (colIdx >= MAX_COLS) continue;

      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const styleMatch = attrs.match(/\bs="(\d+)"/);
      const type = typeMatch?.[1] ?? "n";
      const styleIdx = styleMatch ? Number(styleMatch[1]) : -1;

      let val = "";
      if (type === "inlineStr") {
        const parts = [...body.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
        val = parts.join("");
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : "";
        if (type === "s") {
          val = sharedStrings[Number(rawVal)] ?? "";
        } else if (type === "b") {
          val = rawVal === "1" ? "true" : "false";
        } else if (type === "n" && rawVal !== "" && dateStyleIndices.has(styleIdx)) {
          const serial = Number(rawVal);
          val = Number.isFinite(serial) && serial > 20_000 && serial < 80_000 ? excelSerialToIsoDate(serial) : rawVal;
        } else {
          val = rawVal;
        }
      }
      rowValues[colIdx] = val.trim();
      if (colIdx + 1 > maxCol) maxCol = colIdx + 1;
    }
    if (rowValues.some((v) => v !== undefined && v !== "")) {
      rawRows.push(rowValues);
      if (rawRows.length > MAX_ROWS + 12) break;
    }
  }

  if (rawRows.length < 2 || maxCol === 0) return null;
  try {
    return cleanTabularGrid(sheetName, rawRows, Math.min(maxCol, MAX_COLS));
  } catch {
    return null;
  }
}

export function parseXlsxWorkbook(bytes: Uint8Array): ParsedSpreadsheet[] {
  const entries = readZipEntries(bytes);
  const decoder = new TextDecoder("utf-8");

  const sharedStrings: string[] = [];
  const ssBytes = entries.get("xl/sharedStrings.xml");
  if (ssBytes) {
    const ssXml = decoder.decode(ssBytes);
    for (const si of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts: string[] = [];
      for (const t of si[1].matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)) {
        parts.push(decodeXmlEntities(t[1]));
      }
      sharedStrings.push(parts.join(""));
    }
  }

  const stylesXml = entries.get("xl/styles.xml") ? decoder.decode(entries.get("xl/styles.xml")) : "";
  const dateStyleIndices = stylesXml ? extractDateStyleIndices(stylesXml) : new Set<number>();

  const relsXml = entries.get("xl/_rels/workbook.xml.rels")
    ? decoder.decode(entries.get("xl/_rels/workbook.xml.rels"))
    : "";
  const relTargets = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = rel[0].match(/\bId="([^"]+)"/)?.[1];
    const target = rel[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) {
      const normalized = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
      relTargets.set(id, normalized);
    }
  }

  const workbookXml = entries.get("xl/workbook.xml") ? decoder.decode(entries.get("xl/workbook.xml")) : "";
  const sheetRefs: { name: string; path: string }[] = [];
  let sheetIndex = 1;
  for (const s of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXmlEntities(s[0].match(/\bname="([^"]+)"/)?.[1] ?? `Sheet${sheetIndex}`);
    const rid = s[0].match(/\br:id="([^"]+)"/)?.[1];
    const path = (rid && relTargets.get(rid)) || `xl/worksheets/sheet${sheetIndex}.xml`;
    sheetRefs.push({ name, path });
    sheetIndex++;
  }

  if (sheetRefs.length === 0) {
    for (const [k] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) {
        sheetRefs.push({ name: `Sheet${sheetRefs.length + 1}`, path: k });
      }
    }
  }

  const parsedSheets: ParsedSpreadsheet[] = [];
  for (const ref of sheetRefs.slice(0, 8)) {
    const bytesForSheet = entries.get(ref.path);
    if (!bytesForSheet) continue;
    const sheet = parseWorksheetXml(decoder.decode(bytesForSheet), ref.name, sharedStrings, dateStyleIndices);
    if (sheet) parsedSheets.push(sheet);
  }

  if (parsedSheets.length === 0) {
    throw Object.assign(new Error("Excel workbook must include at least one worksheet with a header row and data rows."), { status: 400 });
  }
  return parsedSheets;
}

export function parseXlsxBuffer(bytes: Uint8Array): ParsedSpreadsheet {
  return parseXlsxWorkbook(bytes)[0];
}

export function normalizeDateValue(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(s)) {
    const iso = s.slice(0, 10);
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === iso ? iso : null;
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const iso = `${s}-01`;
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(+d) ? iso : null;
  }
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const m = Number(slash[1]), day = Number(slash[2]), y = Number(slash[3]);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const d = new Date(`${iso}T00:00:00Z`);
      return Number.isFinite(+d) ? iso : null;
    }
  }
  return null;
}

export function parseNumericValue(raw: string): { value: number; isCurrency: boolean; isPercent: boolean; isInt: boolean } | null {
  const s = raw.trim();
  if (!s) return null;
  const isCurrency = /^[-+]?[$€£]|^\([$€£]/.test(s);
  const isPercent = /%$/.test(s);
  let normalized = s.replace(/[$€£,\s%]/g, "");
  if (/^\(.+\)$/.test(normalized)) normalized = `-${normalized.slice(1, -1)}`;
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const value = isPercent ? n / 100 : n;
  return { value, isCurrency, isPercent, isInt: !isPercent && !isCurrency && Number.isInteger(n) && !normalized.includes(".") };
}

/**
 * Canonicalizes a spreadsheet cell using the exact same coercion rules as sqlLiteral()
 * so "$1,001", "1,001", and "1001.0" collapse to the same numeric key "1001",
 * dates normalize to YYYY-MM-DD, and blanks become null.
 */
export function canonicalizeSpreadsheetValue(raw: string, sqlType: SpreadsheetValueType): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (sqlType === "DATE") {
    return normalizeDateValue(trimmed);
  }
  if (sqlType === "BIGINT") {
    const num = parseNumericValue(trimmed);
    if (!num) return null;
    const rounded = Math.round(num.value);
    return String(rounded === 0 ? 0 : rounded);
  }
  if (sqlType === "DOUBLE") {
    const num = parseNumericValue(trimmed);
    if (!num) return null;
    return String(num.value === 0 ? 0 : num.value);
  }
  return trimmed;
}

const ID_COLUMN_NAME_RE = /(^|_)(id|key|code|uuid)$|^(order|invoice|ticket|txn|transaction)(?:_(?:num|number|no))?$|^sku$/;
const CURRENCY_HINT_RE = /\$|usd|eur|rev|mrr|arr|sales|spend|cost|price|amount|profit|budget/i;

function isAvgLikeMetricName(colName: string, formatHint: SpreadsheetFormatHint): boolean {
  return formatHint === "percent" || /rate|avg|average|ratio|price|margin|discount|score/.test(colName);
}

function roundTwo(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

export function formatImpactAmount(value: number, isCurrency: boolean): string {
  const rounded = roundTwo(value);
  const abs = Math.abs(rounded);
  const formatted = Number.isInteger(abs)
    ? abs.toLocaleString("en-US")
    : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = rounded < 0 ? "-" : "";
  return isCurrency ? `${sign}$${formatted}` : `${sign}${formatted}`;
}

export function formatJoinDedupeNote(opts: {
  rightSheetName: string;
  rightColumnLabel: string;
  join: Pick<SpreadsheetDetectedJoin, "duplicateRightRows" | "duplicateKeys" | "fanoutImpact" | "allExactDuplicates">;
  isCurrency?: boolean;
  onRefresh?: boolean;
}): string {
  const count = opts.join.duplicateRightRows ?? opts.join.duplicateKeys?.length ?? 1;
  const keys = (opts.join.duplicateKeys ?? []).map((d) => d.key);
  const keySummary =
    keys.length === 0
      ? ""
      : keys.length <= 2
        ? ` (${keys.join(", ")})`
        : ` (${keys.slice(0, 2).join(", ")}, +${keys.length - 2} more)`;
  const conflictSuffix = opts.join.allExactDuplicates === false ? ", kept first row" : "";
  const refreshSuffix = opts.onRefresh ? " on refresh" : "";
  const impact = opts.join.fanoutImpact;
  const currency =
    opts.isCurrency ??
    (impact ? CURRENCY_HINT_RE.test(`${impact.metricLabel} ${impact.metricColumn}`) : false);
  if (impact && impact.delta > 0) {
    const before = formatImpactAmount(impact.trueTotal, currency);
    const after = formatImpactAmount(impact.inflatedTotal, currency);
    return `${opts.rightSheetName}: Deduplicated ${count} duplicate ${opts.rightColumnLabel} row${count === 1 ? "" : "s"}${keySummary}${conflictSuffix}${refreshSuffix} — prevented ${before} → ${after} ${impact.metricLabel} double-count`;
  }
  return `${opts.rightSheetName}: Deduplicated ${count} duplicate ${opts.rightColumnLabel} row${count === 1 ? "" : "s"}${keySummary}${conflictSuffix}${refreshSuffix} to preserve unique lookup keys`;
}

export function formatDuplicateJoinErrorMessage(joins: SpreadsheetDetectedJoin[]): string {
  const first = joins[0];
  if (!first) return "Duplicate right-side join keys detected.";
  const sampleKey = first.duplicateKeys?.[0]?.key ?? "duplicate ID";
  const sampleRows = first.duplicateKeys?.[0]?.rightRows ?? 2;
  const impact = first.fanoutImpact;
  if (impact && impact.delta > 0) {
    const isCurrency = CURRENCY_HINT_RE.test(`${impact.metricLabel} ${impact.metricColumn}`);
    const trueStr = formatImpactAmount(impact.trueTotal, isCurrency);
    const infStr = formatImpactAmount(impact.inflatedTotal, isCurrency);
    const deltaStr = formatImpactAmount(impact.delta, isCurrency);
    return `Duplicate key ${sampleKey} in ${first.rightTable}.${first.rightColumn} (${sampleRows} rows) would inflate ${impact.metricLabel} from ${trueStr} to ${infStr} (+${deltaStr} double-count).`;
  }
  return `Duplicate key ${sampleKey} in ${first.rightTable}.${first.rightColumn} (${sampleRows} rows) violates many-to-one join uniqueness.`;
}

export function profileSpreadsheet(fileName: string, parsed: ParsedSpreadsheet): SpreadsheetPreview {
  const sourceId = slugifySourceId(fileName);
  const tableName = sanitizeIdentifier(fileName.replace(/\.(csv|tsv|xlsx|xls)$/i, ""), "sheet_rows");
  const label = friendlyLabel(fileName.replace(/\.(csv|tsv|xlsx|xls)$/i, "").replace(/[_-]+/g, " "));

  const usedNames = new Set<string>();
  const columns: SpreadsheetColumnProfile[] = parsed.headers.map((header, idx) => {
    let name = sanitizeIdentifier(header, `col_${idx + 1}`);
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    usedNames.add(name);

    const nonEmpty = parsed.rows.map((r) => (r[idx] ?? "").trim()).filter(Boolean);
    const sampleCheck = nonEmpty.slice(0, 200);

    let dateHits = 0, numHits = 0, intHits = 0, currencyHits = 0, percentHits = 0;
    for (const v of sampleCheck) {
      if (normalizeDateValue(v)) dateHits++;
      const num = parseNumericValue(v);
      if (num) {
        numHits++;
        if (num.isInt) intHits++;
        if (num.isCurrency) currencyHits++;
        if (num.isPercent) percentHits++;
      }
    }

    const total = sampleCheck.length;
    const isDate = total > 0 && dateHits / total >= 0.8;
    const isNum = !isDate && total > 0 && numHits / total >= 0.85;
    const headerLower = header.toLowerCase();
    const isCurrency = isNum && (currencyHits / total >= 0.3 || CURRENCY_HINT_RE.test(headerLower));
    const isPercent = isNum && (percentHits / total >= 0.3 || /%|rate|pct|percent|margin|ratio|discount|churn|retention/.test(headerLower));
    const isIdNamed = ID_COLUMN_NAME_RE.test(name);
    const looksLikeYear = isNum && intHits === numHits && /^(year|yr|fiscal_year)$/.test(name);

    let sqlType: SpreadsheetValueType = "VARCHAR";
    if (isDate) {
      sqlType = "DATE";
    } else if (isIdNamed) {
      // Numeric ID columns (e.g. "$1,001" / "1001" / "1001.0") use numeric SQL types when all non-empty values parse numerically,
      // so DuckDB and canonical key checks coerce formatted numeric IDs identically. Alphanumeric IDs ("ORD-1001") stay VARCHAR.
      const parsedNums = nonEmpty.length > 0 ? nonEmpty.map((v) => parseNumericValue(v)) : [];
      if (parsedNums.length > 0 && parsedNums.every((n) => n !== null && !n.isPercent)) {
        const allIntegerValues = parsedNums.every((n) => Number.isInteger(n!.value));
        sqlType = allIntegerValues ? "BIGINT" : "DOUBLE";
      } else {
        sqlType = "VARCHAR";
      }
    } else if (isNum && !looksLikeYear) {
      sqlType = !isCurrency && !isPercent && intHits === numHits ? "BIGINT" : "DOUBLE";
    }

    const canonicalVals = parsed.rows
      .map((r) => canonicalizeSpreadsheetValue(r[idx] ?? "", sqlType))
      .filter((v): v is string => v !== null);
    const canonicalUniqueCount = new Set(canonicalVals).size;
    // Strict 100% non-empty canonical uniqueness across all rows is required for primaryKey / "id" role.
    const strictlyUniqueId =
      isIdNamed &&
      parsed.rows.length > 0 &&
      canonicalVals.length === parsed.rows.length &&
      canonicalUniqueCount === parsed.rows.length;

    let formatHint: SpreadsheetFormatHint = "text";
    let role: SpreadsheetColumnRole = "category";

    if (isDate) {
      formatHint = "date";
      role = "date";
    } else if (strictlyUniqueId) {
      formatHint = "text";
      role = "id";
    } else if (isIdNamed) {
      formatHint = "text";
      role = "category";
    } else if (isNum && !looksLikeYear) {
      formatHint = isCurrency ? "currency" : isPercent ? "percent" : "number";
      role = "metric";
    }

    return {
      name,
      originalHeader: header,
      label: friendlyLabel(header.replace(/\s*\([$€£%]\)\s*$/g, "")),
      sqlType,
      formatHint,
      role,
      uniqueCount: canonicalUniqueCount,
      nonEmptyCount: canonicalVals.length,
      samples: nonEmpty.slice(0, 3),
    };
  });

  const dateCol = columns.find((c) => c.role === "date")?.name ?? null;
  const idCol =
    columns.find(
      (c) =>
        c.role === "id" &&
        parsed.rows.length > 0 &&
        c.nonEmptyCount === parsed.rows.length &&
        c.uniqueCount === parsed.rows.length,
    )?.name ?? null;
  const nameHint = `${fileName} ${columns.map((c) => c.name).join(" ")}`.toLowerCase();
  const suggestedGrain = /order|invoice|sale|deal|txn|transaction/.test(nameHint)
    ? "One sale or order"
    : /customer|account|user|client|subscriber/.test(nameHint)
      ? "One customer or account"
      : /month|monthly|summary|budget|forecast/.test(nameHint)
        ? "One monthly summary"
        : "One row per record";

  return {
    sourceId,
    label,
    tableName,
    sheetName: parsed.sheetName,
    rowCount: parsed.rows.length,
    columns,
    previewRows: parsed.rows.slice(0, 5),
    suggestedGrain,
    suggestedTimeColumn: dateCol,
    suggestedPrimaryKey: idCol,
    ...(parsed.cleaningNotes?.length ? { cleaningNotes: parsed.cleaningNotes } : {}),
  };
}

function singularWord(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if ((w.endsWith("ses") || w.endsWith("xes")) && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

function tableMatchesKeyStem(tableName: string, keyColName: string): boolean {
  const rawStem = keyColName.replace(/_?(id|key|code|uuid)$/i, "").toLowerCase();
  if (!rawStem) return false;
  const stem = singularWord(rawStem);
  const tableLower = tableName.toLowerCase();
  if (singularWord(tableLower) === stem) return true;
  const tokens = tableLower.split(/_+/).filter(Boolean).map(singularWord);
  return tokens.includes(stem);
}

function resolveJoinKeyType(leftType: SpreadsheetValueType, rightType: SpreadsheetValueType): SpreadsheetValueType | null {
  if (leftType === rightType) return rightType;
  const leftNum = leftType === "BIGINT" || leftType === "DOUBLE";
  const rightNum = rightType === "BIGINT" || rightType === "DOUBLE";
  if (leftNum && rightNum) {
    return leftType === "DOUBLE" || rightType === "DOUBLE" ? "DOUBLE" : "BIGINT";
  }
  return null;
}

function pickPrimaryAdditiveMetricColumn(
  columns: SpreadsheetColumnProfile[],
): { col: SpreadsheetColumnProfile; idx: number } | null {
  const candidates = columns
    .map((col, idx) => ({ col, idx }))
    .filter(({ col }) => col.role === "metric" && (col.sqlType === "DOUBLE" || col.sqlType === "BIGINT"));
  if (candidates.length === 0) return null;
  const additive = candidates.filter(({ col }) => !isAvgLikeMetricName(col.name, col.formatHint));
  const pool = additive.length > 0 ? additive : candidates;
  return pool.find(({ col }) => col.formatHint === "currency") ?? pool[0];
}

export function evaluateSheetJoinPair(
  left: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] },
  lIdx: number,
  right: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] },
  rIdx: number,
): SpreadsheetDetectedJoin | null {
  const lCol = left.columns[lIdx];
  const rCol = right.columns[rIdx];
  if (!lCol || !rCol) return null;
  const effectiveKeyType = resolveJoinKeyType(lCol.sqlType, rCol.sqlType);
  if (!effectiveKeyType) return null;
  if (left.rows.length === 0 || right.rows.length === 0) return null;

  const rowsByKey = new Map<string, number[]>();
  for (let ri = 0; ri < right.rows.length; ri++) {
    const k = canonicalizeSpreadsheetValue(right.rows[ri]?.[rIdx] ?? "", effectiveKeyType);
    if (k === null) continue;
    const existing = rowsByKey.get(k);
    if (existing) existing.push(ri);
    else rowsByKey.set(k, [ri]);
  }
  if (rowsByKey.size === 0) return null;

  const leftTotalRows = left.rows.length;
  let matched = 0;
  const leftHitsByKey = new Map<string, number>();
  for (let li = 0; li < leftTotalRows; li++) {
    const lk = canonicalizeSpreadsheetValue(left.rows[li]?.[lIdx] ?? "", effectiveKeyType);
    if (lk !== null && rowsByKey.has(lk)) {
      matched++;
      leftHitsByKey.set(lk, (leftHitsByKey.get(lk) ?? 0) + 1);
    }
  }
  if (matched === 0) return null;

  const unmatchedLeftRows = leftTotalRows - matched;
  let matchRate: number;
  if (matched === leftTotalRows) {
    matchRate = 1;
  } else {
    const rawRate = matched / leftTotalRows;
    const rounded4 = Number(rawRate.toFixed(4));
    matchRate = Math.min(0.9999, Math.max(0.0001, rounded4 >= 1 ? 0.9999 : rounded4));
  }

  const dupEntries = [...rowsByKey.entries()].filter(([, idxs]) => idxs.length > 1);
  if (dupEntries.length === 0) {
    return {
      leftTable: left.tableName,
      leftColumn: lCol.name,
      rightTable: right.tableName,
      rightColumn: rCol.name,
      matchRate,
      include: matchRate >= 0.5,
      rightKeyUnique: true,
      ...(unmatchedLeftRows > 0 ? { unmatchedLeftRows } : {}),
    };
  }

  const allDupDetails: (SpreadsheetDuplicateKeyDetail & { leftHits: number })[] = dupEntries.map(([key, idxs]) => {
    const conflictingColumns: string[] = [];
    for (let ci = 0; ci < right.columns.length; ci++) {
      if (ci === rIdx) continue;
      const distinctVals = new Set(
        idxs.map((ri) => canonicalizeSpreadsheetValue(right.rows[ri]?.[ci] ?? "", right.columns[ci].sqlType) ?? ""),
      );
      if (distinctVals.size > 1) {
        conflictingColumns.push(right.columns[ci].name);
      }
    }
    return {
      key,
      rightRows: idxs.length,
      rowNumbers: idxs.map((ri) => ri + 1),
      exactDuplicate: conflictingColumns.length === 0,
      conflictingColumns,
      leftHits: leftHitsByKey.get(key) ?? 0,
    };
  });

  allDupDetails.sort(
    (a, b) =>
      (b.leftHits > 0 ? 1 : 0) - (a.leftHits > 0 ? 1 : 0) ||
      b.rightRows - a.rightRows ||
      a.rowNumbers[0] - b.rowNumbers[0],
  );

  const allExactDuplicates = allDupDetails.every((d) => d.exactDuplicate);
  const duplicateKeyCount = allDupDetails.length;
  const duplicateRightRows = allDupDetails.reduce((sum, d) => sum + (d.rightRows - 1), 0);
  const duplicateKeys: SpreadsheetDuplicateKeyDetail[] = allDupDetails.slice(0, 5).map(({ leftHits: _lh, ...rest }) => rest);

  let fanoutImpact: SpreadsheetJoinFanoutImpact | undefined;
  const metricTarget = pickPrimaryAdditiveMetricColumn(left.columns);
  if (metricTarget) {
    let trueTotal = 0;
    let inflatedTotal = 0;
    for (let li = 0; li < leftTotalRows; li++) {
      const val = parseNumericValue(left.rows[li]?.[metricTarget.idx] ?? "")?.value ?? 0;
      const lk = canonicalizeSpreadsheetValue(left.rows[li]?.[lIdx] ?? "", effectiveKeyType);
      const mult = lk !== null ? Math.max(1, rowsByKey.get(lk)?.length ?? 0) : 1;
      trueTotal += val;
      inflatedTotal += val * mult;
    }
    const cleanTrue = roundTwo(trueTotal);
    const cleanInflated = roundTwo(inflatedTotal);
    const cleanDelta = roundTwo(cleanInflated - cleanTrue);
    const multiplier = cleanTrue !== 0 ? Math.round((cleanInflated / cleanTrue) * 1000) / 1000 : 1;
    fanoutImpact = {
      metricColumn: metricTarget.col.name,
      metricLabel: metricTarget.col.label,
      trueTotal: cleanTrue,
      inflatedTotal: cleanInflated,
      delta: cleanDelta,
      multiplier,
    };
  }

  const resolution: SpreadsheetJoinResolution = allExactDuplicates ? "deduplicate" : "exclude";
  const include = allExactDuplicates ? matchRate >= 0.5 : false;

  return {
    leftTable: left.tableName,
    leftColumn: lCol.name,
    rightTable: right.tableName,
    rightColumn: rCol.name,
    matchRate,
    include,
    rightKeyUnique: false,
    duplicateKeyCount,
    duplicateRightRows,
    allExactDuplicates,
    duplicateKeys,
    ...(fanoutImpact ? { fanoutImpact } : {}),
    resolution,
    ...(unmatchedLeftRows > 0 ? { unmatchedLeftRows } : {}),
  };
}

function scoreJoinDirection(
  left: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] },
  lCol: SpreadsheetColumnProfile,
  right: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] },
  rCol: SpreadsheetColumnProfile,
  rightKeyUnique: boolean,
  leftKeyUnique: boolean,
): number {
  let score = 0;
  const rightOwnsKey =
    (rCol.name === "id" && (lCol.name === `${right.tableName}_id` || lCol.name === `${singularWord(right.tableName)}_id`)) ||
    tableMatchesKeyStem(right.tableName, rCol.name);
  const leftOwnsKey =
    (lCol.name === "id" && (rCol.name === `${left.tableName}_id` || rCol.name === `${singularWord(left.tableName)}_id`)) ||
    tableMatchesKeyStem(left.tableName, lCol.name);

  if (rightOwnsKey && !leftOwnsKey) score += 50;
  else if (leftOwnsKey && !rightOwnsKey) score -= 50;

  const leftHasMetrics = pickPrimaryAdditiveMetricColumn(left.columns) !== null;
  const rightHasMetrics = pickPrimaryAdditiveMetricColumn(right.columns) !== null;
  if (leftHasMetrics && !rightHasMetrics) score += 35;
  else if (rightHasMetrics && !leftHasMetrics) score -= 35;

  const leftHasDate = left.columns.some((c) => c.role === "date");
  const rightHasDate = right.columns.some((c) => c.role === "date");
  if (leftHasDate && !rightHasDate) score += 15;
  else if (rightHasDate && !leftHasDate) score -= 15;

  const leftHasDistinctPk = left.columns.some((c) => c.role === "id" && c.name !== lCol.name);
  const rightHasDistinctPk = right.columns.some((c) => c.role === "id" && c.name !== rCol.name);
  if (leftHasDistinctPk && !rightHasDistinctPk) score += 20;
  else if (rightHasDistinctPk && !leftHasDistinctPk) score -= 20;

  if (rightKeyUnique && !leftKeyUnique) score += 10;
  else if (leftKeyUnique && !rightKeyUnique) score -= 10;

  if (left.rows.length > right.rows.length) score += 5;
  else if (right.rows.length > left.rows.length) score -= 5;

  return score;
}

export function detectSheetJoins(
  sheets: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] }[],
): SpreadsheetDetectedJoin[] {
  const bestByPair = new Map<string, { join: SpreadsheetDetectedJoin; dirScore: number; order: number }>();
  let order = 0;

  for (let li = 0; li < sheets.length; li++) {
    for (let ri = 0; ri < sheets.length; ri++) {
      if (li === ri) continue;
      const left = sheets[li];
      const right = sheets[ri];
      const rightKeyCols = right.columns
        .map((c, idx) => ({ col: c, idx }))
        .filter(({ col }) => col.nonEmptyCount > 0 && (col.role === "id" || /(^|_)id$|_code$|_key$/.test(col.name)));

      for (const { col: rCol, idx: rIdx } of rightKeyCols) {
        for (let lIdx = 0; lIdx < left.columns.length; lIdx++) {
          const lCol = left.columns[lIdx];
          if (!resolveJoinKeyType(lCol.sqlType, rCol.sqlType)) continue;
          const exactNameMatch = lCol.name === rCol.name;
          const fkNameMatch =
            rCol.name === "id" &&
            (lCol.name === `${right.tableName}_id` || lCol.name === `${singularWord(right.tableName)}_id`);
          if (!exactNameMatch && !fkNameMatch) continue;

          const evaluated = evaluateSheetJoinPair(left, lIdx, right, rIdx);
          if (!evaluated || evaluated.matchRate < 0.25) continue;

          const leftKeyUnique =
            left.rows.length > 0 &&
            lCol.nonEmptyCount === left.rows.length &&
            lCol.uniqueCount === left.rows.length;
          const dirScore = scoreJoinDirection(left, lCol, right, rCol, evaluated.rightKeyUnique, leftKeyUnique);
          // Skip clearly inverted lookup -> fact candidate when reverse direction is strongly preferred.
          if (dirScore < 0 && leftKeyUnique && !evaluated.rightKeyUnique && pickPrimaryAdditiveMetricColumn(right.columns) !== null) {
            continue;
          }

          const pairKey = [left.tableName, right.tableName].sort().join("::");
          const prev = bestByPair.get(pairKey);
          const curOrder = order++;
          if (
            !prev ||
            dirScore > prev.dirScore ||
            (dirScore === prev.dirScore && evaluated.matchRate > prev.join.matchRate) ||
            (dirScore === prev.dirScore && evaluated.matchRate === prev.join.matchRate && curOrder < prev.order)
          ) {
            bestByPair.set(pairKey, { join: evaluated, dirScore, order: curOrder });
          }
        }
      }
    }
  }

  return [...bestByPair.values()]
    .map((entry) => entry.join)
    .sort((a, b) => b.matchRate - a.matchRate);
}

export function deduplicateSheetRowsOnKey(
  rows: string[][],
  keyColIdx: number,
  keySqlType: SpreadsheetValueType,
): { rows: string[][]; removedCount: number } {
  const seen = new Set<string>();
  const kept: string[][] = [];
  for (const r of rows) {
    const k = canonicalizeSpreadsheetValue(r[keyColIdx] ?? "", keySqlType);
    if (k === null) {
      kept.push(r);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(r);
  }
  return { rows: kept, removedCount: rows.length - kept.length };
}

export function profileWorkbook(fileName: string, parsedSheets: ParsedSpreadsheet[]): SpreadsheetPreview {
  if (parsedSheets.length === 1) {
    const single = profileSpreadsheet(fileName, parsedSheets[0]);
    const sheetEntry: SpreadsheetSheetPreview = {
      sheetName: single.sheetName,
      tableName: single.tableName,
      rowCount: single.rowCount,
      columns: single.columns,
      previewRows: single.previewRows,
      suggestedGrain: single.suggestedGrain,
      suggestedTimeColumn: single.suggestedTimeColumn,
      suggestedPrimaryKey: single.suggestedPrimaryKey,
      kind: "fact",
    };
    return { ...single, sheets: [sheetEntry], detectedJoins: [] };
  }

  const sourceId = slugifySourceId(fileName);
  const label = friendlyLabel(fileName.replace(/\.(csv|tsv|xlsx|xls)$/i, "").replace(/[_-]+/g, " "));
  const usedTableNames = new Set<string>();

  const profiled = parsedSheets.map((sheet, idx) => {
    const base = profileSpreadsheet(`${sheet.sheetName}.csv`, sheet);
    let tableName = sanitizeIdentifier(sheet.sheetName, `sheet_${idx + 1}`);
    if (usedTableNames.has(tableName)) {
      let s = 2;
      while (usedTableNames.has(`${tableName}_${s}`)) s++;
      tableName = `${tableName}_${s}`;
    }
    usedTableNames.add(tableName);
    return { ...base, tableName, rows: sheet.rows };
  });

  const detectedJoins = detectSheetJoins(
    profiled.map((p) => ({ tableName: p.tableName, columns: p.columns, rows: p.rows })),
  );
  const rightSideTargets = new Set(
    detectedJoins
      .filter((j) => {
        if (j.include) return true;
        const targetSheet = profiled.find((p) => p.tableName === j.rightTable);
        return targetSheet ? pickPrimaryAdditiveMetricColumn(targetSheet.columns) === null : false;
      })
      .map((j) => j.rightTable),
  );

  const sheets: SpreadsheetSheetPreview[] = profiled.map((p) => ({
    sheetName: p.sheetName,
    tableName: p.tableName,
    rowCount: p.rowCount,
    columns: p.columns,
    previewRows: p.previewRows,
    suggestedGrain: p.suggestedGrain,
    suggestedTimeColumn: p.suggestedTimeColumn,
    suggestedPrimaryKey: p.suggestedPrimaryKey,
    kind: rightSideTargets.has(p.tableName) ? "dimension" : "fact",
  }));

  const allCleaningNotes = parsedSheets.flatMap((s) =>
    (s.cleaningNotes ?? []).map((n) => (parsedSheets.length > 1 ? `${s.sheetName}: ${n}` : n)),
  );
  for (const j of detectedJoins) {
    if (!j.rightKeyUnique && j.include && j.resolution === "deduplicate") {
      const rightSheet = profiled.find((p) => p.tableName === j.rightTable);
      const rightCol = rightSheet?.columns.find((c) => c.name === j.rightColumn);
      const leftSheet = profiled.find((p) => p.tableName === j.leftTable);
      const metricCol = leftSheet?.columns.find((c) => c.name === j.fanoutImpact?.metricColumn);
      if (rightSheet && rightCol) {
        allCleaningNotes.push(
          formatJoinDedupeNote({
            rightSheetName: rightSheet.sheetName,
            rightColumnLabel: rightCol.originalHeader || rightCol.label || rightCol.name,
            join: j,
            isCurrency: metricCol ? metricCol.formatHint === "currency" : undefined,
          }),
        );
      }
    }
  }

  const primary = sheets.find((s) => s.kind === "fact") ?? sheets[0];
  return {
    sourceId,
    label,
    tableName: primary.tableName,
    sheetName: primary.sheetName,
    rowCount: primary.rowCount,
    columns: primary.columns,
    previewRows: primary.previewRows,
    suggestedGrain: primary.suggestedGrain,
    suggestedTimeColumn: primary.suggestedTimeColumn,
    suggestedPrimaryKey: primary.suggestedPrimaryKey,
    sheets,
    detectedJoins,
    ...(allCleaningNotes.length ? { cleaningNotes: allCleaningNotes } : {}),
  };
}

export type SpreadsheetProposalJoin = Proposal["joins"][number] & {
  cardinality?: JoinCardinality;
};

export type SpreadsheetProposedMetric = ProposedMetric & {
  importance?: number;
  unit?: Metric["unit"];
};

export interface SpreadsheetProposal extends Omit<Proposal, "joins" | "metrics"> {
  joins: SpreadsheetProposalJoin[];
  metrics: SpreadsheetProposedMetric[];
  hygieneNotes?: string[];
}

export type RequestedSpreadsheetJoin = Pick<
  SpreadsheetDetectedJoin,
  "leftTable" | "leftColumn" | "rightTable" | "rightColumn" | "matchRate" | "include"
> & {
  resolution?: SpreadsheetJoinResolution;
  cardinality?: JoinCardinality;
};

/**
 * Server-side validation & preparation for multi-sheet workbook import:
 * Recomputes canonical right-key uniqueness directly from parsedSheets (never trusting client flags),
 * applies requested deduplication, marks 1:N joins with cardinality: "one_to_many", or rejects
 * unsafe many_to_one joins with duplicate keys before any Parquet or YAML is written.
 */
export function prepareWorkbookImport(opts: {
  parsedSheets: ParsedSpreadsheet[];
  preview: SpreadsheetPreview;
  joins?: RequestedSpreadsheetJoin[];
}):
  | {
      ok: true;
      sheets: SpreadsheetSheetPreview[];
      sheetRows: string[][][];
      joins: (SpreadsheetDetectedJoin & { cardinality?: JoinCardinality })[];
      hygieneNotes: string[];
    }
  | {
      ok: false;
      message: string;
      duplicateJoins: SpreadsheetDetectedJoin[];
    } {
  const baseSheets = (opts.preview.sheets ?? []).map((s) => ({
    ...s,
    columns: s.columns.map((c) => ({ ...c })),
  }));
  const sheetRows = opts.parsedSheets.map((ps) => ps.rows.map((r) => [...r]));
  const baseHygieneNotes = opts.parsedSheets.flatMap((s) =>
    (s.cleaningNotes ?? []).map((n) => (opts.parsedSheets.length > 1 ? `${s.sheetName}: ${n}` : n)),
  );
  const hygieneNotes = [...baseHygieneNotes];

  const rawJoins: RequestedSpreadsheetJoin[] = opts.joins ?? opts.preview.detectedJoins ?? [];
  const resolvedJoins: (SpreadsheetDetectedJoin & { cardinality?: JoinCardinality })[] = [];
  const duplicateJoins: SpreadsheetDetectedJoin[] = [];

  for (const reqJoin of rawJoins) {
    // Skip joins explicitly excluded by include === false (or resolution === "exclude" unless include was forced true without resolution)
    if (!reqJoin.include) continue;
    if (reqJoin.resolution === "exclude" && opts.joins === undefined) continue;

    const lSheetIdx = baseSheets.findIndex((s) => s.tableName === reqJoin.leftTable);
    const rSheetIdx = baseSheets.findIndex((s) => s.tableName === reqJoin.rightTable);
    if (lSheetIdx < 0 || rSheetIdx < 0) continue;

    const lSheet = baseSheets[lSheetIdx];
    const rSheet = baseSheets[rSheetIdx];
    const lColIdx = lSheet.columns.findIndex((c) => c.name === reqJoin.leftColumn);
    const rColIdx = rSheet.columns.findIndex((c) => c.name === reqJoin.rightColumn);
    if (lColIdx < 0 || rColIdx < 0) continue;

    const evaluated = evaluateSheetJoinPair(
      { tableName: lSheet.tableName, columns: lSheet.columns, rows: sheetRows[lSheetIdx] },
      lColIdx,
      { tableName: rSheet.tableName, columns: rSheet.columns, rows: sheetRows[rSheetIdx] },
      rColIdx,
    );
    if (!evaluated) continue;

    if (evaluated.rightKeyUnique) {
      resolvedJoins.push({ ...evaluated, include: true, cardinality: reqJoin.cardinality ?? "many_to_one" });
      continue;
    }

    const wantsOneToMany =
      reqJoin.resolution === "one_to_many" ||
      reqJoin.cardinality === "one_to_many" ||
      reqJoin.cardinality === "many_to_many";
    if (wantsOneToMany) {
      const card: JoinCardinality = reqJoin.cardinality === "many_to_many" ? "many_to_many" : "one_to_many";
      resolvedJoins.push({
        ...evaluated,
        include: true,
        resolution: "one_to_many",
        cardinality: card,
      });
      hygieneNotes.push(
        `${rSheet.sheetName}: Joined ${lSheet.tableName}.${lSheet.columns[lColIdx].name} → ${rSheet.tableName}.${rSheet.columns[rColIdx].name} as ${card} (fan-out sums blocked)`,
      );
      continue;
    }

    if (reqJoin.resolution === "deduplicate") {
      const keyType =
        resolveJoinKeyType(lSheet.columns[lColIdx].sqlType, rSheet.columns[rColIdx].sqlType) ??
        rSheet.columns[rColIdx].sqlType;
      const deduped = deduplicateSheetRowsOnKey(sheetRows[rSheetIdx], rColIdx, keyType);
      sheetRows[rSheetIdx] = deduped.rows;
      rSheet.rowCount = deduped.rows.length;
      rSheet.previewRows = deduped.rows.slice(0, 5);
      // Refresh canonical counts & primaryKey on deduplicated sheet
      for (let ci = 0; ci < rSheet.columns.length; ci++) {
        const col = rSheet.columns[ci];
        const cVals = deduped.rows
          .map((r) => canonicalizeSpreadsheetValue(r[ci] ?? "", col.sqlType))
          .filter((v): v is string => v !== null);
        col.nonEmptyCount = cVals.length;
        col.uniqueCount = new Set(cVals).size;
        if (ci === rColIdx && deduped.rows.length > 0 && col.nonEmptyCount === deduped.rows.length && col.uniqueCount === deduped.rows.length) {
          col.role = "id";
        }
      }
      rSheet.suggestedPrimaryKey =
        rSheet.columns.find(
          (c) => c.role === "id" && rSheet.rowCount > 0 && c.nonEmptyCount === rSheet.rowCount && c.uniqueCount === rSheet.rowCount,
        )?.name ?? rSheet.suggestedPrimaryKey;

      const metricCol = lSheet.columns.find((c) => c.name === evaluated.fanoutImpact?.metricColumn);
      hygieneNotes.push(
        formatJoinDedupeNote({
          rightSheetName: rSheet.sheetName,
          rightColumnLabel: rSheet.columns[rColIdx].originalHeader || rSheet.columns[rColIdx].label || rSheet.columns[rColIdx].name,
          join: evaluated,
          isCurrency: metricCol ? metricCol.formatHint === "currency" : undefined,
        }),
      );

      const postCheck = evaluateSheetJoinPair(
        { tableName: lSheet.tableName, columns: lSheet.columns, rows: sheetRows[lSheetIdx] },
        lColIdx,
        { tableName: rSheet.tableName, columns: rSheet.columns, rows: sheetRows[rSheetIdx] },
        rColIdx,
      );
      resolvedJoins.push({
        ...(postCheck ?? evaluated),
        rightKeyUnique: true,
        include: true,
        resolution: "deduplicate",
        cardinality: "many_to_one",
      });
      continue;
    }

    duplicateJoins.push(evaluated);
  }

  if (duplicateJoins.length > 0) {
    return {
      ok: false,
      message: formatDuplicateJoinErrorMessage(duplicateJoins),
      duplicateJoins,
    };
  }

  return {
    ok: true,
    sheets: baseSheets,
    sheetRows,
    joins: resolvedJoins,
    hygieneNotes,
  };
}

export function buildWorkbookProposal(opts: {
  sourceId: string;
  label: string;
  sheets: SpreadsheetSheetPreview[];
  sheetChoices?: SpreadsheetSheetChoice[];
  joins?: (SpreadsheetDetectedJoin & { cardinality?: JoinCardinality })[];
  primaryGrain?: string;
  primaryTimeColumn?: string | null;
  primaryReportingLag?: number;
  primaryChoices?: SpreadsheetColumnChoice[];
  hygieneNotes?: string[];
}): SpreadsheetProposal {
  if (opts.sheets.length <= 1) {
    const only = opts.sheets[0];
    return buildSpreadsheetProposal({
      sourceId: opts.sourceId,
      label: opts.label,
      tableName: only.tableName,
      rowCount: only.rowCount,
      grain: opts.primaryGrain ?? only.suggestedGrain,
      timeColumn: opts.primaryTimeColumn !== undefined ? opts.primaryTimeColumn : only.suggestedTimeColumn,
      reportingLag: opts.primaryReportingLag,
      columns: only.columns,
      choices: opts.primaryChoices,
      hygieneNotes: opts.hygieneNotes,
    });
  }

  const choiceByTable = new Map((opts.sheetChoices ?? []).map((c) => [c.tableName, c]));
  const allTables: Proposal["tables"] = [];
  const allMetrics: SpreadsheetProposedMetric[] = [];
  const usedMetricNames = new Set<string>();
  const primaryTable = opts.sheets.find((s) => s.kind === "fact")?.tableName ?? opts.sheets[0].tableName;
  const activeJoins = (opts.joins ?? []).filter((j) => j.include && j.resolution !== "exclude");
  const oneToManyRightTables = new Set(
    activeJoins
      .filter((j) => j.resolution === "one_to_many" || j.cardinality === "one_to_many" || j.cardinality === "many_to_many")
      .map((j) => j.rightTable),
  );

  for (const sheet of opts.sheets) {
    const isPrimary = sheet.tableName === primaryTable;
    const sc = choiceByTable.get(sheet.tableName);
    const single = buildSpreadsheetProposal({
      sourceId: opts.sourceId,
      label: sheet.sheetName,
      tableName: sheet.tableName,
      rowCount: sheet.rowCount,
      grain: sc?.grain ?? (isPrimary ? opts.primaryGrain : undefined) ?? sheet.suggestedGrain,
      timeColumn: sc?.timeColumn !== undefined ? sc.timeColumn : isPrimary && opts.primaryTimeColumn !== undefined ? opts.primaryTimeColumn : sheet.suggestedTimeColumn,
      reportingLag: sc?.reportingLag ?? (isPrimary ? opts.primaryReportingLag : undefined),
      columns: sheet.columns,
      choices: sc?.choices ?? (isPrimary ? opts.primaryChoices : undefined),
    });
    const tbl = { ...single.tables[0], kind: sheet.kind };
    allTables.push(tbl);

    // Emit metrics primarily for fact sheets (and 1:N detail sheets), plus record count for dimensions if unique name.
    for (const m of single.metrics) {
      if (sheet.kind === "dimension" && !oneToManyRightTables.has(sheet.tableName) && m.expression.startsWith("SUM(")) continue;
      let name = m.name;
      if (usedMetricNames.has(name)) name = `${sheet.tableName}_${m.name}`;
      usedMetricNames.add(name);
      allMetrics.push({ ...m, name });
    }
  }

  const joins: SpreadsheetProposalJoin[] = activeJoins.map((j) => {
    const cardinality: JoinCardinality =
      j.cardinality ??
      (j.resolution === "one_to_many" ? "one_to_many" : "many_to_one");
    const rateLabel = formatSpreadsheetMatchRate(j.matchRate);
    return {
      left: j.leftTable,
      leftOn: j.leftColumn,
      right: j.rightTable,
      rightOn: j.rightColumn,
      type: "left",
      cardinality,
      include: true,
      evidence:
        cardinality === "one_to_many" || cardinality === "many_to_many"
          ? `Cross-sheet ${cardinality} relationship (${rateLabel} of left rows matched; fan-out aggregates blocked).`
          : `Auto-detected cross-sheet key match (${rateLabel} of rows matched; unique lookup key verified).`,
      resolution: j.matchRate,
    };
  });

  const totalRows = opts.sheets.reduce((sum, s) => sum + s.rowCount, 0);
  const hygieneNotes = opts.hygieneNotes?.filter((n) => n.trim().length > 0);
  return {
    model: {
      name: opts.label,
      description: `Governed multi-sheet semantic model created from workbook "${opts.label}" (${opts.sheets.length} sheets, ${totalRows.toLocaleString()} total rows).`,
    },
    tables: allTables,
    joins,
    metrics: allMetrics,
    warnings: [],
    ...(hygieneNotes?.length ? { hygieneNotes } : {}),
  };
}

export function buildSpreadsheetProposal(opts: {
  sourceId: string;
  label: string;
  tableName: string;
  rowCount: number;
  grain: string;
  timeColumn: string | null;
  reportingLag?: number;
  columns: SpreadsheetColumnProfile[];
  choices?: SpreadsheetColumnChoice[];
  hygieneNotes?: string[];
}): SpreadsheetProposal {
  const choiceByName = new Map((opts.choices ?? []).map((c) => [c.name, c]));
  const resolvedColumns = opts.columns.map((c) => {
    const choice = choiceByName.get(c.name);
    return {
      ...c,
      role: choice?.role ?? c.role,
      label: choice?.label?.trim() || c.label,
    };
  });

  const primaryKey =
    resolvedColumns.find(
      (c) =>
        c.role === "id" &&
        opts.rowCount > 0 &&
        c.nonEmptyCount === opts.rowCount &&
        c.uniqueCount === opts.rowCount,
    )?.name ?? null;
  const timeColumn =
    opts.timeColumn && resolvedColumns.some((c) => c.name === opts.timeColumn && c.sqlType === "DATE")
      ? opts.timeColumn
      : resolvedColumns.find((c) => c.role === "date" && c.sqlType === "DATE")?.name ?? null;

  const metrics: SpreadsheetProposedMetric[] = [];
  const usedMetricNames = new Set<string>();

  for (const col of resolvedColumns) {
    if (col.role !== "metric" || (col.sqlType !== "DOUBLE" && col.sqlType !== "BIGINT")) continue;
    let metricName = sanitizeIdentifier(col.name, "metric");
    if (usedMetricNames.has(metricName)) metricName = `${metricName}_total`;
    usedMetricNames.add(metricName);

    const isAvg = isAvgLikeMetricName(col.name, col.formatHint);
    const expr = isAvg ? `AVG(${col.name})` : `SUM(${col.name})`;
    const hay = `${col.name} ${col.label} ${col.originalHeader}`.toLowerCase();
    const isCostLike = /cost|expense|spend|cogs|opex|capex|fee|loss|curtailment/.test(hay) && !/rev|sales|income|profit|mrr|arr/.test(hay);
    const isRevenueLike =
      !isCostLike &&
      (col.formatHint === "currency" || /rev|sales|mrr|arr|gmv|income|profit|bookings|amount|pnl/.test(hay));
    const importance = isAvg ? 60 : isCostLike ? 75 : isRevenueLike ? 100 : 85;
    const unit: Metric["unit"] =
      col.formatHint === "currency"
        ? "currency"
        : col.formatHint === "percent"
          ? "percent"
          : undefined;
    const unitNote = col.formatHint === "currency" ? " (currency)" : col.formatHint === "percent" ? " (percentage)" : "";
    const formattedLabel =
      col.formatHint === "percent" && !/\b(rate|pct|percent|margin|ratio|retention|conversion|share)\b/i.test(col.label)
        ? `${col.label} rate`
        : col.formatHint === "currency" && !/\$|usd|revenue|sales|mrr|arr|cost|spend|price|profit|budget/i.test(col.label)
          ? `${col.label} (USD)`
          : col.label;
    metrics.push({
      name: metricName,
      label: formattedLabel,
      baseTable: opts.tableName,
      expression: expr,
      ...(unit ? { unit } : {}),
      importance,
      description: `${isAvg ? "Average" : "Total"} ${col.label}${unitNote} from ${opts.label}.`,
      include: true,
      evidence: `Spreadsheet numeric column "${col.originalHeader}" (${col.sqlType}) confirmed as metric.`,
    });
  }

  const rowCountName = usedMetricNames.has("record_count") ? "total_records" : "record_count";
  const grainLower = opts.grain.toLowerCase();
  const countLabel = !primaryKey
    ? "Total rows"
    : /order|sale|invoice|deal/.test(grainLower)
      ? "Total orders"
      : /customer|account|client|user|subscriber/.test(grainLower)
        ? "Total customers"
        : /ticket|event|session/.test(grainLower)
          ? "Total events"
          : /month|period|summary/.test(grainLower)
            ? "Total periods"
            : "Total records";
  metrics.push({
    name: rowCountName,
    label: countLabel,
    baseTable: opts.tableName,
    expression: primaryKey ? `COUNT(DISTINCT ${primaryKey})` : "COUNT(*)",
    importance: 15,
    description: `Count of records in ${opts.label} (${opts.grain}).`,
    include: true,
    evidence: primaryKey ? `Distinct count of confirmed ID column ${primaryKey}.` : `Row count across ${opts.rowCount} imported spreadsheet rows.`,
  });

  const hygieneNotes = opts.hygieneNotes?.filter((n) => n.trim().length > 0);
  return {
    model: {
      name: opts.label,
      description: `Governed semantic model created from spreadsheet "${opts.label}" (${opts.rowCount.toLocaleString()} rows).`,
    },
    tables: [
      {
        name: opts.tableName,
        include: true,
        kind: "fact",
        grain: opts.grain.trim() || "One row per record",
        evidence: `Imported spreadsheet (${opts.rowCount.toLocaleString()} rows, ${resolvedColumns.length} columns).`,
        primaryKey,
        description: `${opts.label} spreadsheet table (${opts.grain.trim() || "one row per record"}).`,
        synonyms: [opts.label.toLowerCase(), opts.tableName],
        timeColumn,
        ...(opts.reportingLag && opts.reportingLag > 0 ? { reportingLag: opts.reportingLag } : {}),
        columns: resolvedColumns.map((c) => ({
          name: c.name,
          type: c.sqlType,
          description: `${c.label}${c.formatHint !== "text" ? ` (${c.formatHint})` : ""}`,
        })),
        rows: opts.rowCount,
      },
    ],
    joins: [],
    metrics,
    warnings: [],
    ...(hygieneNotes?.length ? { hygieneNotes } : {}),
  };
}

function sqlLiteral(raw: string, sqlType: SpreadsheetValueType): string {
  const trimmed = raw.trim();
  if (!trimmed) return "NULL";
  if (sqlType === "DATE") {
    const iso = normalizeDateValue(trimmed);
    return iso ? `DATE '${iso}'` : "NULL";
  }
  if (sqlType === "DOUBLE" || sqlType === "BIGINT") {
    const num = parseNumericValue(trimmed);
    if (!num) return "NULL";
    return sqlType === "BIGINT" ? String(Math.round(num.value)) : String(num.value);
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

export async function writeSpreadsheetParquet(
  lakeRoot: string,
  tableName: string,
  columns: SpreadsheetColumnProfile[],
  rows: string[][],
): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw Object.assign(new Error(`Invalid table name "${tableName}"`), { status: 400 });
  }
  const tableDir = resolve(lakeRoot, tableName);
  await mkdir(tableDir, { recursive: true, mode: 0o700 });
  const parquetPath = resolve(tableDir, "part-0.parquet");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const colDefs = columns.map((c) => `"${c.name.replace(/"/g, '""')}" ${c.sqlType}`).join(", ");
    await conn.run(`CREATE TABLE "${tableName}" (${colDefs})`);
    const batchSize = 400;
    for (let i = 0; i < rows.length; i += batchSize) {
      const slice = rows.slice(i, i + batchSize);
      const valuesSql = slice
        .map((r) => `(${columns.map((c, ci) => sqlLiteral(r[ci] ?? "", c.sqlType)).join(", ")})`)
        .join(", ");
      await conn.run(`INSERT INTO "${tableName}" VALUES ${valuesSql}`);
    }
    const escapedPath = parquetPath.replace(/'/g, "''");
    await conn.run(`COPY "${tableName}" TO '${escapedPath}' (FORMAT PARQUET)`);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  return parquetPath;
}

/**
 * Validates staged refreshed Parquet files alongside un-refreshed live Parquet files in DuckDB:
 * checks every many_to_one / one_to_one join rightOn key and declared primaryKey across existing.model,
 * computes exact DuckDB SQL fan-out dollar impact, and optionally deduplicates staged right keys.
 */
export async function validateSpreadsheetRefreshInDuckDb(opts: {
  model: Model;
  lakeRoot: string;
  stagingRoot: string;
  stagedTables: Set<string>;
  deduplicateKeys?: boolean;
  sheetNamesByTable?: Map<string, string>;
}): Promise<
  | {
      ok: true;
      rowCountsByTable: Map<string, number>;
      dedupeNotes: string[];
    }
  | {
      ok: false;
      message: string;
      duplicateJoins: SpreadsheetDetectedJoin[];
      canDeduplicate: boolean;
    }
> {
  const qId = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const qLit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parquetFor = (table: string) =>
    opts.stagedTables.has(table)
      ? resolve(opts.stagingRoot, table, "part-0.parquet")
      : resolve(opts.lakeRoot, table, "part-0.parquet");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const availableTables = new Set<string>();
    const tableColumns = new Map<string, string[]>();

    for (const tableName of Object.keys(opts.model.tables)) {
      const p = parquetFor(tableName);
      if (!existsSync(p)) continue;
      await conn.run(`CREATE OR REPLACE VIEW ${qId(tableName)} AS SELECT * FROM read_parquet(${qLit(p)})`);
      const desc = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${qId(tableName)}`);
      const cols = desc.getRows().map((r) => String(r[0]));
      tableColumns.set(tableName, cols);
      availableTables.add(tableName);
    }

    type CheckItem = {
      left: string;
      leftOn: string;
      right: string;
      rightOn: string;
      isSelfPrimaryKey: boolean;
    };
    const checks: CheckItem[] = [];
    const seenRightKeys = new Set<string>();

    for (const j of opts.model.joins) {
      if (fansOut(j)) continue;
      if (!availableTables.has(j.left) || !availableTables.has(j.right)) continue;
      checks.push({
        left: j.left,
        leftOn: j.leftOn,
        right: j.right,
        rightOn: j.rightOn,
        isSelfPrimaryKey: false,
      });
      seenRightKeys.add(`${j.right}::${j.rightOn}`);
    }

    for (const [tableName, tbl] of Object.entries(opts.model.tables)) {
      if (!tbl.primaryKey || !opts.stagedTables.has(tableName) || !availableTables.has(tableName)) continue;
      if (seenRightKeys.has(`${tableName}::${tbl.primaryKey}`)) continue;
      checks.push({
        left: tableName,
        leftOn: tbl.primaryKey,
        right: tableName,
        rightOn: tbl.primaryKey,
        isSelfPrimaryKey: true,
      });
      seenRightKeys.add(`${tableName}::${tbl.primaryKey}`);
    }

    const duplicateJoins: SpreadsheetDetectedJoin[] = [];

    for (const chk of checks) {
      const rCols = tableColumns.get(chk.right) ?? [];
      const lCols = tableColumns.get(chk.left) ?? [];
      if (!rCols.includes(chk.rightOn)) {
        throw Object.assign(
          new Error(`Refreshed sheet "${chk.right}" is missing required key column "${chk.rightOn}".`),
          { status: 400 },
        );
      }
      if (!lCols.includes(chk.leftOn)) {
        throw Object.assign(
          new Error(`Refreshed sheet "${chk.left}" is missing required foreign-key column "${chk.leftOn}".`),
          { status: 400 },
        );
      }

      const dupReader = await conn.runAndReadAll(
        `SELECT CAST(${qId(chk.rightOn)} AS VARCHAR) AS k, COUNT(*) AS cnt
         FROM ${qId(chk.right)}
         WHERE ${qId(chk.rightOn)} IS NOT NULL
         GROUP BY ${qId(chk.rightOn)}
         HAVING COUNT(*) > 1
         ORDER BY cnt DESC, k ASC`,
      );
      const dupRows = dupReader.getRows();
      if (dupRows.length === 0) continue;

      const duplicateKeyCount = dupRows.length;
      const duplicateRightRows = dupRows.reduce((sum, r) => sum + (Number(r[1]) - 1), 0);

      // Compute matchRate from left -> distinct right keys
      const matchReader = await conn.runAndReadAll(
        `SELECT COUNT(*) AS left_total, COUNT(__r.__rk) AS matched
         FROM ${qId(chk.left)} AS __l
         LEFT JOIN (SELECT DISTINCT ${qId(chk.rightOn)} AS __rk FROM ${qId(chk.right)} WHERE ${qId(chk.rightOn)} IS NOT NULL) AS __r
           ON __l.${qId(chk.leftOn)} = __r.__rk`,
      );
      const mRow = matchReader.getRows()[0] ?? [0, 0];
      const leftTotal = Number(mRow[0] ?? 0);
      const matched = Number(mRow[1] ?? 0);
      const unmatchedLeftRows = Math.max(0, leftTotal - matched);
      const matchRate =
        leftTotal === 0
          ? 0
          : matched === leftTotal
            ? 1
            : Math.min(0.9999, Math.max(0.0001, Number((matched / leftTotal).toFixed(4)) >= 1 ? 0.9999 : Number((matched / leftTotal).toFixed(4))));

      // Inspect rows for duplicate keys (with 1-based data row numbers) to identify exact vs conflicting attributes
      const detailReader = await conn.runAndReadAll(
        `SELECT * FROM (
           SELECT row_number() OVER () AS __rn, *
           FROM ${qId(chk.right)}
         ) AS __numbered
         WHERE ${qId(chk.rightOn)} IN (
           SELECT ${qId(chk.rightOn)}
           FROM ${qId(chk.right)}
           WHERE ${qId(chk.rightOn)} IS NOT NULL
           GROUP BY ${qId(chk.rightOn)}
           HAVING COUNT(*) > 1
         )
         ORDER BY __rn ASC`,
      );
      const dCols = detailReader.columnNames();
      const rnIdx = dCols.indexOf("__rn");
      const keyColIdx = dCols.indexOf(chk.rightOn);
      const byKey = new Map<string, any[][]>();
      for (const row of detailReader.getRows()) {
        const keyStr = String(row[keyColIdx] ?? "");
        const arr = byKey.get(keyStr);
        if (arr) arr.push(row);
        else byKey.set(keyStr, [row]);
      }

      const allDetails: SpreadsheetDuplicateKeyDetail[] = [];
      for (const [rawKey] of dupRows) {
        const key = String(rawKey ?? "");
        const group = byKey.get(key) ?? [];
        const conflictingColumns: string[] = [];
        for (let ci = 0; ci < dCols.length; ci++) {
          if (ci === rnIdx || ci === keyColIdx) continue;
          const distinctVals = new Set(group.map((r) => (r[ci] === null || r[ci] === undefined ? "" : String(r[ci]))));
          if (distinctVals.size > 1) conflictingColumns.push(dCols[ci]);
        }
        allDetails.push({
          key,
          rightRows: group.length,
          rowNumbers: group.map((r) => Number(r[rnIdx])),
          exactDuplicate: conflictingColumns.length === 0,
          conflictingColumns,
        });
      }

      const allExactDuplicates = allDetails.every((d) => d.exactDuplicate);
      const duplicateKeys = allDetails.slice(0, 5);

      // Compute exact DuckDB SQL fan-out impact over the primary additive SUM() metric on chk.left
      let fanoutImpact: SpreadsheetJoinFanoutImpact | undefined;
      const sumMetrics = Object.values(opts.model.metrics).filter(
        (m) => (m.type ?? "simple") === "simple" && m.baseTable === chk.left && /^\s*sum\s*\(/i.test(m.expression),
      );
      const chosenMetric =
        sumMetrics.find((m) => m.unit === "currency" || CURRENCY_HINT_RE.test(`${m.label} ${m.name}`)) ?? sumMetrics[0];

      if (chosenMetric) {
        const filterClause = chosenMetric.filter ? ` WHERE (${chosenMetric.filter})` : "";
        let trueTotal = 0;
        let inflatedTotal = 0;
        if (chk.isSelfPrimaryKey) {
          const infRes = await conn.runAndReadAll(
            `SELECT COALESCE(CAST(${chosenMetric.expression} AS DOUBLE), 0) FROM ${qId(chk.left)}${filterClause}`,
          );
          inflatedTotal = roundTwo(Number(infRes.getRows()[0]?.[0] ?? 0));
          const dedupTrueRes = await conn.runAndReadAll(
            `SELECT COALESCE(CAST(${chosenMetric.expression} AS DOUBLE), 0)
             FROM (
               SELECT * EXCLUDE (__rn, __ord) FROM (
                 SELECT *,
                   CASE WHEN ${qId(chk.rightOn)} IS NULL THEN 1
                        ELSE row_number() OVER (PARTITION BY ${qId(chk.rightOn)} ORDER BY __ord)
                   END AS __rn
                 FROM (SELECT row_number() OVER () AS __ord, * FROM ${qId(chk.left)})
               ) WHERE __rn = 1
             ) AS ${qId(chk.left)}${filterClause}`,
          );
          trueTotal = roundTwo(Number(dedupTrueRes.getRows()[0]?.[0] ?? 0));
        } else {
          const trueRes = await conn.runAndReadAll(
            `SELECT COALESCE(CAST(${chosenMetric.expression} AS DOUBLE), 0) FROM ${qId(chk.left)}${filterClause}`,
          );
          trueTotal = roundTwo(Number(trueRes.getRows()[0]?.[0] ?? 0));
          const infRes = await conn.runAndReadAll(
            `SELECT COALESCE(CAST(${chosenMetric.expression} AS DOUBLE), 0)
             FROM (
               SELECT ${qId(chk.left)}.*
               FROM ${qId(chk.left)}
               LEFT JOIN (SELECT ${qId(chk.rightOn)} AS __rk FROM ${qId(chk.right)}) AS __r
                 ON ${qId(chk.left)}.${qId(chk.leftOn)} = __r.__rk
             ) AS ${qId(chk.left)}${filterClause}`,
          );
          inflatedTotal = roundTwo(Number(infRes.getRows()[0]?.[0] ?? 0));
        }
        const delta = roundTwo(inflatedTotal - trueTotal);
        const multiplier = trueTotal !== 0 ? Math.round((inflatedTotal / trueTotal) * 1000) / 1000 : 1;
        const colMatch = chosenMetric.expression.match(/\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)/);
        fanoutImpact = {
          metricColumn: colMatch?.[1] ?? chosenMetric.name,
          metricLabel: chosenMetric.label,
          trueTotal,
          inflatedTotal,
          delta,
          multiplier,
        };
      }

      duplicateJoins.push({
        leftTable: chk.left,
        leftColumn: chk.leftOn,
        rightTable: chk.right,
        rightColumn: chk.rightOn,
        matchRate,
        include: true,
        rightKeyUnique: false,
        duplicateKeyCount,
        duplicateRightRows,
        allExactDuplicates,
        duplicateKeys,
        ...(fanoutImpact ? { fanoutImpact } : {}),
        ...(unmatchedLeftRows > 0 ? { unmatchedLeftRows } : {}),
      });
    }

    if (duplicateJoins.length > 0 && !opts.deduplicateKeys) {
      return {
        ok: false,
        message: formatDuplicateJoinErrorMessage(duplicateJoins),
        duplicateJoins,
        canDeduplicate: true,
      };
    }

    const dedupeNotes: string[] = [];
    if (duplicateJoins.length > 0 && opts.deduplicateKeys) {
      for (const dj of duplicateJoins) {
        if (!opts.stagedTables.has(dj.rightTable)) {
          const destDir = resolve(opts.stagingRoot, dj.rightTable);
          await mkdir(destDir, { recursive: true, mode: 0o700 });
          await copyFile(
            resolve(opts.lakeRoot, dj.rightTable, "part-0.parquet"),
            resolve(destDir, "part-0.parquet"),
          );
          opts.stagedTables.add(dj.rightTable);
        }
        const stagedParquet = resolve(opts.stagingRoot, dj.rightTable, "part-0.parquet");
        const tempDedup = `${stagedParquet}.dedup.parquet`;
        await conn.run(
          `COPY (
             SELECT * EXCLUDE (__rn, __ord) FROM (
               SELECT *,
                 CASE WHEN ${qId(dj.rightColumn)} IS NULL THEN 1
                      ELSE row_number() OVER (PARTITION BY ${qId(dj.rightColumn)} ORDER BY __ord)
                 END AS __rn
               FROM (SELECT row_number() OVER () AS __ord, * FROM read_parquet(${qLit(stagedParquet)}))
             )
             WHERE __rn = 1
             ORDER BY __ord
           ) TO ${qLit(tempDedup)} (FORMAT PARQUET)`,
        );
        await rename(tempDedup, stagedParquet);
        await conn.run(`CREATE OR REPLACE VIEW ${qId(dj.rightTable)} AS SELECT * FROM read_parquet(${qLit(stagedParquet)})`);

        const rightLabel = opts.sheetNamesByTable?.get(dj.rightTable) ?? dj.rightTable;
        dedupeNotes.push(
          formatJoinDedupeNote({
            rightSheetName: rightLabel,
            rightColumnLabel: dj.rightColumn,
            join: dj,
            onRefresh: true,
          }),
        );
      }
    }

    const rowCountsByTable = new Map<string, number>();
    for (const tName of opts.stagedTables) {
      const cntRes = await conn.runAndReadAll(`SELECT COUNT(*) FROM ${qId(tName)}`);
      rowCountsByTable.set(tName, Number(cntRes.getRows()[0]?.[0] ?? 0));
    }

    return { ok: true, rowCountsByTable, dedupeNotes };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
