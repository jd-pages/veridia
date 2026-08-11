import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import ts from "typescript";
import { copyE2eDatabaseForRun } from "./e2e-database-template.mjs";
import { ensureProjectBoundDirectory } from "./project-bound-cache.mjs";
import {
  captureFile,
  cleanupTestNextGeneratedTypes,
  e2eTsconfigPath,
  restoreFile,
} from "./next-type-isolation.mjs";
import { waitForStartupRoute } from "./e2e-readiness.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
const workers = Number(args.find((arg) => arg.startsWith("--workers="))?.split("=")[1] || 1);
const failFast = args.includes("--fail-fast");
const grepArgument = args.find((arg) => arg.startsWith("--grep="));
const isolationGroup = args.find((arg) => arg.startsWith("--group="))?.split("=")[1] || "SELECTED";
const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${isolationGroup}-${randomUUID().slice(0, 8)}`;
const runDirectory = path.join(root, ".playwright", "e2e-runs", runId);
const metadataPath = path.join(runDirectory, "run.json");
let serverProcess;
let testProcess;
let warmupBrowser;
let cleaned = false;
let nextEnvSnapshot;
const nextDistDir = ".playwright/next-e2e";

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function browserExecutablePath() {
  const configured = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  const bundledRoot = path.join(root, "desktop-runtime", "ms-playwright");
  if (!fs.existsSync(bundledRoot)) return undefined;
  return fs.readdirSync(bundledRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith("chromium-"))
    .map((item) => path.join(bundledRoot, item.name, "chrome-win64", "chrome.exe"))
    .find((candidate) => fs.existsSync(candidate));
}

function writeMetadata(update) {
  fs.mkdirSync(runDirectory, { recursive: true });
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch {}
  fs.writeFileSync(metadataPath, `${JSON.stringify({ ...previous, ...update }, null, 2)}\n`, "utf8");
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

async function stopOwnedProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) killTree(child);
}

function invalidateMalformedNextCache() {
  const cacheRoot = path.join(root, ".playwright", "next-e2e");
  if (!fs.existsSync(cacheRoot)) return;
  const declarations = [];
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) visit(absolute);
      else if (item.isFile() && item.name.endsWith(".d.ts")) declarations.push(absolute);
    }
  };
  visit(cacheRoot);
  const malformed = declarations.find((file) =>
    ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS).parseDiagnostics.length > 0);
  if (malformed) {
    process.stdout.write(`[Next cache] INVALID ${path.relative(root, malformed)}，安全重建测试缓存\n`);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

async function cleanup(reason) {
  if (cleaned) return;
  cleaned = true;
  try { await warmupBrowser?.close(); } catch {}
  await stopOwnedProcess(testProcess);
  await stopOwnedProcess(serverProcess);
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const name of ["xhs-profile", "douyin-profile"]) fs.rmSync(path.join(runDirectory, name), { recursive: true, force: true });
  const runDatabase = path.join(runDirectory, "veridia-e2e.db");
  try { fs.chmodSync(runDatabase, 0o600); } catch {}
  try { fs.rmSync(runDatabase, { force: true }); } catch (error) {
    writeMetadata({ cleanupWarning: error instanceof Error ? error.message : String(error) });
  }
  try {
    const removedNextTypes = cleanupTestNextGeneratedTypes(root, nextDistDir);
    if (removedNextTypes.length > 0) writeMetadata({ removedNextTypes });
  } catch (error) {
    writeMetadata({ nextTypeCleanupWarning: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (nextEnvSnapshot) restoreFile(path.join(root, "next-env.d.ts"), nextEnvSnapshot);
  } catch (error) {
    writeMetadata({ nextEnvRestoreWarning: error instanceof Error ? error.message : String(error) });
  }
  writeMetadata({ finishedAt: new Date().toISOString(), cleanupReason: reason, cleaned: true });
}

async function waitForHealth(baseURL) {
  const deadline = Date.now() + 180_000;
  let lastError = "尚未响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (response.status === 200 && body?.ok === true) return;
      lastError = `HTTP ${response.status}${response.ok ? "（响应不是 VERIDIA ready）" : ""}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js 健康检查超时: ${lastError}`);
}

async function warmup(baseURL, executablePath) {
  warmupBrowser = await chromium.launch(executablePath ? { executablePath } : {});
  const privateProcess = warmupBrowser?._connection?._transport?._proc;
  let browserPid = privateProcess?.pid || null;
  if (!browserPid && process.platform === "win32") {
    const detected = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter \"ParentProcessId = ${process.pid}\" | Where-Object { $_.Name -match 'chrome|chromium' } | Select-Object -First 1 -ExpandProperty ProcessId)`,
    ], { encoding: "utf8", windowsHide: true });
    browserPid = Number((detected.stdout || "").trim()) || null;
  }
  writeMetadata({ browserPid });
  const context = await warmupBrowser.newContext({ baseURL });
  const page = await context.newPage();
  const loginPageReady = await waitForStartupRoute({
    label: "预热 /login",
    request: () => page.goto("/login", { waitUntil: "domcontentloaded" }),
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((button) =>
      Object.keys(button).some((key) => key.startsWith("__reactProps"))),
  null, { timeout: 30_000 });
  const authStatusReady = await waitForStartupRoute({
    label: "预热 /api/auth/status",
    request: () => context.request.get("/api/auth/status"),
  });
  const authenticationReady = await waitForStartupRoute({
    label: "预热 /api/auth/login",
    request: () => context.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    }),
  });
  writeMetadata({
    readiness: {
      health: "READY",
      loginPageAttempts: loginPageReady.attempts,
      authStatusAttempts: authStatusReady.attempts,
      authLoginAttempts: authenticationReady.attempts,
    },
  });
  for (const route of ["/tasks", "/results", "/campaigns", "/rules"]) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    if (!response || response.status() >= 400) throw new Error(`预热 ${route} 失败: HTTP ${response?.status() ?? "无响应"}`);
    await page.waitForFunction(() => document.readyState !== "loading" && document.body.childElementCount > 0, null, { timeout: 30_000 });
  }
  await context.close();
  await warmupBrowser.close();
  warmupBrowser = undefined;
}

function countTests(environment) {
  const commandArgs = [
    path.join(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    "--list",
    ...(grepArgument ? [grepArgument] : []),
    ...files,
  ];
  const result = spawnSync(process.execPath, commandArgs, { cwd: root, env: environment, encoding: "utf8", windowsHide: true });
  const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/Total:\s+(\d+) tests?/u);
  if (result.status !== 0 || !match) throw new Error("无法枚举所选 E2E 测试");
  return Number(match[1]);
}

async function main() {
  const nextCacheIdentity = ensureProjectBoundDirectory(
    path.join(root, ".playwright", "next-e2e"),
    root,
  );
  if (nextCacheIdentity.reset) {
    process.stdout.write(
      `[Next cache] RESET 项目根已变化，已重建 ${path.relative(root, nextCacheIdentity.directory)}\n`,
    );
  }
  invalidateMalformedNextCache();
  nextEnvSnapshot = captureFile(path.join(root, "next-env.d.ts"));
  const port = await findFreePort();
  const database = copyE2eDatabaseForRun(runDirectory);
  const executablePath = browserExecutablePath();
  const profilePath = path.join(runDirectory, "xhs-profile");
  const douyinProfilePath = path.join(runDirectory, "douyin-profile");
  const publicKeyPath = path.join(database.accountKeyRoot, "public.pem");
  const privateKeyPath = path.join(database.accountKeyRoot, "private.pem");
  const environment = {
    ...process.env,
    DATABASE_URL: `file:${database.runDatabasePath}`,
    E2E_DATABASE_URL: `file:${database.runDatabasePath}`,
    E2E_PORT: String(port),
    E2E_REUSE_SERVER: "true",
    E2E_WORKERS: String(workers),
    E2E_XHS_PROFILE_PATH: profilePath,
    E2E_DOUYIN_PROFILE_PATH: douyinProfilePath,
    VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH: publicKeyPath,
    VERIDIA_ACCOUNT_SIGNING_PRIVATE_KEY_PATH: privateKeyPath,
    VERIDIA_NEXT_DIST_DIR: nextDistDir,
    VERIDIA_NEXT_TSCONFIG_PATH: e2eTsconfigPath(root),
    AUTH_SECRET: process.env.AUTH_SECRET || "e2e-local-secret",
    EXTENSION_TOKEN: process.env.EXTENSION_TOKEN || "local-extension-demo-token",
    AI_ENABLED: "false",
    PLAYWRIGHT_BROWSER_CHANNEL: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "",
    ...(executablePath ? { PLAYWRIGHT_EXECUTABLE_PATH: executablePath } : {}),
  };
  writeMetadata({ schemaVersion: 1, runId, isolationGroup, port, databasePath: database.runDatabasePath, profilePath, douyinProfilePath, nextDistDir: environment.VERIDIA_NEXT_DIST_DIR, serverPid: null, browserPid: null, startedAt: new Date().toISOString(), templateFingerprint: database.fingerprint });
  const total = countTests(environment);
  const log = fs.openSync(path.join(runDirectory, "next-server.log"), "a");
  serverProcess = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)], {
    cwd: root,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  serverProcess.on("error", (error) => {
    writeMetadata({
      serverErrorAt: new Date().toISOString(),
      serverError: error instanceof Error ? error.message : String(error),
    });
  });
  serverProcess.on("exit", (code, signal) => {
    writeMetadata({
      serverExitedAt: new Date().toISOString(),
      serverExitCode: code,
      serverExitSignal: signal,
      serverExitedDuringTests: Boolean(testProcess && testProcess.exitCode === null),
    });
  });
  writeMetadata({ serverPid: serverProcess.pid });
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForHealth(baseURL);
  writeMetadata({ serverReadyAt: new Date().toISOString() });
  await warmup(baseURL, executablePath);
  const playwrightArgs = [
    path.join(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    ...(grepArgument ? [grepArgument] : []),
    ...files,
    `--workers=${workers}`,
  ];
  if (failFast) playwrightArgs.push("--max-failures=1");
  const status = await new Promise((resolve, reject) => {
    testProcess = spawn(process.execPath, playwrightArgs, { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
    testProcess.on("error", reject);
    testProcess.on("exit", (code) => resolve(code ?? 1));
  });
  writeMetadata({ testProcessPid: testProcess.pid, total, passed: status === 0 ? total : null, status: status === 0 ? "PASSED" : "FAILED" });
  process.stdout.write(`VERIDIA_E2E_RESULT=${JSON.stringify({ group: isolationGroup, total, passed: status === 0 ? total : 0 })}\n`);
  await cleanup(status === 0 ? "completed" : "failed");
  process.exitCode = status;
}

const timeout = setTimeout(async () => {
  process.stderr.write("E2E 外层超时，正在清理当前 run 的服务、浏览器、Profile 和数据库。\n");
  await cleanup("outer-timeout");
  process.exit(124);
}, Number(process.env.VERIDIA_E2E_OUTER_TIMEOUT_MS || 1_800_000));
timeout.unref();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await cleanup(signal); process.exit(130); });

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  await cleanup("infrastructure-error");
  process.exitCode = 1;
});
