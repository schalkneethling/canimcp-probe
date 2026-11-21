import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Config shape from https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/index.md
// (read 2026-11-12). That page says readD1Migrations is exported from
// "@cloudflare/vitest-plugin/config", but the installed 1.8.0 package only has
// a root export (node_modules/@cloudflare/vitest-plugin/package.json "exports"),
// so it is imported from the root here.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // The local timing run in bench/ is opt-in: npm run bench:workerd.
    include: process.env["SPIKE_BENCH"] === "1" ? ["bench/**/*.test.ts"] : ["test/**/*.test.ts"],
  },
});
