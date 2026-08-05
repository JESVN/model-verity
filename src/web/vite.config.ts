import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = __dirname;
const srcRoot = path.resolve(webRoot, "src");

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@ui": path.resolve(srcRoot, "ui"),
      "@preview": path.resolve(srcRoot, "preview"),
      "@app": path.resolve(srcRoot, "app"),
    },
  },
  server: {
    // 0.0.0.0 so Nginx Proxy Manager (Docker) can reach the host process.
    // Prefer host gateway IP (e.g. 172.17.0.1) in NPM, not container localhost.
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: path.resolve(webRoot, "../../dist/web"),
    emptyOutDir: true,
  },
});
