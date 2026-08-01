import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("软件更新入口", () => {
  it("不向任何角色暴露历史版本入口", () => {
    const settings = source("app/(admin)/settings/page.tsx");
    const updateCenter = source("components/DesktopUpdateCenter.tsx");
    const preload = source("desktop/preload.cjs");
    const desktopMain = source("desktop/main.cjs");
    const desktopTypes = source("lib/desktop-api.d.ts");

    for (const content of [
      settings,
      updateCenter,
      preload,
      desktopMain,
      desktopTypes,
    ]) {
      expect(content).not.toContain("openReleaseNotes");
      expect(content).not.toContain("veridia:open-release-notes");
    }
    expect(settings).not.toContain("更新日志");
    expect(settings).not.toContain("查看历史版本");
    expect(updateCenter).not.toContain("查看更新内容");
  });

  it("保留版本信息与自动更新能力", () => {
    const settings = source("app/(admin)/settings/page.tsx");
    const updateCenter = source("components/DesktopUpdateCenter.tsx");
    const preload = source("desktop/preload.cjs");

    for (const label of ["当前版本", "构建日期", "数据库版本", "自动检查更新"]) {
      expect(settings).toContain(label);
    }
    expect(settings).toContain("checkForUpdates");
    expect(preload).toContain("veridia:check-update");
    expect(preload).toContain("veridia:download-update");
    expect(preload).toContain("veridia:install-update");
    expect(updateCenter).toContain("downloadUpdate");
    expect(updateCenter).toContain("installUpdate");
  });
});
