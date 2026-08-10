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
import {
  captureFile,
  cleanupKnownTestNextGeneratedTypes,
  cleanupTestNextGeneratedTypes,
  restoreFile,
} from "../../scripts/testing/next-type-isolation.mjs";
import os from "node:os";

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
    expect(runner).toContain("cleanupTestNextGeneratedTypes");
    expect(runner).toContain("restoreFile");
    expect(runner).toContain('await cleanup("outer-timeout")');
    expect(runner).toContain('await cleanup("infrastructure-error")');
    expect(runner).not.toContain("Get-Process | Stop-Process");
  });

  it("正式 TypeScript 配置不包含 E2E generated types", () => {
    const formal = JSON.parse(fs.readFileSync(path.resolve("tsconfig.json"), "utf8"));
    const e2e = JSON.parse(fs.readFileSync(path.resolve("tsconfig.e2e.json"), "utf8"));
    expect(formal.include.join("\n")).not.toContain(".playwright");
    expect(formal.exclude).toContain(".playwright");
    expect(e2e.extends).toBe("./tsconfig.json");
  });

  it("清理测试 generated types 时保留 Next 缓存且不触碰正式 .next", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-next-isolation-"));
    const testDist = path.join(root, ".playwright", "next-e2e");
    const badRoute = path.join(testDist, "dev", "types", "routes.d.ts");
    const cache = path.join(testDist, "cache", "webpack.bin");
    const formal = path.join(root, ".next", "types", "routes.d.ts");
    fs.mkdirSync(path.dirname(badRoute), { recursive: true });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.mkdirSync(path.dirname(formal), { recursive: true });
    fs.writeFileSync(badRoute, "declare global { } }", "utf8");
    fs.writeFileSync(cache, "cache", "utf8");
    fs.writeFileSync(formal, "declare global {}", "utf8");

    expect(cleanupTestNextGeneratedTypes(root, ".playwright/next-e2e")).toEqual([
      ".playwright/next-e2e/dev/types",
    ]);
    expect(fs.existsSync(badRoute)).toBe(false);
    expect(fs.existsSync(cache)).toBe(true);
    expect(fs.existsSync(formal)).toBe(true);
    expect(() => cleanupTestNextGeneratedTypes(root, ".next")).toThrow("拒绝清理非测试 Next 目录");
  });

  it("正式门禁准备会清除所有已识别测试 Next types", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-next-stale-"));
    for (const name of ["next-e2e", "next-release"]) {
      const file = path.join(root, ".playwright", name, "dev", "types", "routes.d.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "broken }", "utf8");
    }
    expect(cleanupKnownTestNextGeneratedTypes(root)).toHaveLength(2);
    expect(fs.existsSync(path.join(root, ".playwright", "next-e2e", "dev", "types"))).toBe(false);
  });

  it("E2E 收尾可以原样恢复 Next 生成入口", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-next-env-"));
    const file = path.join(root, "next-env.d.ts");
    fs.writeFileSync(file, 'import "./.next/types/routes.d.ts";\n', "utf8");
    const snapshot = captureFile(file);
    fs.writeFileSync(file, 'import "./.playwright/next-e2e/dev/types/routes.d.ts";\n', "utf8");
    restoreFile(file, snapshot);
    expect(fs.readFileSync(file, "utf8")).toBe('import "./.next/types/routes.d.ts";\n');
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
