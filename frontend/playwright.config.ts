import { defineConfig, devices } from "@playwright/test";

const backendCommand = process.platform === "win32"
  ? "cd ..\\backend && .venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
  : "cd ../backend && python -m uvicorn app.main:app --host 127.0.0.1 --port 8000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.CI ? devices["Desktop Chrome"] : { channel: "chrome" }),
  },
  webServer: [
    {
      command: backendCommand,
      url: "http://127.0.0.1:8000/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
