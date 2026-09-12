import { defineConfig } from "@playwright/test";
import isolated from "./playwright.config";

const production = process.env.DEVATLAS_GRAPH_BENCHMARK_BUILD === "production";
const profiling = process.env.DEVATLAS_GRAPH_PROFILE === "true";
const services = Array.isArray(isolated.webServer) ? isolated.webServer : [];

// Opt-in benchmark, excluded from normal E2E. Reuse its isolated services only.
export default defineConfig({
  ...isolated,
  testDir: "./perf",
  // Keep earlier tree benchmarks selectable; profiling is opt-in and never
  // silently joins the ordinary timed suites.
  testMatch: profiling ? "**/dependency-graph-profile.spec.ts" : undefined,
  testIgnore: profiling ? undefined : "**/dependency-graph-profile.spec.ts",
  outputDir: "./performance-results",
  reporter: [["list"]],
  webServer: production ? services.map((service, index) => index === 1 ? {
    ...service,
    // Profiling uses the same fixed, locally built bundle as the timed run.
    command: process.env.DEVATLAS_GRAPH_PROFILE_EXISTING_BUILD === "true"
      ? "npm run preview -- --host 127.0.0.1 --port 5175 --strictPort"
      : "npx tsc -b && npx vite build --sourcemap && npm run preview -- --host 127.0.0.1 --port 5175 --strictPort",
    timeout: 60_000,
  } : service) : isolated.webServer,
  use: { ...isolated.use, viewport: { width: 1440, height: 1000 }, trace: "off" },
});
