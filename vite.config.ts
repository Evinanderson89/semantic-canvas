import { defineConfig } from "vite";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.SC_UI_PORT ?? 5173), strictPort: true, proxy: { "/api": process.env.SC_API_URL ?? "http://127.0.0.1:5174" } },
  // Unit tests are vitest; e2e/ is Playwright. Without this vitest collects the
  // Playwright specs and fails on test() being called outside its runner.
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
