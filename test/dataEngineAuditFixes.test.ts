import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBroadsideMarks, renderChartFigure } from "../src/charts/Chart.tsx";
import { buildPredicate, compileTile, splitPartialPeriods, validateTile } from "../src/compiler/compile.ts";
import type { FilterSpec, TileSpec } from "../src/compiler/spec.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { DEFAULT_FORMAT, makeAxisFormatter, makeFormatter, resolveFormat } from "../src/format/format.ts";
import {
  buildSpreadsheetProposal,
  buildWorkbookProposal,
  extractDateStyleIndices,
  normalizeDateValue,
  parseCsv,
  parseNumericValue,
  parseXlsxWorkbook,
  profileSpreadsheet,
  profileWorkbook,
  writeSpreadsheetParquet,
} from "../src/modeler/spreadsheet.ts";
import { buildSampleWorkbookPayload } from "../src/modeler/spreadsheetTypes.ts";
import { proposalIssues, proposalToYaml } from "../src/modeler/yaml.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import { labelTile, reviewDataHonesty } from "../src/suggest/dataHonesty.ts";
import { analyzeMetricDrivers } from "../src/suggest/drivers.ts";
import { conn as mockConn, model as fixtureModel, tile } from "./fixtures.ts";

/** Minimal lightweight DOM shim for testing SVG/HTML output from Chart.tsx in Node. */
class MiniNode {
  tagName: string;
  namespaceURI: string;
  ownerDocument: any = null;
  attributes = new Map<string, string>();
  childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  style: Record<string, any>;
  private _text = "";

  constructor(tagName: string, namespaceURI = "http://www.w3.org/1999/xhtml", ownerDoc: any = null) {
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    this.ownerDocument = ownerDoc;
    const styleStore: Record<string, any> = {
      setProperty: (k: string, v: string) => {
        styleStore[k] = String(v);
      },
      removeProperty: (k: string) => {
        delete styleStore[k];
      },
      getPropertyValue: (k: string) => styleStore[k] ?? "",
    };
    this.style = styleStore;
  }

  get children(): MiniNode[] {
    return this.childNodes.filter((c) => c.tagName !== "#text");
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null;
  }

  get firstElementChild(): MiniNode | null {
    return this.childNodes.find((c) => c.tagName !== "#text") ?? null;
  }

  get textContent(): string {
    if (this.tagName === "#text") return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    if (this.tagName === "#text") {
      this._text = String(val);
      return;
    }
    this.childNodes = [];
    if (val !== "") {
      const t = new MiniNode("#text", this.namespaceURI, this.ownerDocument);
      t._text = String(val);
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }

  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }

  setAttributeNS(_ns: string | null, k: string, v: string) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  removeAttribute(k: string) {
    this.attributes.delete(k);
  }

  removeAttributeNS(_ns: string | null, k: string) {
    this.attributes.delete(k);
  }

  appendChild<T extends MiniNode>(node: T): T {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild<T extends MiniNode>(node: T): T {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    node.parentNode = null;
    return node;
  }

  insertBefore<T extends MiniNode>(node: T, refNode: MiniNode | null): T {
    if (node.parentNode) {
      const oldIdx = node.parentNode.childNodes.indexOf(node);
      if (oldIdx >= 0) node.parentNode.childNodes.splice(oldIdx, 1);
    }
    node.parentNode = this;
    const idx = refNode ? this.childNodes.indexOf(refNode) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, node);
    else this.childNodes.push(node);
    return node;
  }

  cloneNode(deep = false): MiniNode {
    const copy = new MiniNode(this.tagName, this.namespaceURI, this.ownerDocument);
    copy._text = this._text;
    for (const [k, v] of this.attributes) copy.attributes.set(k, v);
    if (deep) {
      for (const ch of this.childNodes) copy.appendChild(ch.cloneNode(true));
    }
    return copy;
  }

  append(...nodes: (MiniNode | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const t = new MiniNode("#text", this.namespaceURI, this.ownerDocument);
        t.textContent = n;
        this.appendChild(t);
      } else {
        this.appendChild(n);
      }
    }
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }

  private matchesSimple(sel: string): boolean {
    const s = sel.trim();
    if (s.startsWith("#")) return this.attributes.get("id") === s.slice(1);
    if (s.startsWith(".")) {
      const cls = (this.attributes.get("class") ?? "").split(/\s+/);
      return cls.includes(s.slice(1));
    }
    return this.tagName.toLowerCase() === s.toLowerCase();
  }

  querySelector(selector: string): MiniNode | null {
    if (selector === ":scope > svg") {
      return this.childNodes.find((c) => c.tagName.toLowerCase() === "svg") ?? null;
    }
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniNode[] {
    const out: MiniNode[] = [];
    const parts = selector.trim().split(/\s+/);
    const visit = (node: MiniNode) => {
      for (const child of node.childNodes) {
        if (child.tagName === "#text") continue;
        if (parts.length === 1 && child.matchesSimple(parts[0])) {
          out.push(child);
        } else if (parts.length === 2 && child.matchesSimple(parts[1])) {
          let p = child.parentNode;
          while (p) {
            if (p.matchesSimple(parts[0])) {
              out.push(child);
              break;
            }
            p = p.parentNode;
          }
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  get outerHTML(): string {
    if (this.tagName === "#text") return this._text;
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    const inner = this.childNodes.map((c) => c.outerHTML).join("");
    return `<${this.tagName}${attrs}>${inner}</${this.tagName}>`;
  }
}

function createMiniDocument() {
  const doc: any = {
    createElement: (tag: string) => new MiniNode(tag, "http://www.w3.org/1999/xhtml", doc),
    createElementNS: (ns: string, tag: string) => new MiniNode(tag, ns, doc),
    createTextNode: (txt: string) => {
      const n = new MiniNode("#text", "http://www.w3.org/1999/xhtml", doc);
      n.textContent = txt;
      return n;
    },
    defaultView: { Event: class {} },
    implementation: {
      createHTMLDocument: () => createMiniDocument(),
    },
  };
  doc.documentElement = new MiniNode("html", "http://www.w3.org/1999/xhtml", doc);
  return doc;
}

function buildCustomXlsxBytes(opts: {
  stylesXml?: string;
  sheets: { name: string; state?: "visible" | "hidden" | "veryHidden"; xml: string }[];
  extraFiles?: Record<string, Uint8Array>;
}): Uint8Array {
  const enc = new TextEncoder();
  const workbookSheets = opts.sheets
    .map(
      (s, i) =>
        `<sheet name="${s.name}" sheetId="${i + 1}"${s.state && s.state !== "visible" ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`,
    )
    .join("");
  const rels = opts.sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    ),
    ...(opts.stylesXml ? { "xl/styles.xml": enc.encode(opts.stylesXml) } : {}),
    ...(opts.extraFiles ?? {}),
  };
  opts.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = enc.encode(s.xml);
  });
  return zipSync(files);
}

describe("Deliverables 1 & 2: Grid Renewables geneRATIOns fix, Wholesale grain fix & Monthly/Quarterly period retention", () => {
  it("never types geneRATIOns / Duration / Operation as percent, never infers One sale or order from Wholesale, and retains Aug 2026 on Samples #1 & #3", async () => {
    const gridBuilt = await buildSampleWorkbookPayload("grid-renewables");
    const gridParsed = parseCsv(gridBuilt.content, "Grid");
    const gridPreview = profileWorkbook(gridBuilt.fileName, [gridParsed]);

    expect(gridPreview.suggestedGrain).toBe("One monthly summary");
    expect(gridPreview.suggestedPeriod).toEqual({ column: "dispatch_month", grain: "month" });

    const byName = Object.fromEntries(gridPreview.columns.map((c) => [c.name, c]));
    expect(byName.solar_generation_mwh.formatHint).toBe("number");
    expect(byName.wind_generation_mwh.formatHint).toBe("number");
    expect(byName.curtailment_mwh.formatHint).toBe("number");
    expect(byName.wholesale_price.formatHint).toBe("currency");

    // Also verify Duration / Operation / Migration columns never match rate/ratio
    const opsCsv = parseCsv(
      "Month,Operation,Task Duration,Migration Count,Churn Rate\n2026-06-01,Alpha,120,450,2.5%\n2026-07-01,Beta,135,510,2.1%\n2026-08-01,Gamma,110,490,1.9%",
    );
    const opsPreview = profileSpreadsheet("System_Operations.csv", opsCsv);
    const opsByName = Object.fromEntries(opsPreview.columns.map((c) => [c.name, c]));
    expect(opsByName.task_duration.formatHint).toBe("number");
    expect(opsByName.migration_count.formatHint).toBe("number");
    expect(opsByName.churn_rate.formatHint).toBe("percent");

    const dir = await mkdtemp(join(tmpdir(), "sc-grid-audit-"));
    try {
      const sheet0 = gridPreview.sheets![0];
      await writeSpreadsheetParquet(dir, sheet0.tableName, sheet0.columns, gridParsed.rows);
      const proposal = buildWorkbookProposal({
        sourceId: gridBuilt.meta.preferredSourceId,
        label: gridBuilt.meta.title,
        sheets: gridPreview.sheets!,
        joins: [],
        primaryGrain: gridPreview.suggestedGrain,
        primaryTimeColumn: gridPreview.suggestedTimeColumn,
        primaryReportingLag: gridBuilt.meta.defaultLag,
      });
      const yamlText = proposalToYaml(proposal);
      expect(yamlText).toContain("period:\n      column: dispatch_month\n      grain: month");
      expect(yamlText).toContain("SUM(solar_generation_mwh)");
      expect(yamlText).toContain("AVG(wholesale_price)");
      expect(yamlText).not.toContain("unit: percent");

      const yamlPath = join(dir, "grid.yaml");
      await writeFile(yamlPath, yamlText, "utf8");
      const loadedModel = (await duckglueAdapter.load(yamlPath))!;
      expect(loadedModel.tables[sheet0.tableName].period).toEqual({ column: "dispatch_month", grain: "month" });

      const solarTile: TileSpec = {
        id: "solar-trend",
        metrics: ["solar_generation_mwh"],
        dimensions: [`month:${sheet0.tableName}.dispatch_month`],
        layout: { x: 0, y: 0, w: 6, h: 4 },
      };
      const fmt = makeFormatter(resolveFormat(loadedModel, solarTile));
      expect(fmt(3992500)).not.toContain("%");
      expect(fmt(3992500)).toBe("3.99M");

      const conn = await duckdbConnector(dir);
      try {
        const sql = compileTile(loadedModel, conn, solarTile);
        const res = splitPartialPeriods(await conn.execute(sql));
        expect(res.partial).toEqual({ start: false, end: false });
        const months = res.rows.map((r) => String(r[0]).slice(0, 10));
        expect(months).toEqual([
          "2026-03-01",
          "2026-04-01",
          "2026-05-01",
          "2026-06-01",
          "2026-07-01",
          "2026-08-01",
        ]);
      } finally {
        await conn.close();
      }

      // Sample #1 (messy-roastery-pnl) also retains Aug 2026 after unpivoting
      const pnlBuilt = await buildSampleWorkbookPayload("messy-roastery-pnl");
      const pnlParsed = parseCsv(pnlBuilt.content, "Roastery Revenue");
      const pnlPreview = profileWorkbook(pnlBuilt.fileName, [pnlParsed]);
      await writeSpreadsheetParquet(dir, pnlPreview.tableName, pnlPreview.columns, pnlParsed.rows);
      const pnlProposal = buildWorkbookProposal({
        sourceId: pnlBuilt.meta.preferredSourceId,
        label: pnlBuilt.meta.title,
        sheets: pnlPreview.sheets!,
        joins: [],
      });
      const pnlYamlPath = join(dir, "pnl.yaml");
      await writeFile(pnlYamlPath, proposalToYaml(pnlProposal), "utf8");
      const pnlModel = (await duckglueAdapter.load(pnlYamlPath))!;
      const conn2 = await duckdbConnector(dir);
      try {
        const pnlSql = compileTile(pnlModel, conn2, {
          id: "pnl-trend",
          metrics: ["revenue"],
          dimensions: [`month:${pnlPreview.tableName}.period_date`],
          layout: { x: 0, y: 0, w: 6, h: 4 },
        });
        const pnlRes = splitPartialPeriods(await conn2.execute(pnlSql));
        expect(pnlRes.partial).toEqual({ start: false, end: false });
        expect(pnlRes.rows.map((r) => String(r[0]).slice(0, 10)).at(-1)).toBe("2026-08-01");
      } finally {
        await conn2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects uniform whole-quarter date columns and emits period: { grain: 'quarter' }", async () => {
    const qCsv = parseCsv(
      "Region,Q1 2026,Q2 2026,Q3 2026,FY Total\nNorth America,$100000,$120000,$140000,$360000\nEurope,$80000,$90000,$95000,$265000",
      "Quarterly Revenue",
    );
    const preview = profileSpreadsheet("Quarterly_Pack.csv", qCsv);
    expect(preview.suggestedPeriod).toEqual({ column: "period_date", grain: "quarter" });
    expect(preview.suggestedGrain).toBe("One quarterly summary");
    const proposal = buildSpreadsheetProposal({
      sourceId: preview.sourceId,
      label: preview.label,
      tableName: preview.tableName,
      rowCount: preview.rowCount,
      grain: preview.suggestedGrain,
      timeColumn: preview.suggestedTimeColumn,
      columns: preview.columns,
    });
    expect(proposalIssues(proposal)).toEqual([]);
    expect(proposalToYaml(proposal)).toContain("period:\n      column: period_date\n      grain: quarter");
  });
});

describe("Deliverable 3: Wide-sheet Q1 Total stripping, [Red] currency, hidden tabs, ZIP caps, locales, safe types & orphan dollars", () => {
  it("strips Total / Q1 Total / YTD / Full Year / YoY / Variance columns, avoids mixing Q1 2026 into monthly unpivots, and strips <Name> Total & Total <Name> rows", () => {
    const wideCsv = [
      "Region,Jan 2026,Feb 2026,Mar 2026,Q1 2026,Q1 Total,YTD,Full Year,Variance,YoY %",
      "North America,$10000,$12000,$15000,$37000,$37000,$37000,$150000,+$2000,18%",
      "Europe,$8000,$9000,$11000,$28000,$28000,$28000,$110000,+$1000,12%",
      "Total North America,$10000,$12000,$15000,$37000,$37000,$37000,$150000,+$2000,18%",
      "Europe Total,$8000,$9000,$11000,$28000,$28000,$28000,$110000,+$1000,12%",
    ].join("\n");

    const parsed = parseCsv(wideCsv, "Revenue Plan");
    expect(parsed.headers).toEqual(["Region", "Period Date", "Revenue ($)"]);
    expect(parsed.rows).toHaveLength(6); // 2 regions * 3 months ONLY (no Q1 2026 4th period, no summary cols, no Total rows!)
    const totalSum = parsed.rows.reduce((s, r) => s + (parseNumericValue(r[2])?.value ?? 0), 0);
    expect(totalSum).toBe(65000); // Exact 37k + 28k = 65k (zero 3x-12x inflation!)
    const notes = (parsed.cleaningNotes ?? []).join(" | ");
    expect(notes).toMatch(/Excluded 2 Total\/Subtotal summary rows/);
    expect(notes).toMatch(/Excluded 6 summary\/variance columns/);
    expect(notes).toMatch(/Unpivoted 3 wide period columns/);
  });

  it("parses XML numFmt order-independently, ignores [Red]/[ColorN]/[$USD] in date detection, and skips hidden & veryHidden sheets", () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <numFmts count="4">
          <numFmt formatCode="$#,##0.00;[Red]($#,##0.00)" numFmtId="164"/>
          <numFmt numFmtId="165" formatCode="[Color10][$USD-409]#,##0"/>
          <numFmt formatCode="yyyy-mm-dd" numFmtId="166"/>
          <numFmt numFmtId="167" formatCode="yyyy-mm-dd hh:mm:ss.000"/>
        </numFmts>
        <cellXfs count="5">
          <xf numFmtId="0"/>
          <xf numFmtId="164"/>
          <xf numFmtId="165"/>
          <xf numFmtId="166"/>
          <xf numFmtId="167"/>
        </cellXfs>
      </styleSheet>`;

    const dateIndices = extractDateStyleIndices(stylesXml);
    expect(dateIndices.has(1)).toBe(false); // [Red] currency is NOT a date!
    expect(dateIndices.has(2)).toBe(false); // [Color10][$USD-409] currency is NOT a date!
    expect(dateIndices.has(3)).toBe(true);
    expect(dateIndices.has(4)).toBe(true);

    const visibleSheetXml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Order Date</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue ($)</t></is></c></row>
      <row r="2"><c r="A2" s="3"><v>46235</v></c><c r="B2" s="1"><v>48200</v></c></row>
    </sheetData></worksheet>`;
    const hiddenSheetXml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Secret</t></is></c><c r="B1" t="inlineStr"><is><t>Val</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>HiddenRow</t></is></c><c r="B2"><v>999999</v></c></row>
    </sheetData></worksheet>`;

    const xlsxBytes = buildCustomXlsxBytes({
      stylesXml,
      sheets: [
        { name: "Live Revenue", state: "visible", xml: visibleSheetXml },
        { name: "Scratch Calc", state: "hidden", xml: hiddenSheetXml },
        { name: "Audit Macro", state: "veryHidden", xml: hiddenSheetXml },
      ],
    });

    const parsed = parseXlsxWorkbook(xlsxBytes);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sheetName).toBe("Live Revenue");
    expect(parsed[0].rows[0][0]).toBe("2026-08-01");
    expect(parsed[0].rows[0][1]).toBe("48200"); // Kept as 48200, NEVER converted to 2031-12-16!
    expect((parsed[0].cleaningNotes ?? []).join(" | ")).toContain(
      "Skipped 2 hidden worksheets (Scratch Calc, Audit Macro)",
    );
  });

  it("enforces <= 64 ZIP entries and <= 24 MB cumulative uncompressed size limits", () => {
    const simpleSheetXml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>ColA</t></is></c><c r="B1" t="inlineStr"><is><t>ColB</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>X</t></is></c><c r="B2"><v>1</v></c></row>
    </sheetData></worksheet>`;

    const tooManyFiles: Record<string, Uint8Array> = {};
    for (let i = 0; i < 66; i++) {
      tooManyFiles[`xl/extra_${i}.xml`] = new Uint8Array([65]);
    }
    const overEntryCap = buildCustomXlsxBytes({
      sheets: [{ name: "S1", xml: simpleSheetXml }],
      extraFiles: tooManyFiles,
    });
    expect(() => parseXlsxWorkbook(overEntryCap)).toThrow(/64-entry safety limit/i);

    // 3 entries of 9 MB zeros each = 27 MB > 24 MB cumulative limit (while each entry <= 12 MB)
    const nineMbZeros = new Uint8Array(9 * 1024 * 1024);
    const overTotalBytesCap = buildCustomXlsxBytes({
      sheets: [{ name: "S1", xml: simpleSheetXml }],
      extraFiles: {
        "xl/media/chunk1.xml": nineMbZeros,
        "xl/media/chunk2.xml": nineMbZeros,
        "xl/media/chunk3.xml": nineMbZeros,
      },
    });
    expect(() => parseXlsxWorkbook(overTotalBytesCap)).toThrow(/24 MB cumulative uncompressed safety limit/i);
  });

  it("preserves >15-digit integers & leading-zero zip/phone as VARCHAR, treats year/month/quarter/*_num as dimensions, and restricts snapshot balances", async () => {
    const csvText = [
      "Month,Fiscal Year,Quarter,Store Number,Postal Code,Card ID,Headcount,Cash Balance ($),Revenue ($)",
      "2026-06-01,2026,2,101,02138,12345678901234567,42,$250000,$85000",
      "2026-07-01,2026,3,102,07030,12345678901234568,45,$265000,$92000",
      "2026-08-01,2026,3,101,02138,12345678901234569,48,$280000,$99000",
    ].join("\n");

    const parsed = parseCsv(csvText, "Store Balances");
    const preview = profileSpreadsheet("Store_Balances.csv", parsed);
    const byName = Object.fromEntries(preview.columns.map((c) => [c.name, c]));

    expect(byName.postal_code).toMatchObject({ sqlType: "VARCHAR", role: "category" });
    expect(byName.card_id).toMatchObject({ sqlType: "VARCHAR", role: "id" });
    expect(byName.fiscal_year).toMatchObject({ sqlType: "VARCHAR", role: "category" });
    expect(byName.quarter).toMatchObject({ sqlType: "VARCHAR", role: "category" });
    expect(byName.store_number).toMatchObject({ sqlType: "VARCHAR", role: "category" });

    const proposal = buildSpreadsheetProposal({
      sourceId: preview.sourceId,
      label: preview.label,
      tableName: preview.tableName,
      rowCount: preview.rowCount,
      grain: preview.suggestedGrain,
      timeColumn: preview.suggestedTimeColumn,
      columns: preview.columns,
    });
    const metricNames = proposal.metrics.map((m) => m.name);
    expect(metricNames).not.toContain("fiscal_year");
    expect(metricNames).not.toContain("quarter");
    expect(metricNames).not.toContain("store_number");
    expect(metricNames).not.toContain("postal_code");

    const headcountMetric = proposal.metrics.find((m) => m.name === "headcount")!;
    const balanceMetric = proposal.metrics.find((m) => m.name === "cash_balance")!;
    const revenueMetric = proposal.metrics.find((m) => m.name === "revenue")!;
    expect(headcountMetric.timeGrains).toEqual(["month"]);
    expect(headcountMetric.timeDimension).toBe("store_balances.month");
    expect(balanceMetric.timeGrains).toEqual(["month"]);
    expect(revenueMetric.timeGrains).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), "sc-types-audit-"));
    try {
      await writeSpreadsheetParquet(dir, preview.tableName, preview.columns, parsed.rows);
      const yamlPath = join(dir, "balances.yaml");
      await writeFile(yamlPath, proposalToYaml(proposal), "utf8");
      const model = (await duckglueAdapter.load(yamlPath))!;

      // Unrestricted SUM across all months is blocked on snapshot balances
      const badIssues = validateTile(model, {
        id: "bad-sum",
        metrics: ["cash_balance"],
        dimensions: [],
        layout: { x: 0, y: 0, w: 4, h: 4 },
      });
      expect(badIssues.map((i) => i.problem).join(" ")).toContain("requires month reporting");

      // Leading zero '02138' and exact 17-digit Card ID survive DuckDB Parquet intact
      const conn = await duckdbConnector(dir);
      try {
        const res = await conn.execute(
          `SELECT postal_code, card_id FROM ${conn.relation(preview.tableName)} ORDER BY card_id ASC LIMIT 1`,
        );
        expect(res.rows[0]).toEqual(["02138", "12345678901234567"]);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports MM/DD/YY, month-name dates, strict calendar validation (02/31/2026 -> null), ISO currency, scientific notation & European ; CSVs", async () => {
    expect(normalizeDateValue("03/15/26")).toBe("2026-03-15");
    expect(normalizeDateValue("12/31/99")).toBe("1999-12-31");
    expect(normalizeDateValue("Mar 15, 2026")).toBe("2026-03-15");
    expect(normalizeDateValue("15-Mar-2026")).toBe("2026-03-15");
    expect(normalizeDateValue("02/31/2026")).toBeNull();
    expect(normalizeDateValue("2026-02-29")).toBeNull();
    expect(normalizeDateValue("31-Feb-2026")).toBeNull();
    expect(normalizeDateValue("2024-02-29")).toBe("2024-02-29");

    expect(parseNumericValue("USD 50000")).toMatchObject({ value: 50000, isCurrency: true });
    expect(parseNumericValue("(USD 1,250.50)")).toMatchObject({ value: -1250.5, isCurrency: true });
    expect(parseNumericValue("EUR 1.234,56")).toMatchObject({ value: 1234.56, isCurrency: true });
    expect(parseNumericValue("1.5e6")).toMatchObject({ value: 1500000 });
    expect(parseNumericValue("-2.5E-3")).toMatchObject({ value: -0.0025 });
    expect(parseNumericValue("12345678901234567")).toBeNull();

    const euroCsv = parseCsv(
      "Datum;Region;Umsatz (EUR);Marge\n15-Mar-2026;DACH;1.234,56;14,5%\n02/31/2026;France;2.500,00;18,0%\n20-Apr-2026;Benelux;890,40;11,2%",
      "EU Sales",
    );
    const preview = profileSpreadsheet("EU_Sales.csv", euroCsv);
    // 2 valid dates out of 3 rows (67% < 80%) when 1 invalid date is present; test with valid dates + 1 invalid out of 6
    const mostlyValidDates = parseCsv(
      [
        "Datum;Region;Umsatz",
        "03/15/26;DACH;1.234,56",
        "Mar 18, 2026;DACH;2.000,25",
        "20-Mar-2026;France;USD 500",
        "03/25/26;Spain;1.5e3",
        "02/31/2026;BadDateRow;100,00",
      ].join("\n"),
      "EU Orders",
    );
    const p2 = profileSpreadsheet("EU_Orders.csv", mostlyValidDates);
    expect(p2.columns[0].sqlType).toBe("DATE");
    expect(p2.columns[2].sqlType).toBe("DOUBLE");

    const dir = await mkdtemp(join(tmpdir(), "sc-euro-audit-"));
    try {
      await writeSpreadsheetParquet(dir, p2.tableName, p2.columns, mostlyValidDates.rows);
      const conn = await duckdbConnector(dir);
      try {
        const res = await conn.execute(
          `SELECT COUNT(*) AS total_rows, COUNT(datum) AS valid_dates, ROUND(SUM(umsatz), 2) AS total_umsatz FROM ${conn.relation(p2.tableName)}`,
        );
        expect(res.rows[0][0]).toBe(5);
        expect(res.rows[0][1]).toBe(4); // 02/31/2026 safely coerced to NULL without crashing DuckDB!
        expect(Number(res.rows[0][2])).toBeCloseTo(1234.56 + 2000.25 + 500 + 1500 + 100, 2);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(preview.columns[2].formatHint).toBe("currency");
  });

  it("populates orphanLeftDollarTotal & orphanMetricLabel on SpreadsheetDetectedJoin when unmatchedLeftRows > 0", () => {
    const orders = parseCsv(
      "Order ID,Store ID,Net Sales ($)\nORD-1,STR-1,$1200\nORD-2,STR-999,$450\nORD-3,,$300",
      "Orders",
    );
    const stores = parseCsv("Store ID,City\nSTR-1,Seattle\nSTR-2,Portland", "Stores");
    const preview = profileWorkbook("Orphan_Test.xlsx", [orders, stores]);

    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins![0]).toMatchObject({
      leftTable: "orders",
      leftColumn: "store_id",
      rightTable: "stores",
      rightColumn: "store_id",
      unmatchedLeftRows: 2,
      orphanLeftDollarTotal: 750,
      orphanMetricLabel: "Net Sales",
    });
  });
});

describe("Deliverable 4: Compiler null-preserving exclude, multi-CTE edges, EXISTS semi-joins, Chart hatching, -$2.62k, drivers & honesty", () => {
  let db: DuckDBConnection;

  beforeAll(async () => {
    db = await (await DuckDBInstance.create(":memory:")).connect();
    await db.run(`
      CREATE TABLE fct_sales (sale_id VARCHAR, user_id VARCHAR, plan_id VARCHAR, amount DOUBLE, sold_on DATE);
      INSERT INTO fct_sales VALUES
        ('s1', 'u_gb', 'p1', 100, '2026-08-01'),
        ('s2', 'u_us', 'p1', 200, '2026-08-15'),
        ('s3', 'u_null_country', 'p2', 50, '2026-08-20'),
        ('s4', 'u_orphan', 'p2', 25, '2026-08-31'),
        ('s5', NULL, NULL, 10, '2026-08-31');
      CREATE TABLE dim_users (user_id VARCHAR, country VARCHAR, region_id VARCHAR);
      INSERT INTO dim_users VALUES
        ('u_gb', 'GB', 'r_eur'),
        ('u_gb', 'GB', 'r_eur'),
        ('u_us', 'US', 'r_amer'),
        ('u_null_country', NULL, 'r_eur');
      CREATE TABLE dim_regions (region_id VARCHAR, region VARCHAR);
      INSERT INTO dim_regions VALUES ('r_eur', 'Europe'), ('r_amer', 'Americas');
    `);
  });

  afterAll(() => {
    db.closeSync();
  });

  it("makes exclude: true null-preserving in buildPredicate while respecting explicit null exclusion", () => {
    const baseFilter = (over: Partial<FilterSpec>): FilterSpec =>
      ({ id: "f", field: "dim_users.country", source: "dimension", mode: "discrete", ...over }) as FilterSpec;

    const exUs = buildPredicate(fixtureModel, mockConn, "fct_sales", baseFilter({ values: ["US"], exclude: true }))!;
    expect(exUs.sql).toBe(`(dim_users."country" IS NULL OR dim_users."country" NOT IN ('US'))`);

    const exUsAndNull = buildPredicate(
      fixtureModel,
      mockConn,
      "fct_sales",
      baseFilter({ values: ["US", null], exclude: true }),
    )!;
    expect(exUsAndNull.sql).toBe(`(dim_users."country" NOT IN ('US') AND dim_users."country" IS NOT NULL)`);

    const exRange = buildPredicate(
      fixtureModel,
      mockConn,
      "fct_sales",
      baseFilter({ mode: "range", min: "A", max: "M", exclude: true }),
    )!;
    expect(exRange.sql).toBe(`(dim_users."country" IS NULL OR NOT (dim_users."country" >= 'A' AND dim_users."country" <= 'M'))`);
  });

  it("uses EXISTS / NOT EXISTS semi-joins for filter-only many_to_one predicates so duplicate dimension keys never fan out sums", async () => {
    const snowModel: Model = {
      ...fixtureModel,
      tables: {
        ...fixtureModel.tables,
        dim_users: {
          ...fixtureModel.tables.dim_users,
          columns: [...fixtureModel.tables.dim_users.columns, { name: "region_id", type: "string" }],
        },
        dim_regions: {
          name: "dim_regions",
          grain: "one row per region",
          synonyms: [],
          partitionKeys: [],
          columns: [
            { name: "region_id", type: "string" },
            { name: "region", type: "string" },
          ],
        },
      },
      joins: [
        ...fixtureModel.joins,
        { left: "dim_users", leftOn: "region_id", right: "dim_regions", rightOn: "region_id", type: "left" },
      ],
    };
    const liveConn = {
      ...mockConn,
      relation: (t: string) => mockConn.quote(t),
      dateTrunc: (g: string, e: string) => `CAST(date_trunc('${g}', ${e}) AS DATE)`,
    };

    const runTotal = async (where: FilterSpec[], modelOverride: Model = snowModel) => {
      const sql = compileTile(modelOverride, liveConn, tile({ metrics: ["revenue"], dimensions: [], where }));
      const rows = (await db.runAndReadAll(sql)).getRows();
      return { sql, val: Number(rows[0]?.[0] ?? 0) };
    };

    // 1. Positive filter on dim_users.country = 'GB' where u_gb has 2 duplicate rows in dim_users:
    //    EXISTS prevents doubling 100 -> 200!
    const posGb = await runTotal([
      { id: "f1", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["GB"] },
    ]);
    expect(posGb.sql).toContain("EXISTS");
    expect(posGb.sql).not.toContain("LEFT JOIN");
    expect(posGb.val).toBe(100);

    // 2. Multi-hop filter on dim_regions.region = 'Europe' (u_gb=100 + u_null_country=50 = 150, never 250!)
    const posEur = await runTotal([
      { id: "f2", source: "dimension", field: "dim_regions.region", mode: "discrete", values: ["Europe"] },
    ]);
    expect(posEur.sql).toContain("EXISTS");
    expect(posEur.val).toBe(150);

    // 3. Null-preserving exclude: exclude 'US' keeps GB (100) + u_null_country (50) + u_orphan (25) + NULL fk (10) = 185!
    const exUs = await runTotal([
      { id: "f3", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"], exclude: true },
    ]);
    expect(exUs.sql).toContain("NOT EXISTS");
    expect(exUs.val).toBe(185);

    // 4. Explicit exclude ['US', null]: keeps ONLY matched non-null 'GB' (100)!
    const exUsNull = await runTotal([
      { id: "f4", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US", null], exclude: true },
    ]);
    expect(exUsNull.val).toBe(100);

    // 5. Explicit exclude [null]: keeps 'GB' (100) + 'US' (200) = 300!
    const exNullOnly = await runTotal([
      { id: "f5", source: "dimension", field: "dim_users.country", mode: "discrete", values: [null], exclude: true },
    ]);
    expect(exNullOnly.val).toBe(300);

    // 6. Positive discrete [null] and ['GB', null]
    const onlyNull = await runTotal([
      { id: "f6", source: "dimension", field: "dim_users.country", mode: "discrete", values: [null] },
    ]);
    expect(onlyNull.val).toBe(85); // 50 + 25 + 10

    const gbOrNull = await runTotal([
      { id: "f7", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["GB", null] },
    ]);
    expect(gbOrNull.val).toBe(185);

    // 7. Inner-join model variant for exclude & null coverage
    const innerModel: Model = {
      ...snowModel,
      joins: snowModel.joins.map((j) => (j.right === "dim_users" ? { ...j, type: "inner" } : j)),
    };
    const innerExUs = await runTotal(
      [{ id: "f8", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"], exclude: true }],
      innerModel,
    );
    expect(innerExUs.val).toBe(150); // u_gb (100) + u_null_country (50); orphan & null FK excluded by inner join

    const innerOnlyNull = await runTotal(
      [{ id: "f9", source: "dimension", field: "dim_users.country", mode: "discrete", values: [null] }],
      innerModel,
    );
    expect(innerOnlyNull.val).toBe(50); // u_null_country only
  });

  it("checks __edge_min and __edge_max across ALL CTE groups so partial-period detection sees full table coverage", async () => {
    const cteModel: Model = {
      ...fixtureModel,
      metrics: {
        ...fixtureModel.metrics,
        early_sales: {
          name: "early_sales",
          label: "Early sales",
          baseTable: "fct_sales",
          expression: "SUM(fct_sales.amount)",
          filter: "fct_sales.sale_id = 's1'", // Only on 2026-08-01!
          synonyms: [],
        },
        late_sales: {
          name: "late_sales",
          label: "Late sales",
          baseTable: "fct_sales",
          expression: "SUM(fct_sales.amount)",
          filter: "fct_sales.sale_id = 's4'", // Only on 2026-08-31!
          synonyms: [],
        },
      },
    };
    const liveConn = {
      ...mockConn,
      relation: (t: string) => mockConn.quote(t),
      dateTrunc: (g: string, e: string) => `CAST(date_trunc('${g}', ${e}) AS DATE)`,
    };
    const sql = compileTile(cteModel, liveConn, tile({ metrics: ["early_sales", "late_sales"], dimensions: ["month:sold_on"] }));
    const raw = await db.runAndReadAll(sql);
    const res = splitPartialPeriods({
      columns: raw.columnNames(),
      rows: raw.getRows().map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v && typeof v === "object" ? String(v).slice(0, 10) : v))),
    });
    // g0 covers Aug 1 and g1 covers Aug 31 -> combined bucket spans Aug 1..Aug 31 (complete month, NOT dropped!)
    expect(res.partial).toEqual({ start: false, end: false });
    expect(res.rows).toEqual([["2026-08-01", 100, 25]]);
  });

  it("formats negative compact & plain currency as -$2.62k (never $-2.62k)", () => {
    const axisFmt = makeAxisFormatter({ ...DEFAULT_FORMAT, number: "currency" }, [50000]);
    expect(axisFmt(-2620)).toBe("-$2.62k");
    expect(axisFmt(2620)).toBe("$2.62k");
    expect(axisFmt(0)).toBe("$0k");
    expect(axisFmt.exact!(-2500)).toBe("-$2.5k");
    expect(axisFmt.exact!(-2620)).toMatch(/^-\$2\.62\d*k$/);

    const valFmt = makeFormatter({ ...DEFAULT_FORMAT, number: "currency" });
    expect(valFmt(-26200)).toBe("-$26.2k");
    expect(valFmt(-2620)).toBe("-$2,620.00");
    expect(valFmt(-0.0001)).toBe("$0.00");
    expect(valFmt.exact!(-2620)).toBe("-$2620");
  });

  it("renders lag hatching ONLY when hasLag is true across line/area/bar/combo, labels null as Unassigned on Donut/Waterfall, and anchors negative waterfall labels at y='lo' dy=12", () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    const miniDoc = createMiniDocument();
    (globalThis as any).document = miniDoc;
    (globalThis as any).window = { document: miniDoc };
    try {
      // 1. Donut null & blank category -> "Unassigned"
      const donutFig: any = renderChartFigure(
        "donut",
        ["region", "revenue"],
        [
          { region: "East", revenue: 300 },
          { region: null, revenue: 100 },
        ],
        { w: 360, h: 240 },
        { ...DEFAULT_FORMAT, number: "currency" },
      );
      expect(donutFig.outerHTML).toContain("Unassigned: $100.00");
      expect(donutFig.outerHTML).not.toContain("null:");

      // 2. Real Plot.plot rendering via renderChartFigure across area, line, bar, combo (hasLag=false vs hasLag=true)
      const dates = [
        new Date("2026-05-01T00:00:00Z"),
        new Date("2026-06-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
        new Date("2026-08-01T00:00:00Z"),
      ];
      const seriesData = dates.map((d, i) => ({ month: d, revenue: (i + 1) * 1000, rate: 0.1 + i * 0.02 }));

      for (const kind of ["area", "line", "bar"] as const) {
        const noLag: any = renderChartFigure(
          kind,
          ["month", "revenue"],
          seriesData,
          { w: 420, h: 240 },
          DEFAULT_FORMAT,
          undefined,
          {},
          ["revenue"],
          false,
          ["month"],
          undefined,
          { month: "month" },
          [],
          false,
        );
        expect(noLag.outerHTML).not.toContain("LAG HATCHED");
        expect(noLag.outerHTML).not.toContain("broadside-hatch-zone");

        const withLag: any = renderChartFigure(
          kind,
          ["month", "revenue"],
          seriesData,
          { w: 420, h: 240 },
          DEFAULT_FORMAT,
          undefined,
          {},
          ["revenue"],
          false,
          ["month"],
          undefined,
          { month: "month" },
          [],
          true,
        );
        expect(withLag.outerHTML).toContain("LAG HATCHED");
        expect(withLag.outerHTML).toContain("broadside-hatch-zone");
      }

      const comboNoLag: any = renderChartFigure(
        "combo",
        ["month", "revenue", "rate"],
        seriesData,
        { w: 420, h: 240 },
        DEFAULT_FORMAT,
        { ...DEFAULT_FORMAT, number: "percent" },
        {},
        ["revenue", "rate"],
        true,
        ["month"],
        undefined,
        { month: "month" },
        [],
        false,
      );
      expect(comboNoLag.outerHTML).not.toContain("LAG HATCHED");

      const comboWithLag: any = renderChartFigure(
        "combo",
        ["month", "revenue", "rate"],
        seriesData,
        { w: 420, h: 240 },
        DEFAULT_FORMAT,
        { ...DEFAULT_FORMAT, number: "percent" },
        {},
        ["revenue", "rate"],
        true,
        ["month"],
        undefined,
        { month: "month" },
        [],
        true,
      );
      expect(comboWithLag.outerHTML).toContain("LAG HATCHED");
      expect(comboWithLag.outerHTML).toContain("broadside-hatch-zone");

      // Also verify addBroadsideMarks direct export contract
      expect(typeof addBroadsideMarks).toBe("function");

      // 3. Waterfall with null category + negative delta: renders "Unassigned" and anchors negative label below y=0 (dy=12 at y="lo")
      const wfFig: any = renderChartFigure(
        "waterfall",
        ["segment", "delta"],
        [
          { segment: "New", delta: 500 },
          { segment: null, delta: -700 },
        ],
        { w: 420, h: 260 },
        { ...DEFAULT_FORMAT, number: "currency" },
      );
      const wfHtml = wfFig.outerHTML;
      expect(wfHtml).toContain("Unassigned");
      expect(wfHtml).not.toContain(">null<");
      expect(wfHtml).toContain("-$700.00");
      expect(wfHtml).toContain("-$200.00");
      // Plot encodes dy=12 as group translate(...,12) and anchors negative labels at y="lo" (208), well below y=0 (152)
      expect(wfHtml).toMatch(/transform="translate\(\d+(?:\.\d+)?,12\)"><text[^>]*transform="translate\(\d+(?:\.\d+)?,208\)"/);
    } finally {
      (globalThis as any).document = prevDoc;
      if (prevWin === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWin;
    }
  });

  it("suppresses >100% shareOfChange when !additive or offsetting signs make |share| > 1, and checks newestEnd > todayUtc regardless of lag", async () => {
    const whModel = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
    const whConn = await duckdbConnector("sample-data/lake");
    try {
      // Offsetting movements on net_new_mrr produce |rawShare| > 1 -> suppressed to null
      const mrrDrivers = await analyzeMetricDrivers(whModel, whConn, {
        metric: "net_new_mrr",
        maxDimensions: 4,
        topN: 3,
      });
      for (const dim of mrrDrivers.dimensions) {
        for (const seg of dim.segments) {
          if (seg.shareOfChange !== null) {
            expect(Math.abs(seg.shareOfChange)).toBeLessThanOrEqual(1);
          }
        }
      }
      const countryDim = mrrDrivers.dimensions.find((d) => d.dimension === "dim_users.country")!;
      const usSeg = countryDim.segments.find((s) => s.segment === "US")!;
      expect(Math.abs(usSeg.delta)).toBeGreaterThan(Math.abs(mrrDrivers.delta));
      expect(usSeg.shareOfChange).toBeNull();

      // Non-additive metric (cost_per_click) always suppresses shareOfChange to null
      const cpcDrivers = await analyzeMetricDrivers(whModel, whConn, {
        metric: "cost_per_click",
        maxDimensions: 2,
        topN: 2,
      });
      expect(cpcDrivers.additive).toBe(false);
      for (const dim of cpcDrivers.dimensions) {
        for (const seg of dim.segments) {
          expect(seg.shareOfChange).toBeNull();
        }
      }
    } finally {
      await whConn.close();
    }

    // dataHonesty: newestEnd > todayUtc fires even when lag === 0, and caps label-through at todayUtc!
    const today = new Date("2026-09-11T15:00:00Z");
    const openMonthFindings = reviewDataHonesty({
      tile: tile({ dimensions: ["month:sold_on"], compare: "prior" }) as any,
      model: fixtureModel, // reportingLagDays is undefined (lag === 0)
      columns: ["sold_on_month", "revenue"],
      rows: [
        ["2026-08-01", 100],
        ["2026-09-01", 40],
      ],
      partial: { start: false, end: false },
      timeDimension: "month:sold_on",
      today,
    });
    expect(openMonthFindings).toHaveLength(1);
    expect(openMonthFindings[0].rule).toBe("lagging");
    expect(openMonthFindings[0].fixes).toEqual([
      { kind: "exclude-unsettled", field: "fct_sales.sold_on", before: "2026-09-01" },
      { kind: "label-through", date: "2026-09-11" }, // Capped at todayUtc (never 2026-09-30!)
    ]);

    // labelTile also caps future label-through dates at todayUtc
    const cappedTitle = labelTile(
      tile({ title: "Monthly Revenue" }) as any,
      "Revenue",
      { kind: "label-through", date: "2026-09-30" },
      today,
    );
    expect(cappedTitle.title).toBe("Monthly Revenue (through Sep 11)");
  });
});
