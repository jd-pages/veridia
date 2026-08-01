import "dotenv/config";
import { prisma } from "../lib/db";
import {
  ensureLocalPreviewRuntime,
  ensureLocalRuntime,
} from "../lib/local-runtime";
import { isLocalPreviewMode } from "../lib/local-preview-mode";
import { ensureBuiltinRules } from "../lib/rules/sync";

const REQUIRED_USER_COLUMNS = [
  "normalizedUsername",
  "accountId",
  "authProvider",
  "sessionVersion",
] as const;

async function main() {
  if (!isLocalPreviewMode()) {
    throw new Error(
      "预览初始化被拒绝：当前环境不是受保护的源码本地预览模式。",
    );
  }

  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    'PRAGMA table_info("users")',
  );
  const names = new Set(columns.map((column) => column.name));
  const missing = REQUIRED_USER_COLUMNS.filter((name) => !names.has(name));
  if (missing.length) {
    process.stderr.write(
      `PREVIEW_SCHEMA_MISMATCH：users 表缺少字段 ${missing.join("、")}。\n`,
    );
    process.exitCode = 42;
    return;
  }

  await ensureLocalRuntime();
  const user = await ensureLocalPreviewRuntime();
  await ensureBuiltinRules();
  if (!user) {
    throw new Error("本地预览账号初始化失败。");
  }
  process.stdout.write(
    `本地预览账号已准备：${user.displayName}（ADMIN）。\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "本地预览初始化失败"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
