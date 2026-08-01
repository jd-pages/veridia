import fs from "node:fs";
import path from "node:path";
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
});
