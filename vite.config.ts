import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const { d1, r2 } = hostingConfig;
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [
    react(),
    sites(),
    ...cloudflare({
      config: {
        name: "weblilypond",
        main: "./worker/index.ts",
        compatibility_date: "2026-08-24",
        compatibility_flags: ["nodejs_compat"],
        assets: { binding: "ASSETS", not_found_handling: "single-page-application" },
        d1_databases: d1 ? [{ binding: d1, database_name: "weblilypond", database_id: "00000000-0000-4000-8000-000000000000" }] : [],
        r2_buckets: r2 ? [{ binding: r2, bucket_name: "weblilypond" }] : [],
      },
    }),
  ],
});
