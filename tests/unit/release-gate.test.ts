import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { describe, expect, it } from "vitest";

describe("本地打包发布门禁", () => {
  it("先确定候选版本，再完成全部检查，最后才构建安装包", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "release.mjs"),
      "utf8",
    );
    const steps = [
      'run("升级版本号"',
      'run("生成 Prisma Client"',
      'run("检查 Prisma Client"',
      'run("TypeScript检查"',
      'run("ESLint"',
      'run("单元测试"',
      'run("桌面健康检查"',
      'run("准备并检查 Electron 运行文件"',
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

  it("软件和规则 BAT 保持独立，软件发布通过 Tag 触发 Actions", () => {
    const softwareBat = fs.readFileSync(
      path.resolve(process.cwd(), "发布新版.bat"),
      "utf8",
    );
    const rulesBatBytes = fs.readFileSync(
      path.resolve(process.cwd(), "发布规则新版.bat"),
    );
    const rulesBat = new TextDecoder("gbk").decode(rulesBatBytes);
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "fixed-workflow.mjs"),
      "utf8",
    );
    const gitignore = fs.readFileSync(
      path.resolve(process.cwd(), ".gitignore"),
      "utf8",
    );

    expect(softwareBat).toContain("fixed-workflow.mjs publish");
    expect(softwareBat).not.toContain("rules:publish");
    expect(rulesBat).toContain("rules:publish");
    expect(rulesBat).not.toContain("fixed-workflow.mjs publish");
    expect([...rulesBatBytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(rulesBat).toContain("chcp 936 >nul");
    expect(rulesBat).not.toContain("chcp 65001 >nul");
    expect(rulesBat).toContain(
      'set "VERIDIA_RULES_REPOSITORY=jd-pages/veridia-rules"',
    );
    for (const message of [
      "数据库检查或迁移失败，规则发布已停止。",
      "远程旧规则未被覆盖，也没有上传新的规则包。",
      "本地规则数据读取失败，规则发布已停止。",
      "规则发布失败。上一版远程规则未被覆盖。",
    ]) {
      expect(rulesBat).toContain(`echo ${message}`);
    }
    const executableLines = rulesBat
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(
      executableLines.filter((line) => /^[\u3400-\u9fff]/u.test(line)),
    ).toEqual([]);
    expect(rulesBat.match(/if errorlevel 1 \(/gu)).toHaveLength(3);
    expect(rulesBat.match(/exit \/b 1/gu)).toHaveLength(3);
    expect(rulesBat).toContain("exit /b 0");
    expect(workflow).toContain('"trigger-actions"');
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
