import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  classifyReleaseFailure,
  ReleaseStageError,
} from "./release-failure.mjs";

export const DESKTOP_NODE_RUNTIME = Object.freeze({
  version: "24.14.0",
  versionTag: "v24.14.0",
  platform: "win32",
  architecture: "x64",
  archiveName: "node-v24.14.0-win-x64.zip",
  archiveSha256:
    "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66",
  executableSha256:
    "63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088",
  distributionRoot: "https://nodejs.org/dist/v24.14.0",
});

const NETWORK_ATTEMPTS = 2;
const CHECKSUM_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 120_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function executeNodeVersion(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function safeDestinationRoot(projectRoot, destinationRoot) {
  const resolvedProject = path.resolve(projectRoot);
  const resolvedDestination = path.resolve(destinationRoot);
  if (
    path.basename(resolvedDestination).toLocaleLowerCase("en-US") !== "node" ||
    resolvedDestination === path.parse(resolvedDestination).root ||
    resolvedDestination === path.resolve(os.homedir()) ||
    resolvedDestination === resolvedProject
  ) {
    throw new Error(`拒绝使用不安全的 Desktop Node runtime 目录：${resolvedDestination}`);
  }
  return resolvedDestination;
}

export function inspectDesktopNodeRuntime({
  destinationRoot,
  requirements = DESKTOP_NODE_RUNTIME,
  platform = process.platform,
  architecture = process.arch,
  runVersion = executeNodeVersion,
}) {
  const executablePath = path.join(destinationRoot, "node.exe");
  const failure = (reason) => ({
    valid: false,
    reason,
    executablePath,
    version: null,
    sha256: null,
  });
  if (platform !== requirements.platform || architecture !== requirements.architecture) {
    return failure(
      `仅支持 ${requirements.platform}/${requirements.architecture} Desktop Node，当前为 ${platform}/${architecture}`,
    );
  }
  let stat;
  try {
    stat = fs.lstatSync(executablePath);
  } catch {
    return failure("node.exe 不存在");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    return failure("node.exe 不是有效的普通文件");
  }
  let version;
  try {
    version = runVersion(executablePath);
  } catch (error) {
    return failure(
      `node.exe 不可执行：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (version !== requirements.versionTag) {
    return failure(
      `node.exe 版本不匹配：期望 ${requirements.versionTag}，实际 ${version || "empty"}`,
    );
  }
  const executableHash = sha256File(executablePath);
  if (executableHash !== requirements.executableSha256) {
    return failure(
      `node.exe checksum mismatch：期望 ${requirements.executableSha256}，实际 ${executableHash}`,
    );
  }
  return {
    valid: true,
    reason: "OK",
    executablePath,
    version,
    sha256: executableHash,
  };
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchBufferWithRetry(
  url,
  {
    timeoutMs,
    attempts = NETWORK_ATTEMPTS,
    fetchImpl = fetch,
    sleepImpl = sleep,
  },
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "VERIDIA-desktop-node-runtime" },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        if (response.status >= 500) error.code = "ECONNRESET";
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (
        classifyReleaseFailure(error) !== "TRANSIENT_NETWORK" ||
        attempt >= attempts
      ) {
        throw error;
      }
      await sleepImpl(400 * attempt);
    }
  }
  throw lastError || new Error(`Unable to download ${url}`);
}

function deterministicFailure(summary, target) {
  return new ReleaseStageError({
    stage: "DESKTOP_PREPARE",
    classification: "DETERMINISTIC",
    summary,
    failedItem: "Desktop bundled Node",
    target,
  });
}

function networkFailure(error, target) {
  return new ReleaseStageError(
    {
      stage: "DESKTOP_PREPARE",
      classification: classifyReleaseFailure(error),
      summary: `Desktop bundled Node 官方下载失败：${
        error instanceof Error ? error.message : String(error)
      }`,
      failedItem: "Desktop bundled Node",
      target,
      maxAttempts: NETWORK_ATTEMPTS,
    },
    { cause: error },
  );
}

export async function prepareDesktopNodeRuntime({
  projectRoot,
  destinationRoot = path.join(projectRoot, "desktop-runtime", "node"),
  requirements = DESKTOP_NODE_RUNTIME,
  platform = process.platform,
  architecture = process.arch,
  runVersion = executeNodeVersion,
  fetchImpl = fetch,
  sleepImpl = sleep,
  output = (message) => process.stdout.write(message),
}) {
  const resolvedDestination = safeDestinationRoot(projectRoot, destinationRoot);
  const inspectionOptions = {
    destinationRoot: resolvedDestination,
    requirements,
    platform,
    architecture,
    runVersion,
  };
  const existing = inspectDesktopNodeRuntime(inspectionOptions);
  if (existing.valid) {
    output(
      `Desktop bundled Node ${existing.version} 校验通过：${existing.executablePath}\n` +
        "Runtime 来源：已验证的项目缓存；未执行下载。\n",
    );
    return { source: "EXISTING", ...existing };
  }
  if (fs.existsSync(existing.executablePath)) {
    throw deterministicFailure(
      `现有 Desktop bundled Node 无效：${existing.reason}`,
      existing.executablePath,
    );
  }
  if (platform !== requirements.platform || architecture !== requirements.architecture) {
    throw deterministicFailure(existing.reason, resolvedDestination);
  }

  const checksumsUrl = `${requirements.distributionRoot}/SHASUMS256.txt`;
  const archiveUrl = `${requirements.distributionRoot}/${requirements.archiveName}`;
  let checksumsBuffer;
  try {
    checksumsBuffer = await fetchBufferWithRetry(checksumsUrl, {
      timeoutMs: CHECKSUM_TIMEOUT_MS,
      fetchImpl,
      sleepImpl,
    });
  } catch (error) {
    if (error instanceof ReleaseStageError) throw error;
    throw networkFailure(error, checksumsUrl);
  }

  const checksums = checksumsBuffer.toString("utf8");
  const escapedArchive = requirements.archiveName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const officialChecksum = checksums
    .match(new RegExp(`^([a-f0-9]{64})\\s+[* ]?${escapedArchive}$`, "imu"))?.[1]
    ?.toLowerCase();
  if (!officialChecksum) {
    throw deterministicFailure(
      `Node 官方 SHASUMS256.txt 不包含 ${requirements.archiveName}`,
      checksumsUrl,
    );
  }
  if (officialChecksum !== requirements.archiveSha256) {
    throw deterministicFailure(
      `Node 官方 checksum 与 VERIDIA 锁定值不一致：${officialChecksum}`,
      checksumsUrl,
    );
  }
  let archiveBuffer;
  try {
    archiveBuffer = await fetchBufferWithRetry(archiveUrl, {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      fetchImpl,
      sleepImpl,
    });
  } catch (error) {
    if (error instanceof ReleaseStageError) throw error;
    throw networkFailure(error, archiveUrl);
  }
  const archiveHash = sha256(archiveBuffer);
  if (archiveHash !== requirements.archiveSha256) {
    throw deterministicFailure(
      `Desktop Node archive checksum mismatch：期望 ${requirements.archiveSha256}，实际 ${archiveHash}`,
      archiveUrl,
    );
  }

  const zip = await JSZip.loadAsync(archiveBuffer, { checkCRC32: true });
  const archiveRoot = requirements.archiveName.replace(/\.zip$/iu, "");
  const executableEntry = zip.file(`${archiveRoot}/node.exe`);
  if (!executableEntry) {
    throw deterministicFailure(
      `Node 官方 archive 不包含 ${archiveRoot}/node.exe`,
      archiveUrl,
    );
  }
  const executableBuffer = await executableEntry.async("nodebuffer");
  const executableHash = sha256(executableBuffer);
  if (executableHash !== requirements.executableSha256) {
    throw deterministicFailure(
      `解压后的 node.exe checksum mismatch：期望 ${requirements.executableSha256}，实际 ${executableHash}`,
      archiveUrl,
    );
  }

  const stagingRoot = path.join(
    path.dirname(resolvedDestination),
    `.node.prepare-${process.pid}-${randomUUID()}`,
  );
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, "node.exe"), executableBuffer, {
      mode: 0o755,
    });
    const stagedExecutable = path.join(stagingRoot, "node.exe");
    const stagedHash = sha256File(stagedExecutable);
    if (stagedHash !== requirements.executableSha256) {
      throw deterministicFailure(
        `准备完成但 staging node.exe checksum mismatch：${stagedHash}`,
        stagedExecutable,
      );
    }
    fs.rmSync(resolvedDestination, { recursive: true, force: true });
    fs.renameSync(stagingRoot, resolvedDestination);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  const finalInspection = inspectDesktopNodeRuntime(inspectionOptions);
  if (!finalInspection.valid) {
    fs.rmSync(resolvedDestination, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    throw deterministicFailure(
      `Desktop bundled Node 最终校验失败：${finalInspection.reason}`,
      finalInspection.executablePath,
    );
  }
  output(
    `Desktop bundled Node ${finalInspection.version} 官方下载与 SHA-256 校验通过：${finalInspection.executablePath}\n`,
  );
  return { source: "DOWNLOAD", ...finalInspection };
}

export function assertDesktopNodeRuntime(input) {
  const result = inspectDesktopNodeRuntime(input);
  if (!result.valid) {
    throw deterministicFailure(
      `Desktop bundled Node 校验失败：${result.reason}`,
      result.executablePath,
    );
  }
  return result;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const destinationArgument = process.argv
    .find((value) => value.startsWith("--destination-root="))
    ?.slice("--destination-root=".length);
  await prepareDesktopNodeRuntime({
    projectRoot,
    destinationRoot: destinationArgument
      ? path.resolve(projectRoot, destinationArgument)
      : path.join(projectRoot, "desktop-runtime", "node"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
