import { expect, test } from "@playwright/test";
import { propose, type TableProfile } from "../src/modeler/propose.ts";

test("join review exposes a small mismatch and an unavailable check without presenting either as complete", async ({ page }, info) => {
  const column = (name: string, n: number, distinct: number) => ({ name, type: "string", rawType: "VARCHAR", nonNull: n, distinct });
  const tables: TableProfile[] = [
    { name: "fct_orders", rows: 10_000, columns: [column("order_id", 10_000, 10_000), column("customer_id", 10_000, 10)] },
    { name: "fct_refunds", rows: 20, columns: [column("refund_id", 20, 20), column("customer_id", 20, 10)] },
    { name: "dim_customers", rows: 10, columns: [column("customer_id", 10, 10)] },
  ];
  const proposal = propose({ id: "join-review", label: "Join quality review", tables, probes: [
    { left: "fct_orders", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id", leftRows: 10_000, matched: 9999 },
    { left: "fct_refunds", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id", leftRows: null, matched: null, failure: "query-failed" },
  ] });
  const draft = { id: "join-review", label: "Join quality review", createdAt: "2026-11-14T12:00:00Z", updatedAt: "2026-11-14T12:00:00Z", createdBy: "test", publishedAt: null, sourceId: null, proposal };
  await page.route("**/api/modeler/drafts", route => route.fulfill({ json: { drafts: [{ ...draft, tables: 3, joins: 2, metrics: proposal.metrics.length, warnings: proposal.warnings.length }] } }));
  await page.route("**/api/modeler/drafts/join-review", route => route.fulfill({ json: draft }));
  await page.goto("/modeler");
  await page.getByRole("button", { name: /Join quality review/ }).click();
  const orders = page.locator(".join").filter({ has: page.getByRole("checkbox", { name: "Include join fct_orders.customer_id to dim_customers.customer_id", exact: true }) });
  const refunds = page.locator(".join").filter({ has: page.getByRole("checkbox", { name: "Include join fct_refunds.customer_id to dim_customers.customer_id", exact: true }) });
  await expect(orders.locator("i")).toHaveText("99.99%");
  await expect(orders).toContainText("9,999 matched; 1 unmatched");
  await expect(orders).toContainText("10,000 non-null");
  await expect(orders.getByRole("checkbox")).toBeChecked();
  await expect(refunds.locator("i")).toHaveText("not measured");
  await expect(refunds).toContainText("Join check failed");
  await expect(refunds).not.toContainText("0%");
  await expect(refunds.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByText(/A left join keeps unmatched rows/)).toBeVisible();
  // Review remains possible; changing a checkbox is local until explicitly saved.
  await refunds.getByRole("checkbox").check();
  await expect(refunds.getByRole("checkbox")).toBeChecked();
  await refunds.getByRole("checkbox").uncheck();
  await orders.locator("..").screenshot({ path: info.outputPath("join-quality-evidence.png") });
});
