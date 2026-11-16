import { expect, test } from "@playwright/test";

const report = (source: string, drift: any[] = []) => ({ source, checkedAt: "2026-11-14T12:00:00Z", tables: 9, drift, dashboards: drift.length ? [{ id: "revenue", name: "Revenue review", metrics: ["net_revenue"], charts: [{ id: "regional", title: "Revenue by country", findings: ["dim_users.country (column_missing)"] }] }] : [] });
const finding = { table: "dim_users", column: "country", kind: "column_missing", declared: "VARCHAR", actual: null, metrics: [], text: "dim_users.country is gone from the warehouse." };

test("switching sources discards a pending check and exposes chart-level impact for the selected source", async ({ page }, info) => {
  let firstSource = "", started = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sources", async route => {
    const response = await route.fetch(), body = await response.json();
    firstSource = body.sources[0].id;
    await route.fulfill({ json: { ...body, sources: [body.sources[0], { ...body.sources[0], id: "other", label: "Other warehouse" }] } });
  });
  await page.route("**/api/modeler/drift?*", async route => {
    const source = new URL(route.request().url()).searchParams.get("source")!;
    if (source === firstSource) { started = true; await pending; }
    await route.fulfill({ json: report(source, source === "other" ? [finding] : []) });
  });
  await page.goto("/modeler");
  const panel = page.getByRole("region", { name: "Drift", exact: true });
  await panel.getByRole("button", { name: "Check drift", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await panel.getByLabel("Source to check").selectOption("other");
  await expect(panel.getByRole("button", { name: "Check drift", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Check drift", exact: true }).click();
  await expect(panel).toContainText("1 drift finding in other");
  release();
  await expect(panel).toContainText("Revenue by country: dim_users.country (column_missing)");
  await expect(panel).toContainText("Saved dashboards to review");
  await expect(panel).toContainText("potential impact");
  await expect(panel).not.toContainText("No schema differences");
  await panel.screenshot({ path: info.outputPath("drift-impact.png") });
  await panel.getByLabel("Source to check").selectOption(firstSource);
  await expect(panel).not.toContainText("Revenue review");
  await panel.getByRole("button", { name: "Check drift", exact: true }).click();
  await expect(panel).toContainText("No schema differences detected by the supported checks");
  await expect(panel).toContainText(firstSource);
  await expect(panel).toContainText("does not verify data completeness");
});

test("a failed recheck clears old findings and can recover without claiming the source is healthy", async ({ page }) => {
  let count = 0;
  await page.route("**/api/modeler/drift?*", route => {
    const source = new URL(route.request().url()).searchParams.get("source")!;
    count++;
    return count === 2 ? route.fulfill({ status: 503, json: { error: "Catalogue unavailable; retry later." } }) : route.fulfill({ json: report(source, count === 1 ? [finding] : []) });
  });
  await page.goto("/modeler");
  const panel = page.getByRole("region", { name: "Drift", exact: true });
  const check = panel.getByRole("button", { name: "Check drift", exact: true });
  await check.click(); await expect(panel).toContainText(finding.text);
  await check.click(); await expect(panel.getByRole("alert")).toContainText("Catalogue unavailable");
  await expect(panel).not.toContainText(finding.text);
  await expect(panel).not.toContainText("No schema differences");
  await check.click(); await expect(panel).toContainText("No schema differences");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("a response for a different source is rejected instead of displayed", async ({ page }) => {
  await page.route("**/api/modeler/drift?*", route => route.fulfill({ json: report("wrong-source") }));
  await page.goto("/modeler");
  const panel = page.getByRole("region", { name: "Drift", exact: true });
  await panel.getByRole("button", { name: "Check drift", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("did not match the selected source");
  await expect(panel).not.toContainText("No schema differences");
});

for (const malformed of ["missing findings", "invalid finding", "invalid impact", "invalid metadata"] as const) test(`rejects ${malformed} without an all-clear and recovers on retry`, async ({ page }) => {
  let count = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/modeler/drift?*", route => {
    const source = new URL(route.request().url()).searchParams.get("source")!;
    count++;
    if (count !== 2) return route.fulfill({ json: report(source, count === 1 ? [finding] : []) });
    const body: any = report(source, [finding]);
    if (malformed === "missing findings") delete body.drift;
    if (malformed === "invalid finding") body.drift = [null];
    if (malformed === "invalid impact") body.dashboards = [{ id: "revenue", name: "Revenue review", metrics: null }];
    if (malformed === "invalid metadata") { body.checkedAt = "not a date"; body.tables = -1; }
    return route.fulfill({ json: body });
  });
  await page.goto("/modeler");
  const panel = page.getByRole("region", { name: "Drift", exact: true });
  const check = panel.getByRole("button", { name: "Check drift", exact: true });
  await check.click(); await expect(panel).toContainText(finding.text);
  await check.click();
  await expect(panel.getByRole("alert")).toContainText("incomplete or invalid drift report");
  await expect(panel).not.toContainText(finding.text);
  await expect(panel).not.toContainText("No schema differences");
  await expect(panel).not.toContainText("Invalid Date");
  expect(errors).toEqual([]);
  await expect(check).toBeEnabled();
  await check.click(); await expect(panel).toContainText("No schema differences detected by the supported checks");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("sources arriving after the Modeler mounts become selectable without reopening it", async ({ page }) => {
  let release!: () => void, expectedSource = "", requestedSource = "";
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sources", async route => {
    const response = await route.fetch(), body = await response.json();
    expectedSource = body.sources.find((s: any) => s.status === "ready").id;
    await pending;
    await route.fulfill({ json: body });
  });
  await page.route("**/api/modeler/drift?*", route => {
    requestedSource = new URL(route.request().url()).searchParams.get("source")!;
    return route.fulfill({ json: report(requestedSource) });
  });
  await page.goto("/modeler");
  await expect(page.getByRole("heading", { name: "A semantic model, from the warehouse itself.", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "Drift", exact: true });
  await expect(panel).toHaveCount(0);
  release();
  await expect(panel.getByLabel("Source to check")).toHaveValue(expectedSource);
  await panel.getByRole("button", { name: "Check drift", exact: true }).click();
  await expect(panel).toContainText("No schema differences detected by the supported checks");
  expect(requestedSource).toBe(expectedSource);
});

for (const snapshot of ["missing", "invalid", "clean", "findings"] as const) test(`extension draft distinguishes a ${snapshot} drift snapshot`, async ({ page }) => {
  const draft = { id: "snapshot-review", label: "Snapshot review", createdAt: "2026-11-15T10:00:00Z", updatedAt: "2026-11-15T10:00:00Z", createdBy: "test", publishedAt: null, sourceId: null,
    proposal: { model: { name: "Snapshot review", description: "Synthetic extension draft" }, tables: [], joins: [], metrics: [], warnings: [], extends: "sample" },
    ...(snapshot === "missing" ? {} : { drift: snapshot === "invalid" ? [null] : snapshot === "clean" ? [] : [finding] }) };
  await page.route("**/api/modeler/drafts", route => route.fulfill({ json: { drafts: [{ ...draft, tables: 0, joins: 0, metrics: 0, warnings: 0, extends: "sample", drift: 0 }] } }));
  await page.route("**/api/modeler/drafts/snapshot-review", route => route.fulfill({ json: draft }));
  await page.goto("/modeler");
  await page.getByRole("button", { name: /Snapshot review/ }).click();
  if (snapshot === "missing" || snapshot === "invalid") {
    await expect(page.getByRole("alert")).toContainText("No usable drift snapshot is available");
    await expect(page.getByRole("alert")).toContainText("All drafts");
    await expect(page.getByText(/No schema differences/)).toHaveCount(0);
  } else {
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/Recorded when this draft was made/)).toBeVisible();
    await expect(page.getByText(snapshot === "clean" ? /No schema differences detected/ : finding.text)).toBeVisible();
  }
  await page.getByRole("button", { name: "← All drafts", exact: true }).click();
  await expect(page.getByRole("region", { name: "Drift", exact: true })).toBeVisible();
});
