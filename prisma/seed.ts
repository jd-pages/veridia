import { prisma } from "../lib/db";
import { ensureLocalRuntime } from "../lib/local-runtime";
import { ensureBuiltinRules } from "../lib/rules/sync";

/**
 * Safe, idempotent local initialization.
 *
 * This seed intentionally creates no audit batches, audit tasks, note records,
 * audit results, manual reviews, demo accounts, or mock data. E2E fixtures must
 * be created only inside an isolated test database by the tests that need them.
 */
async function main() {
  await ensureLocalRuntime();
  await ensureBuiltinRules();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    await prisma.$disconnect();
    process.exit(1);
  });
