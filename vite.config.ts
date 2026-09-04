import { defineConfig } from "vite";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:5174" } },
  // Unit tests are vitest; e2e/ is Playwright. Without this vitest collects the
  // Playwright specs and fails on test() being called outside its runner.
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
