import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(here, "../site/modern"),
    emptyOutDir: true,
  },
  server: {
    port: 4185,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  preview: {
    port: 4186,
    strictPort: true,
  },
});
