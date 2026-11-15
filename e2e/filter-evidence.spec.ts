import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function open(page: Page, presentation = "dropdown") {
  const title = `Filter evidence ${crypto.randomUUID()}`;
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: DEFAULT_CANVAS,
    spec: { title, tiles: [{ id: "a", title: "New signups", metrics: ["new_signups"], dimensions: [], chart: "kpi", layout: { x: 24, y: 200, w: 360, h: 180 } }],
      filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", presentation, scope: "report", bindings: [{ tileId: "a", field: "dim_users.country" }] }] },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
}

for (const failure of ["http", "malformed"]) test(`dashboard filter ${failure} failure offers retry and distinguishes an empty list`, async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/values?*", route => ++attempts === 1
    ? route.fulfill(failure === "http" ? { status: 503, json: { error: "Choices unavailable" } } : { json: { values: [{ value: "US", n: -1 }] } })
    : route.fulfill({ json: { values: [] } }));
  await open(page);
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose Country", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(failure === "http" ? "Choices unavailable" : "invalid filter values");
  await expect(dialog).not.toContainText("No choices returned");
  await dialog.getByRole("button", { name: "Retry filter values", exact: true }).click();
  await expect(dialog).toContainText("No choices returned in this source and role.");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
});

test("distinct typed choices apply distinct values and explain the returned-list limit", async ({ page }, info) => {
  const values = [1, "1", null, "Missing (null)", "", false, "false", "9007199254740992", "9007199254740993"];
  await page.route("**/api/values?*", route => route.fulfill({ json: { values: values.map(value => ({ value, n: 1 })), truncated: true } }));
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["new_signups"], rows: [[100]], ms: 1 } }));
  await open(page);
  await page.getByRole("button", { name: "Choose Country", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose Country", exact: true });
  await expect(dialog).toContainText("9 choices returned. Result limit reached. Other values may exist.");
  await expect(dialog).toContainText("Search checks the returned choices only");
  for (const [label, value] of [["1 (number)", 1], ['"1" (text)', "1"], ["Missing (null)", null], ["Blank text", ""], ["false (boolean)", false],
    ["9007199254740992", "9007199254740992"], ["9007199254740993", "9007199254740993"]] as const) {
    const sent = page.waitForRequest(r => r.url().endsWith("/api/query") && r.postDataJSON()?.id === "a" && r.postDataJSON()?.where?.some((f: any) => f.values?.length === 1 && f.values[0] === value));
    await dialog.getByRole("checkbox", { name: label, exact: true }).check();
    expect((await sent).postDataJSON().where.find((f: any) => f.id === "control:country").values).toEqual([value]);
    await dialog.getByRole("button", { name: "Clear selection", exact: true }).click();
  }
  await dialog.getByRole("textbox", { name: "Search Country" }).fill("Not in these choices");
  await expect(dialog).toContainText("No matches among returned choices or selected values.");
  await expect(dialog).toContainText("Other values may exist.");
  await dialog.getByRole("textbox", { name: "Search Country" }).fill("");
  await dialog.screenshot({ path: info.outputPath("filter-choice-evidence.png") });
});

test("segmented overflow stays single-select and can reach choices beyond the first forty", async ({ page }) => {
  const values = Array.from({ length: 45 }, (_, i) => ({ value: `Country ${i}`, n: 100 - i }));
  await page.route("**/api/values?*", route => route.fulfill({ json: { values } }));
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["new_signups"], rows: [[100]], ms: 1 } }));
  await open(page, "segmented");
  await page.getByRole("button", { name: "and 5 more, use the dropdown", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose Country", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(45);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Country 43", exact: true }).check();
  const next = page.waitForRequest(r => r.url().endsWith("/api/query") && r.postDataJSON()?.where?.some((f: any) => f.values?.length === 1 && f.values[0] === "Country 44"));
  await dialog.getByRole("radio", { name: "Country 44", exact: true }).check();
  await next;
  await expect(dialog.getByRole("radio", { name: "Country 43", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("radiogroup", { name: "Country", exact: true }).getByRole("radio", { name: /^Country 44/ })).toHaveAttribute("aria-checked", "true");
});

test("filter choices invalidate on base, model and viewing context changes and ignore late responses", async ({ page }) => {
  const pending: (() => void)[] = [];
  let requests = 0, completed = 0;
  await page.route("**/api/values?*", async route => {
    const i = requests++, base = new URL(route.request().url()).searchParams.get("base");
    if (i !== 1) await new Promise<void>(resolve => { pending[i] = resolve; });
    await route.fulfill({ json: { values: [{ value: `${base} response ${i}`, n: 1 }] } }).catch(() => {});
    completed++;
  });
  await page.goto("/e2e/fixtures/filter-control.html");
  const control = page.getByRole("region", { name: "Dashboard filter" });
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "Change metric base", exact: true }).click();
  await expect(control).toContainText("dim_users response 1");
  pending[0]();
  await expect.poll(() => completed).toBe(2);
  await expect(control).not.toContainText("fct_sales response 0");
  for (const [name, index] of [["Reload semantic model", 2], ["Change viewing context", 3]] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(() => requests).toBe(index + 1);
    await expect(control).toContainText("Loading values…");
    await expect(control).not.toContainText(`response ${index - 1}`);
    pending[index]();
    await expect(control).toContainText(`dim_users response ${index}`);
  }
  await page.getByRole("button", { name: "Change viewing context", exact: true }).click();
  await expect.poll(() => requests).toBe(5);
  await page.getByRole("button", { name: "Use date control", exact: true }).click();
  await expect(control.getByLabel("Country from", { exact: true })).toBeVisible();
  pending[4]();
  await expect.poll(() => completed).toBe(5);
  await expect(control).not.toContainText("response 4");
  expect(requests).toBe(5);
});
