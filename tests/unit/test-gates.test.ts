import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  E2E_MANIFEST,
  TEST_CATEGORIES,
  groupE2eFiles,
  listFormalE2eFiles,
  selectTestScope,
  validateManifest,
} from "../../scripts/testing/test-matrix.mjs";

describe("分层测试门禁", () => {
  it("正式 E2E 清单与 Playwright 正式测试文件完全一致且没有 skip", () => {
    expect(validateManifest()).toEqual(listFormalE2eFiles());
    expect(Object.keys(E2E_MANIFEST).sort()).toEqual(listFormalE2eFiles());
    const source = Object.keys(E2E_MANIFEST)
      .map((file) => fs.readFileSync(path.resolve(file), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/\b(?:test|describe)\.(?:skip|fixme)\b/u);
  });

  it("稳定分类完整覆盖要求的 16 个域", () => {
    expect(TEST_CATEGORIES).toEqual([
      "AUTH", "ADMIN", "XHS", "DOUYIN", "AUTOMATION", "IMPORT",
      "RESULTS", "RECHECK", "STORE_TOPIC", "RULES", "CAMPAIGN",
      "MIXED_PLATFORM", "UPDATE", "RELEASE", "DATABASE", "UI_LAYOUT",
    ]);
  });

  it("Douyin、结果和数据库改动选择对应测试并输出原因", () => {
    const selection = selectTestScope([
      "lib/automation/douyin-adapter.ts",
      "app/(admin)/results/page.tsx",
      "prisma/schema.prisma",
    ]);
    expect(selection.categories).toEqual(expect.arrayContaining(["DOUYIN", "RESULTS", "DATABASE"]));
    expect(selection.e2eFiles).toContain("tests/e2e/douyin-automation.spec.ts");
    expect(selection.reasons.length).toBeGreaterThan(0);
  });

  it("纯 Douyin 改动保持 FAST 范围收敛但保留跨平台结果回归", () => {
    const selection = selectTestScope(["lib/automation/douyin-page-classifier.ts"]);
    expect(selection.categories).toEqual(["DOUYIN"]);
    expect(selection.e2eFiles).toEqual([
      "tests/e2e/douyin-automation.spec.ts",
      "tests/e2e/platform-published-at.spec.ts",
      "tests/e2e/result-lifecycle.spec.ts",
    ]);
  });

  it("未知改动保守回退，测试基础设施改动至少提升到 REGRESSION", () => {
    expect(selectTestScope(["unknown/new-core-file.xyz"]).e2eFiles).toHaveLength(Object.keys(E2E_MANIFEST).length);
    const infrastructure = selectTestScope(["playwright.config.ts"], "fast");
    expect(infrastructure.minimumMode).toBe("regression");
    expect(infrastructure.e2eFiles).toHaveLength(Object.keys(E2E_MANIFEST).length);
  });

  it("高风险组使用独立运行组，只有全部只读安全文件才允许双 worker", () => {
    const groups = groupE2eFiles(Object.keys(E2E_MANIFEST));
    expect(groups.map((group) => group.name).sort()).toEqual(["AUTH_ADMIN", "AUTOMATION", "DATA_RULES", "RESULTS_UI"]);
    expect(groups.find((group) => group.name === "AUTOMATION")?.workers).toBe(1);
    expect(groupE2eFiles(["tests/e2e/local-fonts.spec.ts"])[0].workers).toBe(2);
  });

  it("平台测试和基线 fixture 显式选择 contentChannel", () => {
    const seed = fs.readFileSync(path.resolve("tests/e2e/setup-database.ts"), "utf8");
    const douyin = fs.readFileSync(path.resolve("tests/e2e/douyin-automation.spec.ts"), "utf8");
    expect(seed).toContain('contentChannel: "XIAOHONGSHU"');
    expect(douyin).toContain("contentChannel=DOUYIN");
    expect(douyin).toContain("contentChannel=XIAOHONGSHU");
  });

  it("运行器记录 run 身份且清理仅指向当前 run 进程和目录", () => {
    const runner = fs.readFileSync(path.resolve("scripts/testing/run-e2e.mjs"), "utf8");
    for (const field of ["runId", "port", "databasePath", "profilePath", "serverPid", "browserPid"]) expect(runner).toContain(field);
    expect(runner).toContain("taskkill");
    expect(runner).toContain("runDirectory");
    expect(runner).not.toContain("Get-Process | Stop-Process");
  });

  it("Actions 只缓存依赖、浏览器、Next 和不可变 fixture，不缓存结果或用户会话", () => {
    for (const workflow of [".github/workflows/veridia-ci.yml", ".github/workflows/veridia-release.yml"]) {
      const source = fs.readFileSync(path.resolve(workflow), "utf8");
      expect(source).toContain(".playwright/e2e-template");
      expect(source).toContain(".playwright/next-e2e");
      expect(source).toContain("ms-playwright");
      expect(source).toContain(".next/cache");
      const cacheBlock = source.match(/uses: actions\/cache@v4[\s\S]*?key:.*$/mu)?.[0] || "";
      expect(cacheBlock).not.toContain("test-results");
      expect(cacheBlock).not.toContain("playwright-report");
      expect(cacheBlock).not.toContain("profile");
    }
  });
});
