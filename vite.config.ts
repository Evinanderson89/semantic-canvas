import { defineConfig } from "vite";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.SC_UI_PORT ?? 5173), strictPort: true, proxy: { "/api": process.env.SC_API_URL ?? "http://127.0.0.1:5174" } },
  // Unit tests are vitest; e2e/ is Playwright. Without this vitest collects the
  // Playwright specs and fails on test() being called outside its runner.
  test: {
    include: ["test/**/*.test.ts"], environment: "node",
    // Floors on the files where a regression is a leak or a wrong number (docs/testing.md). Enforced when run with --coverage (CI does).
    coverage: {
      provider: "v8", reporter: ["text-summary"],
      include: ["src/compiler/**", "src/security/**", "src/modeler/proposals.ts", "src/modeler/extend.ts", "src/suggest/dataHonesty.ts", "src/sources/extensions.ts"],
      thresholds: {
        "src/compiler/compile.ts": { lines: 95, functions: 90 },
        "src/security/rls.ts": { lines: 95 },
        "src/security/queryScope.ts": { lines: 95 },
        "src/security/auth.ts": { lines: 70 },
        "src/modeler/proposals.ts": { lines: 95, functions: 100 },
        "src/modeler/extend.ts": { lines: 95 },
        "src/suggest/dataHonesty.ts": { lines: 95, functions: 100 },
        "src/sources/extensions.ts": { lines: 70 },
      },
    },
  },
});
