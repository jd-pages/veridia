import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const { minimalSafeWindowsNativeEnvironment } = createRequire(import.meta.url)("./windows-native-environment.cjs");

const directory = path.dirname(fileURLToPath(import.meta.url));
const coverage = "NATIVE_HANDLE_BIRTH_FENCED_SAMPLED_DESCENDANTS_NOT_EXHAUSTIVE";
const overrides = ["VERIDIA_NEXT_DIST_DIR", "VERIDIA_NEXT_TSCONFIG_PATH", "E2E_NEXT_DIST_DIR"];

export function formalNextEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of overrides) delete result[name];
  return result;
}

export function skippedNextTypegenReceipt() {
  return { execution: "SKIPPED_NOT_NEEDED", executed: false, status: "PASSED", exitCode: null,
    nativeRoot: null, processQuiescence: { measurement: "NOT_RUN", reason: "NO_CHILD_LAUNCHED",
      scope: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null } };
}

function safeEntry(root, entry) {
  const absolute = path.resolve(entry);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("TYPEGEN_ENTRY_OUTSIDE_ROOT");
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error("TYPEGEN_ENTRY_LINK_NOT_ALLOWED");
  }
  if (!fs.statSync(absolute).isFile()) throw new Error("TYPEGEN_ENTRY_NOT_REGULAR_FILE");
  return absolute;
}

function waitUntil(operation, deadline, code) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), Math.max(1, deadline - performance.now()));
  })]).finally(() => clearTimeout(timer));
}

function exitOf(child, event = "exit") {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once(event, (code, signal) => resolve({ code, signal }));
  });
}

function monitorProtocol(child, onCapture) {
  let pending = "", outputBytes = 0, final;
  const startup = [], finalization = [];
  const finalizationStages = ["ROOT_EXIT_OBSERVED", "CAPTURED_TREE_NOT_QUIESCENT", "CLEANUP_ENTERED",
    "REMAINING_BEFORE_CLEANUP", "HELD_HANDLE_TERMINATE_START", "HELD_HANDLE_TERMINATE_RETURN",
    "HELD_HANDLE_JOIN_RETURN", "REMAINING_AFTER_CLEANUP", "FINAL_EMIT_START", "FINAL_EMITTED"];
  const startupStages = ["SCRIPT_ENTERED", "ARGS_VALIDATED", "ROOT_PROCESS_OPEN_START", "ROOT_QUERY_START", "ROOT_QUERY_READY",
    "ROOT_NATIVE_HANDLE_START", "ROOT_NATIVE_HANDLE_READY", "ROOT_PROCESS_OPEN_READY",
    "ROOT_IDENTITY_BOUND", "READY_EMIT_START", "READY_EMITTED"];
  let readyResolve, readyReject, armedResolve, armedReject, failureReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const armed = new Promise((resolve, reject) => { armedResolve = resolve; armedReject = reject; });
  armed.catch(() => {});
  const failure = new Promise((_, reject) => { failureReject = reject; });
  failure.catch(() => {});
  child.stdout.on("data", chunk => {
    try {
      outputBytes += chunk.length;
      if (outputBytes > 262144) throw new Error("TYPEGEN_MONITOR_OUTPUT_LIMIT");
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.kind === "STARTUP") {
          if (event.stage !== startupStages[startup.length]) throw new Error("TYPEGEN_MONITOR_PROTOCOL_INVALID");
          startup.push(event.stage);
        }
        else if (event.kind === "READY") readyResolve(event);
        else if (event.kind === "ARMED") armedResolve(event);
        else if (event.kind === "CAPTURED") onCapture(event.identity);
        else if (event.kind === "FINALIZATION") {
          if (!finalizationStages.includes(event.stage) || finalization.includes(event.stage) ||
            !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) throw new Error("TYPEGEN_MONITOR_PROTOCOL_INVALID");
          finalization.push(event.stage);
        }
        else if (event.kind === "FINAL") {
          final = event;
          finalization.push("MONITOR_STDOUT_FINAL_RECEIVED");
          child.stdin.end();
        }
        else throw new Error("TYPEGEN_MONITOR_PROTOCOL_INVALID");
      }
    } catch (error) { readyReject(error); armedReject(error); failureReject(error);
      final = { status: "FAILED", failure: "TYPEGEN_MONITOR_PROTOCOL_INVALID" }; }
  });
  child.once("error", readyReject);
  child.once("error", armedReject);
  // close, not exit: drain FINAL/startup stdout before attaching diagnostics.
  child.once("close", () => {
    finalization.push("MONITOR_CLOSE_OBSERVED");
    readyReject(new Error("TYPEGEN_MONITOR_EXITED_BEFORE_READY"));
  });
  child.once("close", () => armedReject(new Error("TYPEGEN_MONITOR_EXITED_BEFORE_ARMED")));
  // Consume the diagnostic pipe without copying arbitrary native exception
  // text, commands or environment into a receipt. Failure codes stay bounded.
  child.stderr.resume();
  return { ready, armed, failure, final: () => final, startup: () => [...startup], finalization: () => [...finalization] };
}

function validNativeRoot(identity, pid, creatorPid) {
  return identity?.pid === pid && identity.parentPid === creatorPid &&
    typeof identity.nativeStartFileTime === "string" && /^[1-9][0-9]+$/u.test(identity.nativeStartFileTime) &&
    typeof identity.createdAt === "string" && Number.isFinite(Date.parse(identity.createdAt));
}

// Generic only to make the actual launcher testable with self-owned fixtures.
// Formal prepare supplies the exact installed Next CLI and ["typegen"].
export async function runOwnedNodeTypegenCommand({ root = process.cwd(), entry, args = ["typegen"],
  environment = process.env, deadlineMs = 60000, exitDeadlineMs = 3000, stdio = "inherit", onPhase = () => {} }) {
  root = path.resolve(root);
  entry = safeEntry(root, entry);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 120000 ||
    !Number.isSafeInteger(exitDeadlineMs) || exitDeadlineMs < 100 || exitDeadlineMs > 10000 ||
    !Array.isArray(args) || args.some(arg => typeof arg !== "string") || !["inherit", "ignore", "pipe"].includes(stdio)) {
    throw new Error("TYPEGEN_LIFECYCLE_OPTIONS_INVALID");
  }
  const started = performance.now(), deadline = started + deadlineMs;
  const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
  const receipt = { execution: "NOT_RUN", executed: false, status: "FAILED", startedAt: new Date().toISOString(),
    entry: path.relative(root, entry).replaceAll(path.sep, "/"), args,
    entrySha256: sha256(fs.readFileSync(entry)), argsSha256: sha256(JSON.stringify(args)),
    formalDistDir: ".next", removedOverrideNames: overrides, nativeRoot: null, exitCode: null,
    processQuiescence: { measurement: "NOT_RUN", scope: coverage, capturedIdentityCount: null,
      remainingCapturedIdentityCount: null } };
  let child, monitor, monitorExit, protocol, rootExit, failure;
  try {
    const earliestCreationMs = Date.now();
    child = fork(path.join(directory, "next-typegen-bootstrap.cjs"), [entry, JSON.stringify(args)], {
      cwd: root, env: formalNextEnvironment(environment), execArgv: [],
      stdio: ["ignore", stdio, stdio, "ipc"], windowsHide: true,
    });
    const latestCreationMs = Date.now();
    rootExit = exitOf(child);
    rootExit.then(exit => { receipt.exitCode = exit.code; receipt.exitSignal = exit.signal;
      receipt.rootExitedAt = new Date().toISOString(); }, () => {});
    if (stdio === "pipe") { child.stdout.resume(); child.stderr.resume(); }
    // Attach a rejection observer immediately; the original rejection is still
    // awaited below, not converted into success.
    rootExit.catch(() => {});
    const bootstrapReady = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("TYPEGEN_BOOTSTRAP_EXITED_BEFORE_READY")));
    });
    const bootstrap = await waitUntil(bootstrapReady, deadline, "TYPEGEN_BOOTSTRAP_READY_DEADLINE");
    if (bootstrap?.kind !== "READY" || bootstrap.pid !== child.pid || bootstrap.parentPid !== process.pid) {
      throw new Error("TYPEGEN_BOOTSTRAP_CREATOR_MISMATCH");
    }
    onPhase({ kind: "BOOTSTRAP_READY", pid: child.pid, at: new Date().toISOString() });
    if (process.platform !== "win32") {
      // No Windows native birth proof is fabricated on another platform.
      // Fail closed until a platform-specific ownership boundary is provided.
      throw new Error("TYPEGEN_NATIVE_OWNERSHIP_PLATFORM_UNSUPPORTED");
    }
    // Native monitor has no app/CLI environment contract. Match the existing
    // native watcher boundary rather than inheriting pwsh/Node/app settings.
    const nativeEnvironment = minimalSafeWindowsNativeEnvironment(environment);
    const powershell = path.win32.join(nativeEnvironment.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    monitor = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(directory, "next-typegen-owner-monitor.ps1"), "-RootPid", String(child.pid), "-CreatorPid", String(process.pid),
      "-ExecutablePath", process.execPath, "-EarliestCreationMs", String(earliestCreationMs),
      "-LatestCreationMs", String(latestCreationMs), "-DeadlineMs", String(Math.max(1000, Math.floor(deadline - performance.now()))),
      "-ExitDeadlineMs", String(exitDeadlineMs)], { cwd: root, env: nativeEnvironment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    monitorExit = exitOf(monitor, "close");
    monitorExit.catch(() => {});
    protocol = monitorProtocol(monitor, identity => onPhase({ kind: "NATIVE_DESCENDANT_CAPTURED", identity, at: new Date().toISOString() }));
    const native = await waitUntil(protocol.ready, deadline, "TYPEGEN_NATIVE_CAPTURE_DEADLINE");
    if (!validNativeRoot(native.root, child.pid, process.pid) || native.scope !== coverage) {
      throw new Error("TYPEGEN_NATIVE_CAPTURE_INVALID");
    }
    receipt.nativeRoot = native.root;
    receipt.nativeCapturedBeforeCliRelease = true;
    onPhase({ kind: "NATIVE_ROOT_CAPTURED", root: native.root, at: new Date().toISOString() });
    monitor.stdin.on("error", () => {}); // Exit/final protocol determines failure; EPIPE is not a successful receipt.
    monitor.stdin.write("RUN\n");
    const armed = await waitUntil(protocol.armed, deadline, "TYPEGEN_NATIVE_ARM_DEADLINE");
    if (armed.pid !== child.pid || armed.nativeStartFileTime !== receipt.nativeRoot.nativeStartFileTime) {
      throw new Error("TYPEGEN_NATIVE_ARM_IDENTITY_MISMATCH");
    }
    receipt.nativeArmedBeforeCliRelease = true;
    receipt.cliReleasedAt = new Date().toISOString();
    child.send({ kind: "RUN", pid: child.pid });
    receipt.execution = "EXECUTED";
    receipt.executed = true;
    const [exit, monitorResult] = await waitUntil(Promise.race([Promise.all([rootExit, monitorExit]), protocol.failure]),
      deadline, "TYPEGEN_STAGE_DEADLINE");
    receipt.exitCode = exit.code;
    receipt.exitSignal = exit.signal;
    const final = protocol.final();
    if (!final || final.status !== "PASSED" || monitorResult.code !== 0 || final.released !== true ||
      final.root?.nativeStartFileTime !== receipt.nativeRoot.nativeStartFileTime ||
      !Array.isArray(final.identities) || final.identities.length < 1 ||
      !Array.isArray(final.remainingBeforeCleanup) || final.remainingBeforeCleanup.length !== 0 ||
      !Array.isArray(final.remainingAfterCleanup) || final.remainingAfterCleanup.length !== 0 ||
      !Array.isArray(final.uncertainResidualCandidates) || final.uncertainResidualCandidates.length !== 0) {
      receipt.nativeMonitor = final ?? null;
      throw new Error(final?.failure || "TYPEGEN_NATIVE_QUIESCENCE_UNAVAILABLE");
    }
    receipt.nativeMonitor = final;
    receipt.processQuiescence = { measurement: "AVAILABLE", status: "PASSED", scope: coverage,
      capturedIdentityCount: final.identities.length, remainingCapturedIdentityCount: 0,
      samplingCount: final.sampleCount, exhaustiveProcessTreeClaim: false };
    if (exit.code !== 0 || exit.signal !== null) throw new Error("TYPEGEN_COMMAND_FAILED");
    receipt.status = "PASSED";
  } catch (error) {
    failure = error;
    receipt.failure = error.message;
    // Publish BEFORE cleanup/global harness timeout can hide the error receipt.
    // Vitest truncates nested custom Error properties. This bounded vocabulary
    // carries only protocol stages and lifecycle facts, never native stderr,
    // environment, CLI arguments or raw exception text.
    console.error(`VERIDIA_TYPEGEN_FAILURE_STAGE=${JSON.stringify({
      failureCode: /^TYPEGEN_[A-Z_]+$/u.test(error.message) ? error.message : "TYPEGEN_NATIVE_EXCEPTION",
      elapsedMs: performance.now() - started,
      startupStages: protocol?.startup() ?? [],
      finalizationStages: protocol?.finalization() ?? [],
      nativeCapturedBeforeCliRelease: receipt.nativeCapturedBeforeCliRelease === true,
      nativeArmedBeforeCliRelease: receipt.nativeArmedBeforeCliRelease === true,
      cliReleased: receipt.executed,
      monitorExitCode: monitor?.exitCode ?? null,
      monitorSignal: monitor?.signalCode ?? null,
    })}`);
  } finally {
    if (failure) {
      if (monitor?.exitCode === null && monitor?.signalCode === null) {
        try { monitor.stdin.end("ABORT\n"); } catch {}
      }
      // Creator-held bootstrap handle only; no raw PID or guessed tree kill.
      if (child?.exitCode === null && child?.signalCode === null) {
        try { child.kill(); } catch (error) { receipt.rootKillFailure = error.code ?? error.message; }
      }
      const cleanupDeadline = performance.now() + exitDeadlineMs + 3000;
      if (rootExit) await waitUntil(rootExit, cleanupDeadline, "TYPEGEN_OWNED_ROOT_CLEANUP_DEADLINE").catch(() => { receipt.rootCleanupUnconfirmed = true; });
      if (monitorExit) {
        await waitUntil(monitorExit, cleanupDeadline, "TYPEGEN_MONITOR_CLEANUP_DEADLINE").catch(async () => {
          receipt.monitorCleanupUnconfirmed = true;
          if (monitor.exitCode === null && monitor.signalCode === null) {
            try { monitor.kill(); } catch (error) { receipt.monitorKillFailure = error.code ?? error.message; }
          }
          await waitUntil(monitorExit, performance.now() + 1000, "TYPEGEN_MONITOR_FORCE_CLOSE_DEADLINE")
            .then(exit => { receipt.monitorForceClose = { observed: true, ...exit }; }, () => {
              receipt.monitorForceClose = { observed: false };
            });
        });
        receipt.nativeMonitor ??= protocol?.final() ?? null;
      }
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.elapsedMs = performance.now() - started;
    if (failure) receipt.monitorStartupStages = protocol?.startup() ?? [];
    receipt.monitorFinalizationStages = protocol?.finalization() ?? [];
    if (failure) console.error(`VERIDIA_TYPEGEN_FAILURE_FINALIZATION=${JSON.stringify({
      finalizationStages: receipt.monitorFinalizationStages,
      nativeFinalReceived: receipt.monitorFinalizationStages.includes("MONITOR_STDOUT_FINAL_RECEIVED"),
      monitorExitCode: monitor?.exitCode ?? null,
      monitorSignal: monitor?.signalCode ?? null,
    })}`);
  }
  if (failure) { failure.receipt = receipt; failure.exitCode = receipt.exitCode; failure.exitSignal = receipt.exitSignal; throw failure; }
  return receipt;
}
