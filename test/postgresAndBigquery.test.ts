import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { postgresConnector } from "../src/connectors/postgres.ts";
import { bigqueryConnector } from "../src/connectors/bigquery.ts";

describe("PostgreSQL connector", () => {
  it("runs queries inside a READ ONLY transaction with statement_timeout and normalizes values", async () => {
    const queries: unknown[] = [];
    let released = false;
    const mockClient = {
      query: vi.fn(async (arg: any) => {
        queries.push(arg);
        if (typeof arg === "object" && arg?.text) {
          return {
            fields: [
              { name: "order_date", dataTypeID: 1082 },
              { name: "revenue", dataTypeID: 1700 },
              { name: "orders", dataTypeID: 20 },
              { name: "region", dataTypeID: 25 },
            ],
            rows: [
              [new Date("2026-08-01T00:00:00Z"), "18400.50", "42", "North America"],
              [new Date("2026-08-02T00:00:00Z"), "6200", "18", "Europe"],
            ],
          };
        }
        return { fields: [], rows: [] };
      }),
      release: vi.fn(() => {
        released = true;
      }),
    };
    const mockPool = {
      connect: vi.fn(async () => mockClient),
      end: vi.fn(async () => {}),
    } as any;

    const conn = await postgresConnector({
      host: "db.example.com",
      port: 5432,
      database: "analytics",
      schema: "mart",
      username: "reader",
      pool: mockPool,
    });

    expect(conn.id).toBe("postgres");
    expect(conn.label).toBe("PostgreSQL");
    expect(conn.quote('order"id')).toBe('"order""id"');
    expect(conn.dateTrunc("month", "created_at")).toBe("CAST(date_trunc('month', created_at) AS DATE)");
    expect(conn.dateAdd("day", "created_at", -7)).toBe("CAST((created_at + INTERVAL '-7 day') AS DATE)");
    expect(conn.toTimezone!("created_at", "America/New_York")).toBe("((created_at)::timestamptz AT TIME ZONE 'America/New_York')");
    expect(conn.relation("orders")).toBe('"mart"."orders"');
    expect(conn.relation("orders", { schema: "core", table: "fact_orders" })).toBe('"core"."fact_orders"');

    const res = await conn.execute("SELECT * FROM mart.orders", 1, undefined, { timeoutMs: 12_000 });
    expect(queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queries[1]).toBe("SET LOCAL statement_timeout = 12000");
    expect(queries[2]).toEqual({ text: "SELECT * FROM mart.orders", rowMode: "array" });
    expect(queries[3]).toBe("COMMIT");
    expect(released).toBe(true);
    expect(res.columns).toEqual(["order_date", "revenue", "orders", "region"]);
    // Limit = 1 enforced and Date / numeric string / BigInt normalized cleanly.
    expect(res.rows).toEqual([["2026-08-01", 18400.5, 42, "North America"]]);

    await conn.close();
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the client when a query fails, and discovers catalog from information_schema", async () => {
    const executed: unknown[] = [];
    let released = 0;
    const mockClient = {
      query: vi.fn(async (arg: any) => {
        executed.push(arg);
        if (typeof arg === "object" && String(arg.text).includes("BOOM")) {
          throw new Error("syntax error at BOOM");
        }
        if (typeof arg === "object" && String(arg.text).includes("information_schema.columns")) {
          return {
            fields: [{ name: "table_name" }, { name: "column_name" }, { name: "data_type" }],
            rows: [
              ["orders", "order_id", "bigint"],
              ["orders", "revenue", "numeric"],
              ["customers", "customer_id", "bigint"],
            ],
          };
        }
        return { fields: [], rows: [] };
      }),
      release: vi.fn(() => {
        released++;
      }),
    };
    const mockPool = {
      connect: vi.fn(async () => mockClient),
      end: vi.fn(async () => {}),
    } as any;

    const conn = await postgresConnector({ database: "analytics", schema: "public", pool: mockPool });
    await expect(conn.execute("SELECT BOOM")).rejects.toThrow(/syntax error at BOOM/);
    expect(executed).toContain("ROLLBACK");
    expect(released).toBe(1);

    const tables = await conn.catalog!();
    expect(tables).toEqual([
      {
        name: "orders",
        relation: { schema: "public", table: "orders" },
        columns: [
          { name: "order_id", type: "BIGINT" },
          { name: "revenue", type: "NUMERIC" },
        ],
      },
      {
        name: "customers",
        relation: { schema: "public", table: "customers" },
        columns: [{ name: "customer_id", type: "BIGINT" }],
      },
    ]);
    expect(released).toBe(2);
  });
});

describe("Google BigQuery connector", () => {
  it("mints RS256 OAuth2 tokens via Service Account JWT, runs queries with type coercion, polls async jobs, and catalogs tables", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const calls: { url: string; method: string; auth?: string }[] = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") ?? undefined });

      if (url === "https://oauth2.googleapis.com/token") {
        const bodyText = String(init?.body ?? "");
        expect(bodyText).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
        expect(bodyText).toContain("assertion=");
        return new Response(JSON.stringify({ access_token: "bq-test-token-123", expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith("/queries") && init?.method === "POST") {
        const reqBody = JSON.parse(String(init.body ?? "{}"));
        if (String(reqBody.query).includes("ASYNC_JOB")) {
          return new Response(
            JSON.stringify({ jobComplete: false, jobReference: { jobId: "job-42" } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            jobComplete: true,
            schema: {
              fields: [
                { name: "order_id", type: "INT64" },
                { name: "revenue", type: "FLOAT64" },
                { name: "paid", type: "BOOL" },
                { name: "created_at", type: "TIMESTAMP" },
                { name: "notes", type: "STRING" },
              ],
            },
            rows: [
              { f: [{ v: "1001" }, { v: "18400.25" }, { v: "true" }, { v: "1785542400" }, { v: null }] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/queries/job-42?")) {
        return new Response(
          JSON.stringify({
            jobComplete: true,
            schema: { fields: [{ name: "cnt", type: "INT64" }] },
            rows: [{ f: [{ v: "99" }] }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/datasets/mart_sales/tables?maxResults=200")) {
        return new Response(
          JSON.stringify({ tables: [{ tableReference: { tableId: "orders" } }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/datasets/mart_sales/tables/orders")) {
        return new Response(
          JSON.stringify({
            schema: {
              fields: [
                { name: "order_id", type: "INT64" },
                { name: "revenue", type: "FLOAT64" },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: `Unhandled mock URL ${url}` } }), { status: 404 });
    });

    const conn = await bigqueryConnector({
      projectId: "acme-prod",
      dataset: "mart_sales",
      location: "US",
      clientEmail: "reader@acme-prod.iam.gserviceaccount.com",
      privateKey,
      fetchImpl: mockFetch as typeof fetch,
    });

    expect(conn.id).toBe("bigquery");
    expect(conn.label).toBe("Google BigQuery");
    expect(conn.quote("col")).toBe("`col`");
    expect(conn.dateTrunc("week", "order_date")).toBe("DATE_TRUNC(CAST(order_date AS DATE), WEEK(MONDAY))");
    expect(conn.dateAdd("month", "order_date", 1)).toBe("DATE_ADD(CAST(order_date AS DATE), INTERVAL 1 MONTH)");
    expect(conn.toTimezone!("ts", "UTC")).toBe("DATETIME(TIMESTAMP(ts), 'UTC')");
    expect(conn.relation("orders")).toBe("`acme-prod`.`mart_sales`.`orders`");

    const syncRes = await conn.execute("SELECT * FROM orders");
    expect(syncRes.columns).toEqual(["order_id", "revenue", "paid", "created_at", "notes"]);
    expect(syncRes.rows[0]).toEqual([1001, 18400.25, true, "2026-08-01T00:00:00.000Z", null]);

    // Second query reuses the cached OAuth token and handles async job polling.
    const asyncRes = await conn.execute("SELECT ASYNC_JOB");
    expect(asyncRes.rows).toEqual([[99]]);
    expect(calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);

    const cat = await conn.catalog!();
    expect(cat).toEqual([
      {
        name: "orders",
        relation: { database: "acme-prod", schema: "mart_sales", table: "orders" },
        columns: [
          { name: "order_id", type: "INT64" },
          { name: "revenue", type: "FLOAT64" },
        ],
      },
    ]);

    await conn.close();
  });

  it("rejects missing required BigQuery credentials or identifiers", async () => {
    await expect(bigqueryConnector({ projectId: "", dataset: "ds", accessToken: "t" })).rejects.toThrow(/projectId and dataset/i);
    await expect(bigqueryConnector({ projectId: "p", dataset: "ds" })).rejects.toThrow(/service account/i);
  });
});
