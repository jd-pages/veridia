import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const dataLocation = require("../../desktop/data-location.cjs") as {
  copyManagedData(source: string, target: string): {
    sourceManifest: Array<{ path: string; size: number; sha256: string }>;
    targetManifest: Array<{ path: string; size: number; sha256: string }>;
  };
  ensureManagedDirectories(root: string): Record<string, string>;
  readDataLocation(controlRoot: string): string | null;
  validateDataDirectory(
    candidate: string,
    options?: {
      installDirectory?: string;
      applicationDirectory?: string;
    },
  ): string;
  writeDataLocation(
    controlRoot: string,
    dataDirectory: string,
  ): { dataDirectory: string };
};

const temporaryRoots: string[] = [];

function temporaryDirectory(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `veridia-${name}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Windows 数据位置管理", () => {
  it("持久化自定义数据目录并写入卸载安全标记", () => {
    const controlRoot = temporaryDirectory("control");
    const target = path.join(temporaryDirectory("volume"), "VERIDIA-Data");

    dataLocation.writeDataLocation(controlRoot, target);

    expect(dataLocation.readDataLocation(controlRoot)).toBe(path.resolve(target));
    expect(fs.existsSync(path.join(target, ".veridia-data-root"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(controlRoot, "config", "data-location.ini"),
      ),
    ).toBe(true);
  });

  it("拒绝软件安装目录及其子目录", () => {
    const root = temporaryDirectory("install");
    const installDirectory = path.join(root, "VERIDIA");
    fs.mkdirSync(installDirectory);

    expect(() =>
      dataLocation.validateDataDirectory(
        path.join(installDirectory, "data"),
        { installDirectory },
      ),
    ).toThrow("软件安装目录");
  });

  it("完整复制并按 SHA-256 校验所有托管数据", () => {
    const source = path.join(temporaryDirectory("source"), "current");
    const target = path.join(temporaryDirectory("target"), "next");
    const layout = dataLocation.ensureManagedDirectories(source);
    fs.writeFileSync(path.join(layout.data, "veridia.db"), "sqlite-data");
    fs.writeFileSync(path.join(layout.config, "settings.json"), "{}");
    fs.writeFileSync(
      path.join(layout.sessions, "session.json"),
      "local-session",
    );
    fs.writeFileSync(
      path.join(layout.douyinSessions, "session.json"),
      "douyin-session",
    );

    const result = dataLocation.copyManagedData(source, target);

    expect(result.targetManifest).toEqual(result.sourceManifest);
    expect(fs.readFileSync(path.join(target, "data", "veridia.db"), "utf8")).toBe(
      "sqlite-data",
    );
    expect(
      fs.readFileSync(
        path.join(target, "sessions", "xiaohongshu-profile", "session.json"),
        "utf8",
      ),
    ).toBe("local-session");
    expect(
      fs.readFileSync(
        path.join(target, "sessions", "douyin-profile", "session.json"),
        "utf8",
      ),
    ).toBe("douyin-session");
    expect(layout.douyinSessions).not.toContain("xiaohongshu-profile");
  });

  it("安装包使用可选择目录的当前用户标准安装向导", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8"),
    );
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    });
  });
});
