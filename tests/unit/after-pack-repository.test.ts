import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPackagedBusinessDataArtifacts,
  resolveSoftwareUpdateRepository,
} from "../../scripts/after-pack.mjs";

const temporaryDirectories: string[] = [];

function project(packageJson: Record<string, unknown> = {}) {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-after-pack-"),
  );
  temporaryDirectories.push(projectDir);
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify(packageJson),
    "utf8",
  );
  return projectDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("after-pack 软件更新仓库解析", () => {
  it("AppInfo 没有 metadata 时从 electron-builder publish 配置读取", () => {
    const projectDir = project();
    const repository = resolveSoftwareUpdateRepository(
      {
        packager: {
          projectDir,
          appInfo: {},
          config: {
            publish: [
              { provider: "github", owner: "jd-pages", repo: "veridia" },
            ],
          },
        },
      },
      {},
    );

    expect(repository).toBe("jd-pages/veridia");
  });

  it("publish 缺失时安全回退到项目 repository", () => {
    const projectDir = project({
      repository: {
        type: "git",
        url: "https://github.com/jd-pages/veridia.git",
      },
    });

    expect(
      resolveSoftwareUpdateRepository(
        { packager: { projectDir, appInfo: {}, config: {} } },
        {},
      ),
    ).toBe("jd-pages/veridia");
  });

  it("优先使用软件发布环境配置且不读取规则仓库变量", () => {
    const projectDir = project();

    expect(
      resolveSoftwareUpdateRepository(
        { packager: { projectDir, appInfo: {}, config: {} } },
        {
          GITHUB_REPOSITORY: "jd-pages/veridia",
          VERIDIA_RULES_REPOSITORY: "jd-pages/veridia-rules",
        },
      ),
    ).toBe("jd-pages/veridia");
  });

  it("本地验收缺少远程仓库信息时返回空值而不是抛 TypeError", () => {
    const projectDir = project();

    expect(
      resolveSoftwareUpdateRepository(
        { packager: { projectDir, appInfo: {}, config: {} } },
        { VERIDIA_RULES_REPOSITORY: "jd-pages/veridia-rules" },
      ),
    ).toBe("");
  });
});

describe("after-pack 业务数据隔离", () => {
  it("拒绝把业务数据库、历史导入模板和验收产物打进应用", () => {
    const applicationRoot = project();
    fs.mkdirSync(path.join(applicationRoot, "data"), { recursive: true });
    fs.writeFileSync(path.join(applicationRoot, "data", "veridia.db"), "db");
    fs.writeFileSync(
      path.join(applicationRoot, "VERIDIA佳贝艾特导入模板_20260804.xlsx"),
      "xlsx",
    );
    fs.mkdirSync(path.join(applicationRoot, "test-results"));

    expect(findPackagedBusinessDataArtifacts(applicationRoot).sort()).toEqual([
      "VERIDIA佳贝艾特导入模板_20260804.xlsx",
      path.join("data", "veridia.db"),
      "test-results",
    ].sort());
  });

  it("允许项目规则源和 Prisma schema 进入应用", () => {
    const applicationRoot = project();
    fs.mkdirSync(path.join(applicationRoot, "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(applicationRoot, "rules", "default-rules.json"),
      "{}",
    );
    fs.mkdirSync(path.join(applicationRoot, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(applicationRoot, "prisma", "schema.prisma"), "");

    expect(findPackagedBusinessDataArtifacts(applicationRoot)).toEqual([]);
  });
});
