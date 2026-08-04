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

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRuleDatabasePath === undefined) {
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
  } else {
    process.env.VERIDIA_RULE_DATABASE_PATH = originalRuleDatabasePath;
  }
});

describe("规则发布数据库前置检查", () => {
  it("检测缺字段后执行迁移，并确认默认值为 false", async () => {
    const inspectStructure = vi
      .fn()
      .mockResolvedValueOnce({
        hasRequireBodyStage: false,
        requireBodyStageDefaultsToFalse: false,
      })
      .mockResolvedValueOnce({
        hasRequireBodyStage: true,
        requireBodyStageDefaultsToFalse: true,
      });
    const checkMigrationStatus = vi
      .fn()
      .mockReturnValueOnce({ ok: false })
      .mockReturnValueOnce({ ok: true });
    const deployMigrations = vi.fn(() => ({ ok: true }));
    const log = vi.fn();

    const result = await ensureRuleDatabaseReady({
      inspectStructure,
      checkMigrationStatus,
      deployMigrations,
      log,
    });

    expect(result.migrated).toBe(true);
    expect(deployMigrations).toHaveBeenCalledOnce();
    expect(result.structure).toEqual({
      hasRequireBodyStage: true,
      requireBodyStageDefaultsToFalse: true,
    });
    expect(log).toHaveBeenNthCalledWith(
      1,
      "检测到本地规则数据库结构不是最新，正在执行安全迁移。",
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      "数据库迁移完成，可以重新发布规则。",
    );
  });

  it("迁移失败时使用中文错误并阻止后续发布", async () => {
    await expect(
      ensureRuleDatabaseReady({
        inspectStructure: async () => ({
          hasRequireBodyStage: false,
          requireBodyStageDefaultsToFalse: false,
        }),
        checkMigrationStatus: () => ({ ok: false }),
        deployMigrations: () => ({
          ok: false,
          status: 1,
          stderr: "P3018: migration SQL failed",
        }),
        log: vi.fn(),
      }),
    ).rejects.toThrow(
      /数据库安全迁移失败，规则发布已停止。[\s\S]*失败步骤：prisma migrate deploy[\s\S]*P3018/u,
    );
  });

  it("迁移前先备份已定位的规则数据库", async () => {
    const backupDatabase = vi.fn(() => "D:\\rules\\backup.db");
    const deployMigrations = vi.fn(() => ({ ok: true }));
    await ensureRuleDatabaseReady({
      resolveDatabase: () => ({
        databasePath: "D:\\rules\\veridia.db",
        databaseUrl: "file:D:\\rules\\veridia.db",
        source: "test",
      }),
      backupDatabase,
      inspectStructure: vi
        .fn()
        .mockResolvedValueOnce({
          hasRequireBodyStage: false,
          requireBodyStageDefaultsToFalse: false,
        })
        .mockResolvedValueOnce({
          hasRequireBodyStage: true,
          requireBodyStageDefaultsToFalse: true,
        }),
      checkMigrationStatus: vi
        .fn()
        .mockReturnValueOnce({ ok: false })
        .mockReturnValueOnce({ ok: true }),
      deployMigrations,
      log: vi.fn(),
    });

    expect(backupDatabase).toHaveBeenCalledWith("D:\\rules\\veridia.db");
    expect(backupDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      deployMigrations.mock.invocationCallOrder[0],
    );
  });

  it("显式规则数据库路径会转换为 Prisma SQLite 地址", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-db-"),
    );
    const databasePath = path.join(temporaryRoot, "veridia.db");
    fs.writeFileSync(databasePath, "fixture");
    delete process.env.DATABASE_URL;
    process.env.VERIDIA_RULE_DATABASE_PATH = databasePath;

    try {
      const location = resolveRuleDatabaseLocation();
      expect(location.databasePath).toBe(databasePath);
      expect(location.databaseUrl).toBe(`file:${databasePath}`);
      expect(process.env.DATABASE_URL).toBe(`file:${databasePath}`);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("未显式设置规则数据库路径时不会使用 DATABASE_URL 或扫描本机目录", () => {
    process.env.DATABASE_URL = "file:E:\\v-preview\\data\\veridia.db";
    delete process.env.VERIDIA_RULE_DATABASE_PATH;

    expect(() => resolveRuleDatabaseLocation()).toThrow(
      "未设置 VERIDIA_RULE_DATABASE_PATH，不会自动扫描本机 VERIDIA 数据库。",
    );
  });

  it("P2022 不会把英文 Prisma 堆栈直接显示给用户", () => {
    const message = formatRulePublishError({
      code: "P2022",
      message: "The column does not exist in the current database.",
    });
    expect(message).toBe(
      "本地规则数据库结构不是最新，规则发布已停止。请先完成数据库安全迁移。",
    );
    expect(message).not.toContain("Prisma");
  });

  it("结构已是最新时不会重复执行迁移", async () => {
    const deployMigrations = vi.fn(() => ({ ok: true }));
    const result = await ensureRuleDatabaseReady({
      inspectStructure: async () => ({
        hasRequireBodyStage: true,
        requireBodyStageDefaultsToFalse: true,
      }),
      checkMigrationStatus: () => ({ ok: true }),
      deployMigrations,
      log: vi.fn(),
    });

    expect(result.migrated).toBe(false);
    expect(deployMigrations).not.toHaveBeenCalled();
  });

  it("规则发布在任何 GitHub 操作前完成数据库前置检查", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "publish-rules.ts"),
      "utf8",
    );
    const preflightIndex = source.indexOf("await prepareRulePublishSource()");
    const firstGithubIndex = source.indexOf('gh(["--version"])');
    const payloadIndex = source.indexOf("await publishSource.createPayload");
    const releaseCreateIndex = source.indexOf('    "create",', payloadIndex);

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(firstGithubIndex).toBeGreaterThan(preflightIndex);
    expect(payloadIndex).toBeGreaterThan(firstGithubIndex);
    expect(releaseCreateIndex).toBeGreaterThan(payloadIndex);
  });
});
