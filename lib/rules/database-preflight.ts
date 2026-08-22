import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
const { readDataLocation } = require("../../desktop/data-location.cjs") as {
  readDataLocation: (controlRoot: string) => string | null;
};

const REQUIRED_COLUMN = "requireBodyStage";

type ColumnInfo = {
  name: string;
  dflt_value: string | number | null;
};

export type RuleDatabaseStructure = {
  hasRequireBodyStage: boolean;
  requireBodyStageDefaultsToFalse: boolean;
  hasStoreTopicRules: boolean;
  hasStoreTopicEntries: boolean;
};

export type RuleDatabaseLocation = {
  databasePath: string;
  databaseUrl: string;
  source: "VERIDIA_RULE_DATABASE_PATH" | "DESKTOP_DATA_LOCATION";
};

export type RuleDatabasePreflightDependencies = {
  resolveDatabase?: () => RuleDatabaseLocation;
  inspectStructure?: (
    database: RuleDatabaseLocation,
  ) => Promise<RuleDatabaseStructure>;
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
    return "本地规则数据库结构不是最新，规则发布已停止。请先启动最新版 VERIDIA 完成数据库升级。";
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
  return `file:${path.resolve(databasePath).replaceAll("\\", "/")}?mode=ro`;
}

function assertReadableDatabase(databasePath: string) {
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error(`规则数据库不存在：${databasePath}`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(databasePath, "r");
  } catch (error) {
    throw new Error(
      `规则数据库不可读：${databasePath}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function defaultControlRoot() {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.resolve(localAppData, "VERIDIA");
  const appData = process.env.APPDATA?.trim();
  return appData
    ? path.resolve(appData, "..", "Local", "VERIDIA")
    : path.resolve(os.homedir(), "AppData", "Local", "VERIDIA");
}

export function resolveRuleDatabaseLocation(): RuleDatabaseLocation {
  const explicitDatabasePath = process.env.VERIDIA_RULE_DATABASE_PATH?.trim();
  const source = explicitDatabasePath
    ? "VERIDIA_RULE_DATABASE_PATH"
    : "DESKTOP_DATA_LOCATION";
  const dataRoot = explicitDatabasePath
    ? null
    : readDataLocation(defaultControlRoot());
  if (!explicitDatabasePath && !dataRoot) {
    throw new Error(
      "未找到 VERIDIA 当前规则数据库：缺少 %LOCALAPPDATA%\\VERIDIA\\config\\data-location.json，规则发布已停止。",
    );
  }
  const databasePath = explicitDatabasePath
    ? path.resolve(explicitDatabasePath)
    : path.join(path.resolve(dataRoot!), "data", "veridia.db");
  assertReadableDatabase(databasePath);
  const databaseUrl = databaseUrlForPath(databasePath);
  process.env.DATABASE_URL = databaseUrl;
  return { databasePath, databaseUrl, source };
}

export async function inspectRuleDatabaseStructure(
  database = resolveRuleDatabaseLocation(),
) {
  const client = new PrismaClient({
    datasourceUrl: database.databaseUrl,
    log: [],
  });
  try {
    const [stageColumns, ruleColumns, entryColumns] = await Promise.all([
      client.$queryRawUnsafe<ColumnInfo[]>(
        'PRAGMA table_info("rule_stage_groups")',
      ),
      client.$queryRawUnsafe<ColumnInfo[]>(
        'PRAGMA table_info("store_topic_rules")',
      ),
      client.$queryRawUnsafe<ColumnInfo[]>(
        'PRAGMA table_info("store_topic_entries")',
      ),
    ]);
    const requiredColumn = stageColumns.find(
      (item) => item.name === REQUIRED_COLUMN,
    );
    const hasColumns = (columns: ColumnInfo[], required: string[]) =>
      required.every((name) => columns.some((column) => column.name === name));
    return {
      hasRequireBodyStage: Boolean(requiredColumn),
      requireBodyStageDefaultsToFalse: Boolean(
        requiredColumn && isFalseDefault(requiredColumn.dflt_value),
      ),
      hasStoreTopicRules: hasColumns(ruleColumns, [
        "commercePlatform",
        "storeName",
        "normalizedStoreName",
        "enabled",
        "deletedAt",
      ]),
      hasStoreTopicEntries: hasColumns(entryColumns, [
        "storeTopicRuleId",
        "topic",
        "normalizedTopic",
        "topicType",
        "sortOrder",
        "enabled",
        "deletedAt",
      ]),
    } satisfies RuleDatabaseStructure;
  } finally {
    await client.$disconnect();
  }
}

export async function ensureRuleDatabaseReady(
  dependencies: RuleDatabasePreflightDependencies = {},
) {
  const database = (dependencies.resolveDatabase ?? resolveRuleDatabaseLocation)();
  const log = dependencies.log ?? console.log;
  log(`规则数据库（严格只读）：${database.databasePath}`);
  const structure = await (
    dependencies.inspectStructure ?? inspectRuleDatabaseStructure
  )(database);
  if (
    !structure.hasRequireBodyStage ||
    !structure.requireBodyStageDefaultsToFalse ||
    !structure.hasStoreTopicRules ||
    !structure.hasStoreTopicEntries
  ) {
    throw new Error(
      "本地规则数据库结构不是最新，规则发布只读检查已停止；请先启动最新版 VERIDIA 完成数据库升级。",
    );
  }
  return { migrated: false, readOnly: true, database, structure };
}
