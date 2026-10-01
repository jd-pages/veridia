/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
// SYNTHETIC_TOOL_VALIDATION only. Never starts Next, Build or a database.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "owned-sleep") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
} else if (process.argv[2] === "build") {
  const error = new Error("SYNTHETIC fatal error; token=DO_NOT_EXPORT_THIS_SECRET");
  error.code = "EBUSY"; error.errno = -4082; error.syscall = "open"; error.path = process.env.VERIDIA_BUILD_LOCK_TARGET;
  throw error;
} else {
  (async () => {
    const { createBuildLockDiagnosticsFixtureController } = await import("../../scripts/testing/build-lock-diagnostics.mjs");
    const id = process.argv[3];
    const controller = createBuildLockDiagnosticsFixtureController({ fixture: { id, policy: { leaseMs: 6000, readyMs: 15000, graceMs: 300, finalMs: 700 } } });
    const session = await controller.begin({ head: "a".repeat(40), sourceFingerprint: "b".repeat(64), environment: { NODE_ENV: "test" } });
    const started = new Date().toISOString();
    // Own fixed-purpose child, not a Node timer: collector must enforce its
    // lease while this controller's Node event loop is synchronously blocked.
    spawnSync(process.execPath, [__filename, "owned-sleep", "6500"], { windowsHide: true, timeout: 8000, env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot } });
    const evidence = await controller.end(session, { buildStatus: 0, buildStartedAt: started, buildEndedAt: new Date().toISOString() });
    const root = path.resolve(__dirname, "../..");
    const proof = JSON.parse(fs.readFileSync(path.join(root, path.dirname(session.receiptRelativePath), "worker-exit-proof.json"), "utf8"));
    process.stdout.write(`${JSON.stringify({ label: "SYNTHETIC_TOOL_VALIDATION", evidence, proof })}\n`);
  })().catch(error => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
