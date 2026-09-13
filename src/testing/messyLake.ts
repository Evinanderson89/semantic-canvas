import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A deliberately messy warehouse (docs/messy-lake.md): the kinds of wrong
 * that real data is, generated deterministically so the tools' answers can
 * be asserted. Every mess is listed here so a test can name what it is
 * checking for:
 *
 *   dim_customers   unique key; country in mixed case and padding and two
 *                   spellings; signup_date as text in two formats; null
 *                   emails; a region_id that is orphaned 8% of the time
 *   dim_regions     six rows, clean
 *   dim_products    zero rows (a table someone created and never loaded)
 *   fct_orders      unique order_id; customer_id orphaned 9% of the time;
 *                   amount with refunds (negative) and a few absurd outliers;
 *                   amount_text as "$1,234.50"; status in four spellings;
 *                   ordered_at with 1% nulls and 0.5% in the future; the
 *                   newest week incomplete (data ends `today` minus 9 days)
 *   fct_refunds     unique refund_id; order_id resolves 100%; one order can
 *                   have several refunds (the join from orders fans out)
 *   fct_events      no unique column at all; 2% null customer_id;
 *                   occurred_at partly in a local zone written as if UTC
 *   stg_orders_2024 a stale copy of the orders table, with one column renamed
 *
 * The lake is written as one Parquet file per table under `<dir>/lake`, and
 * the orders as a CSV with the same mess for Ingest, under `<dir>/messy-orders.csv`.
 */
export const MESSY_TODAY = "2026-09-13";

export async function writeMessyLake(dir: string, today = MESSY_TODAY): Promise<{ tables: Record<string, number> }> {
  const lake = join(dir, "lake");
  await mkdir(lake, { recursive: true });
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const run = (sql: string) => c.run(sql);
  await run("SELECT setseed(0.4242)");
  const end = `DATE '${today}' - INTERVAL 9 DAY`;

  await run(`CREATE TABLE dim_regions AS SELECT * FROM (VALUES (1, 'EMEA', 'Europe, Middle East and Africa'), (2, 'AMER', 'Americas'), (3, 'APAC', 'Asia Pacific'), (4, 'LATAM', 'Latin America'), (5, 'ANZ', 'Australia and New Zealand'), (6, 'OTHER', 'Unassigned')) t(region_id, region, region_name)`);

  await run(`CREATE TABLE dim_customers AS
    SELECT 'C' || lpad(i::VARCHAR, 5, '0') AS customer_id,
           CASE (i % 7) WHEN 0 THEN 'GB' WHEN 1 THEN 'gb' WHEN 2 THEN ' GB ' WHEN 3 THEN 'United Kingdom' WHEN 4 THEN 'US' WHEN 5 THEN 'DE' ELSE 'FR' END AS country,
           CASE WHEN i % 3 = 0 THEN strftime(DATE '2024-01-01' + (i % 700)::INT, '%d/%m/%Y') ELSE strftime(DATE '2024-01-01' + (i % 700)::INT, '%Y-%m-%d') END AS signup_date,
           CASE WHEN i % 11 = 0 THEN NULL ELSE 'person' || i || '@example.com' END AS email,
           CASE WHEN i % 13 = 0 THEN 'Zoë Ærø-Åström' ELSE 'Person ' || i END AS full_name,
           CASE WHEN random() < 0.08 THEN 99 ELSE 1 + (i % 6) END AS region_id,
           CASE WHEN i % 5 = 0 THEN 'pro' WHEN i % 5 = 1 THEN 'PRO' ELSE 'free' END AS plan
    FROM range(1, 1201) t(i)`);

  await run(`CREATE TABLE dim_products (product_id VARCHAR, name VARCHAR, price DOUBLE)`);

  await run(`CREATE TABLE fct_orders AS
    SELECT 'O' || lpad(i::VARCHAR, 6, '0') AS order_id,
           CASE WHEN random() < 0.09 THEN 'C' || lpad((5000 + (i % 400))::VARCHAR, 5, '0') ELSE 'C' || lpad((1 + (i * 7919) % 1200)::VARCHAR, 5, '0') END AS customer_id,
           CASE WHEN random() < 0.01 THEN NULL
                WHEN random() < 0.005 THEN (${end} + INTERVAL 30 DAY)::TIMESTAMP + INTERVAL (i % 86400) SECOND
                ELSE (${end} - INTERVAL ((i * 37) % 730) DAY)::TIMESTAMP + INTERVAL (i % 86400) SECOND END AS ordered_at,
           CASE WHEN random() < 0.002 THEN 1e9 WHEN random() < 0.06 THEN -round(random() * 200, 2) ELSE round(5 + random() * 495, 2) END AS amount,
           '$' || format('{:,.2f}', round(5 + random() * 495, 2)) AS amount_text,
           CASE (i % 9) WHEN 0 THEN 'PAID' WHEN 1 THEN 'Paid ' WHEN 2 THEN 'refunded' WHEN 3 THEN 'paid' ELSE 'paid' END AS status,
           CASE WHEN i % 4 = 0 THEN 'web' WHEN i % 4 = 1 THEN 'Web' WHEN i % 4 = 2 THEN 'app' ELSE 'partner-' || (i % 50) END AS channel,
           (i % 5 + 1) AS items
    FROM range(1, 20001) t(i)`);

  await run(`CREATE TABLE fct_refunds AS
    SELECT 'R' || lpad(i::VARCHAR, 5, '0') AS refund_id,
           'O' || lpad((1 + (i * 13) % 1100)::VARCHAR, 6, '0') AS order_id,
           (${end} - INTERVAL ((i * 11) % 700) DAY)::DATE AS refunded_on,
           round(random() * 120, 2) AS amount,
           CASE WHEN i % 3 = 0 THEN 'damaged' WHEN i % 3 = 1 THEN 'Damaged' ELSE 'changed mind' END AS reason
    FROM range(1, 1501) t(i)`);

  await run(`CREATE TABLE fct_events AS
    SELECT CASE (i % 4) WHEN 0 THEN 'view' WHEN 1 THEN 'click' WHEN 2 THEN 'add_to_cart' ELSE 'view' END AS event_type,
           CASE WHEN random() < 0.02 THEN NULL ELSE 'C' || lpad((1 + (i * 31) % 1200)::VARCHAR, 5, '0') END AS customer_id,
           (${end} - INTERVAL ((i * 3) % 400) DAY)::TIMESTAMP + INTERVAL ((i * 977) % 86400) SECOND + CASE WHEN i % 2 = 0 THEN INTERVAL 5 HOUR ELSE INTERVAL 0 HOUR END AS occurred_at,
           'page-' || (i % 30) AS page
    FROM range(1, 50001) t(i)`);

  await run(`CREATE TABLE stg_orders_2024 AS SELECT order_id, customer_id, ordered_at, amount AS order_total, status FROM fct_orders WHERE ordered_at < DATE '2025-01-01'`);

  const tables = ["dim_regions", "dim_customers", "dim_products", "fct_orders", "fct_refunds", "fct_events", "stg_orders_2024"];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    await mkdir(join(lake, t), { recursive: true });
    await run(`COPY ${t} TO '${join(lake, t, "data.parquet").replace(/'/g, "''")}' (FORMAT PARQUET)`);
    const r = await c.runAndReadAll(`SELECT COUNT(*) FROM ${t}`);
    counts[t] = Number(r.getRows()[0][0]);
  }
  // The same orders as a file for Ingest, with the mess a file has: blank cells, a bad date, a text amount, a stray column.
  await run(`COPY (SELECT order_id, customer_id, CASE WHEN order_id = 'O000007' THEN 'yesterday' ELSE strftime(ordered_at, '%Y-%m-%d %H:%M:%S') END AS ordered_at, amount_text AS amount, status, channel, items, '' AS notes FROM fct_orders WHERE ordered_at IS NOT NULL ORDER BY order_id LIMIT 5000) TO '${join(dir, "messy-orders.csv").replace(/'/g, "''")}' (HEADER, DELIMITER ',')`);
  await writeFile(join(dir, "README.md"), `A deliberately messy warehouse, generated by src/testing/messyLake.ts for ${today}. See docs/messy-lake.md.\n`);
  c.closeSync(); db.closeSync();
  return { tables: counts };
}
