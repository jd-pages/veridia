import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Windows CI runs several SQLite/Prisma compatibility suites that spawn
    // heavyweight child processes. Running test files in parallel can starve
    // Vitest's worker RPC long enough for birpc onTaskUpdate to time out even
    // though every assertion passed. Keep file execution deterministic without
    // weakening any test timeout or assertion.
    fileParallelism: false,
    coverage: { reporter: ["text", "html"] },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
