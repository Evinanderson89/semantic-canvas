import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { workbookXml, sheetCells } from "../test/xlsxValues.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

async function open(page: Page, rows: unknown[][], extra: Record<string, unknown> = {}, chart = "table") {
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ["country", "new_signups"], rows, ms: 1, ...extra } }));
  const title = `Workbook export ${crypto.randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, canvas: DEFAULT_CANVAS,
    spec: { title, tiles: [{ id: "data", title: "Signup evidence", metrics: ["new_signups"], dimensions: ["country"], chart,
      where: [{ id: "channel", field: "signup_source", source: "dimension", mode: "discrete", values: ["organic"] }],
      layout: { x: 24, y: 24, w: 850, h: 420 } }] } } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  const tile = page.locator(".node .tile");
  await expect(tile.locator("table")).toBeVisible();
  return tile;
}
async function exportPanel(page: Page) {
  const tile = page.locator(".node .tile");
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Export", exact: true }).click();
  return page.getByRole("dialog", { name: "Chart export", exact: true });
}

test("exports typed returned values and their scope, with no spreadsheet formulas or external relationships", async ({ page }, info) => {
  const rows = [['=1+1', '9007199254740993'], ['München 東京 🌍', 42], ['00123', -2], ['literal_x000A_', null]];
  await open(page, rows, { truncated: true, limit: 4, warnings: ["Returned limit reached"], rlsApplied: ["region-policy"], source: { id: "synthetic-sample", label: "Synthetic warehouse" }, principal: "reviewer" });
  await expect(page.locator(".node .tile tbody")).toContainText("9007199254740993");
  await expect(page.locator(".data-table-precision")).toContainText("shown as returned");
  const panel = await exportPanel(page);
  await expect(panel).toContainText("CSV has no cell types");
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download Excel (.xlsx)", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("signup-evidence-limited-window.xlsx");
  const path = info.outputPath("typed-query-export.xlsx"); await file.saveAs(path);
  const files = workbookXml(await readFile(path));
  expect(sheetCells(files)).toMatchObject({ A2: { type: "s", value: "=1+1" }, B2: { type: "s", value: "9007199254740993" },
    A3: { type: "s", value: "München 東京 🌍" }, B3: { type: "n", value: 42 }, A4: { type: "s", value: "00123" }, B4: { type: "n", value: -2 },
    A5: { type: "s", value: "literal_x000A_" } });
  const context = Object.values(sheetCells(files, 2)).map(c => c.value);
  expect(context).toContain(true);
  expect(context).toContain("region-policy");
  expect(context).toContain("Synthetic warehouse");
  expect(context).toContain("synthetic-sample");
  expect(context).toContain("reviewer");
  expect(context).toContainEqual(expect.stringContaining('"field":"signup_source"'));
  expect(context).toContainEqual(expect.stringContaining('"values":["organic"]'));
  expect(context).toContainEqual(expect.stringContaining('Numeric precision needs review'));
  expect(context).toContain('Returned limit reached');
  const parsed = await page.evaluate(xmlFiles => Object.values(xmlFiles).filter(xml => xml.startsWith('<?xml')).map(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { errors: doc.getElementsByTagName('parsererror').length, formulas: doc.getElementsByTagName('f').length,
      external: [...doc.getElementsByTagName('Relationship')].some(e => e.getAttribute('TargetMode') === 'External') };
  }), files);
  expect(parsed.every(p => !p.errors && !p.formulas && !p.external)).toBe(true);
  await page.screenshot({ path: info.outputPath("spreadsheet-export.png") });
});

test("metric evidence also exports Excel and rejects unrepresentable values with a useful retry path", async ({ page }) => {
  const rows: unknown[][] = [['US', 'x'.repeat(32768)]];
  const tile = await open(page, rows);
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Metric definition and scope", exact: true });
  await evidence.getByRole("button", { name: "Download Excel (.xlsx)", exact: true }).click();
  await expect(evidence.getByRole("alert")).toContainText("32,767");
  await expect(evidence.getByRole("button", { name: "Download raw CSV", exact: true })).toBeEnabled();
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  rows[0][1] = 123;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await tile.getByRole("button", { name: "More chart actions", exact: true }).click();
  await tile.getByRole("button", { name: "Metric definition and scope", exact: true }).click();
  await expect(evidence.getByRole("button", { name: "Download Excel (.xlsx)", exact: true })).toBeEnabled();
  await expect(evidence.getByRole("alert")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await evidence.getByRole("button", { name: "Download Excel (.xlsx)", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("signup-evidence.xlsx");
});

test("refreshing during lazy workbook loading cancels the old export and failed results cannot export", async ({ page }, info) => {
  let release!: () => void, started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/src/app/spreadsheetExport.ts*", async route => { started = true; await held; await route.continue(); });
  await open(page, [['US', 100]]);
  const panel = await exportPanel(page);
  const downloads: string[] = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await panel.getByRole("button", { name: "Download Excel (.xlsx)", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(panel.getByRole("button", { name: "Preparing spreadsheet…", exact: true })).toBeDisabled();
  await page.route("**/api/query", route => route.fulfill({ status: 503, json: { error: 'Synthetic export source failure' } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('.node .tile')).toContainText('Synthetic export source failure');
  release();
  // A second import waits for the same module evaluation to finish before
  // checking the cancelled export; no arbitrary timing sleep is needed.
  await page.evaluate(async () => { await import('/src/app/spreadsheetExport.ts'); });
  expect(downloads).toEqual([]);
  await expect(page.getByRole('button', { name: 'Download Excel (.xlsx)', exact: true })).toHaveCount(0);
  await page.route("**/api/query", route => route.fulfill({ json: { columns: ['country', 'new_signups'], rows: [['CA', 125]], ms: 1 } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const next = await exportPanel(page);
  const download = page.waitForEvent('download');
  await next.getByRole('button', { name: 'Download Excel (.xlsx)', exact: true }).click();
  const path = info.outputPath('recovered-workbook.xlsx'); await (await download).saveAs(path);
  expect(sheetCells(workbookXml(await readFile(path)))).toMatchObject({ A2: { value: 'CA' }, B2: { value: 125 } });
  expect(downloads).toHaveLength(1);
});


test("actual sample queries attribute the returned values to their selected connection", async ({ request }) => {
  const response = await request.get('/api/sources');
  expect(response.ok()).toBe(true);
  const { sources } = await response.json();
  const source = sources.find((s: { status: string }) => s.status === 'ready');
  expect(source).toBeTruthy();
  const result = await request.post('/api/query', { headers: { 'x-sc-source': source.id, 'x-sc-principal': 'admin' },
    data: { metrics: ['new_signups'], dimensions: ['country'], limit: 2 } });
  expect(result.ok(), await result.text()).toBe(true);
  const body = await result.json();
  expect(body.source).toEqual({ id: source.id, label: source.label });
  expect(body.principal).toBe('admin');
  expect(body.rows).toHaveLength(2);
  expect(body.truncated).toBe(true);
});


test("tables sort neighboring precise values correctly and keep them intact in every presentation", async ({ page }, info) => {
  const tile = await open(page, [['Lower', '9007199254740992'], ['Higher', '9007199254740993'],
    ['Fraction lower', '0.12345678901234567890'], ['Fraction higher', '0.12345678901234567891'], ['Unknown', null]]);
  await expect(tile.locator('tbody tr').first()).toHaveText('Higher9007199254740993');
  await expect(tile.locator('tbody tr').nth(1)).toHaveText('Lower9007199254740992');
  await tile.getByRole('button', { name: /^New signups/ }).click();
  await expect(tile.locator('tbody tr').first()).toHaveText('Fraction lower0.12345678901234567890');
  await expect(tile.locator('tbody tr').last()).toHaveText('Unknown—');
  await page.getByRole('button', { name: 'Review and share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review and share', exact: true });
  for (const mode of ['Dashboard', 'Story', 'Infographic']) {
    await dialog.getByRole('button', { name: mode, exact: true }).click();
    const report = dialog.getByRole('article', { name: `${mode} presentation` });
    await expect(report.locator('tbody')).toContainText('9007199254740993');
    await expect(report.locator('tbody')).toContainText('0.12345678901234567891');
    await expect(report.locator('.data-table-precision')).toContainText('without unit formatting');
  }
  await page.screenshot({ path: info.outputPath('precise-table-infographic.png') });
});
