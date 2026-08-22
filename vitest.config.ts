import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Windows CI runs several SQLite/Prisma compatibility suites that spawn
    // heavyweight child processes. Keep file execution deterministic and
    // resource usage bounded without weakening any test timeout or assertion.
    fileParallelism: false,
    coverage: { reporter: ["text", "html"] },
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
});
