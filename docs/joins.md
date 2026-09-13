# Joins: paths and cardinality

Status: **built**. Multi-hop paths, declared cardinality, fan-out refused.

## The rule

A join is declared once, from the table that holds the foreign key to the table it points at:

```yaml
joins:
  - {left: fct_sales, left_on: user_id,   right: dim_users,   right_on: user_id,   type: left}
  - {left: dim_users, left_on: region_id, right: dim_regions, right_on: region_id, type: left}
  - {left: fct_sales, left_on: sale_id,   right: fct_refunds, right_on: sale_id,   type: left, cardinality: one_to_many}
```

`cardinality` says how many rows of the right table one row of the left meets. Absent means `many_to_one` — the fact-to-dimension case, which never multiplies rows. Declare `one_to_many` or `many_to_many` where a join would (a sale to its refunds, a user to their events); `one_to_one` where it cannot.

## What the compiler does with it

- **Paths.** A dimension or filter on a table the base does not join directly is reached through the declared joins, left to right, hop by hop: `fct_sales → dim_users → dim_regions`. The shortest path is taken; each hop is joined once, in order. A snowflake resolves as naturally as a star.
- **Two ways is refused.** If two shortest paths exist, the tile is refused and both are named ("`fct_sales` reaches `dim_regions` two ways (`dim_users → dim_regions`, or `dim_plans → dim_regions`); the model must say which"). A chart must not be right by luck.
- **Fan-out is refused.** A path through a `one_to_many` or `many_to_many` join is refused: "joining `fct_sales` to `fct_refunds` multiplies `fct_sales`'s rows (one_to_many); an aggregate over it would double count." The way to count refunds per sale is a metric on `fct_refunds`, or a ratio across the two tables (docs/metric-types.md), never a join that inflates the base.
- **Joins are never walked backwards.** A join declared from `fct_sales` to `dim_users` does not make `fct_sales` reachable from `dim_users`; that direction is one-to-many by definition.

Row-level policies (`security/policies.yaml`, and the gateway's) reach their column through the same paths, so a policy on `dim_regions.region` constrains `fct_sales` through `dim_users`; a policy on a table the base cannot reach makes the query refused rather than run unscoped, as before.

## The Modeler

Joins the Modeler proposes are foreign key to key (`fct_orders.customer_id → dim_customers.customer_id`) and are written as `many_to_one`. A join it did not propose, or one the other way round, is declared by hand with its cardinality.

## Not yet

- Choosing between two paths in the tile (`via:`) rather than in the model.
- Symmetric aggregates (counting distinct base keys) to survive a fan-out instead of refusing it.
