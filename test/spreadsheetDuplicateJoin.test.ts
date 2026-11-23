import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import writeXlsxFile from "write-excel-file/universal";
import YAML from "yaml";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import {
  buildWorkbookProposal,
  canonicalizeSpreadsheetValue,
  formatSpreadsheetMatchRate,
  parseXlsxWorkbook,
  prepareWorkbookImport,
  profileWorkbook,
  writeSpreadsheetParquet,
} from "../src/modeler/spreadsheet.ts";
import { proposalToYaml } from "../src/modeler/yaml.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";

const s = (value: string) => ({ value, type: String as typeof String });
const n = (value: number) => ({ value, type: Number as typeof Number });

async function encodeXlsxBase64(sheets: Parameters<typeof writeXlsxFile>[0]): Promise<string> {
  const blob = await writeXlsxFile(sheets).toBlob();
  return Buffer.from(await blob.arrayBuffer()).toString("base64");
}

describe("duplicate right-key detection, canonical coercion & fan-out prevention (unit)", () => {
  it("catches conflicting duplicate IDs on >=20-row lookup sheets, quantifies $3,000 -> $6,000 impact, and defaults to exclude", async () => {
    const customerRows = Array.from({ length: 19 }, (_, idx) => {
      const id = `CUST-${String(idx + 1).padStart(2, "0")}`;
      return [s(id), s(idx === 0 ? "Acme Corp" : `Client ${idx + 1}`), s("Enterprise")];
    });
    // Row 20 duplicates CUST-01 with conflicting attributes
    customerRows.push([s("CUST-01"), s("Acme Corp (Dup)"), s("SMB")]);

    const b64 = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order Date"), s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("2026-07-10"), s("ORD-1"), s("CUST-01"), n(1000)],
          [s("2026-08-15"), s("ORD-2"), s("CUST-01"), n(2000)],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          ...customerRows,
        ],
      },
    ]);

    const parsed = parseXlsxWorkbook(new Uint8Array(Buffer.from(b64, "base64")));
    const preview = profileWorkbook("Sales_Customers_20.xlsx", parsed);

    // Customers has 19 unique / 20 rows (95%): strict 100% primaryKey check refuses primaryKey
    const customersPreview = preview.sheets!.find((sh) => sh.tableName === "customers")!;
    expect(customersPreview.suggestedPrimaryKey).toBeNull();

    expect(preview.detectedJoins).toHaveLength(1);
    const detected = preview.detectedJoins![0];
    expect(detected).toMatchObject({
      leftTable: "sales",
      leftColumn: "customer_id",
      rightTable: "customers",
      rightColumn: "customer_id",
      matchRate: 1,
      rightKeyUnique: false,
      duplicateKeyCount: 1,
      duplicateRightRows: 1,
      allExactDuplicates: false,
      include: false,
      resolution: "exclude",
      fanoutImpact: {
        metricColumn: "sales",
        metricLabel: "Sales",
        trueTotal: 3000,
        inflatedTotal: 6000,
        delta: 3000,
        multiplier: 2,
      },
    });
    expect(detected.duplicateKeys).toEqual([
      {
        key: "CUST-01",
        rightRows: 2,
        rowNumbers: [1, 20],
        exactDuplicate: false,
        conflictingColumns: ["company", "segment"],
      },
    ]);
  });

  it("preserves fact -> lookup direction on <20-row (3-row) lookup sheets without flipping Customers -> Sales", async () => {
    // Customers placed first with 3 rows (duplicate CUST-01) and Sales second with 2 unique customer rows:
    // Sales must remain the primary fact sheet with SUM(sales), never flipped into a dimension!
    const b64 = await encodeXlsxBase64([
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          [s("CUST-01"), s("Acme West"), s("Enterprise")],
          [s("CUST-01"), s("Acme East"), s("Mid-Market")],
          [s("CUST-02"), s("Beta Labs"), s("Growth")],
        ],
      },
      {
        sheet: "Sales",
        data: [
          [s("Customer ID"), s("Sales ($)")],
          [s("CUST-01"), n(1500)],
          [s("CUST-02"), n(1500)],
        ],
      },
    ]);

    const parsed = parseXlsxWorkbook(new Uint8Array(Buffer.from(b64, "base64")));
    const preview = profileWorkbook("Tiny_3Row_Lookup.xlsx", parsed);

    expect(preview.tableName).toBe("sales");
    const salesSheet = preview.sheets!.find((sh) => sh.tableName === "sales")!;
    const custSheet = preview.sheets!.find((sh) => sh.tableName === "customers")!;
    expect(salesSheet.kind).toBe("fact");
    expect(custSheet.kind).toBe("dimension");

    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins![0]).toMatchObject({
      leftTable: "sales",
      leftColumn: "customer_id",
      rightTable: "customers",
      rightColumn: "customer_id",
      rightKeyUnique: false,
      allExactDuplicates: false,
      include: false,
      resolution: "exclude",
      fanoutImpact: {
        metricColumn: "sales",
        trueTotal: 3000,
        inflatedTotal: 4500,
        delta: 1500,
        multiplier: 1.5,
      },
    });
  });

  it("detects canonical SQL coercion collisions ('$1,001' vs '1001' vs '1,001' vs '1001.0' and date formats)", async () => {
    expect(canonicalizeSpreadsheetValue("$1,001", "BIGINT")).toBe("1001");
    expect(canonicalizeSpreadsheetValue("1,001", "BIGINT")).toBe("1001");
    expect(canonicalizeSpreadsheetValue("1001.0", "DOUBLE")).toBe("1001");
    expect(canonicalizeSpreadsheetValue("1001", "DOUBLE")).toBe("1001");
    expect(canonicalizeSpreadsheetValue("8/5/2026", "DATE")).toBe("2026-08-05");
    expect(canonicalizeSpreadsheetValue("2026-08-05", "DATE")).toBe("2026-08-05");

    const b64 = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("ORD-1"), s("1001"), n(2000)],
          [s("ORD-2"), s("1002"), n(1000)],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Account Name")],
          [s("$1,001"), s("Formatted Currency ID")],
          [s("1001"), s("Plain Numeric ID")],
          [s("1002"), s("Second Account")],
        ],
      },
    ]);

    const parsed = parseXlsxWorkbook(new Uint8Array(Buffer.from(b64, "base64")));
    const preview = profileWorkbook("Coercion_Collision.xlsx", parsed);
    const custSheet = preview.sheets!.find((sh) => sh.tableName === "customers")!;
    expect(custSheet.suggestedPrimaryKey).toBeNull();

    expect(preview.detectedJoins).toHaveLength(1);
    expect(preview.detectedJoins![0]).toMatchObject({
      leftTable: "sales",
      rightTable: "customers",
      rightKeyUnique: false,
      duplicateKeyCount: 1,
      duplicateRightRows: 1,
      fanoutImpact: {
        trueTotal: 3000,
        inflatedTotal: 5000,
        delta: 2000,
      },
    });
    expect(preview.detectedJoins![0].duplicateKeys?.[0]).toMatchObject({
      key: "1001",
      rightRows: 2,
      rowNumbers: [1, 2],
      exactDuplicate: false,
    });
  });

  it("computes matchRate honestly: counts blank left FKs as unmatched and never rounds <1.0 up to 1.0", async () => {
    const salesData: ReturnType<typeof s | typeof n>[][] = [
      [s("Order ID"), s("Customer ID"), s("Sales ($)")],
    ];
    for (let i = 1; i <= 249; i++) {
      salesData.push([s(`ORD-${i}`), s("CUST-01"), n(10)]);
    }
    // 250th row has a blank Customer ID -> 249 / 250 = 0.996 (never 1.0!)
    salesData.push([s("ORD-250"), s(""), n(10)]);

    const b64 = await encodeXlsxBase64([
      { sheet: "Sales", data: salesData },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Segment")],
          [s("CUST-01"), s("Enterprise")],
        ],
      },
    ]);

    const parsed = parseXlsxWorkbook(new Uint8Array(Buffer.from(b64, "base64")));
    const preview = profileWorkbook("MatchRate_Honesty.xlsx", parsed);
    expect(preview.detectedJoins).toHaveLength(1);
    const join = preview.detectedJoins![0];
    expect(join.matchRate).toBe(0.996);
    expect(join.unmatchedLeftRows).toBe(1);
    expect(join.rightKeyUnique).toBe(true);
    expect(formatSpreadsheetMatchRate(join.matchRate)).toBe("99.6%");
    expect(formatSpreadsheetMatchRate(0.9999)).toBe("<100%");
    expect(formatSpreadsheetMatchRate(1)).toBe("100%");
  });

  it("supports resolution: 'one_to_many' by writing cardinality: one_to_many so compileTile blocks fan-out aggregates", async () => {
    const b64 = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order Date"), s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("2026-07-01"), s("ORD-1"), s("CUST-01"), n(3000)],
        ],
      },
      {
        sheet: "Customer Contacts",
        data: [
          [s("Customer ID"), s("Contact Name"), s("Role")],
          [s("CUST-01"), s("Alice"), s("Buyer")],
          [s("CUST-01"), s("Bob"), s("Champion")],
        ],
      },
    ]);

    const parsed = parseXlsxWorkbook(new Uint8Array(Buffer.from(b64, "base64")));
    const preview = profileWorkbook("Contacts_1toN.xlsx", parsed);
    const prepared = prepareWorkbookImport({
      parsedSheets: parsed,
      preview,
      joins: preview.detectedJoins!.map((j) => ({ ...j, include: true, resolution: "one_to_many" })),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const dir = await mkdtemp(join(tmpdir(), "sc-1ton-test-"));
    try {
      for (let i = 0; i < prepared.sheets.length; i++) {
        await writeSpreadsheetParquet(dir, prepared.sheets[i].tableName, prepared.sheets[i].columns, prepared.sheetRows[i]);
      }
      const proposal = buildWorkbookProposal({
        sourceId: "contacts-1ton",
        label: "Contacts 1toN",
        sheets: prepared.sheets,
        joins: prepared.joins,
        primaryGrain: "One sale",
        hygieneNotes: prepared.hygieneNotes,
      });
      const yamlPath = join(dir, "model.yaml");
      await writeFile(yamlPath, proposalToYaml(proposal), "utf8");
      const model = await duckglueAdapter.load(yamlPath);
      expect(model).not.toBeNull();
      expect(model!.joins[0].cardinality).toBe("one_to_many");
      expect(model!.hygieneNotes?.some((note) => note.includes("one_to_many"))).toBe(true);

      // Fan-out breakdown across customer_contacts is refused by validateTile
      const fanoutIssues = validateTile(model!, {
        id: "bad-breakdown",
        metrics: ["sales"],
        dimensions: ["customer_contacts.role"],
        layout: { x: 0, y: 0, w: 4, h: 4 },
      });
      expect(fanoutIssues.map((i) => i.problem).join(" ")).toMatch(/multiplies sales's rows \(one_to_many\)/);

      // Base-table KPI remains exact ($3,000)
      const conn = await duckdbConnector(dir);
      try {
        const kpiSql = compileTile(model!, conn, {
          id: "kpi",
          metrics: ["sales"],
          dimensions: [],
          layout: { x: 0, y: 0, w: 4, h: 4 },
        });
        const res = await conn.execute(kpiSql);
        expect(Number(res.rows[0][0])).toBe(3000);
      } finally {
        await conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("server /import 400 guard & atomic /refresh/:sourceId 409 guard + deduplicateKeys", () => {
  let root = "";
  let url = "";
  let output = "";
  let app: ChildProcess;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sc-sheet-dup-api-"));
    const socket = createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((r) => socket.close(() => r()));
    url = `http://127.0.0.1:${port}`;

    const repoRoot = resolve(import.meta.dirname, "..");
    const baseSources = {
      sources: [
        {
          id: "duckglue-local",
          label: "Sample Warehouse",
          adapter: "duckglue",
          model: resolve(repoRoot, "sample-data/warehouse.yaml"),
          connector: { type: "duckdb", lakeRoot: resolve(repoRoot, "sample-data/lake"), poolSize: 1 },
        },
      ],
    };
    await writeFile(join(root, "sources.yaml"), YAML.stringify(baseSources));

    app = spawn(process.execPath, ["--import", "tsx", resolve(repoRoot, "src/server.ts")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        SC_MODE: "local",
        SC_HOST: "127.0.0.1",
        SC_SERVE_UI: "false",
        SC_DATA_DIR: join(root, "data"),
        SOURCES_PATH: join(root, "sources.yaml"),
        SC_ENV_PATH: join(root, "absent.env"),
        RLS_PATH: resolve(repoRoot, "security/policies.yaml"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    app.stdout?.on("data", (d) => (output += d));
    app.stderr?.on("data", (d) => (output += d));
    for (let i = 0; i < 200; i++) {
      if (app.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${url}/readyz`)).ok) return;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Server did not become ready: ${output}`);
  }, 30_000);

  afterAll(async () => {
    if (app && app.exitCode === null) {
      app.kill("SIGTERM");
      await new Promise((r) => app.once("exit", r));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("blocks /import with HTTP 400 when duplicate rightOn keys lack resolution='deduplicate', and imports cleanly when deduplicated", async () => {
    const dupWorkbook = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order Date"), s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("2026-07-01"), s("ORD-1"), s("CUST-01"), n(1000)],
          [s("2026-08-01"), s("ORD-2"), s("CUST-01"), n(2000)],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          [s("CUST-01"), s("Acme Primary"), s("Enterprise")],
          [s("CUST-01"), s("Acme Duplicate"), s("Enterprise")],
          [s("CUST-02"), s("Beta Corp"), s("Growth")],
        ],
      },
    ]);

    // Attempt to force include: true without resolution="deduplicate" (even spoofing rightKeyUnique: true) -> HTTP 400
    const blockedRes = await fetch(`${url}/api/modeler/spreadsheet/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Dup_Sales.xlsx",
        format: "xlsx",
        content: dupWorkbook,
        sourceId: "dup-blocked-test",
        label: "Dup Blocked Test",
        grain: "One sale",
        timeColumn: "order_date",
        joins: [
          {
            leftTable: "sales",
            leftColumn: "customer_id",
            rightTable: "customers",
            rightColumn: "customer_id",
            matchRate: 1,
            include: true,
            rightKeyUnique: true,
          },
        ],
      }),
    });
    expect(blockedRes.status).toBe(400);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.error).toBe("duplicate_join_key");
    expect(blockedBody.message).toMatch(/\$3,000.*\$6,000/);
    expect(blockedBody.duplicateJoins).toHaveLength(1);
    expect(blockedBody.duplicateJoins[0].fanoutImpact).toMatchObject({
      trueTotal: 3000,
      inflatedTotal: 6000,
      delta: 3000,
    });

    // Now import with resolution: "deduplicate" -> HTTP 200 and $3,000 across all queries + hygieneNotes persisted
    const okRes = await fetch(`${url}/api/modeler/spreadsheet/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Dup_Sales.xlsx",
        format: "xlsx",
        content: dupWorkbook,
        sourceId: "deduped-sales",
        label: "Deduped Sales",
        grain: "One sale",
        timeColumn: "order_date",
        joins: [
          {
            leftTable: "sales",
            leftColumn: "customer_id",
            rightTable: "customers",
            rightColumn: "customer_id",
            matchRate: 1,
            include: true,
            resolution: "deduplicate",
          },
        ],
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody.cleaningNotes?.join(" | ")).toMatch(/prevented \$3,000 → \$6,000 Sales double-count/);

    const loadedModel = await (await fetch(`${url}/api/model?source=deduped-sales`)).json();
    expect(loadedModel.hygieneNotes?.join(" | ")).toMatch(/prevented \$3,000 → \$6,000 Sales double-count/);

    // Query grouped by customers.segment must return exact $3,000 (never $6,000!)
    const groupedQuery = await (
      await fetch(`${url}/api/query?source=deduped-sales`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metrics: ["sales"], dimensions: ["customers.segment"] }),
      })
    ).json();
    expect(groupedQuery.rows).toEqual([["Enterprise", 3000]]);
  }, 25_000);

  it("atomically blocks /refresh/:sourceId with HTTP 409 on full and partial sheet refreshes with duplicate keys, then succeeds with deduplicateKeys=true", async () => {
    const cleanWorkbook = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order Date"), s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("2026-07-05"), s("ORD-1"), s("CUST-01"), n(1200)],
          [s("2026-07-18"), s("ORD-2"), s("CUST-01"), n(1800)],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          [s("CUST-01"), s("Acme Corp"), s("Enterprise")],
          [s("CUST-02"), s("Beta Labs"), s("Growth")],
        ],
      },
    ]);

    const impRes = await fetch(`${url}/api/modeler/spreadsheet/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Refresh_Target.xlsx",
        format: "xlsx",
        content: cleanWorkbook,
        sourceId: "refresh-guard-test",
        label: "Refresh Guard Test",
        grain: "One sale",
        timeColumn: "order_date",
      }),
    });
    expect(impRes.status).toBe(200);

    // 1. Full 2-tab refresh introducing duplicate CUST-01 -> HTTP 409, live Parquet untouched
    const dirtyFullWorkbook = await encodeXlsxBase64([
      {
        sheet: "Sales",
        data: [
          [s("Order Date"), s("Order ID"), s("Customer ID"), s("Sales ($)")],
          [s("2026-07-05"), s("ORD-1"), s("CUST-01"), n(1200)],
          [s("2026-07-18"), s("ORD-2"), s("CUST-01"), n(1800)],
        ],
      },
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          [s("CUST-01"), s("Acme Corp"), s("Enterprise")],
          [s("CUST-01"), s("Acme Corp CRM Dup"), s("Enterprise")],
          [s("CUST-02"), s("Beta Labs"), s("Growth")],
        ],
      },
    ]);

    const conflictFull = await fetch(`${url}/api/modeler/spreadsheet/refresh/refresh-guard-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Refresh_Target_Dirty.xlsx",
        format: "xlsx",
        content: dirtyFullWorkbook,
      }),
    });
    expect(conflictFull.status).toBe(409);
    const conflictFullBody = await conflictFull.json();
    expect(conflictFullBody).toMatchObject({
      error: "duplicate_join_key",
      canDeduplicate: true,
    });
    expect(conflictFullBody.duplicateJoins[0].fanoutImpact).toMatchObject({
      trueTotal: 3000,
      inflatedTotal: 6000,
      delta: 3000,
      multiplier: 2,
    });

    // Verify live query was NOT corrupted by failed refresh
    const stillClean = await (
      await fetch(`${url}/api/query?source=refresh-guard-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metrics: ["sales"], dimensions: ["customers.segment"] }),
      })
    ).json();
    expect(stillClean.rows).toEqual([["Enterprise", 3000]]);

    // 2. Partial single-sheet refresh (uploading ONLY Customers tab with duplicate CUST-01!) -> HTTP 409 with live DuckDB $3,000 -> $6,000 impact
    const dirtyPartialCustomersOnly = await encodeXlsxBase64([
      {
        sheet: "Customers",
        data: [
          [s("Customer ID"), s("Company"), s("Segment")],
          [s("CUST-01"), s("Acme Corp"), s("Enterprise")],
          [s("CUST-01"), s("Acme Corp"), s("Enterprise")],
          [s("CUST-02"), s("Beta Labs"), s("Growth")],
        ],
      },
    ]);

    const conflictPartial = await fetch(`${url}/api/modeler/spreadsheet/refresh/refresh-guard-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Customers_Only.xlsx",
        format: "xlsx",
        content: dirtyPartialCustomersOnly,
      }),
    });
    expect(conflictPartial.status).toBe(409);
    const conflictPartialBody = await conflictPartial.json();
    expect(conflictPartialBody.error).toBe("duplicate_join_key");
    expect(conflictPartialBody.duplicateJoins[0].fanoutImpact).toMatchObject({
      trueTotal: 3000,
      inflatedTotal: 6000,
      delta: 3000,
    });

    // 3. Confirm refresh with deduplicateKeys: true -> HTTP 200, deduplicates Customers, preserves $3,000 and updates model.hygieneNotes
    const resolvedRefresh = await fetch(`${url}/api/modeler/spreadsheet/refresh/refresh-guard-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "Customers_Only.xlsx",
        format: "xlsx",
        content: dirtyPartialCustomersOnly,
        deduplicateKeys: true,
      }),
    });
    expect(resolvedRefresh.status).toBe(200);
    const resolvedBody = await resolvedRefresh.json();
    expect(resolvedBody.ok).toBe(true);
    expect(resolvedBody.rowsUpdated).toBe(2); // 3 raw rows deduplicated to 2 unique customers
    expect(resolvedBody.cleaningNotes?.join(" | ")).toMatch(/prevented \$3,000 → \$6,000 Sales double-count/);

    const afterRefreshQuery = await (
      await fetch(`${url}/api/query?source=refresh-guard-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metrics: ["sales"], dimensions: ["customers.segment"] }),
      })
    ).json();
    expect(afterRefreshQuery.rows).toEqual([["Enterprise", 3000]]);

    const refreshedModel = await (await fetch(`${url}/api/model?source=refresh-guard-test`)).json();
    expect(refreshedModel.hygieneNotes?.join(" | ")).toMatch(/prevented \$3,000 → \$6,000 Sales double-count/);
  }, 30_000);
});
