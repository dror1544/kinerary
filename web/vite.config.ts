import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sites } from "@openai/sites-vite-plugin";

export default defineConfig(({ command }) => {
  const hasSitesProject = existsSync(resolve(process.cwd(), ".openai/hosting.json"));

  const apiOrigin = process.env.KINERARY_API_ORIGIN || "http://127.0.0.1:4310";
  const parsed = new URL(apiOrigin);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("KINERARY_API_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  const proxy = { "/v1": { target: parsed.origin } };
  return {
    // Sites metadata is added only after a real project is created. The plugin
    // still participates in local development without inventing the opaque
    // project id required by .openai/hosting.json.
    plugins: [react(), ...(command === "serve" || hasSitesProject ? [sites()] : [])],
    server: {
      proxy,
      port: 4175,
      strictPort: true,
    },
    preview: {
      proxy,
      port: 4176,
      strictPort: true,
    },
  };
});
