import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSoftwareUpdateRepository } from "../../scripts/after-pack.mjs";

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
