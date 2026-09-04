import type { Connector, QueryResult } from "../src/connectors/types.ts";
import type { Model } from "../src/semantic/model.ts";

export const model: Model = {
  source: "test", name: "t",
  tables: {
    fct_sales: {
      name: "fct_sales", grain: "one row per sale", synonyms: ["sales"],
      partitionKeys: ["sold_on"],
      columns: [
        { name: "sale_id", type: "string" }, { name: "user_id", type: "string" },
        { name: "plan_id", type: "string" }, { name: "amount", type: "double" },
        { name: "sold_on", type: "date" },
      ],
    },
    dim_users: {
      name: "dim_users", grain: "one row per user", synonyms: [], partitionKeys: [],
      columns: [{ name: "user_id", type: "string" }, { name: "country", type: "string" }],
    },
    dim_plans: {
      name: "dim_plans", grain: "one row per plan", synonyms: [], partitionKeys: [],
      columns: [{ name: "plan_id", type: "string" }, { name: "tier", type: "string" }],
    },
  },
  metrics: {
    revenue: { name: "revenue", label: "Revenue (USD)", baseTable: "fct_sales",
               expression: "SUM(fct_sales.amount)", filter: null, synonyms: ["sales"] },
    live_revenue: { name: "live_revenue", label: "Live revenue (USD)", baseTable: "fct_sales",
                    expression: "SUM(fct_sales.amount)", filter: "fct_sales.amount > 0", synonyms: [] },
    users: { name: "users", label: "Users", baseTable: "dim_users",
             expression: "COUNT(*)", filter: null, synonyms: [] },
    arpu: { name: "arpu", label: "ARPU (USD)", baseTable: "fct_sales",
            expression: "SUM(fct_sales.amount) / NULLIF(COUNT(DISTINCT fct_sales.user_id), 0)",
            filter: "fct_sales.amount > 0", synonyms: [] },
    retention: { name: "retention", label: "Net revenue retention", baseTable: "fct_sales",
                 expression: "1.0", filter: null, synonyms: [] },
  },
  joins: [
    { left: "fct_sales", leftOn: "user_id", right: "dim_users", rightOn: "user_id", type: "left" },
    { left: "fct_sales", leftOn: "plan_id", right: "dim_plans", rightOn: "plan_id", type: "left" },
  ],
};

export const conn: Connector = {
  id: "test", label: "test",
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  dateTrunc: (g, e) => `date_trunc('${g}', ${e})`,
  relation: (t) => `read_parquet('/lake/${t}/**/*.parquet')`,
  async execute(): Promise<QueryResult> { return { columns: [], rows: [], sql: "", ms: 0 }; },
  async close() {},
};

export const tile = (over: Partial<any> = {}) => ({
  id: "t1", metrics: ["revenue"], dimensions: [] as string[],
  layout: { x: 0, y: 0, w: 100, h: 100 }, ...over,
});
