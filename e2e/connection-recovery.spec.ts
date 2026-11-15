import { expect, test, type Page, type Route } from "@playwright/test";

const openConnections = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
};
const editSource = (page: Page) => page.locator(".mrow").getByRole("button", { name: "Edit", exact: true }).first().click();
const sourceConfig = (route: Route) => ({
  id: decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!),
  label: "Synthetic warehouse", adapter: "duckglue", model: "/sample/model.yaml",
  connector: { type: "snowflake", account: "sample-account", username: "sample-reader", database: "SAMPLE", warehouse: "READ_WH", schema: "PUBLIC", poolSize: 3 },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

const syntheticPem = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-TEST-CONTENT\n-----END PRIVATE KEY-----\n";
async function pasteKey(page: Page, label: string, pem: string) {
  await page.getByLabel(label, { exact: true }).evaluate((element, text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, pem);
}

test("Snowflake credentials stay masked and preserve PEM line breaks through paste, reveal, replacement and submission", async ({ page }) => {
  let submitted: any;
  await page.route("**/api/sources/*/config", route => route.fulfill({ json: sourceConfig(route) }));
  await page.route("**/api/sources/*", route => {
    if (route.request().method() !== "PUT") return route.continue();
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 422, json: { error: "Synthetic connection failure; no credential saved" } });
  });
  await openConnections(page); await editSource(page);
  const form = page.getByRole("form", { name: "Edit source" });
  const key = form.getByLabel("Private key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await pasteKey(page, "Private key", syntheticPem);
  await expect(key).toHaveAttribute("readonly", "");
  await expect(form.locator("textarea")).toHaveCount(0);
  await form.getByRole("button", { name: "Show private key", exact: true }).click();
  await expect(key).toHaveValue(syntheticPem);
  await key.fill(syntheticPem.replace("CONTENT", "EDITED"));
  await form.getByRole("button", { name: "Hide private key", exact: true }).click();
  await expect(key).toHaveAttribute("type", "password");
  const replacement = syntheticPem.replaceAll("\n", "\r\n");
  await pasteKey(page, "Private key", replacement);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("no credential saved");
  expect(submitted.connector.privateKey).toBe(replacement);
  await expect(key).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: "Clear private key", exact: true }).click();
  await expect(key).toHaveValue("");
  await expect(key).not.toHaveAttribute("readonly");
});

test("Modeler uses the same masked multiline key entry and submits the complete synthetic key", async ({ page }) => {
  let submitted: any;
  await page.route("**/api/modeler/drafts", route => {
    if (route.request().method() !== "POST") return route.continue();
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 422, json: { error: "Synthetic warehouse unavailable; no draft created" } });
  });
  await page.goto("/modeler");
  const form = page.getByRole("form", { name: "New model" });
  await form.getByLabel("What to do").selectOption("snowflake");
  await form.getByLabel("Label", { exact: true }).fill("Synthetic masked key");
  await form.getByLabel("Account", { exact: true }).fill("synthetic");
  await form.getByLabel("Username", { exact: true }).fill("synthetic");
  await form.getByLabel("Database", { exact: true }).fill("synthetic");
  const label = "Private key (PEM), instead of a password";
  await expect(form.getByLabel(label)).toHaveAttribute("type", "password");
  await pasteKey(page, label, syntheticPem);
  await form.getByRole("button", { name: "Read the warehouse and propose a model" }).click();
  await expect(form.getByRole("alert")).toContainText("no draft created");
  expect(submitted.connector.privateKey).toBe(syntheticPem);
  await expect(form.locator("textarea")).toHaveCount(0);
});

test("AI status failures remain visible and can be retried", async ({ page }) => {
  let available = false;
  await page.route("**/api/agent/status", route => available
    ? route.fulfill({ json: { configured: false } })
    : route.fulfill({ status: 503, contentType: "text/html", body: "<h1>Unavailable</h1>" }));
  await openConnections(page);
  const panel = page.getByRole("region", { name: "Embedded agent connection" });
  await expect(panel.getByRole("alert")).toContainText("Request failed (503)");
  await expect(panel.getByRole("button", { name: "Add key" })).toHaveCount(0);
  await panel.screenshot({ path: "../../outputs/semantic-canvas-local/ai-connection-status-recovery.png" });
  available = true;
  await panel.getByRole("button", { name: "Retry AI status" }).click();
  await expect(panel).toContainText("Not configured");
  await expect(panel.getByRole("button", { name: "Add key" })).toBeVisible();
  await expect(panel).not.toContainText("undefined");
});

test("malformed AI status does not invent a configured state", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: "false" } }));
  await openConnections(page);
  const panel = page.getByRole("region", { name: "Embedded agent connection" });
  await expect(panel.getByRole("alert")).toContainText("invalid AI status");
  await expect(panel.getByRole("button", { name: "Replace key" })).toHaveCount(0);
});

test("unsupported AI configuration explains the server fix instead of offering another key attempt", async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: {
    configured: false, provider: "unsupported", model: "synthetic-model", canSetKey: false,
    issue: "Unsupported AI provider: unsupported. This Canvas supports Anthropic only. Update ai.provider in the server configuration.",
  } }));
  await openConnections(page);
  const panel = page.getByRole("region", { name: "Embedded agent connection" });
  await expect(panel).toContainText("Update ai.provider in the server configuration");
  await expect(panel.getByRole("button", { name: "Add key" })).toBeDisabled();
  await expect(panel.getByLabel("Anthropic API key")).toHaveCount(0);
});

test("failed key removal keeps confirmation and configuration until a successful retry", async ({ page }) => {
  let configured = true, removals = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured } }));
  await page.route("**/api/agent/key", route => {
    expect(route.request().method()).toBe("DELETE");
    if (++removals === 1) return route.fulfill({ status: 503, json: { error: "Credential storage unavailable" } });
    configured = false;
    return route.fulfill({ json: { configured: false } });
  });
  await openConnections(page);
  const panel = page.getByRole("region", { name: "Embedded agent connection" });
  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm remove" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Credential storage unavailable");
  await expect(panel.locator(".active-badge")).toHaveText("Configured");
  await panel.getByRole("button", { name: "Confirm remove" }).click();
  await expect(panel.locator(".active-badge")).toHaveText("Not configured");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("key validation freezes the input and retains it after a failed save", async ({ page }) => {
  const gate = deferred();
  let configured = false, saves = 0;
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured } }));
  await page.route("**/api/agent/key", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ apiKey: "synthetic-test-key" });
    if (++saves === 1) {
      await gate.promise;
      return route.fulfill({ status: 422, json: { error: "Synthetic key rejected" } });
    }
    configured = true;
    return route.fulfill({ json: { configured: true } });
  });
  await openConnections(page);
  const panel = page.getByRole("region", { name: "Embedded agent connection" });
  await panel.getByRole("button", { name: "Add key" }).click();
  const key = panel.getByLabel("Anthropic API key");
  await key.fill("synthetic-test-key");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(key).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Cancel" })).toBeDisabled();
  } finally { gate.resolve(); }
  await expect(panel.getByRole("alert")).toHaveText("Synthetic key rejected");
  await expect(key).toHaveValue("synthetic-test-key");
  await expect(key).toBeEnabled();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.locator(".active-badge")).toHaveText("Configured");
  await expect(key).toHaveCount(0);
});

test("source edit waits for valid saved settings and preserves changes after a failed save", async ({ page }) => {
  let loads = 0, saves = 0;
  const gate = deferred();
  await page.route("**/api/sources/*/config", route => ++loads === 1
    ? route.fulfill({ status: 502, contentType: "text/html", body: "Unavailable" })
    : route.fulfill({ json: sourceConfig(route) }));
  await page.route("**/api/sources/*", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const body = route.request().postDataJSON();
    expect(body.label).toBe("Updated synthetic warehouse");
    expect(body.connector).toMatchObject({ type: "snowflake", account: "sample-account", privateKey: "", warehouse: "READ_WH", poolSize: 3 });
    if (++saves === 1) {
      await gate.promise;
      return route.fulfill({ status: 422, json: { error: "Warehouse unavailable; settings not saved" } });
    }
    return route.fulfill({ json: { saved: true } });
  });
  await openConnections(page); await editSource(page);
  const loading = page.getByRole("region", { name: "Source settings" });
  await expect(loading.getByRole("alert")).toContainText("Request failed (502)");
  await expect(page.getByRole("form", { name: "Edit source" })).toHaveCount(0);
  await loading.getByRole("button", { name: "Retry loading source" }).click();
  const form = page.getByRole("form", { name: "Edit source" });
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Synthetic warehouse");
  await expect(form.getByLabel("Private key", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Private key passphrase (optional)")).toHaveAttribute("type", "password");
  await form.getByLabel("Label", { exact: true }).fill("Updated synthetic warehouse");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  try {
    for (const control of await form.locator("input, select").all()) await expect(control).toBeDisabled();
    await expect(form.getByRole("button", { name: "Cancel" })).toBeDisabled();
  } finally { gate.resolve(); }
  await expect(form.getByRole("alert")).toContainText("settings not saved");
  await form.screenshot({ path: "../../outputs/semantic-canvas-local/source-connection-recovery.png" });
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Updated synthetic warehouse");
  await expect(form.getByLabel("Connector", { exact: true })).toBeEnabled();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(saves).toBe(2);
});

for (const invalid of ["missing", "wrong-source", "invalid-connector"]) test(`source edit rejects ${invalid} settings`, async ({ page }) => {
  await page.route("**/api/sources/*/config", route => {
    const config = sourceConfig(route);
    return route.fulfill({ json: invalid === "missing" ? {} : invalid === "wrong-source"
      ? { ...config, id: "unrelated-source" } : { ...config, connector: { type: "unknown" } } });
  });
  await openConnections(page); await editSource(page);
  const loading = page.getByRole("region", { name: "Source settings" });
  await expect(loading.getByRole("alert")).toContainText("incomplete or mismatched");
  await expect(page.getByRole("form", { name: "Edit source" })).toHaveCount(0);
  await loading.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "+ Add source", exact: true })).toBeVisible();
});

test("a slow source load can be cancelled without replacing a later edit", async ({ page }) => {
  const gate = deferred(), entered = deferred();
  let loads = 0;
  await page.route("**/api/sources/*/config", async route => {
    const config = sourceConfig(route);
    if (++loads === 1) {
      entered.resolve(); await gate.promise;
      // The cancelled request may already have been aborted by the browser.
      await route.fulfill({ json: { ...config, label: "Stale settings" } }).catch(() => {});
    } else await route.fulfill({ json: config });
  });
  await openConnections(page); await editSource(page); await entered.promise;
  const loading = page.getByRole("region", { name: "Source settings" });
  await expect(loading.getByRole("status")).toContainText("Loading saved source settings");
  await loading.getByRole("button", { name: "Cancel" }).click();
  await editSource(page);
  const form = page.getByRole("form", { name: "Edit source" });
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Synthetic warehouse");
  gate.resolve();
  await form.getByLabel("Label", { exact: true }).fill("Current edit");
  await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Current edit");
});

test("model upload freezes the selected adapter and applies the returned path", async ({ page }) => {
  const gate = deferred();
  await page.route("**/api/setup/model", async route => {
    expect(route.request().postDataJSON()).toEqual({ content: "name: synthetic", adapter: "duckglue" });
    await gate.promise;
    return route.fulfill({ json: { path: "/sample/uploaded-model.yaml" } });
  });
  await openConnections(page);
  await page.getByRole("button", { name: "+ Add source", exact: true }).click();
  const form = page.getByRole("form", { name: "Add source" });
  await form.getByLabel("Or upload your semantic model").setInputFiles({ name: "synthetic.yaml", mimeType: "text/yaml", buffer: Buffer.from("name: synthetic") });
  try {
    await expect(form.getByLabel("Semantic adapter", { exact: true })).toBeDisabled();
    await expect(form.getByLabel("Model path", { exact: true })).toBeDisabled();
  } finally { gate.resolve(); }
  await expect(form.getByLabel("Model path", { exact: true })).toHaveValue("/sample/uploaded-model.yaml");
  await expect(form.getByLabel("Semantic adapter", { exact: true })).toBeEnabled();
});

test("the real sample source can be inspected without changing its configuration", async ({ page }) => {
  await openConnections(page); await editSource(page);
  const form = page.getByRole("form", { name: "Edit source" });
  await expect(form.getByLabel("Model path", { exact: true })).not.toHaveValue("");
  await expect(form.getByLabel("Connector", { exact: true })).toHaveValue("duckdb");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
});

test("legacy DuckDB defaults and numeric-string pool sizes remain editable", async ({ page }) => {
  await page.route("**/api/sources/*/config", route => route.fulfill({ json: {
    ...sourceConfig(route), connector: { lakeRoot: "/sample/lake", poolSize: "5" },
  } }));
  await openConnections(page); await editSource(page);
  const form = page.getByRole("form", { name: "Edit source" });
  await expect(form.getByLabel("Connector", { exact: true })).toHaveValue("duckdb");
  await expect(form.getByLabel("Pool size", { exact: true })).toHaveValue("5");
  await expect(form.getByRole("alert")).toHaveCount(0);
});
