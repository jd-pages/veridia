import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  classifyReleaseFailure,
  parseReleaseResult,
  ReleaseStageError,
  releaseResultLine,
} from "./release-failure.mjs";
import { DESKTOP_NODE_RUNTIME } from "./desktop-node-runtime.mjs";

const require = createRequire(import.meta.url);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WARMUP_MARKER = "VERIDIA_WARMUP_RESULT=";
const PREFLIGHT_MARKER = "VERIDIA_PREFLIGHT_RESULT=";
const MINIMUM_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const ELECTRON_PLATFORM = "win32";
const ELECTRON_ARCH = "x64";
const NETWORK_ATTEMPTS = 2;
const NETWORK_TIMEOUT_MS = 15_000;
const WARMUP_TIMEOUT_MS = 75_000;

function plainCommand(command, args) {
  return [command, ...args].join(" ");
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scriptRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs || 10_000,
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryNetwork(label, operation, attempts = NETWORK_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (classifyReleaseFailure(error) !== "TRANSIENT_NETWORK" || attempt >= attempts) {
        throw error;
      }
      await sleep(400 * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function runNetworkCommand(command, args, options = {}) {
  return retryNetwork(plainCommand(command, args), async () => {
    const result = commandResult(command, args, {
      ...options,
      timeoutMs: options.timeoutMs || NETWORK_TIMEOUT_MS,
    });
    if (result.status === 0 && !result.error) return result;
    const message = `${plainCommand(command, args)} failed: ${
      result.error?.message || result.stderr || `exit ${result.status}`
    }`;
    const error = new Error(message);
    if (result.error?.code) error.code = result.error.code;
    throw error;
  });
}

function requireCondition(condition, input) {
  if (!condition) throw new ReleaseStageError(input);
}

export function validatePreflightSnapshot(snapshot, targetVersion) {
  requireCondition(snapshot.branch === "main", {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `正式发布只能从 main 执行，当前为 ${snapshot.branch || "unknown"}`,
  });
  requireCondition(!snapshot.dirty, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: "Git working tree is dirty",
  });
  requireCondition(snapshot.behind === 0, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `origin/main has ${snapshot.behind} commit(s) not present locally`,
  });
  requireCondition(snapshot.ahead === 0, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `local main has ${snapshot.ahead} unpushed commit(s)`,
  });
  requireCondition(snapshot.head === snapshot.originHead, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: "local HEAD and origin/main do not match",
  });
  requireCondition(snapshot.sourceVersion === snapshot.lockVersion, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: "package.json and package-lock.json versions do not match",
  });
  requireCondition(
    !snapshot.lockRootVersion || snapshot.sourceVersion === snapshot.lockRootVersion,
    {
      stage: "PREFLIGHT",
      classification: "DETERMINISTIC",
      summary: "package-lock.json root package version does not match package.json",
    },
  );
  const versionParts = (value) => String(value).split(".").map(Number);
  const sourceParts = versionParts(snapshot.sourceVersion);
  const targetParts = versionParts(targetVersion);
  const targetComparison = targetParts.findIndex(
    (value, index) => value !== sourceParts[index],
  );
  requireCondition(
    targetComparison < 0 || targetParts[targetComparison] > sourceParts[targetComparison],
    {
      stage: "PREFLIGHT",
      classification: "DETERMINISTIC",
      summary: `Target version ${targetVersion} is lower than source version ${snapshot.sourceVersion}`,
    },
  );
  requireCondition(!snapshot.localTagExists && !snapshot.remoteTagExists, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `Target Tag v${targetVersion} already exists`,
    target: `v${targetVersion}`,
  });
  requireCondition(!snapshot.targetReleaseExists, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `GitHub Release v${targetVersion} already exists`,
    target: `v${targetVersion}`,
  });
  return snapshot;
}

export function validateWarmupResult(result) {
  const prerequisites = result?.prerequisites || [];
  const failed = prerequisites.find(
    (item) => !item.ready || item.integrity !== "VERIFIED" || !item.path,
  );
  requireCondition(!failed && prerequisites.length >= 5, {
    stage: "PREREQUISITE_WARMUP",
    classification:
      failed?.integrity === "MISMATCH" ? "DETERMINISTIC" : "ENVIRONMENT",
    summary: failed
      ? `${failed.name} prerequisite is not ready (${failed.integrity || "UNKNOWN"})`
      : "Release prerequisite warmup returned an incomplete result",
    target: failed?.name,
  });
  return result;
}

export function verifyFileSha256(file, expected) {
  const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (hash !== String(expected).toLowerCase()) {
    throw new ReleaseStageError({
      stage: "PREREQUISITE_WARMUP",
      classification: "DETERMINISTIC",
      summary: `checksum mismatch for ${path.basename(file)}`,
      target: file,
    });
  }
  return hash;
}

function readPackageVersions(root) {
  const packageValue = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lockValue = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  return {
    sourceVersion: packageValue.version,
    lockVersion: lockValue.version,
    lockRootVersion: lockValue.packages?.[""]?.version,
    electronVersion: require(path.join(root, "node_modules", "electron", "package.json")).version,
  };
}

async function inspectGit(root, targetVersion) {
  const git = (args) => commandResult("git", args, { cwd: root });
  const branch = git(["branch", "--show-current"]).stdout.trim();
  const status = git(["status", "--porcelain=v1"]).stdout;
  const versions = readPackageVersions(root);
  if (branch !== "main" || status.trim()) {
    return {
      branch,
      dirty: Boolean(status.trim()),
      ahead: 0,
      behind: 0,
      head: git(["rev-parse", "HEAD"]).stdout.trim(),
      originHead: git(["rev-parse", "origin/main"]).stdout.trim(),
      localTagExists: false,
      remoteTagExists: false,
      ...versions,
    };
  }
  await runNetworkCommand("git", ["fetch", "--quiet", "origin", "main", "--tags"], {
    cwd: root,
    timeoutMs: 15_000,
  });
  const counts = git(["rev-list", "--left-right", "--count", "origin/main...main"])
    .stdout.trim()
    .split(/\s+/u)
    .map(Number);
  const localTagExists = Boolean(git(["tag", "-l", `v${targetVersion}`]).stdout.trim());
  const remoteTag = await runNetworkCommand(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/v${targetVersion}`],
    { cwd: root, timeoutMs: 15_000 },
  );
  return {
    branch,
    dirty: Boolean(status.trim()),
    ahead: counts[1] || 0,
    behind: counts[0] || 0,
    head: git(["rev-parse", "HEAD"]).stdout.trim(),
    originHead: git(["rev-parse", "origin/main"]).stdout.trim(),
    localTagExists,
    remoteTagExists: Boolean(remoteTag.stdout.trim()),
    ...versions,
  };
}

function repositoryFromOrigin(root) {
  const result = commandResult("git", ["remote", "get-url", "origin"], { cwd: root });
  const match = result.stdout.trim().match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/iu);
  requireCondition(result.status === 0 && match, {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: "origin is not a recognized GitHub repository",
  });
  return match[1];
}

async function inspectGitHub(root, targetVersion) {
  const repository = repositoryFromOrigin(root);
  const auth = commandResult("gh", ["auth", "status"], { cwd: root, timeoutMs: 10_000 });
  requireCondition(auth.status === 0 && !auth.error, {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: `GitHub CLI authentication is unavailable: ${auth.stderr || auth.error?.message || "unknown"}`,
  });
  await runNetworkCommand("gh", ["api", `repos/${repository}`, "--silent"], {
    cwd: root,
  });
  await runNetworkCommand("gh", ["api", `repos/${repository}/releases/latest`, "--silent"], {
    cwd: root,
  });
  const target = await retryNetwork(`GitHub Release v${targetVersion}`, async () => {
    const result = commandResult(
      "gh",
      ["api", `repos/${repository}/releases/tags/v${targetVersion}`, "--silent"],
      { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS },
    );
    const notFound = /HTTP 404|Not Found|release not found/iu.test(result.stderr);
    if (result.status === 0 || notFound) return result;
    throw new ReleaseStageError({
      stage: "PREFLIGHT",
      classification: classifyReleaseFailure(result.error || result.stderr, "ENVIRONMENT"),
      summary: `Unable to query GitHub Release v${targetVersion}: ${result.error?.message || result.stderr}`,
      target: `v${targetVersion}`,
    });
  });
  return { repository, targetReleaseExists: target.status === 0 };
}

function findFile(root, name, maximumEntries = 20_000) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  let inspected = 0;
  while (stack.length > 0 && inspected < maximumEntries) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      inspected += 1;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.name.toLowerCase() === name.toLowerCase()) return fullPath;
      if (inspected >= maximumEntries) break;
    }
  }
  return null;
}

async function inspectDesktop(root) {
  const bundledNode = path.join(root, "desktop-runtime", "node", "node.exe");
  const prismaAlias = path.join(root, "desktop", "prisma-alias.cjs");
  const playwrightRoot = path.join(root, "desktop-runtime", "ms-playwright");
  requireCondition(fs.existsSync(bundledNode), {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: "Desktop bundled Node is missing",
    target: bundledNode,
  });
  const version = commandResult(bundledNode, ["--version"], { cwd: root, timeoutMs: 5_000 });
  requireCondition(
    version.status === 0 && version.stdout.trim() === DESKTOP_NODE_RUNTIME.versionTag,
    {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: `Desktop bundled Node must be ${DESKTOP_NODE_RUNTIME.versionTag}`,
    target: bundledNode,
    },
  );
  requireCondition(fs.existsSync(prismaAlias), {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: "Desktop Prisma alias hook is missing",
    target: prismaAlias,
  });
  requireCondition(fs.existsSync(path.join(root, "node_modules", "@prisma", "client")), {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: "Prisma client alias/package is missing",
  });
  const chromium = findFile(playwrightRoot, "chrome.exe");
  requireCondition(Boolean(chromium), {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: "Desktop Playwright Chromium runtime is missing",
    target: playwrightRoot,
  });
  return { bundledNode, nodeVersion: version.stdout.trim(), prismaAlias, chromium };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function liveOwnedTestProcesses(root) {
  const runsRoot = path.join(root, ".playwright", "runs");
  if (!fs.existsSync(runsRoot)) return [];
  const live = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true }).slice(-200)) {
    if (!entry.isDirectory()) continue;
    const metadataFile = path.join(runsRoot, entry.name, "metadata.json");
    if (!fs.existsSync(metadataFile)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
      for (const pid of [value.serverPid, value.browserPid]) {
        if (Number.isInteger(pid) && pid > 0 && pidIsAlive(pid)) live.push(pid);
      }
    } catch {
      // Malformed historic metadata cannot establish ownership of a live process.
    }
  }
  return [...new Set(live)];
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function writableProbe(directory) {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `.veridia-release-probe-${randomUUID()}`);
  try {
    fs.writeFileSync(file, "release preflight\n", { flag: "wx" });
    fs.renameSync(file, `${file}.renamed`);
    fs.rmSync(`${file}.renamed`, { force: true });
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.renamed`, { force: true });
    if (!existed) {
      try {
        fs.rmdirSync(directory);
      } catch {
        // Never remove a directory if another process populated it during the probe.
      }
    }
  }
}

async function inspectSystem(root) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-release-preflight-"));
  try {
    writableProbe(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  writableProbe(path.join(root, ".release-work", "preflight"));
  writableProbe(path.join(root, "dist-installer"));
  const disk = fs.statfsSync(root);
  const freeBytes = disk.bavail * disk.bsize;
  requireCondition(freeBytes >= MINIMUM_FREE_BYTES, {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: `Insufficient disk space: ${(freeBytes / 1024 ** 3).toFixed(2)} GiB free`,
  });
  const livePids = liveOwnedTestProcesses(root);
  requireCondition(livePids.length === 0, {
    stage: "PREFLIGHT",
    classification: "ENVIRONMENT",
    summary: `Owned VERIDIA test processes are still running: ${livePids.join(", ")}`,
  });
  const port = await reservePort();
  return { tempWritable: true, outputWritable: true, freeBytes, port, livePids };
}

function terminateWorker(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGKILL");
  }
}

function runWarmupWorker(root, electronVersion, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [fileURLToPath(import.meta.url), "--warmup-worker", `--electron=${electronVersion}`];
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      terminateWorker(child);
      reject(
        new ReleaseStageError({
          stage: "PREREQUISITE_WARMUP",
          classification: "TRANSIENT_NETWORK",
          summary: `Release prerequisite warmup timed out after ${WARMUP_TIMEOUT_MS}ms`,
          command: plainCommand(process.execPath, args),
        }),
      );
    }, options.timeoutMs || WARMUP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const marker = stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith(WARMUP_MARKER));
      if (code === 0 && marker) {
        try {
          resolve(JSON.parse(marker.slice(WARMUP_MARKER.length)));
          return;
        } catch {
          // Fall through to the structured failure below.
        }
      }
      const structured = parseReleaseResult(`${stdout}\n${stderr}`);
      if (structured) {
        reject(new ReleaseStageError(structured));
        return;
      }
      reject(
        new ReleaseStageError({
          stage: "PREREQUISITE_WARMUP",
          classification: classifyReleaseFailure(`${stderr}\n${stdout}`, "ENVIRONMENT"),
          summary: stderr.trim() || stdout.trim() || `Warmup worker exited with ${code}`,
          command: plainCommand(process.execPath, args),
        }),
      );
    });
  });
}

export async function fetchTextWithRetry(url, options = {}) {
  const timeoutMs = options.timeoutMs || NETWORK_TIMEOUT_MS;
  const attempts = options.attempts || NETWORK_ATTEMPTS;
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleep || sleep;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStartedAt = performance.now();
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "VERIDIA-release-preflight" },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        if (response.status >= 500) error.code = "ECONNRESET";
        throw error;
      }
      const text = await response.text();
      options.onAttempt?.({
        url,
        attempt,
        maxAttempts: attempts,
        elapsedMs: Math.round(performance.now() - attemptStartedAt),
        success: true,
      });
      return text;
    } catch (error) {
      lastError = error;
      const classification = classifyReleaseFailure(error);
      options.onAttempt?.({
        url,
        attempt,
        maxAttempts: attempts,
        elapsedMs: Math.round(performance.now() - attemptStartedAt),
        success: false,
        classification,
        summary: error instanceof Error ? error.message : String(error),
      });
      if (classification !== "TRANSIENT_NETWORK" || attempt >= attempts) {
        throw error;
      }
      await sleepImpl(400 * attempt);
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
}

async function fetchWarmupText(url, failedItem) {
  const startedAt = performance.now();
  const networkAttempts = [];
  try {
    const text = await fetchTextWithRetry(url, {
      timeoutMs: NETWORK_TIMEOUT_MS,
      attempts: NETWORK_ATTEMPTS,
      fetchImpl: fetch,
      sleep,
      onAttempt: (attempt) => networkAttempts.push(attempt),
    });
    return {
      text,
      attempts: networkAttempts,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    const lastAttempt = networkAttempts.at(-1);
    throw new ReleaseStageError(
      {
        stage: "PREREQUISITE_WARMUP",
        classification: classifyReleaseFailure(error),
        summary: error instanceof Error ? error.message : String(error),
        target: url,
        failedItem,
        attempt: lastAttempt?.attempt,
        maxAttempts: NETWORK_ATTEMPTS,
        elapsedMs: Math.round(performance.now() - startedAt),
        cacheStatus: "NOT_APPLICABLE",
      },
      { cause: error },
    );
  }
}

export function createElectronDownloadOptions(zipName, expectedChecksum) {
  return {
    force: false,
    checksums: { [zipName]: expectedChecksum },
    downloadOptions: { timeout: { request: NETWORK_TIMEOUT_MS } },
  };
}

function prerequisite(name, targetPath) {
  const ready = Boolean(targetPath && fs.existsSync(targetPath));
  return {
    name,
    path: targetPath,
    ready,
    integrity: ready ? "VERIFIED" : "MISSING",
  };
}

async function executeWarmupWorker(root, electronVersion) {
  const startedAt = Date.now();
  const zipName = `electron-v${electronVersion}-${ELECTRON_PLATFORM}-${ELECTRON_ARCH}.zip`;
  const checksumUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/SHASUMS256.txt`;
  const checksumFetch = await fetchWarmupText(checksumUrl, "Electron SHASUMS");
  const checksumText = checksumFetch.text;
  const checksumPattern = new RegExp(`^([a-f0-9]{64})\\s+[* ]?${zipName.replaceAll(".", "\\.")}$`, "imu");
  const expectedChecksum = checksumText.match(checksumPattern)?.[1]?.toLowerCase();
  requireCondition(Boolean(expectedChecksum), {
    stage: "PREREQUISITE_WARMUP",
    classification: "DETERMINISTIC",
    summary: `Official SHASUMS256.txt does not contain ${zipName}`,
    target: checksumUrl,
  });

  const electronGet = require("app-builder-lib/out/util/electronGet.js");
  const windowsTools = require("app-builder-lib/out/toolsets/windows.js");
  const sevenZip = require("app-builder-lib/out/toolsets/7zip.js");
  const electronUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/${zipName}`;
  const electronCacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "electron", "Cache")
    : null;
  const cachedElectronZip = electronCacheRoot
    ? findFile(electronCacheRoot, zipName)
    : null;
  const electronCacheStatus = cachedElectronZip ? "HIT" : "MISS";
  const electronStartedAt = performance.now();
  let electronZip;
  try {
    electronZip = await electronGet.downloadElectronArtifactZip({
      electronDownload: createElectronDownloadOptions(zipName, expectedChecksum),
      artifactName: "electron",
      platformName: ELECTRON_PLATFORM,
      arch: ELECTRON_ARCH,
      version: electronVersion,
    });
  } catch (error) {
    throw new ReleaseStageError(
      {
        stage: "PREREQUISITE_WARMUP",
        classification: classifyReleaseFailure(error),
        summary: `Electron ZIP official downloader failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        target: electronUrl,
        failedItem: "Electron ZIP",
        elapsedMs: Math.round(performance.now() - electronStartedAt),
        cacheStatus: electronCacheStatus,
      },
      { cause: error },
    );
  }
  verifyFileSha256(electronZip, expectedChecksum);
  const nsis = await windowsTools.getMakeNsisPath(null);
  const nsisResources = await windowsTools.getNsisPluginsPath(null);
  const winCodeSign = await windowsTools.getSignToolPath(null, true);
  const sevenZipPath = await sevenZip.getPath7za();
  const result = {
    electronVersion,
    checksumUrl,
    zipName,
    elapsedMs: Date.now() - startedAt,
    networkAttempts: checksumFetch.attempts,
    checksumElapsedMs: checksumFetch.elapsedMs,
    prerequisites: [
      {
        ...prerequisite("Electron ZIP", electronZip),
        sha256: expectedChecksum,
        url: electronUrl,
        cacheStatus: electronCacheStatus,
        elapsedMs: Math.round(performance.now() - electronStartedAt),
      },
      prerequisite("NSIS", nsis.path),
      prerequisite("nsis-resources", nsisResources),
      prerequisite("winCodeSign", winCodeSign.path),
      prerequisite("7zip", sevenZipPath),
    ],
  };
  validateWarmupResult(result);
  return result;
}

export async function runReleasePreflight(input, dependencyOverrides = {}) {
  const root = path.resolve(input.root || scriptRoot);
  const targetVersion = input.targetVersion;
  requireCondition(/^\d+\.\d+\.\d+$/u.test(targetVersion || ""), {
    stage: "PREFLIGHT",
    classification: "DETERMINISTIC",
    summary: `Invalid target version: ${targetVersion || "empty"}`,
  });
  const dependencies = {
    inspectGit,
    inspectGitHub,
    inspectDesktop,
    inspectSystem,
    warmup: async (valueRoot, electronVersion) => runWarmupWorker(valueRoot, electronVersion),
    ...dependencyOverrides,
  };
  const timings = [];
  const measure = async (name, operation) => {
    const startedAt = performance.now();
    const result = await operation();
    timings.push({ name, milliseconds: Math.round(performance.now() - startedAt) });
    return result;
  };
  const gitState = await measure("Git", () => dependencies.inspectGit(root, targetVersion));
  validatePreflightSnapshot(
    { ...gitState, targetReleaseExists: false },
    targetVersion,
  );
  const github = await measure("GitHub", () => dependencies.inspectGitHub(root, targetVersion));
  validatePreflightSnapshot({ ...gitState, ...github }, targetVersion);
  const desktop = await measure("Desktop", () => dependencies.inspectDesktop(root));
  const system = await measure("System", () => dependencies.inspectSystem(root));
  const warmup = validateWarmupResult(
    await measure("Prerequisite warmup", () =>
      dependencies.warmup(root, gitState.electronVersion),
    ),
  );
  return {
    success: true,
    stage: "PREFLIGHT",
    targetVersion,
    head: gitState.head,
    originHead: gitState.originHead,
    repository: github.repository,
    desktop,
    system,
    warmup,
    timings,
    elapsedMs: timings.reduce((sum, value) => sum + value.milliseconds, 0),
  };
}

function targetVersionArgument() {
  return process.argv.find((value) => value.startsWith("--target-version="))?.split("=")[1];
}

async function runCli() {
  if (process.argv.includes("--warmup-worker")) {
    try {
      const electronVersion = process.argv.find((value) => value.startsWith("--electron="))?.split("=")[1];
      const result = await executeWarmupWorker(process.cwd(), electronVersion);
      process.stdout.write(`${WARMUP_MARKER}${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`${releaseResultLine(error, { stage: "PREREQUISITE_WARMUP" })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    const result = await runReleasePreflight({
      root: process.cwd(),
      targetVersion: targetVersionArgument(),
    });
    process.stdout.write(
      [
        "RELEASE PREFLIGHT = PASS",
        `Target: ${result.targetVersion}`,
        `Preflight + warmup: ${result.elapsedMs}ms`,
        ...result.warmup.prerequisites.map(
          (item) => `${item.name}: READY (${item.integrity})`,
        ),
        `${PREFLIGHT_MARKER}${JSON.stringify(result)}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    const stage = error instanceof ReleaseStageError ? error.stage : "PREFLIGHT";
    process.stderr.write(
      [
        "RELEASE PREFLIGHT = BLOCKED",
        releaseResultLine(error, { stage }),
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await runCli();
