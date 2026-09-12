import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Each run owns its database, provider configuration, source copies and caches.
// Keep runtime data outside Playwright's outputDir, which it clears on startup.
const runtimeParent = resolve(import.meta.dirname, "../data/tmp/e2e");
mkdirSync(runtimeParent, { recursive: true });
const runtimeRoot = process.env.DEVATLAS_E2E_RUNTIME ?? mkdtempSync(`${runtimeParent}/run-`);
process.env.DEVATLAS_E2E_RUNTIME = runtimeRoot;
const runtimePath = (name: string) => resolve(runtimeRoot, name).replaceAll("\\", "/");
mkdirSync(runtimePath("tmp"), { recursive: true });

const backendCommand = process.platform === "win32"
  ? "cd ..\\backend && .venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8011"
  : "cd ../backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 8011";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5175",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.CI ? devices["Desktop Chrome"] : { channel: "chrome" }),
  },
  webServer: [
    {
      command: backendCommand,
      url: "http://127.0.0.1:8011/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DEVATLAS_DATABASE_URL: `sqlite:///${runtimePath("devatlas.db")}`,
        DEVATLAS_REPOSITORY_ROOT: runtimePath("repositories"),
        DEVATLAS_TEMPORARY_ROOT: runtimePath("tmp"),
        DEVATLAS_SEARCH_INDEX_ROOT: runtimePath("indexes"),
        DEVATLAS_PROVIDER_CONFIG_PATH: runtimePath("report-providers.json"),
        DEVATLAS_ALLOWED_ORIGINS: "http://127.0.0.1:5175",
        DEVATLAS_SEMANTIC_SEARCH_ENABLED: "false",
        TEMP: runtimePath("tmp"),
        TMP: runtimePath("tmp"),
      },
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5175 --strictPort",
      url: "http://127.0.0.1:5175",
      env: { DEVATLAS_API_TARGET: "http://127.0.0.1:8011" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
