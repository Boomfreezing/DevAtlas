import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.DEVATLAS_API_TARGET;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
