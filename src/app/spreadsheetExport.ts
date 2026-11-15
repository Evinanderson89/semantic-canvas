import writeXlsxFile, { type Cell } from "write-excel-file/universal";

/** Everything here is a value, never a formula, hyperlink, or workbook instruction. */
function cell(value: unknown, location: string): Cell {
  if (value == null) return null;
  if (typeof value === "boolean") return { type: Boolean, value };
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel has 15 significant decimal digits and no subnormal numbers.
    // Keep the exact returned representation as text beyond those limits.
    const digits = String(value).split(/e/i)[0].replace(/[^0-9]/g, "").replace(/^0+/, "").length;
    if (digits <= 15 && Math.abs(value) < 1e15 && (value === 0 || Math.abs(value) >= 2.2250738585072014e-308))
      return { type: Number, value };
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text.length > 32767) throw new Error(`${location} exceeds Excel’s 32,767-character cell limit. Use raw CSV to retain the original value.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/u.test(text))
    throw new Error(`${location} contains a control character this spreadsheet export cannot preserve. Use raw CSV to retain the original value.`);
  // Protect literal OOXML escape sequences and preserve CR through XML parsing.
  const encoded = text.replace(/_x[0-9a-f]{4}_/gi, value => `_x005F_${value.slice(1)}`).replace(/\r/g, "_x000D_");
  return { type: String, value: encoded, wrap: true };
}

/** Values are the returned query snapshot, before chart formatting. Numeric
 * strings deliberately stay strings: type inference would lose IDs/digits. */
export async function toSpreadsheet(columns: string[], rows: unknown[][], context: [string, unknown][] = []): Promise<Blob> {
  if (!columns.length) throw new Error("There are no columns to export.");
  if (columns.length > 16384 || rows.length > 1048575)
    throw new Error("The returned data exceeds Excel’s sheet dimensions. Use raw CSV instead.");
  const header = (values: string[]) => values.map((v, i) => ({ ...cell(v, `Header column ${i + 1}`) as object,
    fontWeight: "bold" as const, backgroundColor: "#2E5948", color: "#FFFFFF" }));
  const data = [header(columns), ...rows.map((row, r) => {
    if (row.length !== columns.length) throw new Error(`Returned row ${r + 1} does not match the column count. Refresh the query before exporting.`);
    return row.map((v, c) => cell(v, `Data row ${r + 2}, column ${c + 1}`));
  })];
  const notes: [string, unknown][] = [
    ["Export format", "Returned query values, before chart formatting. This workbook contains no formulas or linked data."],
    ["Value types", "Text stays text, including numeric strings and dates. Numeric results stay numbers within Excel’s precision limits; larger or more precise numbers are saved as text. Nulls and empty strings become blank cells."],
    ["Scope boundary", "Only returned rows are included. This is not a warehouse backup or certification of completeness, freshness, or business accuracy. Values already rounded upstream cannot be recovered."],
    ...context,
  ];
  return writeXlsxFile([
    { sheet: "Data", data, stickyRowsCount: 1, columns: columns.map(c => ({ width: Math.min(42, Math.max(18, c.length + 2)) })) },
    { sheet: "Query context", data: [header(["Context", "Value"]), ...notes.map(([k, v], r) => [cell(k, `Context row ${r + 2}`), cell(v, `Context row ${r + 2}`)])],
      stickyRowsCount: 1, columns: [{ width: 28 }, { width: 100 }] },
  ], { fontFamily: "Calibri", fontSize: 11 }).toBlob();
}
