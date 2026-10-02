/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// SYNTHETIC_TOOL_VALIDATION only. Never starts Next, Build or a database.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: wait } = require("node:timers/promises");
const { minimalSafeWindowsNativeEnvironment } = require("../../scripts/testing/windows-native-environment.cjs");
if (process.argv[2] === "owned-sleep") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
} else if (process.argv[2] === "build") {
  const error = new Error("SYNTHETIC fatal error; token=DO_NOT_EXPORT_THIS_SECRET");
  error.code = "EBUSY"; error.errno = -4082; error.syscall = "open"; error.path = process.env.VERIDIA_BUILD_LOCK_TARGET;
  throw error;
} else {
  (async () => {
    const { createBuildLockDiagnosticsFixtureController, createBuildLockReadyObservation } = await import("../../scripts/testing/build-lock-diagnostics.mjs");
    const id = process.argv[3];
    const readyMs = 15000, activeLeaseMs = 6000;
    let injectedStartupDelay = false;
    let guardianObservation;
    const controller = createBuildLockDiagnosticsFixtureController({ fixture: { id, bootstrapDeadlineMs: 5000,
      // The synthetic fixture's absolute lease must include the existing READY
      // budget. The production lease and all test/child timeouts are unchanged.
      policy: { leaseMs: readyMs + activeLeaseMs, readyMs, graceMs: 300, finalMs: 700 } },
      spawnChild: (...args) => {
        if (process.argv[2] === "lease-startup-delay" && !injectedStartupDelay) {
          injectedStartupDelay = true;
          // Controlled counterexample: the old 6s lease expired before READY.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        }
        const child = spawn(...args);
        const role = args[1][args[1].indexOf("-Role") + 1];
        if (role === "Guardian") {
          const cfg = JSON.parse(fs.readFileSync(args[1][args[1].indexOf("-Configuration") + 1], "utf8"));
          guardianObservation = createBuildLockReadyObservation({ ...cfg, role, pid: child.pid, now: () => performance.now() });
          child.stdout.on("data", chunk => guardianObservation.push(chunk));
        }
        return child;
      } });
    const readyStartedMono = process.hrtime.bigint();
    const session = await controller.begin({ head: "a".repeat(40), sourceFingerprint: "b".repeat(64), environment: { NODE_ENV: "test" } });
    const readyDurationMs = Number(process.hrtime.bigint() - readyStartedMono) / 1e6;
    let endedSession = false;
    try {
    const root = path.resolve(__dirname, "../..");
    const directory = path.join(root, path.dirname(session.receiptRelativePath));
    const configuration = JSON.parse(fs.readFileSync(path.join(directory, "configuration.json"), "utf8"));
    const leaseDeadline = Date.parse(configuration.leaseDeadlineUtc);
    // Align the deliberate blocking fault to the original absolute native
    // deadline, not to variable startup latency. This wait is the fixture's
    // measured fault schedule, never a production readiness/cleanup workaround.
    while (Date.now() < leaseDeadline - activeLeaseMs) await wait(leaseDeadline - activeLeaseMs - Date.now());
    const started = new Date().toISOString();
    if (!(Date.parse(started) < leaseDeadline && leaseDeadline - Date.parse(started) <= activeLeaseMs)) throw new Error("FIXTURE_LEASE_WINDOW_ALREADY_EXPIRED");
    // Own fixed-purpose child, not a Node timer: collector must enforce its
    // lease while this controller's Node event loop is synchronously blocked.
    const blocker = spawnSync(process.execPath, [__filename, "owned-sleep", "6500"], { windowsHide: true, timeout: 8000, env: minimalSafeWindowsNativeEnvironment() });
    const ended = new Date().toISOString();
    // Capture the native stop before Node can write its own STOP_SIGNAL.
    const nativeLeaseStop = JSON.parse(fs.readFileSync(path.join(directory, "stop.json"), "utf8"));
    endedSession = true;
    const evidence = await controller.end(session, { buildStatus: blocker.status, buildStartedAt: started, buildEndedAt: ended });
    const proof = JSON.parse(fs.readFileSync(path.join(directory, "worker-exit-proof.json"), "utf8"));
    const worker = JSON.parse(fs.readFileSync(path.join(directory, "worker-summary.json"), "utf8"));
    if (blocker.status !== 0 || Date.parse(ended) < leaseDeadline) throw new Error("FIXTURE_SYNCHRONOUS_BLOCK_DID_NOT_CROSS_LEASE");
    const stages = guardianObservation.snapshot().records.map(record => record.stage);
    const guardianReadPath = Object.fromEntries(["CONTROL_RECORD_READ_START", "CONTROL_RECORD_READ_READY", "CONTROL_RECORD_PARSE_READY", "WORKER_CREATED_OBSERVED", "GUARDIAN_ENROLLED"].map(stage => [stage, stages.includes(stage)]));
    const workerReady = JSON.parse(fs.readFileSync(path.join(directory, "worker-ready.json"), "utf8"));
    process.stdout.write(`${JSON.stringify({ label: "SYNTHETIC_TOOL_VALIDATION", evidence, proof, worker, nativeLeaseStop, guardianReadPath,
      workerReadyIdentityConfirmed: workerReady.pid === proof.pid && workerReady.nativeStartFileTime === proof.nativeStartFileTime && workerReady.firstQueryValid === true,
      leaseWindow: { readyMs, readyDurationMs, activeLeaseMs, leaseDeadlineUtc: configuration.leaseDeadlineUtc, blockStartedAt: started, blockEndedAt: ended, injectedStartupDelayMs: injectedStartupDelay ? 6500 : 0 } })}\n`);
    } finally { if (!endedSession) await controller.end(session); }
  })().catch(error => {
    // Failure-only fixed projection. No raw configuration, environment, command
    // lines or owners. Preserve the primary failure and original exit1.
    const native = error.diagnostics?.native;
    process.stderr.write(`VERIDIA_NATIVE_READY_FAILURE=${JSON.stringify({ label: "SYNTHETIC_TOOL_VALIDATION",
      mode: process.argv[2], fixtureId: process.argv[3], invocationId: error.diagnostics?.invocationId ?? null,
      startup: error.diagnostics?.startupFailure ?? null,
      bootstrap: native ? { supervisor: native.supervisor, guardian: native.guardian } : null,
      close: native ? { workerExitConfirmed: native.workerExitConfirmed, creatorForceStopped: native.creatorForceStopped,
        supervisorCloseObserved: native.supervisor?.actualCloseObserved ?? null, guardianCloseObserved: native.guardian?.actualCloseObserved ?? null } : null })}\n`);
    process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1;
  });
}
