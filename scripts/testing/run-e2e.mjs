import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium, request } from "playwright";
import ts from "typescript";
import { copyE2eDatabaseForRun } from "./e2e-database-template.mjs";
import { collectSourceFingerprint } from "../source-fingerprint.mjs";
import { applyNextTraceSingleFlight } from "./next-trace-single-flight.mjs";
import { captureWarmupApiAuthCookieSnapshot } from "./warmup-api-auth-cookie-snapshot.mjs";
import { ensureProjectBoundDirectory } from "./project-bound-cache.mjs";
import {
  captureFile,
  cleanupTestNextGeneratedTypes,
  e2eTsconfigPath,
  restoreFile,
} from "./next-type-isolation.mjs";
import {
  StartupRouteReadinessError,
  waitForStartupRoute,
} from "./e2e-readiness.mjs";
import { readPlaywrightCaseEvidence, summarizePlaywrightCaseEvidence } from "./protected-evidence.mjs";
import {
  captureWindowsRuntime,
  captureWindowsScopedResiduals,
  closeWithinDeadline,
  evaluateGenerationIdleSnapshot,
  exportFailureDiagnostics,
  extendOwnedProcessIdentities,
  matchingOwnedProcesses,
  normalizeUniqueFormalCaseEvidence,
  parseRepeatEach,
  readServerSnapshots,
  selectNewOwnedBrowserRoot,
  startWindowsRuntimeObservation,
  summarizeRepeatedExecutions,
  terminateWindowsOwnedProcesses,
  validateInitialOwnedRoot,
  waitForOwnedProcessQuiescence,
} from "./e2e-server-infrastructure.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
const workers = Number(args.find((arg) => arg.startsWith("--workers="))?.split("=")[1] || 1);
const repeatEach = parseRepeatEach(args);
const failFast = args.includes("--fail-fast");
const grepArgument = args.find((arg) => arg.startsWith("--grep="));
const isolationGroup = args.find((arg) => arg.startsWith("--group="))?.split("=")[1] || "SELECTED";
const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${isolationGroup}-${randomUUID().slice(0, 8)}`;
const runDirectory = path.join(root, ".playwright", "e2e-runs", runId);
const metadataPath = path.join(runDirectory, "run.json");
const jsonReportPath = path.join(runDirectory, "playwright-results.json");
let serverProcess;
let testProcess;
let warmupBrowser;
let warmupProcess;
let warmupStorageState;
let cleaned = false;
let cleanupPromise;
let nextEnvSnapshot;
let runPort;
let runtimeBeforeCleanup;
let runtimeAfterCleanup;
let generationIdleCheck;
let processObserver;
let processObservation;
let wrapperIdentity;
let runHead;
let runSourceFingerprint;
let isolatedBaseURL;
const teardownNonce = randomUUID();
const ownedProcessIdentities = new Map();
const retiredProcessTrees = [];
const nextDistDir = ".playwright/next-e2e";
const physicalCleanupDeadlineMs = 45_000;

function sourceIdentity() {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (git.error || git.status !== 0 || !/^[a-f\d]{40}$/u.test(git.stdout.trim())) throw new Error("E2E 源码 HEAD 无法验证");
  return { head: git.stdout.trim(), sourceFingerprint: collectSourceFingerprint(root) };
}

function allCapturedIdentities() {
  const unique = new Map([...retiredProcessTrees.flatMap(tree => tree.identities), ...ownedProcessIdentities.values()].flat()
    .map(item => [`${item.pid}:${item.createdAt}`, item]));
  return [...unique.values()];
}

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
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

function recordMetadataBestEffort(update, errors) {
  try { writeMetadata(update); }
  catch (error) {
    errors?.push(error);
    process.stderr.write("E2E diagnostic metadata write failed; physical teardown will still run.\n");
  }
}

function rememberOwnedTree(child, runtime) {
  if (!child?.pid) return;
  const prior = ownedProcessIdentities.get(child.pid) || [];
  if (prior.length === 0 && (child.exitCode !== null || child.signalCode !== null)) return;
  const currentRoot = runtime.processes.find(item => item.pid === child.pid);
  if (prior.length === 0 && !validateInitialOwnedRoot(currentRoot, child.e2eOwnershipFence)) {
    throw new Error("E2E 初始进程身份不匹配创建者/出生时间，禁止采用未知 PID");
  }
  ownedProcessIdentities.set(child.pid, extendOwnedProcessIdentities(runtime.processes, prior.length ? prior : [currentRoot]));
}

function captureOwnedRuntime(label) {
  const serverProcesses = readServerSnapshots(path.join(runDirectory, "server-diagnostics"));
  if (process.platform !== "win32") {
    return { label, capturedAt: new Date().toISOString(), serverProcesses };
  }
  const runtime = captureWindowsRuntime(runPort);
  rememberOwnedTree(serverProcess, runtime);
  rememberOwnedTree(testProcess, runtime);
  rememberOwnedTree(warmupProcess, runtime);
  const identities = allCapturedIdentities();
  return { label, capturedAt: new Date().toISOString(),
    processes: matchingOwnedProcesses(runtime.processes, identities),
    ports: runtime.ports, serverProcesses };
}

async function stopOwnedProcess(child, remainingBudget = () => 10_000) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const before = captureWindowsRuntime(runPort, undefined, Math.min(15_000, remainingBudget()));
    rememberOwnedTree(child, before);
    const identities = ownedProcessIdentities.get(child.pid) || [];
    // Handle-bound termination validates all birth identities before killing
    // retained handles leaf-first. No snapshot-to-taskkill raw PID race.
    terminateWindowsOwnedProcesses(matchingOwnedProcesses(before.processes, identities), undefined, Math.min(5_000, remainingBudget()));
    await waitForOwnedProcessQuiescence({ identities, deadlineMs: Math.min(10_000, remainingBudget()),
      capture: remainingMs => captureWindowsRuntime(runPort, undefined, Math.min(15_000, remainingMs)) });
    // A physically verified-empty tree is evidence/history, not active kill
    // authority. Its exited PIDs may legitimately be reused in a long run.
    ownedProcessIdentities.delete(child.pid);
    retiredProcessTrees.push({ rootPid: child.pid, retiredAt: new Date().toISOString(), identities, ownedProcessCount: 0 });
    recordMetadataBestEffort({ retiredProcessTrees });
    // Retired birth identities remain in history for the final independent
    // fence; they do not authorize a reused PID or an unobserved orphan.
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) killTree(child);
}

function startNextServer(port, environment, log) {
  const observerPath = path.join(root, "scripts", "testing", "e2e-server-observer.cjs").replaceAll("\\", "/");
  const serverEnvironment = {
    ...environment,
    NODE_OPTIONS: `${environment.NODE_OPTIONS || ""} --require=${JSON.stringify(observerPath)}`.trim(),
    VERIDIA_E2E_SERVER_DIAGNOSTIC_DIR: path.join(runDirectory, "server-diagnostics"),
  };
  const earliestCreationMs = Date.now();
  const child = spawn(process.execPath, [
    path.join(root, "node_modules", "next", "dist", "bin", "next"),
    "dev",
    "-p",
    String(port),
  ], {
    cwd: root,
    env: serverEnvironment,
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  // Establish cleanup ownership before any fallible diagnostic I/O.
  serverProcess = child;
  child.e2eOwnershipFence = { pid: child.pid, parentPid: process.pid, name: path.basename(process.execPath),
    earliestCreationMs, latestCreationMs: Date.now() };
  child.on("error", (error) => {
    recordMetadataBestEffort({
      serverErrorAt: new Date().toISOString(),
      serverError: error instanceof Error ? error.message : String(error),
    });
  });
  child.on("exit", (code, signal) => {
    recordMetadataBestEffort({
      serverExitedAt: new Date().toISOString(),
      serverExitCode: code,
      serverExitSignal: signal,
      serverExitedDuringTests: Boolean(testProcess && testProcess.exitCode === null),
    });
  });
  writeMetadata({
    serverPid: child.pid,
    serverStartedAt: new Date().toISOString(),
    serverExitedAt: null,
    serverExitCode: null,
    serverExitSignal: null,
  });
  if (process.platform === "win32") {
    rememberOwnedTree(child, captureWindowsRuntime(port));
    processObserver ??= startWindowsRuntimeObservation({ port, runId, wrapperIdentity, record: runtime => {
      rememberOwnedTree(serverProcess, runtime);
      rememberOwnedTree(testProcess, runtime);
      rememberOwnedTree(warmupProcess, runtime);
    } });
  }
  return child;
}

async function resetNextCacheAfterStartup404(cacheDirectory) {
  const expected = path.resolve(root, nextDistDir);
  if (path.resolve(cacheDirectory) !== expected) {
    throw new Error(`拒绝重建非 E2E Next 缓存目录：${cacheDirectory}`);
  }
  await closeWarmupBrowser();
  await stopOwnedProcess(serverProcess);
  fs.rmSync(expected, { recursive: true, force: true });
  ensureProjectBoundDirectory(expected, root);
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

function cleanup(reason) {
  if (cleaned) return Promise.resolve();
  cleanupPromise ??= performCleanup(reason);
  return cleanupPromise;
}

async function captureFinalPhysicalFence(remainingBudget, label) {
  if (processObserver) {
    const terminal = processObserver.snapshot();
    const priorFailure = processObservation?.status === "FAILED" ? processObservation : undefined;
    processObservation = { ...processObservation, ...terminal, workerExitVerified: terminal.workerJoined === true,
      ...(priorFailure && { status: "FAILED", error: priorFailure.error }) };
    if (!terminal.workerJoined) throw new Error("E2E observation worker 尚未自然退出，禁止最终原生 fence");
    processObserver = undefined;
  }
  const identities = allCapturedIdentities();
  const fence = await waitForOwnedProcessQuiescence({ identities, requirePortClosed: true, deadlineMs: remainingBudget(),
    capture: remainingMs => captureWindowsRuntime(runPort, undefined, Math.min(15_000, remainingMs)) });
  const residuals = captureWindowsScopedResiduals({ projectRoot: root,
    profilePaths: ["xhs-profile", "douyin-profile"].map(name => path.join(runDirectory, name)),
    identities, wrapperIdentity, timeoutMs: Math.min(15_000, remainingBudget()),
    identityForensics: label === "after-process-cleanup" && process.env?.VERIDIA_E2E_IDENTITY_FORENSICS === "1",
    ports: [runPort], portListeners: fence.runtime.ports });
  runtimeAfterCleanup = { label, capturedAt: new Date().toISOString(),
    processes: matchingOwnedProcesses(fence.runtime.processes, identities), ports: fence.runtime.ports, residuals,
    allCapturedIdentityCount: identities.length, physicalFence: { observations: fence.observations, elapsedMs: fence.elapsedMs } };
  if (residuals.ownedProcesses.length || residuals.unknownProcesses.length) {
    throw new Error(`E2E scoped residual 仍存活：owned=${residuals.ownedProcesses.length}, unknown=${residuals.unknownProcesses.length}；未知进程禁止终止`);
  }
}

async function stopPeriodicRuntimeObservation(boundary, remainingBudget = () => 15_000) {
  const current = processObserver;
  let stopped;
  try { stopped = await current?.stop(performance.now() + remainingBudget()); }
  catch (error) {
    // A failed bounded join is not evidence of a naturally exited worker.
    // Preserve the failure and still run the creator-owned physical fences.
    const terminal = error.observation ?? current?.snapshot?.();
    stopped = { ...terminal, status: "FAILED", coverage: "SAMPLED_NOT_EXHAUSTIVE",
      error: error instanceof Error ? error.message : String(error),
      workerExitVerified: terminal?.workerJoined === true };
  }
  if (current && stopped?.workerJoined !== true && stopped?.workerExitVerified !== true) {
    stopped = { ...stopped, status: "FAILED", workerExitVerified: false,
      error: stopped?.error || "E2E observation worker 缺少自然退出证明" };
  }
  // Keep the object visible until its cached join settles. A concurrent signal
  // or outer-deadline cleanup must await that same join, not guess NOT_RUN and
  // start fresh native fences while the collector is still in flight.
  if (processObserver === current && (stopped?.workerJoined === true || stopped?.workerExitVerified === true)) processObserver = undefined;
  // Stopping before the authenticated probe must not discard observations or
  // turn an earlier native measurement failure into NOT_RUN during cleanup.
  processObservation ??= { ...(stopped || { status: "NOT_RUN", coverage: "SAMPLED_NOT_EXHAUSTIVE" }),
    stoppedAt: new Date().toISOString(), stopBoundary: boundary };
  if (stopped?.status === "FAILED" && processObservation.status !== "FAILED") processObservation = stopped;
  return processObservation;
}

async function performCleanup(reason) {
  let cleanupFailure;
  const startedAt = Date.now();
  const remainingBudget = () => {
    const remainingMs = physicalCleanupDeadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new Error("E2E cleanup 组合物理退出期限已耗尽");
    return remainingMs;
  };
  try {
  const teardownErrors = [];
  await stopPeriodicRuntimeObservation("PHYSICAL_CLEANUP", remainingBudget);
  if (processObservation.status === "FAILED") teardownErrors.push(new Error(`E2E 后代观测失败：${processObservation.error}`));
  try { if (runPort) runtimeBeforeCleanup = captureOwnedRuntime("before-cleanup"); }
  catch (error) { teardownErrors.push(error); }
  try { if (reason !== "completed") preserveFailureDiagnostics(); }
  catch (error) { recordMetadataBestEffort({ diagnosticExportError: error instanceof Error ? error.message : String(error) }, teardownErrors); }
  // Preserve the pre-teardown idle/business evidence, then close the server's
  // actual retained contexts before fixed-snapshot native tree termination.
  // A live Chromium parent can create a child after that snapshot. Unknown
  // late children must never be adopted merely by their historical PPID.
  if (reason === "completed" && generationIdleCheck?.status === "PASSED") {
    let api;
    let contextAbandoned = false;
    let contextTimer;
    const contextCloseStartedAt = Date.now();
    try {
      await Promise.race([
        Promise.resolve().then(async () => {
          const context = await request.newContext({ baseURL: isolatedBaseURL, storageState: warmupStorageState,
            extraHTTPHeaders: { Connection: "close" } });
          if (contextAbandoned) {
            recordMetadataBestEffort({ lateTeardownApiContext: { status: "PENDING_DISPOSAL", acceptanceAlreadyFailed: true } });
            try {
              await closeWithinDeadline(() => context.dispose(), Math.min(2_000, remainingBudget()));
              recordMetadataBestEffort({ lateTeardownApiContext: { status: "DISPOSED", acceptanceAlreadyFailed: true } });
            } catch {
              recordMetadataBestEffort({ lateTeardownApiContext: { status: "FAILED_DISPOSAL_OR_SHARED_BUDGET_EXHAUSTED", acceptanceAlreadyFailed: true } });
            }
            return;
          }
          api = context;
        }),
        new Promise((_, reject) => { contextTimer = setTimeout(() => reject(new Error("E2E browser teardown context 创建期限耗尽")), remainingBudget()); }),
      ]);
      clearTimeout(contextTimer);
      remainingBudget();
      const response = await api.post("/api/automation/session", { maxRetries: 0, timeout: remainingBudget(),
        data: { action: "CLOSE_BROWSERS_FOR_E2E_TEARDOWN", teardownNonce } });
      if (!response.ok() || (await response.json()).data?.closed !== true) throw new Error("E2E retained browser context 关闭未确认");
      remainingBudget();
      recordMetadataBestEffort({ retainedBrowserContextClose: { status: "PASSED", elapsedMs: Date.now() - contextCloseStartedAt,
        beforePhysicalTreeTermination: true, authenticatedIsolatedServer: true } }, teardownErrors);
    } catch (error) {
      recordMetadataBestEffort({ retainedBrowserContextClose: { status: "FAILED", elapsedMs: Date.now() - contextCloseStartedAt } }, teardownErrors);
      teardownErrors.push(error);
    } finally {
      contextAbandoned = true;
      clearTimeout(contextTimer);
      if (api) try { await closeWithinDeadline(() => api.dispose(), Math.min(2_000, remainingBudget())); }
      catch (error) { teardownErrors.push(error); }
    }
  }
  try { await closeWarmupBrowser(remainingBudget); }
  catch (error) { teardownErrors.push(error); }
  for (const child of [process.platform === "win32" ? warmupProcess : undefined, testProcess, serverProcess]) {
    try { await stopOwnedProcess(child, remainingBudget); }
    catch (error) { teardownErrors.push(error); }
  }
  if (runPort) {
    try {
      if (process.platform === "win32") await captureFinalPhysicalFence(remainingBudget, "after-process-cleanup");
      else runtimeAfterCleanup = captureOwnedRuntime("after-cleanup");
    }
    catch (error) { teardownErrors.push(error); }
    if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, "E2E cleanup 进程诊断或退出验证失败");
    const leakedProcesses = runtimeAfterCleanup.processes || [];
    const listeningPorts = runtimeAfterCleanup.ports || [];
    if (leakedProcesses.length > 0 || listeningPorts.length > 0) {
      throw new Error(`E2E cleanup 资源仍占用：processes=${leakedProcesses.length}, listeningPorts=${listeningPorts.length}`);
    }
  }
  for (const name of ["xhs-profile", "douyin-profile"]) {
    const profileDirectory = path.join(runDirectory, name);
    if (path.dirname(path.resolve(profileDirectory)) !== path.resolve(runDirectory)) {
      throw new Error(`拒绝清理非当前 run 的 Profile：${profileDirectory}`);
    }
    fs.rmSync(profileDirectory, { recursive: true, force: true });
    if (fs.existsSync(profileDirectory)) {
      throw new Error(`E2E 隔离 Profile 清理失败：${profileDirectory}`);
    }
  }
  const runDatabase = path.join(runDirectory, "veridia-e2e.db");
  try { fs.chmodSync(runDatabase, 0o600); } catch {}
  try { fs.rmSync(runDatabase, { force: true }); } catch (error) {
    writeMetadata({ cleanupWarning: error instanceof Error ? error.message : String(error) });
  }
  try {
    const removedNextTypes = cleanupTestNextGeneratedTypes(root, nextDistDir);
    if (removedNextTypes.length > 0) writeMetadata({ removedNextTypes });
  } catch (error) {
    recordMetadataBestEffort({ nextTypeCleanupWarning: error instanceof Error ? error.message : String(error) }, teardownErrors);
    teardownErrors.push(error);
  }
  try {
    if (nextEnvSnapshot) restoreFile(path.join(root, "next-env.d.ts"), nextEnvSnapshot);
  } catch (error) {
    recordMetadataBestEffort({ nextEnvRestoreWarning: error instanceof Error ? error.message : String(error) }, teardownErrors);
    teardownErrors.push(error);
  }
  if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, "E2E shared Next types/next-env 恢复失败");
  remainingBudget();
  // History is rechecked after shared-file/profile cleanup, never replaced by
  // an empty active map. Unknown current project/profile processes only fail.
  if (process.platform === "win32") await captureFinalPhysicalFence(remainingBudget, "after-cleanup");
  const finalSource = sourceIdentity();
  if (finalSource.head !== runHead || finalSource.sourceFingerprint !== runSourceFingerprint) throw new Error("E2E 源码身份在运行期间变化，禁止生成同源码 quiescence PASS");
  const quiescence = { schemaVersion: 1,
    status: process.platform === "win32" ? reason === "completed" && generationIdleCheck?.status === "PASSED" ? "PASSED" : "FAILED" : "NOT_APPLICABLE",
    runId, runDirectory, group: isolationGroup, port: runPort, head: runHead, sourceFingerprint: runSourceFingerprint,
    observedAt: new Date().toISOString(), ownershipScope: "CAPTURED_NATIVE_BIRTH_LINEAGES_WITH_LIVE_PARENT_PERIODIC_OBSERVATION",
    observation: processObservation, logicalIdleStatus: generationIdleCheck?.status || "NOT_RUN",
    capturedBeforePhysicalTeardown: generationIdleCheck?.capturedBeforePhysicalTeardown === true,
    retiredProcessTrees, allCapturedIdentities: allCapturedIdentities(), finalOwnedProcessCount: runtimeAfterCleanup?.processes?.length ?? null,
    portCount: runtimeAfterCleanup?.ports?.length ?? null, unknownResidualCount: runtimeAfterCleanup?.residuals?.unknownProcesses?.length ?? null,
    wrapperIdentity, profilesRemoved: true, nextEnvRestored: Boolean(nextEnvSnapshot), typeCleanupPass: true,
    elapsedMs: Date.now() - startedAt, deadlineMs: physicalCleanupDeadlineMs };
  remainingBudget();
  if (quiescence.status === "PASSED" && (processObservation.status !== "PASSED" || !quiescence.nextEnvRestored ||
    retiredProcessTrees.length === 0 || retiredProcessTrees.some(tree => !tree.identities.length || !tree.identities.some(item => item.pid === tree.rootPid)))) {
    throw new Error("E2E 后代观测/退休物理身份/共享文件恢复缺失，禁止 quiescence PASS");
  }
  writeMetadata({ finishedAt: new Date().toISOString(), cleanupReason: reason, cleaned: true,
    runtimeBeforeCleanup, runtimeAfterCleanup, processObservation, postE2eQuiescence: quiescence,
    resourceLeakCheck: { status: process.platform === "win32" ? "PASSED" : "NOT_APPLICABLE",
      passed: process.platform === "win32" ? true : null, ownedProcessCount: runtimeAfterCleanup?.processes?.length ?? null,
      listeningPortCount: runtimeAfterCleanup?.ports?.length ?? null, profilesRemoved: true },
    generationIdleCheck: generationIdleCheck && { ...generationIdleCheck,
      ownerAfterPhysicalTeardown: process.platform === "win32" ? "RELEASED_BY_OWNED_TEARDOWN" : "NOT_APPLICABLE" } });
  cleaned = true;
  if (reason === "completed") process.stdout.write(`VERIDIA_E2E_QUIESCENCE=${JSON.stringify(quiescence)}\n`);
  } catch (error) {
    cleanupFailure = error;
    recordMetadataBestEffort({ cleaned: false, cleanupError: error instanceof Error ? error.message : String(error),
      runtimeAfterCleanup, processObservation, retiredProcessTrees,
      cleanupElapsedMs: Date.now() - startedAt, cleanupDeadlineMs: physicalCleanupDeadlineMs,
      resourceLeakCheck: { status: "FAILED", passed: false } });
    throw error;
  } finally {
    if (reason !== "completed" || cleanupFailure) {
      try { preserveFailureDiagnostics(); }
      catch (error) { process.stderr.write(`E2E 失败证据保存失败：${error instanceof Error ? error.message : String(error)}\n`); }
    }
  }
}

function preserveFailureDiagnostics() {
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch {}
  exportFailureDiagnostics({ runDirectory, outputDirectory: path.join(root, "artifacts", "e2e-diagnostics", runId),
    metadata, runtime: { before: runtimeBeforeCleanup, after: runtimeAfterCleanup },
    secrets: [process.env.AUTH_SECRET, process.env.EXTENSION_TOKEN, process.env.OPENAI_API_KEY, teardownNonce] });
}

async function waitForHealth(baseURL) {
  const deadline = Date.now() + 180_000;
  let lastError = "尚未响应";
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null || serverProcess?.signalCode !== null) {
      throw new Error("Next.js 在健康检查就绪前退出");
    }
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(Math.min(3_000, deadline - Date.now())) });
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (response.status === 200 && body?.ok === true && body?.service === "VERIDIA") return;
      lastError = `HTTP ${response.status}${response.ok ? "（响应不是 VERIDIA ready）" : ""}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js 健康检查超时: ${lastError}`);
}

async function waitForCompiledJsonRoute(input) {
  const startedAt = Date.now();
  const timeoutMs = 15_000;
  let attempts = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const response = await input.request();
    const contentType = response.headers()["content-type"] || "";
    if (
      [400, 404].includes(response.status()) &&
      contentType.includes("application/json")
    ) {
      return { attempts, elapsedMs: Date.now() - startedAt };
    }
    if (response.status() !== 404) {
      throw new Error(
        `${input.label} 预编译失败: HTTP ${response.status()} ${contentType || "无 Content-Type"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new StartupRouteReadinessError(
    input.label,
    attempts,
    Date.now() - startedAt,
  );
}

async function warmup(baseURL, executablePath) {
  const before = process.platform === "win32" ? captureWindowsRuntime(runPort).processes : [];
  warmupBrowser = await chromium.launch(executablePath ? { executablePath } : {});
  if (process.platform === "win32") {
    const after = captureWindowsRuntime(runPort);
    const identity = selectNewOwnedBrowserRoot(before, after.processes, process.pid);
    warmupProcess = { pid: identity.pid, exitCode: null, signalCode: null,
      e2eOwnershipFence: { pid: identity.pid, parentPid: process.pid, name: identity.name, expectedCreatedAt: identity.createdAt } };
    rememberOwnedTree(warmupProcess, after);
    writeMetadata({ browserPid: identity.pid, warmupProcessIdentity: identity });
  }
  const context = await warmupBrowser.newContext({ baseURL, extraHTTPHeaders: { Connection: "close" } });
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
  // Turbopack compiles dynamic Route Handlers on first use. Compile the two
  // lifecycle endpoints before heavyweight automation begins and require a
  // VERIDIA JSON error for a nonexistent id; a Next HTML 404 is not ready.
  const controlRouteReady = await waitForCompiledJsonRoute({
    label: "预热 dynamic batch control API",
    request: () => context.request.post(
      "/api/automation/batches/__e2e_route_warmup__/control",
      { data: { action: "CANCEL" } },
    ),
  });
  const clearRouteReady = await waitForCompiledJsonRoute({
    label: "预热 dynamic batch clear API",
    request: () => context.request.post(
      "/api/automation/batches/__e2e_route_warmup__/clear",
    ),
  });
  writeMetadata({
    readiness: {
      health: "READY",
      loginPageAttempts: loginPageReady.attempts,
      authStatusAttempts: authStatusReady.attempts,
      authLoginAttempts: authenticationReady.attempts,
      controlRouteAttempts: controlRouteReady.attempts,
      clearRouteAttempts: clearRouteReady.attempts,
    },
  });
  for (const route of ["/tasks", "/results", "/campaigns", "/rules"]) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    if (!response || response.status() >= 400) throw new Error(`预热 ${route} 失败: HTTP ${response?.status() ?? "无响应"}`);
    await page.waitForFunction(() => document.readyState !== "loading" && document.body.childElementCount > 0, null, { timeout: 30_000 });
  }
  // Compile the read-only diagnostic route during startup, not inside the
  // group-end 3-second measurement window. These are single attempts.
  for (const platform of ["XIAOHONGSHU", "DOUYIN"]) {
    const response = await context.request.get(`/api/automation/session?platform=${platform}`, { maxRetries: 0, timeout: 15_000 });
    if (!response.ok()) throw new Error(`预热 ${platform} session diagnostics: HTTP ${response.status()}`);
  }
  // Keep authentication only in memory for read-only pre-teardown probes.
  // Browser.close owns context teardown; a separate unbounded context.close
  // must not stand in front of the bounded physical ownership fence.
  // Group-end probes are API-only: renderer DOM/localStorage state is neither
  // consumed nor an authentication authority. Capture only the current local
  // HttpOnly session cookie, with the unchanged 2-second absolute deadline.
  // Assignment stays outside the timed provider so a late result cannot mutate
  // the accepted authentication state after a deadline failure.
  try {
    const snapshot = await captureWarmupApiAuthCookieSnapshot(context, baseURL);
    warmupStorageState = snapshot.storageState;
    writeMetadata({ warmupAuthSnapshot: snapshot.measurement });
  } catch (error) {
    recordMetadataBestEffort({ warmupAuthSnapshot: {
      status: "FAILED", label: "AUTH_COOKIE_SNAPSHOT", budgetMs: 2_000,
      elapsedMs: error.elapsedMs ?? null, code: error.code ?? "SNAPSHOT_UNAVAILABLE",
    } });
    throw error;
  }
  await closeWarmupBrowser();
}

async function closeWarmupBrowser(remainingBudget = () => 10_000) {
  if (!warmupBrowser) return;
  const browser = warmupBrowser;
  // The graceful close is bounded; physical ownership verification still runs
  // if Chromium hangs. Never let a diagnostic write suppress that fence.
  try { await closeWithinDeadline(() => browser.close(), Math.min(2_000, remainingBudget())); }
  catch (error) { recordMetadataBestEffort({ warmupCloseError: error instanceof Error ? error.message : String(error) }); }
  if (process.platform === "win32") {
    if (!warmupProcess) throw new Error("E2E warmup browser 缺少可验证物理所有权");
    await stopOwnedProcess(warmupProcess, remainingBudget);
    warmupProcess = undefined;
  }
  warmupBrowser = undefined;
}

async function captureGroupEndLogicalIdle(baseURL) {
  const startedAt = Date.now();
  const deadline = startedAt + 3_000;
  let api;
  let latest;
  let observations = 0;
  let stage = "CONTEXT_CREATE";
  let contextAbandoned = false;
  const stageTimings = [];
  const remainingBudget = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`E2E group-end logical idle 期限已耗尽：${stage}`);
    return remaining;
  };
  const withinBudget = async operation => {
    const remaining = remainingBudget();
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`E2E group-end logical idle 期限已耗尽：${stage}`)), remaining);
      })]);
      // A blocked event loop can deliver a success before its overdue timer.
      // Actual elapsed time, not timer callback order, decides acceptance.
      remainingBudget();
      return value;
    } finally { clearTimeout(timer); }
  };
  try {
    if (!warmupStorageState) throw new Error("E2E group-end 缺少内存认证状态，禁止重登录");
    const contextStartedAt = Date.now();
    // Queue creation only inside the already budget-checked/race-observed
    // operation. An expired initial check must not leave an unobserved promise.
    try { await withinBudget(async () => {
      const context = await request.newContext({ baseURL,
        storageState: warmupStorageState, extraHTTPHeaders: { Connection: "close" } });
      if (contextAbandoned || Date.now() >= deadline) {
        await closeWithinDeadline(() => context.dispose()).catch(() => undefined);
        throw new Error("E2E group-end logical idle 期限已耗尽：CONTEXT_CREATE");
      }
      // Retain disposal ownership even if the shared budget expires between
      // context resolution and the caller's post-await elapsed-time check.
      api = context;
      return context;
    }); }
    catch (error) { contextAbandoned = true; throw error; }
    finally { stageTimings.push({ stage: "CONTEXT_CREATE", elapsedMs: Date.now() - contextStartedAt }); }
    const get = async path => {
      const response = await api.get(path, { maxRetries: 0, timeout: remainingBudget() });
      if (!response.ok()) throw new Error(`E2E group-end observation ${path}: HTTP ${response.status()}`);
      return response.json();
    };
    do {
      stage = "AUTHENTICATED_IDLE_SNAPSHOT";
      const snapshotStartedAt = Date.now();
      let health, xhs, douyin;
      try { [health, xhs, douyin] = await withinBudget(() => Promise.all([
        get("/api/health"), get("/api/automation/session?platform=XIAOHONGSHU"), get("/api/automation/session?platform=DOUYIN"),
      ])); }
      finally { stageTimings.push({ stage, elapsedMs: Date.now() - snapshotStartedAt }); }
      if (xhs.success !== true || douyin.success !== true) throw new Error("E2E group-end authenticated isolated DB session 读取失败");
      stage = "IDLE_EVALUATION";
      latest = evaluateGenerationIdleSnapshot(xhs.data?.globalRuntimeDiagnostics,
        { XIAOHONGSHU: xhs.data, DOUYIN: douyin.data }, health);
      observations += 1;
      remainingBudget();
      if (latest.idle) return { status: "PASSED", capturedBeforePhysicalTeardown: true,
        transactionMeasurementScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS",
        observedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, deadlineMs: 3_000,
        observations, stageTimings, ...latest };
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    } while (Date.now() < deadline);
    throw new Error("E2E group-end logical idle 条件在限定时间内未满足");
  } catch (error) {
    return { status: "FAILED", capturedBeforePhysicalTeardown: true, elapsedMs: Date.now() - startedAt,
      deadlineMs: 3_000, stage, stageTimings, observations, latest,
      error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  } finally {
    // API context has no browser child, but its disposal must not hold physical
    // server cleanup hostage if a request is already failing.
    if (api) await closeWithinDeadline(() => api.dispose()).catch(() => undefined);
  }
}

function countTests(environment) {
  const commandArgs = [
    path.join(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    "--list",
    `--repeat-each=${repeatEach}`,
    ...(grepArgument ? [grepArgument] : []),
    ...files,
  ];
  const result = spawnSync(process.execPath, commandArgs, { cwd: root, env: environment, encoding: "utf8", windowsHide: true });
  const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/Total:\s+(\d+) tests?/u);
  if (result.status !== 0 || !match) throw new Error("无法枚举所选 E2E 测试");
  return Number(match[1]);
}

async function main() {
  const nextTracePatch = await applyNextTraceSingleFlight();
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
  runPort = port;
  ({ head: runHead, sourceFingerprint: runSourceFingerprint } = sourceIdentity());
  if (process.platform === "win32") {
    wrapperIdentity = captureWindowsRuntime(port).processes.find(item => item.pid === process.pid);
    if (!wrapperIdentity) throw new Error("E2E 当前 wrapper 物理身份不可验证");
  }
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
    XHS_PROFILE_PATH: profilePath,
    DOUYIN_PROFILE_PATH: douyinProfilePath,
    E2E_HTML_REPORT_DIR: path.join(root, "playwright-report", isolationGroup, runId),
    E2E_TEST_RESULTS_DIR: path.join(root, "test-results", isolationGroup, runId),
    PLAYWRIGHT_JSON_OUTPUT_FILE: jsonReportPath,
    VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH: publicKeyPath,
    VERIDIA_ACCOUNT_SIGNING_PRIVATE_KEY_PATH: privateKeyPath,
    VERIDIA_NEXT_DIST_DIR: nextDistDir,
    VERIDIA_NEXT_TSCONFIG_PATH: e2eTsconfigPath(root),
    AUTH_SECRET: process.env.AUTH_SECRET || "e2e-local-secret",
    EXTENSION_TOKEN: process.env.EXTENSION_TOKEN || "local-extension-demo-token",
    AI_ENABLED: "false",
    VERIDIA_E2E: "true",
    VERIDIA_E2E_TEARDOWN_NONCE: teardownNonce,
    PLAYWRIGHT_BROWSER_CHANNEL: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "",
    ...(executablePath ? { PLAYWRIGHT_EXECUTABLE_PATH: executablePath } : {}),
  };
  writeMetadata({ schemaVersion: 2, runId, isolationGroup, port, repeatEach, requestRetries: 0, httpConnection: "close",
    nextTracePatch, head: runHead, sourceFingerprint: runSourceFingerprint,
    databasePath: database.runDatabasePath, profilePath, douyinProfilePath, nextDistDir: environment.VERIDIA_NEXT_DIST_DIR,
    htmlReportDirectory: environment.E2E_HTML_REPORT_DIR, testResultsDirectory: environment.E2E_TEST_RESULTS_DIR,
    serverPid: null, browserPid: null, startedAt: new Date().toISOString(), templateFingerprint: database.fingerprint });
  const executionTotal = countTests(environment);
  const total = executionTotal / repeatEach;
  if (!Number.isSafeInteger(total)) throw new Error("Playwright repeat 枚举与正式测试数量不一致");
  const log = fs.openSync(path.join(runDirectory, "next-server.log"), "a");
  const baseURL = `http://127.0.0.1:${port}`;
  isolatedBaseURL = baseURL;
  let startupRecovery;
  for (let startupAttempt = 1; startupAttempt <= 2; startupAttempt += 1) {
    serverProcess = startNextServer(port, environment, log);
    // The ownership object is already stored before awaiting worker readiness,
    // so startup failure still has a bounded natural-exit cleanup path.
    await processObserver?.ready;
    await waitForHealth(baseURL);
    writeMetadata({ serverReadyAt: new Date().toISOString(), startupAttempt });
    try {
      await warmup(baseURL, executablePath);
      if (startupRecovery) {
        startupRecovery = {
          ...startupRecovery,
          status: "RECOVERED",
          recoveredAt: new Date().toISOString(),
        };
        writeMetadata({ startupRecovery });
      }
      break;
    } catch (error) {
      if (!(error instanceof StartupRouteReadinessError) || startupAttempt >= 2) {
        throw error;
      }
      startupRecovery = {
        status: "ATTEMPTED",
        reason: error.code,
        route: error.label,
        attempts: error.attempts,
        elapsedMs: error.elapsedMs,
        cacheReset: true,
        attemptedAt: new Date().toISOString(),
      };
      writeMetadata({ startupRecovery });
      process.stdout.write(
        `[Next cache] RECOVER ${error.label} 持续返回 404，正在重建安全测试缓存并重启一次\n`,
      );
      await resetNextCacheAfterStartup404(nextCacheIdentity.directory);
    }
  }
  const playwrightArgs = [
    path.join(root, "node_modules", "@playwright", "test", "cli.js"),
    "test",
    ...(grepArgument ? [grepArgument] : []),
    ...files,
    `--workers=${workers}`,
    `--repeat-each=${repeatEach}`,
  ];
  const runtimeBeforeTests = captureOwnedRuntime("before-tests");
  if (process.platform === "win32" && !runtimeBeforeTests.ports.some(item => runtimeBeforeTests.processes.some(owned => owned.pid === item.pid))) {
    throw new Error("E2E 监听端口不属于当前 run 的服务器进程树");
  }
  writeMetadata({ runtimeBeforeTests });
  if (failFast) playwrightArgs.push("--max-failures=1");
  const status = await new Promise((resolve, reject) => {
    const earliestCreationMs = Date.now();
    testProcess = spawn(process.execPath, playwrightArgs, { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
    testProcess.e2eOwnershipFence = { pid: testProcess.pid, parentPid: process.pid, name: path.basename(process.execPath),
      earliestCreationMs, latestCreationMs: Date.now() };
    testProcess.on("error", reject);
    testProcess.on("exit", (code) => resolve(code ?? 1));
    if (process.platform === "win32") rememberOwnedTree(testProcess, captureWindowsRuntime(port));
  });
  // Join the serial native sampler before the bounded API probe, never leaving
  // an in-flight collector to race the subsequent fresh physical fences.
  await stopPeriodicRuntimeObservation("POST_TEST_PRE_LOGICAL_PROBE");
  generationIdleCheck = await captureGroupEndLogicalIdle(baseURL);
  writeMetadata({ generationIdleCheck });
  const cases = normalizeUniqueFormalCaseEvidence(readPlaywrightCaseEvidence(jsonReportPath, root));
  const summary = summarizePlaywrightCaseEvidence(cases, total);
  const report = fs.existsSync(jsonReportPath) ? JSON.parse(fs.readFileSync(jsonReportPath, "utf8")) : {};
  const executionSummary = summarizeRepeatedExecutions(report, executionTotal);
  const runtimeAfterTests = captureOwnedRuntime("after-tests");
  const expectedServerPid = runtimeBeforeTests.ports?.[0]?.pid;
  const actualServerPid = runtimeAfterTests.ports?.[0]?.pid;
  const unexpectedServerOwnershipChange = process.platform === "win32" && expectedServerPid !== actualServerPid;
  const exitStatus = status || (summary.failed > 0 || summary.notRun > 0 || executionSummary.failed > 0 || executionSummary.notRun > 0 || executionSummary.retryCount > 0 || unexpectedServerOwnershipChange || generationIdleCheck.status !== "PASSED" || (process.platform === "win32" && processObservation?.status !== "PASSED") ? 1 : 0);
  writeMetadata({ runtimeAfterTests, unexpectedServerOwnershipChange });
  writeMetadata({ testProcessPid: testProcess.pid, ...summary, executionSummary, status: exitStatus === 0 ? "PASSED" : "FAILED", cases });
  process.stdout.write(`VERIDIA_E2E_RESULT=${JSON.stringify({ group: isolationGroup, ...summary, repeatEach, executionSummary, generationIdleCheck, cases })}\n`);
  await cleanup(exitStatus === 0 ? "completed" : "failed");
  process.exitCode = exitStatus;
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
  try { writeMetadata({ infrastructureError: error instanceof Error ? error.message : String(error) }); } catch {}
  try { preserveFailureDiagnostics(); } catch {}
  try { await cleanup("infrastructure-error"); }
  catch (cleanupError) { recordMetadataBestEffort({ cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError), cleaned: false }); }
  try { preserveFailureDiagnostics(); } catch {}
  process.exitCode = 1;
});
