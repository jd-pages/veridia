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
    latestPublishedRelease: {
      version: "1.1.6",
      releaseExists: true,
      tagExists: true,
      tagCommit: "published-commit",
      remoteTagCommit: "published-commit",
      releaseCommit: "published-commit",
    },
    historicalTags: [],
    targetTagExists: false,
    targetReleaseExists: false,
    ...overrides,
  };
}

function failedTag(version: string, overrides: Record<string, unknown> = {}) {
  const tagCommit = `failed-${version}`;
  return {
    version,
    tagCommit,
    remoteTagCommit: tagCommit,
    releaseExists: false,
    isMainAncestor: true,
    workflowRuns: [{
      databaseId: Number(version.replaceAll(".", "")),
      headSha: tagCommit,
      headBranch: `v${version}`,
      status: "completed",
      conclusion: "failure",
      event: "push",
      url: `https://github.example/actions/${version}`,
    }],
    ...overrides,
  };
}

function operations(overrides: Record<string, unknown> = {}) {
  return {
    preflight: vi.fn(),
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
      }),
    );

    expect(plan.targetVersion).toBe("1.2.0");
    expect(plan.versionChangeRequired).toBe(false);
  });

  it("Case A：无失败历史时按预先准备的源码版本首次发布", () => {
    const plan = createSoftwarePublishPlan(state({
      sourceVersion: "1.1.14",
      lockVersion: "1.1.14",
      latestReleaseVersion: "1.1.13",
      latestPublishedRelease: {
        version: "1.1.13",
        releaseExists: true,
        tagExists: true,
        tagCommit: "release-113",
        remoteTagCommit: "release-113",
        releaseCommit: "release-113",
      },
    }));

    expect(plan).toMatchObject({
      targetVersion: "1.1.14",
      versionChangeRequired: false,
      latestPublishedReleaseVersion: "1.1.13",
      latestHistoricalTagVersion: "1.1.13",
      failedReleaseTags: [],
    });
  });

  it("Case B / J：单个失败历史 Tag 合法时目标仍严格等于源码版本", () => {
    const plan = createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      latestReleaseVersion: "1.1.13",
      latestPublishedRelease: {
        version: "1.1.13",
        releaseExists: true,
        tagExists: true,
        tagCommit: "release-113",
        remoteTagCommit: "release-113",
        releaseCommit: "release-113",
      },
      historicalTags: [failedTag("1.1.14")],
    }));

    expect(plan).toMatchObject({
      currentVersion: "1.1.13",
      sourceVersion: "1.1.15",
      targetVersion: "1.1.15",
      latestHistoricalTagVersion: "1.1.14",
      versionChangeRequired: false,
    });
    expect(plan.failedReleaseTags).toEqual([
      expect.objectContaining({
        version: "1.1.14",
        workflowConclusion: "failure",
      }),
    ]);
  });

  it("Case C：多个连续失败历史 Tag 都有有效证据时允许更高目标版本", () => {
    const plan = createSoftwarePublishPlan(state({
      sourceVersion: "1.1.16",
      lockVersion: "1.1.16",
      latestReleaseVersion: "1.1.13",
      latestPublishedRelease: {
        version: "1.1.13",
        releaseExists: true,
        tagExists: true,
        tagCommit: "release-113",
        remoteTagCommit: "release-113",
        releaseCommit: "release-113",
      },
      historicalTags: [failedTag("1.1.14"), failedTag("1.1.15", {
        workflowRuns: [{
          databaseId: 115,
          headSha: "failed-1.1.15",
          headBranch: "v1.1.15",
          status: "completed",
          conclusion: "cancelled",
          event: "push",
        }],
      })],
    }));

    expect(plan.targetVersion).toBe("1.1.16");
    expect(plan.failedReleaseTags.map((tag) => tag.version)).toEqual([
      "1.1.14",
      "1.1.15",
    ]);
  });

  it.each(["queued", "in_progress"])(
    "Case D：失败历史 Tag 的 Workflow 仍为 %s 时阻止",
    (status) => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14", {
        workflowRuns: [{
          databaseId: 114,
          headSha: "failed-1.1.14",
          headBranch: "v1.1.14",
          status,
          conclusion: "",
          event: "push",
        }],
      })],
    }))).toThrow(`仍处于 ${status}`);
    },
  );

  it("Case E：无终态失败证据的孤立 Tag 阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14", { workflowRuns: [] })],
    }))).toThrow("缺少同提交、终态失败");
  });

  it.each([
    ["Case F：目标 Tag 已存在", { targetTagExists: true }, "目标 Tag v1.1.15 已存在"],
    ["Case G：目标 Release 已存在", { targetReleaseExists: true }, "GitHub Release v1.1.15 已存在"],
  ])("%s 时阻止", (_label, override, message) => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14")],
      ...override,
    }))).toThrow(message);
  });

  it("Case H：失败历史 Tag Commit 不是 main 祖先时阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14", { isMainAncestor: false })],
    }))).toThrow("不是当前 main 的祖先");
  });

  it("失败历史 Tag 必须严格低于 target", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.15")],
    }))).toThrow("必须严格低于目标版本 v1.1.15");
  });

  it("Release 存在但对应 Tag 缺失时阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      latestPublishedRelease: {
        version: "1.1.6",
        releaseExists: true,
        tagExists: false,
      },
    }))).toThrow("GitHub Release v1.1.6 存在，但对应 Tag 缺失");
  });

  it("Latest Release 查询结果与正式发布状态版本不一致时阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      latestPublishedRelease: {
        version: "1.1.5",
        releaseExists: true,
        tagExists: true,
        tagCommit: "release-115",
        remoteTagCommit: "release-115",
        releaseCommit: "release-115",
      },
    }))).toThrow("Latest Release 查询结果与 PUBLISHED_RELEASE 状态版本不一致");
  });

  it("同版本 Tag / Release 指向不同 Commit 时阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      latestPublishedRelease: {
        version: "1.1.6",
        releaseExists: true,
        tagExists: true,
        tagCommit: "tag-commit",
        remoteTagCommit: "tag-commit",
        releaseCommit: "release-commit",
      },
    }))).toThrow("Tag、远程引用、Release/Workflow 提交不一致");
  });

  it("失败历史 Tag 被移动或覆盖时阻止", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14", {
        remoteTagCommit: "moved-commit",
      })],
    }))).toThrow("Tag、远程引用、Release/Workflow 提交不一致");
  });

  it("中间版本已有 Release 时不能分类为失败历史 Tag", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.15",
      lockVersion: "1.1.15",
      historicalTags: [failedTag("1.1.14", { releaseExists: true })],
    }))).toThrow("不能分类为 FAILED_RELEASE_TAG");
  });

  it("Case I：源码版本低于正式 Release 时停止", () => {
    expect(() => createSoftwarePublishPlan(state({
      sourceVersion: "1.1.6",
      lockVersion: "1.1.6",
      latestReleaseVersion: "1.1.7",
      latestPublishedRelease: {
        version: "1.1.7",
        releaseExists: true,
        tagExists: true,
        tagCommit: "release-117",
        remoteTagCommit: "release-117",
        releaseCommit: "release-117",
      },
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

  it("失败收尾输出结构化阶段、类型与安全边界", () => {
    const error = new SoftwarePublishError("FULL_GATE_FAILED", "退出码 1", {
      stage: "UNIT_TEST",
      classification: "TEST_TIMEOUT",
      failedItem: "playwright-chromium-runtime.test.ts / Case C",
      attempt: 2,
      maxAttempts: 2,
      elapsedMs: 30_400,
      cacheStatus: "NOT_APPLICABLE",
    });
    const output = formatSoftwarePublishFailure(error, "C:\\logs\\release.log").join("\n");
    expect(output).toContain("VERIDIA 正式发布未完成");
    expect(output).toContain("失败阶段：UNIT_TEST");
    expect(output).toContain("错误类型：TEST_TIMEOUT");
    expect(output).toContain("失败项目：playwright-chromium-runtime.test.ts / Case C");
    expect(output).toContain("请求次数：2/2");
    expect(output).toContain("耗时：30400ms");
    expect(output).toContain("缓存状态：NOT_APPLICABLE");
    expect(output).toContain("错误摘要：退出码 1");
    expect(output).toContain("- Push main");
    expect(output).toContain("- 创建 / Push Tag");
    expect(output).toContain("- GitHub Release");
    expect(output).toContain("- 执行rules:publish");
  });

  it.each([
    ["FULL", "Unit failed", "UNIT_TEST"],
    ["FULL", "Build failed", "PRODUCTION_BUILD"],
    ["FULL", "Electron request ETIMEDOUT", "PREREQUISITE_WARMUP"],
    ["FULL", "Package failed", "PACKAGE"],
    ["PUSH_MAIN", "push failed", "PUSH_MAIN"],
    ["TAG", "tag failed", "TAG"],
  ])("子阶段 %s 失败保留真实 stage %s", async (_wrapper, message, stage) => {
    const plan = createSoftwarePublishPlan(state());
    const stageOperation = {
      UNIT_TEST: "validate",
      PRODUCTION_BUILD: "validate",
      PREREQUISITE_WARMUP: "preflight",
      PACKAGE: "validate",
      PUSH_MAIN: "pushMain",
      TAG: "createTag",
    }[stage] as string;
    const calls = operations({
      [stageOperation]: vi.fn().mockRejectedValue(
        new SoftwarePublishError("SIMULATED", message, {
          stage,
          classification: message.includes("ETIMEDOUT")
            ? "TRANSIENT_NETWORK"
            : "DETERMINISTIC",
        }),
      ),
    });

    await expect(
      executeSoftwarePublishPlan(plan, { dryRun: false, operations: calls }),
    ).rejects.toMatchObject({ stage });
    if (["UNIT_TEST", "PRODUCTION_BUILD", "PREREQUISITE_WARMUP", "PACKAGE"].includes(stage)) {
      expect(calls.commitVersion).not.toHaveBeenCalled();
      expect(calls.pushMain).not.toHaveBeenCalled();
      expect(calls.createTag).not.toHaveBeenCalled();
    }
    if (stage === "PREREQUISITE_WARMUP") {
      expect(calls.updateVersion).not.toHaveBeenCalled();
      expect(calls.validate).not.toHaveBeenCalled();
      expect(calls.restoreVersion).not.toHaveBeenCalled();
    }
    if (stage === "PUSH_MAIN") expect(calls.createTag).not.toHaveBeenCalled();
    if (stage === "TAG") expect(calls.pushTag).not.toHaveBeenCalled();
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
