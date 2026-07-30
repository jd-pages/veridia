import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const defaultDatabasePath = path.resolve(process.cwd(), "prisma", "e2e.db");
const defaultDatabaseUrl = `file:${defaultDatabasePath}`;
const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() || defaultDatabaseUrl;

async function resetDefaultDatabase() {
  if (databaseUrl !== defaultDatabaseUrl) return;
  const outputDirectory = path.resolve(process.cwd(), "prisma");
  const databasePath = defaultDatabasePath;
  const relative = path.relative(outputDirectory, databasePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("E2E 数据库路径不在 prisma 目录内");
  }
  await mkdir(outputDirectory, { recursive: true });
  await rm(databasePath, { force: true });
}

async function main() {
  await resetDefaultDatabase();
  process.env.DATABASE_URL = databaseUrl;

  const commandEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/ensure-sqlite-db.ts"],
    {
      cwd: process.cwd(),
      env: commandEnvironment,
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [
      path.resolve(process.cwd(), "node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
    ],
    {
    cwd: process.cwd(),
    env: commandEnvironment,
    stdio: "inherit",
    },
  );

  const [{ prisma }, { ensureLocalRuntime }, { ensureBuiltinRules }] =
    await Promise.all([
      import("../../lib/db"),
      import("../../lib/local-runtime"),
      import("../../lib/rules/sync"),
    ]);
  const [{ createMockNote }, { normalizeUrl }, { runAuditTask }] =
    await Promise.all([
      import("../../lib/mock-data"),
      import("../../lib/topic"),
      import("../../lib/audit-service"),
    ]);

  await ensureLocalRuntime();
  await ensureBuiltinRules();
  if ((await prisma.auditResult.count()) === 0) {
    const product = await prisma.product.findFirstOrThrow({
      where: { deletedAt: null },
    });
    const campaign = await prisma.campaign.findFirstOrThrow({
      where: { deletedAt: null },
    });
    for (let index = 0; index < 15; index += 1) {
      const payload = createMockNote("passed");
      payload.url = `${payload.url}&isolated-fixture=${index + 1}`;
      payload.finalUrl = payload.url;
      payload.noteId = `isolated-fixture-${index + 1}`;
      const task = await prisma.auditTask.create({
        data: {
          url: payload.url,
          normalizedUrl: normalizeUrl(payload.url),
          productId: product.id,
          campaignId: campaign.id,
          productStage: "IFFO_2",
          source: "SEED",
          notes: "Playwright isolated fixture",
        },
      });
      await runAuditTask(task.id, payload);
    }
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "E2E 数据库初始化失败");
  process.exit(1);
});
