import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const RUNTIME_MANIFEST = ".veridia-chromium-runtime.json";
const WINDOWS_X64_MACHINE = 0x8664;

export const MINIMUM_CHROMIUM_FILE_SIZES = Object.freeze({
  "chrome.exe": 1_000_000,
  "chrome.dll": 50_000_000,
  "chrome_elf.dll": 100_000,
  "chrome_100_percent.pak": 100_000,
  "icudtl.dat": 1_000_000,
  "resources.pak": 1_000_000,
  "v8_context_snapshot.bin": 100_000,
  "locales/en-US.pak": 100_000,
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizedPath(value) {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.filter(Boolean)) {
    const resolved = path.resolve(value);
    const normalized = normalizedPath(resolved);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(resolved);
  }
  return result;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function fileMeetsMinimum(file, minimumBytes) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size >= minimumBytes;
  } catch {
    return false;
  }
}

function peMachine(file) {
  const handle = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length) {
      return null;
    }
    if (header[0] !== 0x4d || header[1] !== 0x5a) return null;
    const peOffset = header.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (
      fs.readSync(handle, peHeader, 0, peHeader.length, peOffset) !==
      peHeader.length
    ) {
      return null;
    }
    if (!peHeader.subarray(0, 4).equals(Buffer.from("PE\0\0", "binary"))) {
      return null;
    }
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(handle);
  }
}

export function readPlaywrightChromiumRequirements(projectRoot) {
  const playwrightCoreRoot = path.join(
    projectRoot,
    "node_modules",
    "playwright-core",
  );
  const packageJson = readJson(path.join(playwrightCoreRoot, "package.json"));
  const browsers = readJson(path.join(playwrightCoreRoot, "browsers.json"));
  const chromium = browsers.browsers.find(
    (browser) => browser.name === "chromium",
  );
  const headlessShell = browsers.browsers.find(
    (browser) => browser.name === "chromium-headless-shell",
  );
  if (!chromium?.revision) {
    throw new Error("无法从当前 playwright-core/browsers.json 解析 Chromium revision");
  }
  return {
    playwrightVersion: packageJson.version,
    revision: String(chromium.revision),
    browserVersion: chromium.browserVersion || null,
    directoryName: `chromium-${chromium.revision}`,
    headlessShellRevision: headlessShell?.revision
      ? String(headlessShell.revision)
      : null,
  };
}

export function trustedPlaywrightCacheRoots({
  projectRoot,
  destinationRoot,
  environment = process.env,
}) {
  const configured = environment.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const configuredRoot = configured
    ? configured === "0"
      ? path.join(
          projectRoot,
          "node_modules",
          "playwright-core",
          ".local-browsers",
        )
      : path.resolve(projectRoot, configured)
    : "";
  const localAppData = environment.LOCALAPPDATA?.trim();
  const defaultWindowsRoot = path.join(
    localAppData || path.join(os.homedir(), "AppData", "Local"),
    "ms-playwright",
  );
  return uniquePaths([
    destinationRoot,
    configuredRoot,
    defaultWindowsRoot,
  ]);
}

export function resolvePlaywrightChromiumExecutable(
  projectRoot,
  browserRoot,
) {
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      'const { chromium } = require("playwright"); process.stdout.write(chromium.executablePath());',
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15_000,
    },
  ).trim();
  if (!output) {
    throw new Error("当前 Playwright 未返回 Chromium executable path");
  }
  return path.resolve(output);
}

export function inspectChromiumCache({
  cacheRoot,
  requirements,
  projectRoot,
  platform = process.platform,
  architecture = process.arch,
  minimumFileSizes = MINIMUM_CHROMIUM_FILE_SIZES,
  resolveExecutable = resolvePlaywrightChromiumExecutable,
}) {
  const browserDirectory = path.join(cacheRoot, requirements.directoryName);
  const failure = (reason) => ({
    valid: false,
    reason,
    cacheRoot,
    browserDirectory,
    executablePath: null,
  });
  if (platform !== "win32" || architecture !== "x64") {
    return failure(`仅接受 Windows x64 Chromium，当前为 ${platform}/${architecture}`);
  }
  try {
    const stat = fs.lstatSync(browserDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return failure("精确 revision 目录不存在或不是可信普通目录");
    }
  } catch {
    return failure(`未找到 ${requirements.directoryName}`);
  }

  let executablePath;
  try {
    executablePath = path.resolve(
      resolveExecutable(projectRoot, path.resolve(cacheRoot)),
    );
  } catch (error) {
    return failure(
      `当前 Playwright 无法解析该缓存：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !isInside(browserDirectory, executablePath) ||
    path.basename(executablePath).toLocaleLowerCase("en-US") !== "chrome.exe"
  ) {
    return failure("Playwright 解析结果未指向精确 revision 的 chrome.exe");
  }
  const executableRoot = path.dirname(executablePath);
  for (const [relativePath, minimumBytes] of Object.entries(
    minimumFileSizes,
  )) {
    const file = path.join(executableRoot, ...relativePath.split("/"));
    if (!fileMeetsMinimum(file, minimumBytes)) {
      return failure(
        `必要运行文件缺失或疑似截断：${relativePath}（至少 ${minimumBytes} 字节）`,
      );
    }
  }
  if (peMachine(executablePath) !== WINDOWS_X64_MACHINE) {
    return failure("chrome.exe 不是 Windows x64 PE 可执行文件");
  }
  return {
    valid: true,
    reason: "OK",
    cacheRoot: path.resolve(cacheRoot),
    browserDirectory,
    executablePath,
  };
}

function writeManifest(destinationRoot, requirements, executablePath) {
  fs.writeFileSync(
    path.join(destinationRoot, RUNTIME_MANIFEST),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        playwrightVersion: requirements.playwrightVersion,
        chromiumRevision: requirements.revision,
        chromiumVersion: requirements.browserVersion,
        directoryName: requirements.directoryName,
        executableRelativePath: path
          .relative(destinationRoot, executablePath)
          .replaceAll(path.sep, "/"),
        platform: "win32",
        architecture: "x64",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function removeUnpackagedBrowserArtifacts(destinationRoot, directoryName) {
  for (const entry of fs.readdirSync(destinationRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === directoryName || entry.name === RUNTIME_MANIFEST) {
      continue;
    }
    fs.rmSync(path.join(destinationRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

function materializeRuntime({
  sourceRoot,
  destinationRoot,
  requirements,
  projectRoot,
  inspectionOptions,
}) {
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot)) {
    removeUnpackagedBrowserArtifacts(
      destinationRoot,
      requirements.directoryName,
    );
    const result = inspectChromiumCache({
      cacheRoot: destinationRoot,
      requirements,
      projectRoot,
      ...inspectionOptions,
    });
    if (!result.valid) {
      throw new Error(`项目 Chromium runtime 校验失败：${result.reason}`);
    }
    writeManifest(destinationRoot, requirements, result.executablePath);
    return result;
  }

  const stagingRoot = `${destinationRoot}.prepare-${process.pid}`;
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  try {
    fs.cpSync(
      path.join(sourceRoot, requirements.directoryName),
      path.join(stagingRoot, requirements.directoryName),
      { recursive: true },
    );
    const staged = inspectChromiumCache({
      cacheRoot: stagingRoot,
      requirements,
      projectRoot,
      ...inspectionOptions,
    });
    if (!staged.valid) {
      throw new Error(`复制后的 Chromium runtime 校验失败：${staged.reason}`);
    }
    writeManifest(stagingRoot, requirements, staged.executablePath);
    fs.rmSync(destinationRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, destinationRoot);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  const result = inspectChromiumCache({
    cacheRoot: destinationRoot,
    requirements,
    projectRoot,
    ...inspectionOptions,
  });
  if (!result.valid) {
    throw new Error(`最终 Chromium runtime 校验失败：${result.reason}`);
  }
  return result;
}

export function preparePlaywrightChromiumRuntime({
  projectRoot,
  destinationRoot,
  cacheRoots = trustedPlaywrightCacheRoots({
    projectRoot,
    destinationRoot,
  }),
  requirements = readPlaywrightChromiumRequirements(projectRoot),
  download,
  output = (message) => process.stdout.write(message),
  platform = process.platform,
  architecture = process.arch,
  minimumFileSizes = MINIMUM_CHROMIUM_FILE_SIZES,
  resolveExecutable = resolvePlaywrightChromiumExecutable,
}) {
  const startedAt = performance.now();
  const inspectionOptions = {
    platform,
    architecture,
    minimumFileSizes,
    resolveExecutable,
  };
  output(
    "========================================\n" +
      "Playwright Chromium\n" +
      "========================================\n" +
      `当前所需版本：${requirements.directoryName}（Playwright ${requirements.playwrightVersion}）\n`,
  );

  const diagnostics = [];
  let matched = null;
  for (const cacheRoot of uniquePaths(cacheRoots)) {
    const inspected = inspectChromiumCache({
      cacheRoot,
      requirements,
      projectRoot,
      ...inspectionOptions,
    });
    diagnostics.push(inspected);
    if (inspected.valid) {
      matched = inspected;
      break;
    }
  }

  let source = "CACHE";
  if (!matched) {
    if (typeof download !== "function") {
      throw new Error(
        `本机未发现有效 ${requirements.directoryName}，且未配置官方下载步骤`,
      );
    }
    output(
      `本机未发现有效 ${requirements.directoryName}。\n` +
        "开始从 Playwright 官方源下载。\n",
    );
    const downloadRoot = `${destinationRoot}.download-${process.pid}`;
    fs.rmSync(downloadRoot, { recursive: true, force: true });
    fs.mkdirSync(downloadRoot, { recursive: true });
    try {
      download(downloadRoot);
      const downloaded = inspectChromiumCache({
        cacheRoot: downloadRoot,
        requirements,
        projectRoot,
        ...inspectionOptions,
      });
      if (!downloaded.valid) {
        throw new Error(
          `官方下载结束但 Chromium runtime 不完整：${downloaded.reason}`,
        );
      }
      matched = downloaded;
      source = "DOWNLOAD";
      materializeRuntime({
        sourceRoot: matched.cacheRoot,
        destinationRoot,
        requirements,
        projectRoot,
        inspectionOptions,
      });
    } finally {
      fs.rmSync(downloadRoot, { recursive: true, force: true });
    }
  } else {
    materializeRuntime({
      sourceRoot: matched.cacheRoot,
      destinationRoot,
      requirements,
      projectRoot,
      inspectionOptions,
    });
  }

  const finalInspection = inspectChromiumCache({
    cacheRoot: destinationRoot,
    requirements,
    projectRoot,
    ...inspectionOptions,
  });
  if (!finalInspection.valid) {
    throw new Error(`Chromium runtime 最终校验失败：${finalInspection.reason}`);
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const reportedCacheRoot =
    source === "CACHE" ? matched.cacheRoot : path.resolve(destinationRoot);
  output(
    `本机缓存：${source === "CACHE" ? "已命中" : "下载完成"}\n` +
      "缓存完整性：通过\n" +
      `缓存来源：${reportedCacheRoot}\n` +
      `${
        source === "CACHE"
          ? "直接复用本机缓存，跳过官网下载安装。"
          : "官方下载完成，已保存为后续构建可复用的项目 runtime。"
      }\n` +
      `Chromium 准备耗时：${elapsedMs}ms\n`,
  );
  return {
    source,
    requirements,
    cacheRoot: reportedCacheRoot,
    destinationRoot,
    executablePath: finalInspection.executablePath,
    elapsedMs,
    diagnostics,
  };
}

export function assertPlaywrightChromiumRuntime({
  projectRoot,
  browserRoot,
  requirements = readPlaywrightChromiumRequirements(projectRoot),
  platform = process.platform,
  architecture = process.arch,
  minimumFileSizes = MINIMUM_CHROMIUM_FILE_SIZES,
  resolveExecutable = resolvePlaywrightChromiumExecutable,
}) {
  const result = inspectChromiumCache({
    cacheRoot: browserRoot,
    requirements,
    projectRoot,
    platform,
    architecture,
    minimumFileSizes,
    resolveExecutable,
  });
  if (!result.valid) {
    throw new Error(
      `Playwright Chromium ${requirements.revision} runtime 校验失败：${result.reason}`,
    );
  }
  const manifestPath = path.join(browserRoot, RUNTIME_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (
      manifest.chromiumRevision !== requirements.revision ||
      manifest.playwrightVersion !== requirements.playwrightVersion ||
      manifest.architecture !== "x64" ||
      manifest.platform !== "win32"
    ) {
      throw new Error("Playwright Chromium runtime manifest 与当前依赖不一致");
    }
  }
  return { ...result, requirements };
}
