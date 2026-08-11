import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertProjectRootConsistency,
  assertOnlyVersionFiles,
  createSoftwarePublishPlan,
  executeSoftwarePublishPlan,
  formatSoftwarePublishFailure,
  nextPatchVersion,
  parseGitPorcelainPaths,
  SoftwarePublishError,
} from "../../scripts/software-publish-orchestrator.mjs";
import { canonicalizeProjectPath } from "../../scripts/testing/project-path.mjs";

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
    sourceTagExists: true,
    sourceReleaseExists: true,
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
  it("以 Git 顶层目录校验发布入口、脚本目录和当前工作目录", () => {
    const gitRoot = path.resolve(process.cwd());

    expect(
      assertProjectRootConsistency({
        scriptRoot: gitRoot,
        resolvedProjectRoot: gitRoot,
        gitRoot,
        workingDirectory: gitRoot,
      }),
    ).toBe(canonicalizeProjectPath(gitRoot));
    expect(() =>
      assertProjectRootConsistency({
        scriptRoot: path.join(gitRoot, "stale-copy"),
        resolvedProjectRoot: gitRoot,
        gitRoot,
        workingDirectory: gitRoot,
      }),
    ).toThrow("Git 顶层根目录不一致");
  });

  it("发布入口不再绑定开发机绝对项目路径", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/software-publish-orchestrator.mjs"),
      "utf8",
    );

    const retiredProjectRoot = [
      "C:",
      "Users",
      "18341",
      "Desktop",
      "veridia",
    ].join("\\");
    expect(source).not.toContain(retiredProjectRoot);
    expect(source).toContain('git", ["rev-parse", "--show-toplevel"]');
  });

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
      state({
        sourceVersion: "1.2.0",
        lockVersion: "1.2.0",
        sourceTagExists: false,
        sourceReleaseExists: false,
      }),
    );

    expect(plan.targetVersion).toBe("1.2.0");
    expect(plan.versionChangeRequired).toBe(false);
  });

  it("源码版本尚无 Tag 时按该版本首次发布", () => {
    const plan = createSoftwarePublishPlan(state({
      sourceVersion: "1.1.8",
      lockVersion: "1.1.8",
      latestReleaseVersion: "1.1.7",
      latestTagVersion: "1.1.7",
      sourceTagExists: false,
      sourceReleaseExists: false,
    }));

    expect(plan).toMatchObject({
      targetVersion: "1.1.8",
      versionChangeRequired: false,
    });
  });

  it("Tag 已占用但 Release 缺失的失败版本会保留并规划下一补丁版本", () => {
    const plan = createSoftwarePublishPlan(state({
      sourceVersion: "1.1.8",
      lockVersion: "1.1.8",
      latestReleaseVersion: "1.1.7",
      latestTagVersion: "1.1.8",
      sourceTagExists: true,
      sourceReleaseExists: false,
    }));

    expect(plan).toMatchObject({
      currentVersion: "1.1.7",
      sourceVersion: "1.1.8",
      targetVersion: "1.1.9",
      failedReservedVersion: "1.1.8",
      versionChangeRequired: true,
    });
  });

  it("不属于当前源码失败保留版本的 Tag/Release 不一致仍会阻止发布", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.9",
      lockVersion: "1.1.9",
      latestReleaseVersion: "1.1.7",
      latestTagVersion: "1.1.8",
      sourceTagExists: false,
      sourceReleaseExists: false,
    }))).toThrow("Latest Release（1.1.7）与最新正式 Tag（1.1.8）不一致");
  });

  it("源码版本低于正式 Release 时停止", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.6",
      lockVersion: "1.1.6",
      latestReleaseVersion: "1.1.7",
      latestTagVersion: "1.1.7",
      sourceTagExists: true,
      sourceReleaseExists: false,
    }))).toThrow("源码版本 1.1.6 低于已发布版本 1.1.7");
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

  it("完整保留 Git porcelain 路径且兼容状态、空格、rename、CRLF 与 NUL", () => {
    expect(parseGitPorcelainPaths(" M package.json\r\n")).toEqual(["package.json"]);
    expect(parseGitPorcelainPaths(" M package-lock.json\r\n")).toEqual(["package-lock.json"]);
    expect(parseGitPorcelainPaths("M  package.json\nMM app/page.tsx\n?? unexpected.txt\n")).toEqual([
      "package.json",
      "app/page.tsx",
      "unexpected.txt",
    ]);
    expect(parseGitPorcelainPaths("?? file with spaces.txt\nR  old name.txt -> new name.txt\n")).toEqual([
      "file with spaces.txt",
      "new name.txt",
    ]);
    expect(parseGitPorcelainPaths(" M package.json\0R  new name.txt\0old name.txt\0?? C:\\temp file.txt\0")).toEqual([
      "package.json",
      "new name.txt",
      "C:\\temp file.txt",
    ]);
  });

  it("版本白名单只允许真实版本源，业务源码修改仍会阻止发布", () => {
    expect(() => assertOnlyVersionFiles(["package.json", "package-lock.json"])).not.toThrow();
    expect(() => assertOnlyVersionFiles(["package.json", "app/page.tsx"])).toThrow(
      "发布验证产生了非版本文件修改：\napp/page.tsx",
    );
  });
});
