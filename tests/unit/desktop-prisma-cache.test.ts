import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createPrismaExecutionContext,
  isPrismaCachePermissionError,
  prismaMigrationFailureMessage,
} = require("../../desktop/prisma-environment.cjs") as {
  createPrismaExecutionContext: (options: {
    userDataPath: string;
    baseEnvironment?: NodeJS.ProcessEnv;
  }) => {
    cacheRoot: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  isPrismaCachePermissionError: (value: string) => boolean;
  prismaMigrationFailureMessage: (options: {
    details: string;
    logPath: string;
    restored: boolean;
  }) => string;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("桌面 Prisma 缓存目录", () => {
  it("安装目录只读时仍只在用户数据目录准备迁移缓存", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-prisma-"));
    temporaryRoots.push(root);
    const applicationRoot = path.join(
      root,
      "Program Files",
      "VERIDIA",
      "resources",
      "app",
    );
    const userDataPath = path.join(root, "user-data");
    fs.mkdirSync(applicationRoot, { recursive: true });
    fs.chmodSync(applicationRoot, 0o555);

    const context = createPrismaExecutionContext({
      userDataPath,
      baseEnvironment: { NODE_ENV: "production" },
    });

    expect(context.cacheRoot).toBe(
      path.join(userDataPath, "prisma-cache"),
    );
    expect(context.cwd).toBe(
      path.join(userDataPath, "prisma-cache", "working"),
    );
    expect(context.env.APPDATA).toBe(context.cacheRoot);
    expect(context.env.LOCALAPPDATA).toBe(context.cacheRoot);
    expect(context.env.XDG_CACHE_HOME).toBe(context.cacheRoot);
    expect(fs.existsSync(context.cwd)).toBe(true);
    expect(
      fs.existsSync(
        path.join(applicationRoot, "node_modules", ".cache", "prisma"),
      ),
    ).toBe(false);
  });

  it("将 Program Files 下的 Prisma EPERM 识别为缓存权限错误", () => {
    const details =
      "Error: EPERM: operation not permitted, mkdir 'C:\\Program Files\\VERIDIA\\resources\\app\\node_modules\\.cache\\prisma'";

    expect(isPrismaCachePermissionError(details)).toBe(true);
    expect(
      prismaMigrationFailureMessage({
        details,
        logPath: "E:\\logs\\desktop.log",
        restored: true,
      }),
    ).toBe(
      "权限/缓存目录写入失败，原数据库已恢复。请确认数据目录可写后重试。详情：E:\\logs\\desktop.log",
    );
  });

  it("普通迁移错误继续使用数据库迁移失败提示", () => {
    const message = prismaMigrationFailureMessage({
      details: "Migration failed because a SQL statement was invalid",
      logPath: "E:\\logs\\desktop.log",
      restored: true,
    });

    expect(message).toBe(
      "数据库迁移失败，原数据库已恢复。详情：E:\\logs\\desktop.log",
    );
  });

  it("所有桌面迁移命令都使用用户数据目录中的执行上下文", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "desktop", "main.cjs"),
      "utf8",
    );
    const migrationSource = source.slice(
      source.indexOf("function migrationExecutionContext"),
      source.indexOf("function serverEnvironment"),
    );

    expect(migrationSource).toContain('userDataPath: app.getPath("userData")');
    expect(migrationSource.match(/cwd: \w+\.cwd/gu)).toHaveLength(3);
    expect(migrationSource).not.toContain("cwd: applicationRoot()");
  });
});
