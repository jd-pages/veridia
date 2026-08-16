import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MINIMUM_CHROMIUM_FILE_SIZES,
  assertPlaywrightChromiumRuntime,
  preparePlaywrightChromiumRuntime,
  readPlaywrightChromiumRequirements,
  trustedPlaywrightCacheRoots,
  type PlaywrightChromiumRequirements,
} from "../../scripts/playwright-chromium-runtime.mjs";

const temporaryRoots: string[] = [];
const requirements: PlaywrightChromiumRequirements = {
  playwrightVersion: "1.62.0",
  revision: "1234",
  browserVersion: "151.0.7922.34",
  directoryName: "chromium-1234",
  headlessShellRevision: "1234",
};
const fixtureMinimums = Object.fromEntries(
  Object.keys(MINIMUM_CHROMIUM_FILE_SIZES).map((file: string) => [file, 1]),
);

function temporaryRoot(name = "runtime") {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-playwright-runtime-"),
  );
  temporaryRoots.push(parent);
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writePeExecutable(file: string, machine = 0x8664) {
  const content = Buffer.alloc(256);
  content.write("MZ", 0, "ascii");
  content.writeUInt32LE(128, 0x3c);
  content.write("PE\0\0", 128, "binary");
  content.writeUInt16LE(machine, 132);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createChromium(
  cacheRoot: string,
  revision = "1234",
  options: { omitExecutable?: boolean; machine?: number } = {},
) {
  const executableRoot = path.join(
    cacheRoot,
    `chromium-${revision}`,
    "chrome-win64",
  );
  fs.mkdirSync(executableRoot, { recursive: true });
  for (const relativePath of Object.keys(MINIMUM_CHROMIUM_FILE_SIZES)) {
    const file = path.join(executableRoot, ...relativePath.split("/"));
    if (relativePath === "chrome.exe") {
      if (!options.omitExecutable) {
        writePeExecutable(file, options.machine);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "runtime\n");
  }
}

function resolvedExecutable(_projectRoot: string, cacheRoot: string) {
  return path.join(
    cacheRoot,
    requirements.directoryName,
    "chrome-win64",
    "chrome.exe",
  );
}

function prepare(input: {
  destinationRoot: string;
  cacheRoots: string[];
  download: (downloadRoot: string) => void;
}) {
  return preparePlaywrightChromiumRuntime({
    projectRoot: temporaryRoot("project"),
    requirements,
    minimumFileSizes: fixtureMinimums,
    resolveExecutable: resolvedExecutable,
    output: vi.fn(),
    ...input,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Playwright Chromium runtime cache", () => {
  it("A: 精确版本完整缓存命中时不调用官方下载", () => {
    const destinationRoot = temporaryRoot("desktop runtime");
    createChromium(destinationRoot);
    const download = vi.fn();

    const result = prepare({
      destinationRoot,
      cacheRoots: [destinationRoot],
      download,
    });

    expect(result.source).toBe("CACHE");
    expect(download).not.toHaveBeenCalled();
    expect(result.executablePath).toBe(resolvedExecutable("", destinationRoot));
  });

  it("B: 缓存不存在时调用官方安装一次", () => {
    const destinationRoot = temporaryRoot("desktop-runtime");
    const download = vi.fn((downloadRoot: string) => {
      createChromium(downloadRoot);
    });

    const result = prepare({
      destinationRoot,
      cacheRoots: [destinationRoot],
      download,
    });

    expect(result.source).toBe("DOWNLOAD");
    expect(download).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(result.executablePath)).toBe(true);
  });

  // This remains a real filesystem integration case. On a saturated Windows
  // unit run, synchronous copy/inspection/cleanup has been observed at 12.7s.
  // Keep a bounded case-only ceiling without weakening the cache assertions.
  it("C: 只有旧 revision 时拒绝复用并下载精确版本", () => {
    const cacheRoot = temporaryRoot("official-cache");
    const destinationRoot = temporaryRoot("desktop-runtime");
    createChromium(cacheRoot, "1220");
    const download = vi.fn((downloadRoot: string) => {
      createChromium(downloadRoot);
    });

    prepare({ destinationRoot, cacheRoots: [cacheRoot], download });

    expect(download).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(path.join(destinationRoot, "chromium-1234")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(destinationRoot, "chromium-1220")),
    ).toBe(false);
  }, 20_000);

  it("D: 精确目录缺少 chrome.exe 时视为损坏并重新下载", () => {
    const cacheRoot = temporaryRoot("broken-cache");
    const destinationRoot = temporaryRoot("desktop-runtime");
    createChromium(cacheRoot, "1234", { omitExecutable: true });
    const download = vi.fn((downloadRoot: string) => {
      createChromium(downloadRoot);
    });

    prepare({ destinationRoot, cacheRoots: [cacheRoot], download });

    expect(download).toHaveBeenCalledTimes(1);
  });

  it("E: 下载完成后的第二次执行直接命中项目 runtime", () => {
    const destinationRoot = temporaryRoot("desktop-runtime");
    const download = vi.fn((downloadRoot: string) => {
      createChromium(downloadRoot);
      fs.mkdirSync(
        path.join(downloadRoot, "chromium_headless_shell-1234"),
        { recursive: true },
      );
    });

    prepare({ destinationRoot, cacheRoots: [destinationRoot], download });
    const second = prepare({
      destinationRoot,
      cacheRoots: [destinationRoot],
      download,
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("CACHE");
    expect(
      fs.existsSync(
        path.join(destinationRoot, "chromium_headless_shell-1234"),
      ),
    ).toBe(false);
  });

  it("F: GitHub Windows Runner 的 LOCALAPPDATA 缓存可被解析", () => {
    const projectRoot = temporaryRoot("project");
    const destinationRoot = temporaryRoot("desktop-runtime");
    const localAppData = temporaryRoot("runner AppData Local");

    expect(
      trustedPlaywrightCacheRoots({
        projectRoot,
        destinationRoot,
        environment: { ...process.env, LOCALAPPDATA: localAppData },
      }),
    ).toContain(path.join(localAppData, "ms-playwright"));
  });

  it("G: 带空格的可信缓存路径可以复制并校验", () => {
    const cacheRoot = temporaryRoot("cache with spaces");
    const destinationRoot = temporaryRoot("desktop runtime with spaces");
    createChromium(cacheRoot);
    const download = vi.fn();

    const result = prepare({
      destinationRoot,
      cacheRoots: [cacheRoot],
      download,
    });

    expect(result.source).toBe("CACHE");
    expect(download).not.toHaveBeenCalled();
    expect(fs.existsSync(result.executablePath)).toBe(true);
  });

  it("H: 打包资源中的精确 Chromium 与 x64 架构校验通过", () => {
    const packageRoot = temporaryRoot("win-unpacked resources");
    createChromium(packageRoot);

    const result = assertPlaywrightChromiumRuntime({
      projectRoot: temporaryRoot("project"),
      browserRoot: packageRoot,
      requirements,
      minimumFileSizes: fixtureMinimums,
      resolveExecutable: resolvedExecutable,
    });

    expect(result.valid).toBe(true);
    expect(result.requirements.revision).toBe("1234");
  });

  it("拒绝把非 x64 Chromium 当作完整缓存", () => {
    const cacheRoot = temporaryRoot("wrong-architecture");
    const destinationRoot = temporaryRoot("desktop-runtime");
    createChromium(cacheRoot, "1234", { machine: 0x014c });
    const download = vi.fn((downloadRoot: string) => {
      createChromium(downloadRoot);
    });

    prepare({ destinationRoot, cacheRoots: [cacheRoot], download });

    expect(download).toHaveBeenCalledTimes(1);
  });

  it("revision 始终从当前 playwright-core/browsers.json 动态读取", () => {
    const projectRoot = path.resolve(__dirname, "..", "..");
    const current = readPlaywrightChromiumRequirements(projectRoot);
    const browsers = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, "node_modules", "playwright-core", "browsers.json"),
        "utf8",
      ),
    );
    const chromium = browsers.browsers.find(
      (browser: { name: string }) => browser.name === "chromium",
    );

    expect(current.revision).toBe(String(chromium.revision));
    expect(current.directoryName).toBe(`chromium-${chromium.revision}`);
  });
});
