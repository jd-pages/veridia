import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const REQUIRED_COLUMN = "requireBodyStage";

type ColumnInfo = {
  name: string;
  dflt_value: string | number | null;
};

export type RuleDatabaseStructure = {
  hasRequireBodyStage: boolean;
  requireBodyStageDefaultsToFalse: boolean;
};

type CommandResult = {
  ok: boolean;
};

export type RuleDatabasePreflightDependencies = {
  inspectStructure?: () => Promise<RuleDatabaseStructure>;
  checkMigrationStatus?: () => CommandResult;
  deployMigrations?: () => CommandResult;
  log?: (message: string) => void;
};

export function formatRulePublishError(
  error: unknown,
  fallback = "规则发布失败，请检查本地数据库、签名配置和 GitHub 登录状态后重试。",
) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2022"
  ) {
    return "本地规则数据库结构不是最新，规则发布已停止。请先完成数据库安全迁移。";
  }
  if (
    error instanceof Error &&
    /^[\u3400-\u9fff]/u.test(error.message) &&
    !error.message.includes("Prisma")
  ) {
    return error.message;
  }
  return fallback;
}

function isFalseDefault(value: ColumnInfo["dflt_value"]) {
  if (value === 0) return true;
  const normalized = String(value ?? "")
    .trim()
    .replace(/^\((.*)\)$/u, "$1")
    .replace(/^['"]|['"]$/gu, "")
    .toLowerCase();
  return normalized === "false" || normalized === "0";
}

export async function inspectRuleDatabaseStructure() {
  const client = new PrismaClient({ log: [] });
  try {
    const columns = await client.$queryRawUnsafe<ColumnInfo[]>(
      'PRAGMA table_info("rule_stage_groups")',
    );
    const column = columns.find((item) => item.name === REQUIRED_COLUMN);
    return {
      hasRequireBodyStage: Boolean(column),
      requireBodyStageDefaultsToFalse: Boolean(
        column && isFalseDefault(column.dflt_value),
      ),
    } satisfies RuleDatabaseStructure;
  } finally {
    await client.$disconnect();
  }
}

function runPrismaMigrate(command: "status" | "deploy"): CommandResult {
  const prismaCli = path.join(
    process.cwd(),
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  const result = spawnSync(process.execPath, [prismaCli, "migrate", command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  return { ok: !result.error && result.status === 0 };
}

export async function ensureRuleDatabaseReady(
  dependencies: RuleDatabasePreflightDependencies = {},
) {
  const inspectStructure =
    dependencies.inspectStructure ?? inspectRuleDatabaseStructure;
  const checkMigrationStatus =
    dependencies.checkMigrationStatus ?? (() => runPrismaMigrate("status"));
  const deployMigrations =
    dependencies.deployMigrations ?? (() => runPrismaMigrate("deploy"));
  const log = dependencies.log ?? console.log;

  let initialStructure: RuleDatabaseStructure;
  try {
    initialStructure = await inspectStructure();
  } catch {
    initialStructure = {
      hasRequireBodyStage: false,
      requireBodyStageDefaultsToFalse: false,
    };
  }

  const migrationsCurrent = checkMigrationStatus().ok;
  const needsMigration =
    !migrationsCurrent ||
    !initialStructure.hasRequireBodyStage ||
    !initialStructure.requireBodyStageDefaultsToFalse;

  if (!needsMigration) {
    return { migrated: false, structure: initialStructure };
  }

  log("检测到本地规则数据库结构不是最新，正在执行安全迁移。");
  if (!deployMigrations().ok) {
    throw new Error(
      "数据库安全迁移失败，规则发布已停止。请检查数据库文件权限和迁移记录后重试。",
    );
  }

  let finalStructure: RuleDatabaseStructure;
  try {
    finalStructure = await inspectStructure();
  } catch {
    throw new Error(
      "数据库迁移后的结构校验失败，规则发布已停止。请检查本地数据库后重试。",
    );
  }
  if (
    !checkMigrationStatus().ok ||
    !finalStructure.hasRequireBodyStage ||
    !finalStructure.requireBodyStageDefaultsToFalse
  ) {
    throw new Error(
      "数据库迁移未完整生效，规则发布已停止。旧规则不会被覆盖。",
    );
  }

  log("数据库迁移完成，可以重新发布规则。");
  return { migrated: true, structure: finalStructure };
}
