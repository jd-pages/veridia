import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { installWindowOpenPolicy } = require(
  "../../desktop/window-open-policy.cjs",
) as {
  installWindowOpenPolicy(dependencies: {
    window: {
      setMenuBarVisibility(value: boolean): void;
      removeMenu(): void;
      webContents: {
        setWindowOpenHandler(handler: (details: { url: string }) => unknown): void;
        downloadURL(url: string): void;
      };
    };
    shell: { openExternal(url: string): Promise<void> };
    internalOrigin: string;
    writeLog(message: string, error?: unknown): void;
  }): void;
};

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function windowFixture() {
  let handler: ((details: { url: string }) => unknown) | undefined;
  const downloadURL = vi.fn();
  const setMenuBarVisibility = vi.fn();
  const removeMenu = vi.fn();
  return {
    window: {
      setMenuBarVisibility,
      removeMenu,
      webContents: {
        downloadURL,
        setWindowOpenHandler: vi.fn((next) => {
          handler = next;
        }),
      },
    },
    downloadURL,
    setMenuBarVisibility,
    removeMenu,
    getHandler: () => handler!,
  };
}

describe("桌面端导入模板下载", () => {
  it("前端使用 fetch 保存附件，不再通过 window.open 创建子窗口", () => {
    const tasksPage = source("app/(admin)/tasks/page.tsx");
    const downloadClient = source("lib/import-template-download-client.ts");

    expect(tasksPage).toContain('downloadTemplate("xlsx", "danone-customer")');
    expect(tasksPage).not.toContain('downloadTemplate("xlsx", "danone-agency")');
    expect(tasksPage).not.toContain("下载达能代发 Excel 模板");
    expect(tasksPage).toContain('downloadTemplate("xlsx", "kabrita")');
    expect(tasksPage).not.toContain('downloadTemplate("csv"');
    expect(tasksPage).toContain('accept=".xlsx"');
    expect(tasksPage).toContain("暂不支持CSV文件");
    expect(tasksPage).not.toMatch(
      /window\.open\(\s*["']\/api\/import\/template/iu,
    );
    expect(downloadClient).toContain(
      "`/api/import/template?format=${format}&brand=${brand}`",
    );
    expect(downloadClient).not.toContain('"danone-agency"');
    expect(downloadClient).toContain("link.download = fileName");
    expect(downloadClient).not.toContain("window.open");
  });

  it("内部附件请求进入下载流程，但所有新窗口请求均被拒绝", () => {
    const fixture = windowFixture();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    installWindowOpenPolicy({
      window: fixture.window,
      shell: { openExternal },
      internalOrigin: "http://127.0.0.1:3100",
      writeLog: vi.fn(),
    });

    expect(
      fixture.getHandler()({
        url: "http://127.0.0.1:3100/api/import/template?format=xlsx",
      }),
    ).toEqual({ action: "deny" });
    expect(fixture.downloadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/import/template?format=xlsx",
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect(fixture.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(fixture.removeMenu).toHaveBeenCalledTimes(1);
  });

  it("外部链接交给系统浏览器，未知协议不会创建 BrowserWindow", () => {
    const fixture = windowFixture();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    installWindowOpenPolicy({
      window: fixture.window,
      shell: { openExternal },
      internalOrigin: "http://127.0.0.1:3100",
      writeLog: vi.fn(),
    });

    expect(
      fixture.getHandler()({ url: "https://www.xiaohongshu.com/explore/1" }),
    ).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith(
      "https://www.xiaohongshu.com/explore/1",
    );
    expect(fixture.getHandler()({ url: "about:blank" })).toEqual({
      action: "deny",
    });
    expect(fixture.downloadURL).not.toHaveBeenCalled();
  });

  it("Electron 主窗口全局移除默认英文应用菜单", () => {
    const desktopMain = source("desktop/main.cjs");
    expect(desktopMain).toContain("Menu.setApplicationMenu(null)");
    expect(desktopMain).toContain("installWindowOpenPolicy({");
  });
});
