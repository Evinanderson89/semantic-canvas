import { test, expect, type Page } from "@playwright/test";

const time = "2026-11-15T10:00:00.000Z";
const makeDraft = (extend = true) => ({
  id: "synthetic-review", label: "Synthetic model review", createdAt: time, updatedAt: time, createdBy: "test", publishedAt: null, sourceId: null, drift: [],
  proposal: { model: { name: "Synthetic model", description: "Review synthetic definitions." }, tables: [], joins: [], warnings: [],
    metrics: [{ name: "orders", label: "Orders", baseTable: "fct_orders", expression: "COUNT(*)", evidence: "Synthetic count", include: true }],
    ...(extend ? { extends: "duckglue-local" } : {}),
  },
});
const published = (extend = true, status = "ready") => ({
  draft: { id: "synthetic-review", sourceId: extend ? "duckglue-local" : "synthetic-review", publishedAt: time, updatedAt: time },
  source: { id: extend ? "duckglue-local" : "synthetic-review", status },
});
async function open(page: Page, extend = true) {
  const draft = makeDraft(extend);
  await page.route("**/api/modeler/drafts", route => route.fulfill({ json: { drafts: [{ ...draft, tables: 0, joins: 0, metrics: 1, warnings: 0, extends: extend ? "duckglue-local" : null, drift: 0 }] } }));
  await page.route("**/api/modeler/drafts/synthetic-review", route => route.fulfill({ json: draft }));
  await page.goto("/modeler");
  await page.getByRole("button", { name: /Synthetic model review/ }).click();
  return page.locator(".modeler");
}

for (const extend of [true, false]) test(`publication confirms the server's ${extend ? "extended" : "new"} source in both status and metadata`, async ({ page }) => {
  await page.route("**/api/modeler/drafts/synthetic-review/publish", route => route.fulfill({ json: published(extend) }));
  const modeler = await open(page, extend);
  await modeler.getByRole("button", { name: extend ? "Add to duckglue-local" : "Publish as a source", exact: true }).click();
  await expect(modeler.locator(".eyebrow").first()).toContainText(extend ? "Added to source duckglue-local" : "Published as source synthetic-review");
  await expect(modeler.getByRole("status").filter({ hasText: extend ? "Added to" : "Published." })).toContainText(extend ? "duckglue-local" : "synthetic-review");
  await expect(modeler.getByRole("button", { name: extend ? "Update duckglue-local" : "Publish again", exact: true })).toBeEnabled();
});

test("publication distinguishes saved definitions from an unavailable source", async ({ page }) => {
  await page.route("**/api/modeler/drafts/synthetic-review/publish", route => route.fulfill({ json: published(true, "error") }));
  const modeler = await open(page);
  await modeler.getByRole("button", { name: "Add to duckglue-local", exact: true }).click();
  await expect(modeler.getByRole("alert")).toContainText("definitions were published, but the source is unavailable");
  await expect(modeler.locator(".eyebrow").first()).toContainText("Added to source duckglue-local");
  await expect(modeler.getByRole("status").filter({ hasText: "Definitions published to" })).toContainText("Open Connections");
});

for (const failure of ["network", "wrong-source", "missing-confirmation"] as const) test(`publication does not claim success after ${failure}`, async ({ page }) => {
  await page.route("**/api/modeler/drafts/synthetic-review/publish", route => failure === "network"
    ? route.fulfill({ status: 503, json: { error: "Publication unavailable" } })
    : route.fulfill({ json: failure === "wrong-source" ? { ...published(), source: { id: "other", status: "ready" } } : { ok: true } }));
  const modeler = await open(page);
  await modeler.getByRole("button", { name: "Add to duckglue-local", exact: true }).click();
  await expect(modeler.getByRole("alert")).toContainText(failure === "network" ? "Publication unavailable" : "no matching source confirmation");
  await expect(modeler.locator(".eyebrow").first()).toContainText("Draft");
  await expect(modeler.getByRole("button", { name: "Add to duckglue-local", exact: true })).toBeEnabled();
  await expect(modeler.getByRole("status").filter({ hasText: "Added to" })).toHaveCount(0);
});

test("publishing unsaved edits freezes the exact draft through save and publication", async ({ page }) => {
  const modeler = await open(page);
  let finishSave!: () => void, finishPublish!: () => void;
  const saveGate = new Promise<void>(resolve => { finishSave = resolve; });
  const publishGate = new Promise<void>(resolve => { finishPublish = resolve; });
  let writes = 0;
  await page.route("**/api/modeler/drafts/synthetic-review", async route => {
    if (route.request().method() !== "PUT") return route.fallback();
    writes++;
    expect(route.request().postDataJSON()).toMatchObject({ label: "Reviewed orders", proposal: { metrics: [{ label: "Reviewed order count" }] } });
    await saveGate; await route.fulfill({ json: { issues: [] } });
  });
  await page.route("**/api/modeler/drafts/synthetic-review/publish", async route => { writes++; await publishGate; await route.fulfill({ json: published() }); });
  await modeler.getByLabel("Model label").fill("Reviewed orders");
  await modeler.getByLabel("Metric label", { exact: true }).fill("Reviewed order count");
  await modeler.getByRole("button", { name: "Add to duckglue-local", exact: true }).click();
  await expect(modeler.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await expect(modeler.getByLabel("Model label")).toBeDisabled();
  await expect(modeler.getByLabel("Metric label", { exact: true })).toBeDisabled();
  await expect(modeler.getByRole("button", { name: /All drafts/ })).toBeDisabled();
  finishSave();
  await expect(modeler.getByRole("button", { name: "Publishing…", exact: true })).toBeDisabled();
  await expect(modeler.getByLabel("Metric expression")).toBeDisabled();
  finishPublish();
  await expect(modeler.getByRole("button", { name: "Update duckglue-local", exact: true })).toBeEnabled();
  await expect(modeler.getByLabel("Model label")).toHaveValue("Reviewed orders");
  await expect(modeler.getByLabel("Metric label", { exact: true })).toHaveValue("Reviewed order count");
  expect(writes).toBe(2);
});

test("a failed draft save preserves edits and prevents publication until retry succeeds", async ({ page }) => {
  const modeler = await open(page);
  let retry = false, publications = 0;
  await page.route("**/api/modeler/drafts/synthetic-review", route => route.request().method() !== "PUT" ? route.fallback()
    : retry ? route.fulfill({ json: { issues: [] } }) : route.fulfill({ status: 503, json: { error: "Draft storage unavailable" } }));
  await page.route("**/api/modeler/drafts/synthetic-review/publish", route => { publications++; return route.fulfill({ json: published() }); });
  await modeler.getByLabel("Metric label", { exact: true }).fill("My reviewed definition");
  await modeler.getByRole("button", { name: "Add to duckglue-local", exact: true }).click();
  await expect(modeler.getByRole("alert")).toContainText("Draft storage unavailable");
  expect(publications).toBe(0);
  await expect(modeler.getByLabel("Metric label", { exact: true })).toBeEnabled();
  await expect(modeler.getByLabel("Metric label", { exact: true })).toHaveValue("My reviewed definition");
  await expect(modeler.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  retry = true;
  await modeler.getByRole("button", { name: "Add to duckglue-local", exact: true }).click();
  await expect(modeler.locator(".eyebrow").first()).toContainText("Added to source duckglue-local");
  expect(publications).toBe(1);
});
