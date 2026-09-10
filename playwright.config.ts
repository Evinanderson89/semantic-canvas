import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: {
    baseURL: "http://127.0.0.1:5273",
    viewport: { width: 1440, height: 900 },
  },
  workers: 2,
  webServer: [
    { command: "npm run server", url: "http://127.0.0.1:5274/api/model", timeout: 60000,
      env: { PORT: "5274", SC_DATA_DIR: ".test-data", SEMANTIC_CANVAS_URL: "http://127.0.0.1:5274" } },
    { command: "npm run dev -- --port 5273 --strictPort", url: "http://127.0.0.1:5273", timeout: 60000,
      env: { SC_API_URL: "http://127.0.0.1:5274" } },
  ],
  reporter: [["list"]],
});
