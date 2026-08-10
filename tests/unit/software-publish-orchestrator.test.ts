import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createSoftwarePublishPlan,
  executeSoftwarePublishPlan,
  formatSoftwarePublishFailure,
  nextPatchVersion,
  SoftwarePublishError,
} from "../../scripts/software-publish-orchestrator.mjs";

function state(overrides: Record<string, unknown> = {}) {
  return {
    dirty: false,
    branch: "main",
    ahead: 3,
    behind: 0,
    commitsToPush: ["ccc fix: c", "bbb feat: b", "aaa test: a"],
    commitsSinceRelease: ["ccc fix: c", "bbb feat: b", "aaa test: a"],
    sourceVersion: "1.1.6",
    lockVersion: "1.1.6",
    latestReleaseVersion: "1.1.6",
    latestTagVersion: "1.1.6",
    targetTagExists: false,
    targetReleaseExists: false,
    ...overrides,
  };
}

function operations(overrides: Record<string, unknown> = {}) {
  return {
    updateVersion: vi.fn(),
    validate: vi.fn(),
    commitVersion: vi.fn(),
    restoreVersion: vi.fn(),
    pushMain: vi.fn(),
    assertMainSynchronized: vi.fn(),
    assertTargetAvailable: vi.fn(),
    createTag: vi.fn(),
    pushTag: vi.fn(),
    waitForActions: vi.fn().mockResolvedValue({
      success: true,
      url: "https://github.example/actions/1",
    }),
    verifyRelease: vi.fn().mockResolvedValue({
      url: "https://github.example/releases/v1.1.7",
    }),
    ...overrides,
  };
}

describe("一键软件发布编排", () => {
  it("使用真正的语义化 Patch 递增", () => {
    expect(nextPatchVersion("1.1.6")).toBe("1.1.7");
    expect(nextPatchVersion("1.1.9")).toBe("1.1.10");
  });

  it("clean + ahead 3 + behind 0 允许发布并保留提交列表", () => {
    const plan = createSoftwarePublishPlan(state());

    expect(plan).toMatchObject({
      kind: "release",
      currentVersion: "1.1.6",
      targetVersion: "1.1.7",
      ahead: 3,
      behind: 0,
      versionChangeRequired: true,
    });
    expect(plan.commitsToPush).toHaveLength(3);
  });

  it("工作区不干净时阻止发布", () => {
    expect(() => createSoftwarePublishPlan(state({ dirty: true }))).toThrow(
      "检测到未提交修改",
    );
  });

  it("behind 大于 0 时阻止且不尝试自动同步", () => {
    expect(() => createSoftwarePublishPlan(state({ behind: 1 }))).toThrow(
      "远程main存在本地尚未同步的提交",
    );
  });

  it("HEAD 已是最新正式版本且没有新提交时不空发布", () => {
    const plan = createSoftwarePublishPlan(
      state({ ahead: 0, commitsToPush: [], commitsSinceRelease: [] }),
    );

    expect(plan.kind).toBe("none");
    expect(plan.currentVersion).toBe("1.1.6");
  });

  it("源码已经预先升级且尚未发布时使用源码版本", () => {
    const plan = createSoftwarePublishPlan(
      state({ sourceVersion: "1.2.0", lockVersion: "1.2.0" }),
    );

    expect(plan.targetVersion).toBe("1.2.0");
    expect(plan.versionChangeRequired).toBe(false);
  });

  it.each([
    ["目标 Tag", { targetTagExists: true }, "目标 Tag v1.1.7 已存在"],
    [
      "目标 Release",
      { targetReleaseExists: true },
      "GitHub Release v1.1.7 已存在",
    ],
  ])("%s 已存在时阻止", (_label, override, message) => {
    expect(() => createSoftwarePublishPlan(state(override))).toThrow(message);
  });

  it("Push main 失败时不创建 Tag", async () => {
    const plan = createSoftwarePublishPlan(state());
    const calls = operations({
      pushMain: vi.fn().mockRejectedValue(new Error("push failed")),
    });

    await expect(
      executeSoftwarePublishPlan(plan, { dryRun: false, operations: calls }),
    ).rejects.toThrow("push failed");
    expect(calls.createTag).not.toHaveBeenCalled();
    expect(calls.pushTag).not.toHaveBeenCalled();
  });

  it("Actions 失败时不验证或宣告 Release 成功", async () => {
    const plan = createSoftwarePublishPlan(state());
    const calls = operations({
      waitForActions: vi.fn().mockResolvedValue({
        success: false,
        url: "https://github.example/actions/failed",
      }),
    });

    await expect(
      executeSoftwarePublishPlan(plan, { dryRun: false, operations: calls }),
    ).rejects.toBeInstanceOf(SoftwarePublishError);
    expect(calls.verifyRelease).not.toHaveBeenCalled();
  });

  it("dry-run 不调用任何写操作", async () => {
    const plan = createSoftwarePublishPlan(state());
    const calls = operations();

    await expect(
      executeSoftwarePublishPlan(plan, { dryRun: true, operations: calls }),
    ).resolves.toMatchObject({ dryRun: true, released: false });
    for (const operation of Object.values(calls)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("软件发布入口没有执行规则发布的命令", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/software-publish-orchestrator.mjs"),
      "utf8",
    );

    expect(source).not.toMatch(/(?:npm|npm\.cmd)[^\r\n]*rules:publish/iu);
    expect(source).not.toContain('"rules:publish"');
  });

  it("失败收尾输出稳定中文阶段且声明没有执行外部发布动作", () => {
    const error = new SoftwarePublishError("FULL_GATE_FAILED", "退出码 1", {
      stage: "正式FULL门禁",
    });
    const output = formatSoftwarePublishFailure(error, "C:\\logs\\release.log").join("\n");
    expect(output).toContain("VERIDIA 正式发布未完成");
    expect(output).toContain("失败阶段：正式FULL门禁");
    expect(output).toContain("错误摘要：退出码 1");
    expect(output).toContain("- Push发布版本");
    expect(output).toContain("- 创建Tag");
    expect(output).toContain("- 创建Release");
    expect(output).toContain("- 执行rules:publish");
  });
});
