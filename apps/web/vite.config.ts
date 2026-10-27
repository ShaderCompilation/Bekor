import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA and API share one origin. In development Vite proxies API and auth paths, so the API
// must run with API_ORIGIN set to this dev server's origin (http://localhost:5173).
const apiTarget = process.env.BEKOR_API_PROXY ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget },
      "/auth": { target: apiTarget },
      "/health": { target: apiTarget },
    },
  },
  preview: { host: "localhost", port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 6000 },
});
