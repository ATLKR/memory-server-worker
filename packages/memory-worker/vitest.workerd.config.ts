import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Keep runtime integration fully local. The production Agent Memory
      // binding is remote-only and would otherwise require deployment
      // credentials even though these boundary tests never access it.
      wrangler: { configPath: "./wrangler.workerd-test.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
