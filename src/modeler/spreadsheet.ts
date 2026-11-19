import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Proposal, ProposedMetric } from "./propose.ts";
import {
  SAMPLE_SPREADSHEET_CSV,
  SAMPLE_SPREADSHEET_NAME,
  type ParsedSpreadsheet,
  type SpreadsheetColumnChoice,
  type SpreadsheetColumnProfile,
  type SpreadsheetColumnRole,
  type SpreadsheetDetectedJoin,
  type SpreadsheetFormatHint,
  type SpreadsheetPreview,
  type SpreadsheetSheetChoice,
  type SpreadsheetSheetPreview,
  type SpreadsheetValueType,
} from "./spreadsheetTypes.ts";

export {
  SAMPLE_SPREADSHEET_CSV,
  SAMPLE_SPREADSHEET_NAME,
  type ParsedSpreadsheet,
  type SpreadsheetColumnChoice,
  type SpreadsheetColumnProfile,
  type SpreadsheetColumnRole,
  type SpreadsheetDetectedJoin,
  type SpreadsheetFormatHint,
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
const SUMMARY_ROW_LABEL_RE = /^(grand\s+total|sub\s*-?\s*total|total|totals|net\s+total|ytd\s+total|overall\s+total)(\s*:.*)?$/i;
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
    const uniqueCount = new Set(nonEmpty).size;
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
    const isCurrency = isNum && (currencyHits / total >= 0.3 || /\$|usd|eur|rev|mrr|arr|sales|spend|cost|price|amount|profit|budget/.test(headerLower));
    const isPercent = isNum && (percentHits / total >= 0.3 || /%|rate|pct|percent|margin|ratio|discount|churn|retention/.test(headerLower));
    const looksLikeId =
      /(^|_)id$|order|invoice|ticket|txn|transaction|sku|code|uuid/.test(name) &&
      nonEmpty.length > 0 &&
      uniqueCount / nonEmpty.length >= 0.9;
    const looksLikeYear = isNum && intHits === numHits && /^(year|yr|fiscal_year)$/.test(name);

    let sqlType: SpreadsheetValueType = "VARCHAR";
    let formatHint: SpreadsheetFormatHint = "text";
    let role: SpreadsheetColumnRole = "category";

    if (isDate) {
      sqlType = "DATE";
      formatHint = "date";
      role = "date";
    } else if (looksLikeId) {
      sqlType = "VARCHAR";
      formatHint = "text";
      role = "id";
    } else if (isNum && !looksLikeYear) {
      sqlType = !isCurrency && !isPercent && intHits === numHits ? "BIGINT" : "DOUBLE";
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
      uniqueCount,
      nonEmptyCount: nonEmpty.length,
      samples: nonEmpty.slice(0, 3),
    };
  });

  const dateCol = columns.find((c) => c.role === "date")?.name ?? null;
  const idCol = columns.find((c) => c.role === "id")?.name ?? null;
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

export function detectSheetJoins(
  sheets: { tableName: string; columns: SpreadsheetColumnProfile[]; rows: string[][] }[],
): SpreadsheetDetectedJoin[] {
  const joins: SpreadsheetDetectedJoin[] = [];
  const seen = new Set<string>();

  for (let li = 0; li < sheets.length; li++) {
    for (let ri = 0; ri < sheets.length; ri++) {
      if (li === ri) continue;
      const left = sheets[li];
      const right = sheets[ri];
      const rightKeyCols = right.columns
        .map((c, idx) => ({ col: c, idx }))
        .filter(({ col }) => col.nonEmptyCount > 0 && col.uniqueCount / col.nonEmptyCount >= 0.95 && (col.role === "id" || /(^|_)id$|_code$|_key$/.test(col.name)));

      for (const { col: rCol, idx: rIdx } of rightKeyCols) {
        const rightValues = new Set(right.rows.map((r) => (r[rIdx] ?? "").trim()).filter(Boolean));
        if (rightValues.size === 0) continue;

        for (let lIdx = 0; lIdx < left.columns.length; lIdx++) {
          const lCol = left.columns[lIdx];
          if (lCol.sqlType !== rCol.sqlType) continue;
          const exactNameMatch = lCol.name === rCol.name;
          const fkNameMatch =
            rCol.name === "id" &&
            (lCol.name === `${right.tableName}_id` || lCol.name === `${right.tableName.replace(/s$/, "")}_id`);
          if (!exactNameMatch && !fkNameMatch) continue;

          const leftVals = left.rows.map((r) => (r[lIdx] ?? "").trim()).filter(Boolean);
          if (leftVals.length === 0) continue;
          let matched = 0;
          for (const v of leftVals) if (rightValues.has(v)) matched++;
          const matchRate = Math.round((matched / leftVals.length) * 1000) / 1000;
          if (matchRate < 0.25) continue;

          // Prefer pointing from the larger / fact-like sheet to the unique lookup sheet.
          const pairKey = [left.tableName, right.tableName].sort().join("::");
          if (seen.has(pairKey)) continue;
          if (left.rows.length < right.rows.length && left.columns[lIdx].uniqueCount === leftVals.length) continue;

          seen.add(pairKey);
          joins.push({
            leftTable: left.tableName,
            leftColumn: lCol.name,
            rightTable: right.tableName,
            rightColumn: rCol.name,
            matchRate,
            include: matchRate >= 0.5,
          });
        }
      }
    }
  }
  return joins.sort((a, b) => b.matchRate - a.matchRate);
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
  const rightSideTargets = new Set(detectedJoins.filter((j) => j.include).map((j) => j.rightTable));

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

export function buildWorkbookProposal(opts: {
  sourceId: string;
  label: string;
  sheets: SpreadsheetSheetPreview[];
  sheetChoices?: SpreadsheetSheetChoice[];
  joins?: SpreadsheetDetectedJoin[];
  primaryGrain?: string;
  primaryTimeColumn?: string | null;
  primaryReportingLag?: number;
  primaryChoices?: SpreadsheetColumnChoice[];
}): Proposal {
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
    });
  }

  const choiceByTable = new Map((opts.sheetChoices ?? []).map((c) => [c.tableName, c]));
  const allTables: Proposal["tables"] = [];
  const allMetrics: ProposedMetric[] = [];
  const usedMetricNames = new Set<string>();
  const primaryTable = opts.sheets.find((s) => s.kind === "fact")?.tableName ?? opts.sheets[0].tableName;

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

    // Emit metrics primarily for fact sheets (and record count for dimensions only if unique name).
    for (const m of single.metrics) {
      if (sheet.kind === "dimension" && m.expression.startsWith("SUM(")) continue;
      let name = m.name;
      if (usedMetricNames.has(name)) name = `${sheet.tableName}_${m.name}`;
      usedMetricNames.add(name);
      allMetrics.push({ ...m, name });
    }
  }

  const joins: Proposal["joins"] = (opts.joins ?? [])
    .filter((j) => j.include)
    .map((j) => ({
      left: j.leftTable,
      leftOn: j.leftColumn,
      right: j.rightTable,
      rightOn: j.rightColumn,
      type: "left",
      include: true,
      evidence: `Auto-detected cross-sheet key match (${Math.round(j.matchRate * 100)}% of rows matched).`,
      resolution: j.matchRate,
    }));

  const totalRows = opts.sheets.reduce((sum, s) => sum + s.rowCount, 0);
  return {
    model: {
      name: opts.label,
      description: `Governed multi-sheet semantic model created from workbook "${opts.label}" (${opts.sheets.length} sheets, ${totalRows.toLocaleString()} total rows).`,
    },
    tables: allTables,
    joins,
    metrics: allMetrics,
    warnings: [],
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
}): Proposal {
  const choiceByName = new Map((opts.choices ?? []).map((c) => [c.name, c]));
  const resolvedColumns = opts.columns.map((c) => {
    const choice = choiceByName.get(c.name);
    return {
      ...c,
      role: choice?.role ?? c.role,
      label: choice?.label?.trim() || c.label,
    };
  });

  const primaryKey = resolvedColumns.find((c) => c.role === "id")?.name ?? null;
  const timeColumn =
    opts.timeColumn && resolvedColumns.some((c) => c.name === opts.timeColumn && c.sqlType === "DATE")
      ? opts.timeColumn
      : resolvedColumns.find((c) => c.role === "date" && c.sqlType === "DATE")?.name ?? null;

  const metrics: ProposedMetric[] = [];
  const usedMetricNames = new Set<string>();

  for (const col of resolvedColumns) {
    if (col.role !== "metric" || (col.sqlType !== "DOUBLE" && col.sqlType !== "BIGINT")) continue;
    let metricName = sanitizeIdentifier(col.name, "metric");
    if (usedMetricNames.has(metricName)) metricName = `${metricName}_total`;
    usedMetricNames.add(metricName);

    const isAvg = col.formatHint === "percent" || /rate|avg|average|ratio|price|margin|discount|score/.test(col.name);
    const expr = isAvg ? `AVG(${col.name})` : `SUM(${col.name})`;
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
    description: `Count of records in ${opts.label} (${opts.grain}).`,
    include: true,
    evidence: primaryKey ? `Distinct count of confirmed ID column ${primaryKey}.` : `Row count across ${opts.rowCount} imported spreadsheet rows.`,
  });

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
