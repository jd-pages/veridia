import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureRuleDatabaseReady,
  formatRulePublishError,
  resolveRuleDatabaseLocation,
} from "@/lib/rules/database-preflight";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRuleDatabasePath = process.env.VERIDIA_RULE_DATABASE_PATH;
const originalLocalAppData = process.env.LOCALAPPDATA;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRuleDatabasePath === undefined) {
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
  } else {
    process.env.VERIDIA_RULE_DATABASE_PATH = originalRuleDatabasePath;
  }
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
});

function currentStructure() {
  return {
    hasRequireBodyStage: true,
    requireBodyStageDefaultsToFalse: true,
    hasStoreTopicRules: true,
    hasStoreTopicEntries: true,
  };
}

describe("规则发布数据库只读前置检查", () => {
  it("显式规则数据库路径优先并使用 SQLite mode=ro", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-db-"),
    );
    const databasePath = path.join(temporaryRoot, "veridia.db");
    fs.writeFileSync(databasePath, "fixture");
    process.env.VERIDIA_RULE_DATABASE_PATH = databasePath;

    try {
      const location = resolveRuleDatabaseLocation();
      expect(location).toMatchObject({
        databasePath,
        source: "VERIDIA_RULE_DATABASE_PATH",
      });
      expect(location.databaseUrl).toMatch(/^file:.*veridia\.db\?mode=ro$/u);
      expect(process.env.DATABASE_URL).toBe(location.databaseUrl);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("未显式指定时复用 Desktop data-location.json 定位正式数据库", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-location-"),
    );
    const localAppData = path.join(temporaryRoot, "LocalAppData");
    const dataRoot = path.join(temporaryRoot, "Formal Data");
    const configRoot = path.join(localAppData, "VERIDIA", "config");
    const databasePath = path.join(dataRoot, "data", "veridia.db");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, "data-location.json"),
      JSON.stringify({ schemaVersion: 1, dataDirectory: dataRoot }),
    );
    fs.writeFileSync(databasePath, "fixture");
    process.env.LOCALAPPDATA = localAppData;
    delete process.env.VERIDIA_RULE_DATABASE_PATH;

    try {
      expect(resolveRuleDatabaseLocation()).toMatchObject({
        databasePath,
        source: "DESKTOP_DATA_LOCATION",
      });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("缺少 Desktop 路径指针时阻断且不使用 DATABASE_URL 猜测", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-missing-location-"),
    );
    process.env.LOCALAPPDATA = temporaryRoot;
    process.env.DATABASE_URL = "file:E:/preview/veridia.db";
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
    try {
      expect(() => resolveRuleDatabaseLocation()).toThrow(
        /未找到 VERIDIA 当前规则数据库/u,
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("结构完整时仅只读检查，不备份、不迁移", async () => {
    const inspectStructure = vi.fn(async () => currentStructure());
    const log = vi.fn();
    const database = {
      databasePath: "D:\\VERIDIA\\data\\veridia.db",
      databaseUrl: "file:D:/VERIDIA/data/veridia.db?mode=ro",
      source: "DESKTOP_DATA_LOCATION" as const,
    };
    const result = await ensureRuleDatabaseReady({
      resolveDatabase: () => database,
      inspectStructure,
      log,
    });

    expect(result).toMatchObject({ migrated: false, readOnly: true, database });
    expect(inspectStructure).toHaveBeenCalledWith(database);
    expect(log).toHaveBeenCalledWith(
      "规则数据库（严格只读）：D:\\VERIDIA\\data\\veridia.db",
    );
  });

  it("缺少店铺规则结构时明确阻断而不自动迁移", async () => {
    await expect(
      ensureRuleDatabaseReady({
        resolveDatabase: () => ({
          databasePath: "D:\\VERIDIA\\data\\veridia.db",
          databaseUrl: "file:D:/VERIDIA/data/veridia.db?mode=ro",
          source: "DESKTOP_DATA_LOCATION",
        }),
        inspectStructure: async () => ({
          ...currentStructure(),
          hasStoreTopicEntries: false,
        }),
        log: vi.fn(),
      }),
    ).rejects.toThrow(/只读检查已停止/u);
  });

  it("P2022 不会把英文 Prisma 堆栈直接显示给用户", () => {
    const message = formatRulePublishError({
      code: "P2022",
      message: "The column does not exist in the current database.",
    });
    expect(message).toContain("规则发布已停止");
    expect(message).not.toContain("Prisma");
  });

  it("发布前置实现不包含备份、迁移或写数据库命令", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "rules", "database-preflight.ts"),
      "utf8",
    );
    expect(source).toContain("?mode=ro");
    expect(source).not.toMatch(/migrate\s+deploy|backupRuleDatabase|copyFileSync/u);
    expect(source).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+["'`\w]|DELETE\s+FROM|ALTER\s+TABLE|VACUUM\b)/iu,
    );
  });

  it("规则发布在任何 GitHub 操作前完成数据库前置检查", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "publish-rules.ts"),
      "utf8",
    );
    expect(source.indexOf("await prepareRulePublishSource()")).toBeLessThan(
      source.indexOf('gh(["--version"])'),
    );
  });
});
