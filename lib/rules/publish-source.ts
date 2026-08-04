import fs from "node:fs/promises";
import path from "node:path";
import { ensureRuleDatabaseReady } from "./database-preflight";
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
  source: "VERIDIA_RULE_DATABASE_PATH" | "PROJECT_RULE_SOURCE";
  sourcePath: string;
  createPayload: (
    options: RulePublishPayloadOptions,
  ) => Promise<RulePackagePayload>;
};

export type RulePublishSourceDependencies = {
  ruleDatabasePath?: string | null;
  projectRuleSourcePath?: string;
  ensureDatabaseReady?: typeof ensureRuleDatabaseReady;
  exportDatabasePayload?: typeof exportCurrentRulePayload;
};

const PROJECT_SOURCE_ERROR =
  "未找到项目规则源，请设置 VERIDIA_RULE_DATABASE_PATH 或补充项目规则配置。";

export async function prepareRulePublishSource(
  dependencies: RulePublishSourceDependencies = {},
): Promise<PreparedRulePublishSource> {
  const configuredDatabasePath =
    dependencies.ruleDatabasePath === undefined
      ? process.env.VERIDIA_RULE_DATABASE_PATH?.trim() || null
      : dependencies.ruleDatabasePath?.trim() || null;

  if (configuredDatabasePath) {
    const databasePath = path.resolve(configuredDatabasePath);
    process.env.VERIDIA_RULE_DATABASE_PATH = databasePath;
    await (dependencies.ensureDatabaseReady ?? ensureRuleDatabaseReady)();
    return {
      source: "VERIDIA_RULE_DATABASE_PATH",
      sourcePath: databasePath,
      createPayload: (options) =>
        (dependencies.exportDatabasePayload ?? exportCurrentRulePayload)(
          options,
        ),
    };
  }

  const sourcePath = path.resolve(
    dependencies.projectRuleSourcePath ??
      path.join(process.cwd(), "rules", "default-rules.json"),
  );
  let projectPayload: RulePackagePayload;
  try {
    const source = await fs.readFile(sourcePath, "utf8");
    projectPayload = validateRulePayload(JSON.parse(source));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${PROJECT_SOURCE_ERROR}\n项目规则源：${sourcePath}\n${details}`,
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
