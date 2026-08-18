import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { describe, expect, it } from "vitest";

describe("本地打包发布门禁", () => {
  it("正式发布复用统一 FULL 门禁，最后才构建安装包", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release.mjs"),
      "utf8",
    );
    const steps = [
      'run("VERSION_UPDATE", "升级版本号"',
      'run("FULL", "正式FULL门禁"',
      'run("PREREQUISITE_WARMUP", "准备并检查 Electron 运行文件"',
      '"构建Windows安装包"',
    ];
    const positions = steps.map((step) => source.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("本地打包脚本本身不创建 Tag、Release 或上传文件", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release.mjs"),
      "utf8",
    );

    expect(source).not.toContain("finalize-release.mjs");
    expect(source).not.toContain("create-release-tag.mjs");
    expect(source).not.toContain("action-gh-release");
  });

  it("方案 A 始终执行本地正式 FULL，不复用 Attestation", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release.mjs"),
      "utf8",
    );

    expect(source).not.toContain("validateFullGateAttestation(root)");
    expect(source).not.toContain("VERIDIA_ALLOW_FULL_ATTESTATION_REUSE");
    expect(source).toContain('run("FULL", "正式FULL门禁"');
    expect(source).toContain('VERIDIA_DISABLE_ATTESTATION_WRITE: "true"');
  });

  it("本地和远端各只有一个 FULL Build，Package 不重复 Next Build", () => {
    const local = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release.mjs"),
      "utf8",
    );
    const remote = fs.readFileSync(
      path.resolve(process.cwd(), ".github", "workflows", "veridia-release.yml"),
      "utf8",
    );
    expect(local.match(/npm\.cmd", \["run", "verify:full"\]/gu)).toHaveLength(1);
    expect(local).not.toContain('run("PRODUCTION_BUILD"');
    expect(local).not.toContain('run("SENSITIVE_SCAN"');
    expect(local).toContain('releaseStage === "full"');
    expect(local).toContain('["all", "full", "package"].includes(releaseStage)');
    expect(remote.match(/npm run verify:full/gu)).toHaveLength(1);
    expect(remote).not.toContain("构建正式 Next.js 版本");
    expect(remote.match(/electron-builder --win nsis/gu)).toHaveLength(1);
  });

  it("只有明确标记的只读网络命令进入有限 Retry，Push 与 Release 写入不重试", () => {
    const orchestrator = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "software-publish-orchestrator.mjs"),
      "utf8",
    );
    expect(orchestrator).toContain("readOnlyNetwork: true");
    expect(orchestrator).toContain('git(["push", "origin", "main"])');
    expect(orchestrator).toContain('git(["push", "origin", `v${current.targetVersion}`])');
    expect(orchestrator).not.toMatch(/git\(\["push"[^\n]+readOnlyNetwork/gu);
    expect(orchestrator).not.toMatch(/gh\(\["release", "create"[^\n]+readOnlyNetwork/gu);
  });

  it("Preflight 位于用户确认后、版本修改和 FULL 之前", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/software-publish-orchestrator.mjs"),
      "utf8",
    );
    const confirm = source.indexOf("confirmPublish()");
    const preflight = source.indexOf("preflight: async () => runReleasePreflight");
    const update = source.indexOf("updateVersion: async () => updateVersionFiles");

    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(confirm);
    expect(update).toBeGreaterThan(preflight);
  });

  it("云端发布安装完整开发依赖并在打包前检查 Electron 运行文件", () => {
    const workflow = fs.readFileSync(
      path.resolve(
        process.cwd(),
        ".github",
        "workflows",
        "veridia-release.yml",
      ),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as {
      build: Record<string, unknown>;
      scripts: Record<string, string>;
    };

    expect(workflow).toContain("npm ci --include=dev");
    expect(workflow).toContain("npm run electron:ensure");
    const assertions = [...workflow.matchAll(/npm run electron:assert/gu)];
    expect(assertions).toHaveLength(1);
    expect(packageJson.scripts["electron:ensure"]).toContain(
      "node_modules/electron/install.js",
    );
    expect(packageJson.build).not.toHaveProperty("electronDist");
    expect(workflow).not.toMatch(/"[^"\r\n]*[“”][^"\r\n]*"/u);
  });

  it("Main CI 与 Release Workflow 在 FULL 前使用同一 Desktop Node prepare 入口", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const prepareScript = packageJson.scripts["desktop:node:prepare"];
    expect(prepareScript).toBe("node scripts/desktop-node-runtime.mjs");

    for (const workflowPath of [
      ".github/workflows/veridia-ci.yml",
      ".github/workflows/veridia-release.yml",
    ]) {
      const workflow = fs.readFileSync(path.resolve(workflowPath), "utf8");
      const install = workflow.indexOf("npm ci");
      const prepare = workflow.indexOf("npm run desktop:node:prepare");
      const full = workflow.indexOf("npm run verify:full");
      expect(install).toBeGreaterThanOrEqual(0);
      expect(prepare).toBeGreaterThan(install);
      expect(full).toBeGreaterThan(prepare);
      expect(workflow.match(/npm run desktop:node:prepare/gu)).toHaveLength(1);
    }
  });

  it("Standalone smoke 只验证 bundled Node，缺失时失败且不负责下载", () => {
    const smoke = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "scripts",
        "testing",
        "standalone-runtime-smoke.mjs",
      ),
      "utf8",
    );
    const prepareDesktop = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "prepare-desktop.mjs"),
      "utf8",
    );

    expect(smoke).toContain("VERIDIA Desktop bundled Node is missing");
    expect(smoke).not.toContain("prepareDesktopNodeRuntime");
    expect(prepareDesktop).toContain("assertDesktopNodeRuntime");
    expect(prepareDesktop).not.toContain(
      "fs.copyFileSync(process.execPath",
    );
  });

  it("软件和规则 BAT 保持独立，软件发布通过 Tag 触发 Actions", () => {
    const softwareBatBytes = fs.readFileSync(
      path.resolve(process.cwd(), "发布新版.bat"),
    );
    const softwareBat = new TextDecoder("utf-8").decode(softwareBatBytes);
    const rulesBatBytes = fs.readFileSync(
      path.resolve(process.cwd(), "发布规则新版.bat"),
    );
    const rulesBat = new TextDecoder("gbk").decode(rulesBatBytes);
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "fixed-workflow.mjs"),
      "utf8",
    );
    const releaseWorkflow = fs.readFileSync(
      path.resolve(
        process.cwd(),
        ".github",
        "workflows",
        "veridia-release.yml",
      ),
      "utf8",
    );
    const finalizeRelease = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "finalize-release.mjs"),
      "utf8",
    );
    const gitignore = fs.readFileSync(
      path.resolve(process.cwd(), ".gitignore"),
      "utf8",
    );

    const orchestrator = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "scripts",
        "software-publish-orchestrator.mjs",
      ),
      "utf8",
    );

    expect(softwareBat).toContain("software-publish-orchestrator.mjs");
    expect(softwareBat).toContain("%*");
    expect(softwareBat).not.toContain("fixed-workflow.mjs publish");
    expect(softwareBat).not.toContain("validate-software-release.mjs");
    expect(softwareBat).not.toMatch(/npm(?:\.cmd)?[^\r\n]*rules:publish/iu);
    expect([...softwareBatBytes.subarray(0, 3)]).not.toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    expect(softwareBat).toContain("chcp 65001 >nul");
    expect(softwareBat).not.toContain("chcp 936 >nul");
    expect(softwareBat).toContain("software-publish-bat-tail.mjs failure");
    expect(softwareBat).toContain("software-publish-bat-tail.mjs success");
    expect(softwareBatBytes.includes(Buffer.from("\r\n"))).toBe(true);
    expect(softwareBat).not.toMatch(/[\u0080-\uffff]/u);
    const batTail = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "software-publish-bat-tail.mjs"),
      "utf8",
    );
    expect(batTail).toContain("VERIDIA 正式发布未完成");
    expect(batTail).toContain("VERIDIA 发布入口已正常结束");
    expect(orchestrator).toContain("失败阶段：");
    expect(orchestrator).toContain("VERIDIA 正式发布未完成");
    expect(orchestrator).toContain(".release-work");
    expect(orchestrator).toContain("software-release-");
    expect(softwareBat.match(/^pause$/gmu)).toHaveLength(2);
    expect(softwareBat).toContain("exit /b %VERIDIA_EXIT_CODE%");
    expect(softwareBat).not.toMatch(/^\s*exit(?:\s|$)(?!\/b)/gmu);
    expect(rulesBat).toContain("rules:publish");
    expect(rulesBat).not.toContain("fixed-workflow.mjs publish");
    expect([...rulesBatBytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(rulesBat).toContain("chcp 936 >nul");
    expect(rulesBat).not.toContain("chcp 65001 >nul");
    expect(rulesBat).toContain(
      'set "VERIDIA_RULES_REPOSITORY=jd-pages/veridia-rules"',
    );
    expect(rulesBat).toContain('cd /d "%~dp0"');
    expect(rulesBat).toContain("规则来源：项目内 rules/default-rules.json");
    expect(rulesBat).toContain("if defined VERIDIA_RULE_DATABASE_PATH (");
    expect(rulesBat).not.toContain("E:\\veridi\\shuju\\data\\veridia.db");
    expect(rulesBat).not.toContain("E:\\v-preview\\data\\veridia.db");
    expect(rulesBat).not.toContain("rules:db:preflight");
    expect(rulesBat).not.toContain("rules:validate-local");
    expect(rulesBat).toContain("call npm.cmd run rules:publish");
    expect(rulesBat).toContain('set "VERIDIA_EXIT_CODE=%ERRORLEVEL%"');
    expect(rulesBat).toContain("pause");
    expect(rulesBat).toContain("exit /b %VERIDIA_EXIT_CODE%");
    const executableLines = rulesBat
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(
      executableLines.filter((line) => /^[\u3400-\u9fff]/u.test(line)),
    ).toEqual([]);
    expect(workflow).toContain('"trigger-actions"');
    expect(orchestrator).toContain('"release.mjs"');
    expect(orchestrator).toContain("waitForActions");
    expect(orchestrator).toContain("verifyRemoteRelease");
    expect(orchestrator).toContain("--dry-run");
    expect(releaseWorkflow).toContain("检查自动更新发布三件套");
    expect(releaseWorkflow).toContain(
      "validate-software-release.mjs --directory=dist-installer",
    );
    expect(releaseWorkflow).toContain("gh release create");
    expect(releaseWorkflow).toContain("--draft");
    expect(releaseWorkflow).not.toContain("softprops/action-gh-release");
    expect(releaseWorkflow).toContain("gh release download");
    expect(releaseWorkflow).toContain("validate-software-release.mjs --directory=$draft");
    expect(releaseWorkflow).toContain("gh release edit");
    expect(releaseWorkflow).toContain("--draft=false --latest");
    expect(releaseWorkflow).not.toContain("finalize-release.mjs verify-remote");
    for (const asset of [
      "dist-installer/VERIDIA-Setup-${{ steps.version.outputs.version }}.exe",
      "dist-installer/VERIDIA-Setup-${{ steps.version.outputs.version }}.exe.blockmap",
      "dist-installer/latest.yml",
    ]) {
      expect(releaseWorkflow).toContain(asset);
    }
    expect(releaseWorkflow).not.toContain("rules:publish");
    expect(releaseWorkflow).toContain("客户端将通过 latest.yml 检测版本");
    expect(releaseWorkflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(finalizeRelease).toContain("process.env.GH_TOKEN");
    for (const ignored of [
      "/release/",
      "/dist-installer/",
      "*.exe",
      "latest.yml",
      "*.blockmap",
    ]) {
      expect(gitignore).toContain(ignored);
    }
  });
});
