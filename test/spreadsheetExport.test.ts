import { expect, it } from "vitest";
import { toSpreadsheet } from "../src/app/spreadsheetExport.ts";
import { toCsv } from "../src/app/export.ts";
import { workbookXml, sheetCells } from "./xlsxValues.ts";
const output = async (columns: string[], rows: unknown[][], context: [string, unknown][] = []) => workbookXml(new Uint8Array(await (await toSpreadsheet(columns, rows, context)).arrayBuffer()));

it("emits formula-like inputs and headers as text without formulas, links or macros", async () => {
  const values = ['=HYPERLINK("https://invalid.example","click")', '+1+2', '-1+2', '@SUM(A1)', '\t=1+1', '\r=1+1', '＝SUM(A1)', { formula: "1+1" }];
  const files = await output(['=1+1'], values.map(v => [v]), [['=context', '=1+1']]);
  const cells = sheetCells(files);
  expect(cells.A1).toEqual({ type: "s", value: "=1+1" });
  values.forEach((v, i) => expect(cells[`A${i + 2}`]).toEqual({ type: "s", value: typeof v === "object" ? JSON.stringify(v) : v }));
  for (const xml of Object.values(files)) {
    expect(xml).not.toMatch(/<f(?:\s|>)/);
    expect(xml).not.toContain('TargetMode="External"');
  }
  expect(Object.keys(files).some(n => /vba|externalLinks/i.test(n))).toBe(false);
});

it("preserves Unicode, identifiers, exact numeric text, XML characters, whitespace and literal escape strings", async () => {
  const values = ['München 東京 🌍', '00123', '9007199254740993', '0.12345678901234567890', '<tag>&"quoted"', '  padded  ', 'first\r\nsecond\tthird', '_x000A_ and _x005F_', ''];
  const files = await output(['label'], values.map(v => [v]));
  const cells = sheetCells(files);
  values.forEach((v, i) => v === '' ? expect(cells[`A${i + 2}`]).toBeUndefined() : expect(cells[`A${i + 2}`]).toEqual({ type: "s", value: v }));
  expect(files['xl/sharedStrings.xml']).toContain('xml:space="preserve"');
});

it("keeps ordinary numeric and boolean values typed, preserves missing values and protects Excel precision limits", async () => {
  const files = await output(['n', 'bool', 'null', 'large', 'precise', 'tiny'], [[-42.5, false, null, 9007199254740992, 0.12345678901234567, 1e-320]]);
  expect(sheetCells(files)).toMatchObject({ A2: { type: "n", value: -42.5 }, B2: { type: "b", value: false },
    D2: { type: "s", value: "9007199254740992" }, E2: { type: "s", value: "0.12345678901234566" }, F2: { type: "s", value: "1e-320" } });
  expect(sheetCells(files).C2).toBeUndefined();
});

it("includes the returned-row boundary and supplied context without changing raw CSV bytes", async () => {
  const rows = [["001", "=1+1", "9007199254740993"]];
  const before = toCsv(['id', 'text', 'amount'], rows);
  const files = await output(['id', 'text', 'amount'], rows, [['Query', '{"where":["East"]}'], ['Truncated', true], ['Returned rows', 1]]);
  expect(files['xl/workbook.xml']).toContain('name="Query context"');
  const cells = Object.values(sheetCells(files, 2)).map(c => c.value);
  expect(cells).toContain('{"where":["East"]}');
  expect(cells).toContain(true);
  expect(cells).toContainEqual(expect.stringContaining("Only returned rows"));
  expect(toCsv(['id', 'text', 'amount'], rows)).toBe(before);
  expect(before).toContain('001,=1+1,9007199254740993');
});

it("refuses values and shapes that cannot be preserved instead of silently truncating", async () => {
  await expect(output(['text'], [['x'.repeat(32768)]])).rejects.toThrow('32,767');
  await expect(output(['text'], [['a\u0000b']])).rejects.toThrow('control character');
  await expect(output(['text'], [['\ud800']])).rejects.toThrow('control character');
  await expect(output(['text'], [['a', 'b']])).rejects.toThrow('column count');
  await expect(output([], [])).rejects.toThrow('no columns');
  await expect(output(Array(16385).fill('column'), [])).rejects.toThrow('sheet dimensions');
  await expect(output(['column'], Array(1048576).fill(['value']))).rejects.toThrow('sheet dimensions');
});
