import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

export type CommandResult = {
  ok: boolean;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type RuleDatabaseLocation = {
  databasePath: string;
  databaseUrl: string;
  source: string;
};

export type RuleDatabasePreflightDependencies = {
  resolveDatabase?: () => RuleDatabaseLocation | null;
  backupDatabase?: (databasePath: string) => string;
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

function databaseUrlForPath(databasePath: string) {
  return `file:${path.resolve(databasePath)}`;
}

function databasePathFromUrl(databaseUrl: string) {
  const normalized = databaseUrl.trim().replace(/^['"]|['"]$/gu, "");
  if (!normalized.startsWith("file:")) {
    throw new Error("规则发布仅支持本地 SQLite 数据库，DATABASE_URL 必须使用 file: 地址。");
  }
  const withoutQuery = normalized.slice("file:".length).split("?", 1)[0];
  const decoded = decodeURIComponent(withoutQuery).replace(
    /^\/([A-Za-z]:[\\/])/u,
    "$1",
  );
  return path.isAbsolute(decoded)
    ? path.normalize(decoded)
    : path.resolve(process.cwd(), "prisma", decoded);
}

function configuredDesktopDatabasePath(localAppData: string) {
  const controlRoot = path.join(localAppData, "VERIDIA");
  const pointerPath = path.join(
    controlRoot,
    "config",
    "data-location.json",
  );
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as {
      dataDirectory?: unknown;
    };
    if (typeof pointer.dataDirectory === "string") {
      return path.join(path.resolve(pointer.dataDirectory), "data", "veridia.db");
    }
  } catch {
    // Fall through to the default desktop data location.
  }
  return path.join(controlRoot, "data", "veridia.db");
}

function assertUsableDatabase(databasePath: string) {
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error(`规则数据库不存在：${databasePath}`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(databasePath, "r+");
  } catch (error) {
    throw new Error(
      `规则数据库不可写：${databasePath}\n${
        error instanceof Error ? error.stack || error.message : String(error)
      }`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveRuleDatabaseLocation(): RuleDatabaseLocation {
  const explicitDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (explicitDatabaseUrl) {
    const databasePath = databasePathFromUrl(explicitDatabaseUrl);
    assertUsableDatabase(databasePath);
    return {
      databasePath,
      databaseUrl: databaseUrlForPath(databasePath),
      source: "DATABASE_URL",
    };
  }

  const explicitDatabasePath = process.env.VERIDIA_RULE_DATABASE_PATH?.trim();
  if (explicitDatabasePath) {
    const databasePath = path.resolve(explicitDatabasePath);
    assertUsableDatabase(databasePath);
    const databaseUrl = databaseUrlForPath(databasePath);
    process.env.DATABASE_URL = databaseUrl;
    return {
      databasePath,
      databaseUrl,
      source: "VERIDIA_RULE_DATABASE_PATH",
    };
  }

  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    configuredDesktopDatabasePath(localAppData),
    path.join(
      process.env.VERIDIA_PRODUCTION_DATA_DIR || "E:\\v",
      "data",
      "veridia.db",
    ),
    path.join(
      process.env.VERIDIA_PREVIEW_DATA_DIR || "E:\\v-preview",
      "data",
      "veridia.db",
    ),
  ]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => fs.existsSync(candidate));

  if (candidates.length === 0) {
    throw new Error(
      "未找到可用的本地规则数据库。请设置 DATABASE_URL 或 VERIDIA_RULE_DATABASE_PATH 后重试。",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `检测到多个本地规则数据库，无法安全判断发布来源：\n${candidates.join(
        "\n",
      )}\n请设置 VERIDIA_RULE_DATABASE_PATH 明确指定后重试。`,
    );
  }

  const databasePath = candidates[0];
  assertUsableDatabase(databasePath);
  const databaseUrl = databaseUrlForPath(databasePath);
  process.env.DATABASE_URL = databaseUrl;
  return { databasePath, databaseUrl, source: "自动定位" };
}

function localTimestamp() {
  const value = new Date();
  const part = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(
    value.getDate(),
  )}-${part(value.getHours())}${part(value.getMinutes())}${part(
    value.getSeconds(),
  )}`;
}

export function backupRuleDatabase(databasePath: string) {
  const dataDirectory = path.dirname(databasePath);
  const backupDirectory =
    path.basename(dataDirectory).toLowerCase() === "data"
      ? path.join(path.dirname(dataDirectory), "backups")
      : path.join(dataDirectory, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `rules-db-backup-before-preflight-${localTimestamp()}.db`,
  );
  fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL);

  const source = fs.readFileSync(databasePath);
  const backup = fs.readFileSync(backupPath);
  const digest = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  if (source.byteLength !== backup.byteLength || digest(source) !== digest(backup)) {
    throw new Error(`规则数据库备份校验失败：${backupPath}`);
  }
  return backupPath;
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
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  const result = spawnSync(
    process.execPath,
    [prismaCli, "migrate", command, "--schema", schemaPath],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.stack || result.error?.message,
  };
}

function commandFailureDetails(step: string, result: CommandResult) {
  const details = [result.error, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return [
    `失败步骤：prisma migrate ${step}`,
    `退出码：${result.status ?? "未知"}`,
    details || "Prisma 未返回详细输出。",
  ].join("\n");
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
  const usesRealDatabase =
    !dependencies.inspectStructure &&
    !dependencies.checkMigrationStatus &&
    !dependencies.deployMigrations;
  const resolveDatabase =
    dependencies.resolveDatabase ??
    (usesRealDatabase ? resolveRuleDatabaseLocation : () => null);
  const backupDatabase = dependencies.backupDatabase ?? backupRuleDatabase;
  const database = resolveDatabase();
  if (database) {
    process.env.DATABASE_URL = database.databaseUrl;
    log(`规则数据库：${database.databasePath}`);
  }

  let initialStructure: RuleDatabaseStructure;
  let inspectionError: unknown;
  try {
    initialStructure = await inspectStructure();
  } catch (error) {
    inspectionError = error;
    initialStructure = {
      hasRequireBodyStage: false,
      requireBodyStageDefaultsToFalse: false,
    };
  }

  const initialMigrationStatus = checkMigrationStatus();
  const migrationsCurrent = initialMigrationStatus.ok;
  const needsMigration =
    !migrationsCurrent ||
    !initialStructure.hasRequireBodyStage ||
    !initialStructure.requireBodyStageDefaultsToFalse;

  if (!needsMigration) {
    return { migrated: false, structure: initialStructure };
  }

  log("检测到本地规则数据库结构不是最新，正在执行安全迁移。");
  if (database) {
    const backupPath = backupDatabase(database.databasePath);
    log(`迁移前备份：${backupPath}`);
  }
  const deployResult = deployMigrations();
  if (!deployResult.ok) {
    const inspectionDetails =
      inspectionError instanceof Error
        ? `\n结构检查错误：\n${inspectionError.stack || inspectionError.message}`
        : "";
    throw new Error(
      `数据库安全迁移失败，规则发布已停止。\n${commandFailureDetails(
        "deploy",
        deployResult,
      )}${inspectionDetails}\n迁移前状态：\n${commandFailureDetails(
        "status",
        initialMigrationStatus,
      )}`,
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
  const finalMigrationStatus = checkMigrationStatus();
  if (
    !finalMigrationStatus.ok ||
    !finalStructure.hasRequireBodyStage ||
    !finalStructure.requireBodyStageDefaultsToFalse
  ) {
    throw new Error(
      `数据库迁移未完整生效，规则发布已停止。旧规则不会被覆盖。\n${commandFailureDetails(
        "status",
        finalMigrationStatus,
      )}`,
    );
  }

  log("数据库迁移完成，可以重新发布规则。");
  return { migrated: true, structure: finalStructure };
}
