import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  ensureRuleDatabaseReady,
  type RuleDatabaseLocation,
} from "./database-preflight";
import {
  exportCurrentRulePayload,
  validateRulePayload,
} from "./package";
import type { RulePackagePayload } from "./types";

export type RulePublishPayloadOptions = {
  ruleVersion: string;
  minimumAppVersion: string;
  publishedAt?: Date;
};

export type PreparedRulePublishSource = {
  source:
    | "VERIDIA_RULE_DATABASE_PATH"
    | "DESKTOP_DATA_LOCATION"
    | "PROJECT_RULE_SOURCE";
  sourcePath: string;
  createPayload: (
    options: RulePublishPayloadOptions,
  ) => Promise<RulePackagePayload>;
};

export type RulePublishSourceDependencies = {
  ruleDatabasePath?: string | null;
  projectRuleSourcePath?: string;
  projectSourceEnabled?: boolean;
  ensureDatabaseReady?: typeof ensureRuleDatabaseReady;
  exportDatabasePayload?: (
    options: RulePublishPayloadOptions,
  ) => Promise<RulePackagePayload>;
};

type FileState = {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
};

async function fileState(filePath: string): Promise<FileState> {
  try {
    const stat = await fs.stat(filePath);
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function databaseState(databasePath: string) {
  return Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
      .map(async (filePath) => [filePath, await fileState(filePath)] as const),
  );
}

async function exportReadOnlyDatabasePayload(
  database: RuleDatabaseLocation,
  options: RulePublishPayloadOptions,
) {
  const client = new PrismaClient({
    datasourceUrl: database.databaseUrl,
    log: [],
  });
  try {
    return await exportCurrentRulePayload(options, client);
  } finally {
    await client.$disconnect();
  }
}

async function guardedDatabaseExport(
  database: RuleDatabaseLocation,
  createPayload: () => Promise<RulePackagePayload>,
) {
  const before = await databaseState(database.databasePath);
  const payload = await createPayload();
  const after = await databaseState(database.databasePath);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      "规则数据库或 SQLite sidecar 在只读导出期间发生变化，规则发布已停止；请关闭 VERIDIA 后重试。",
    );
  }
  return payload;
}

async function prepareProjectSource(
  sourcePath: string,
): Promise<PreparedRulePublishSource> {
  let projectPayload: RulePackagePayload;
  try {
    const source = await fs.readFile(sourcePath, "utf8");
    projectPayload = validateRulePayload(JSON.parse(source));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `显式项目规则源读取失败：${sourcePath}\n${details}`,
    );
  }
  return {
    source: "PROJECT_RULE_SOURCE",
    sourcePath,
    createPayload: async (options) =>
      validateRulePayload({
        ...projectPayload,
        ruleVersion: options.ruleVersion,
        minimumAppVersion: options.minimumAppVersion,
        publishedAt: (options.publishedAt ?? new Date()).toISOString(),
      }),
  };
}

export async function prepareRulePublishSource(
  dependencies: RulePublishSourceDependencies = {},
): Promise<PreparedRulePublishSource> {
  const configuredDatabasePath =
    dependencies.ruleDatabasePath === undefined
      ? process.env.VERIDIA_RULE_DATABASE_PATH?.trim() || null
      : dependencies.ruleDatabasePath?.trim() || null;
  if (configuredDatabasePath) {
    process.env.VERIDIA_RULE_DATABASE_PATH = path.resolve(configuredDatabasePath);
  } else {
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
  }

  const projectSourceEnabled =
    dependencies.projectSourceEnabled ??
    process.env.VERIDIA_RULE_PROJECT_SOURCE?.trim() === "1";
  if (!configuredDatabasePath && projectSourceEnabled) {
    return prepareProjectSource(
      path.resolve(
        dependencies.projectRuleSourcePath ??
          path.join(process.cwd(), "rules", "default-rules.json"),
      ),
    );
  }

  const readiness = await (
    dependencies.ensureDatabaseReady ?? ensureRuleDatabaseReady
  )();
  const database = readiness.database;
  return {
    source: database.source,
    sourcePath: database.databasePath,
    createPayload: (options) =>
      guardedDatabaseExport(database, () =>
        dependencies.exportDatabasePayload
          ? dependencies.exportDatabasePayload(options)
          : exportReadOnlyDatabasePayload(database, options),
      ),
  };
}
