import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sites } from "@openai/sites-vite-plugin";

export default defineConfig(({ command }) => {
  const hasSitesProject = existsSync(resolve(process.cwd(), ".openai/hosting.json"));

  return {
    // Sites metadata is added only after a real project is created. The plugin
    // still participates in local development without inventing the opaque
    // project id required by .openai/hosting.json.
    plugins: [react(), ...(command === "serve" || hasSitesProject ? [sites()] : [])],
    server: {
      port: 4175,
      strictPort: true,
    },
    preview: {
      port: 4176,
      strictPort: true,
    },
  };
});
