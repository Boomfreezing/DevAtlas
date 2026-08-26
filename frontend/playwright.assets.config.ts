import { defineConfig } from "@playwright/test";

const backendCommand = process.platform === "win32"
  ? "..\\backend\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --app-dir ..\\backend --host 127.0.0.1 --port 8010"
  : "python -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8010";

export default defineConfig({
  testDir: "./visual-assets",
  outputDir: "./test-results/visual-assets",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  },
  webServer: [
    {
      command: backendCommand,
      url: "http://127.0.0.1:8010/api/health",
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        DEVATLAS_DATABASE_URL: "sqlite:///./frontend/test-results/capture-data/devatlas.db",
        DEVATLAS_REPOSITORY_ROOT: "./frontend/test-results/capture-data/repositories",
        DEVATLAS_PROVIDER_CONFIG_PATH: "./frontend/test-results/capture-data/report-providers.json",
        DEVATLAS_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
      },
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5174",
      url: "http://127.0.0.1:5174",
      timeout: 30_000,
      reuseExistingServer: false,
      env: { DEVATLAS_API_TARGET: "http://127.0.0.1:8010" },
    },
  ],
});
