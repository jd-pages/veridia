import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureRuleDatabaseReady,
  formatRulePublishError,
} from "@/lib/rules/database-preflight";

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
        deployMigrations: () => ({ ok: false }),
        log: vi.fn(),
      }),
    ).rejects.toThrow("数据库安全迁移失败，规则发布已停止");
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
    const preflightIndex = source.indexOf("await ensureRuleDatabaseReady()");
    const firstGithubIndex = source.indexOf('gh(["--version"])');
    const payloadIndex = source.indexOf("await exportCurrentRulePayload");
    const releaseCreateIndex = source.indexOf('    "create",', payloadIndex);

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(firstGithubIndex).toBeGreaterThan(preflightIndex);
    expect(payloadIndex).toBeGreaterThan(firstGithubIndex);
    expect(releaseCreateIndex).toBeGreaterThan(payloadIndex);
  });
});
