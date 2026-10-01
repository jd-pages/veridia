/* eslint-disable @typescript-eslint/no-require-imports -- Public Node --require preload is CommonJS. */
"use strict";

// Public fatal-observation hook only: never catch/consume a Next error or alter
// exitCode. The parent alone decides whether diagnostic coverage is complete.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const token = process.env.VERIDIA_BUILD_LOCK_TOKEN;
const nonce = process.env.VERIDIA_BUILD_LOCK_NONCE;
const directory = process.env.VERIDIA_BUILD_LOCK_DIRECTORY;
const target = process.env.VERIDIA_BUILD_LOCK_TARGET;
const entry = process.env.VERIDIA_BUILD_LOCK_ENTRY;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let monitorSha256 = null;
function canonical(value) { return path.resolve(value).replaceAll("\\", "/").toLowerCase(); }
function safe(value) {
  return String(value ?? "").replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, "[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:api[_-]?key|secret|password|passwd|token|authorization|credential|database[_-]?url)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:--?(?:encodedcommand|encodedarguments|eval|command|e|c)|\/(?:c|k))["']?(?:\s+|=|:)).*/gi, "$1[REDACTED_INLINE_PROGRAM]")
    .slice(0, 8192);
}
function fixedFailure() {
  try { fs.writeSync(2, "VERIDIA_BUILD_LOCK_MONITOR_INCOMPLETE\n"); } catch { /* Original fatal behavior remains authoritative. */ }
}
function write(kind, data) {
  try {
    const record = { schemaVersion: 1, kind, invocationId: token, nonce,
      target: path.resolve(target), pid: process.pid, parentPid: process.ppid,
      observedAt: new Date().toISOString(), hrtimeTicks: process.hrtime.bigint().toString(),
      clock: "NODE_HRTIME_EXCEPTION_OBSERVATION_NOT_KERNEL_SYSCALL_TIME", ...data,
      entry: path.resolve(entry), monitorSha256 };
    const encoded = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(encoded) > 32768) throw new Error("MONITOR_CAP");
    const filename = `${kind}-${process.pid}-${crypto.randomUUID()}.json`;
    fs.writeFileSync(path.join(directory, filename), encoded, { flag: "wx" });
  } catch { fixedFailure(); }
}
try {
  // npm's node, lifecycle wrappers, dev/start and unrelated processes are inert.
  if (uuid.test(token ?? "") && uuid.test(nonce ?? "") && directory && target && entry &&
    process.argv[1] && canonical(process.argv[1]) === canonical(entry) && process.argv[2] === "build" &&
    path.basename(target) === "trace") {
    monitorSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
    write("monitor-ready", {});
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      try {
        if (error?.code !== "EBUSY" || typeof error.path !== "string" || canonical(error.path) !== canonical(target)) return;
        write("trace-ebusy", { origin: origin === "unhandledRejection" ? origin : "uncaughtException",
          code: "EBUSY", errno: typeof error.errno === "number" ? error.errno : null,
          syscall: typeof error.syscall === "string" && /^[a-z_]{1,32}$/i.test(error.syscall) ? error.syscall : null,
          message: safe(error.message), physicalStack: safe(error.stack),
          attribution: "OBSERVED_FATAL_TRACE_ERROR_NOT_HISTORICAL_HOLDER_PROOF" });
      } catch { fixedFailure(); }
    });
    process.on("exit", code => { try { write("monitor-exit", { exitCode: code }); } catch { fixedFailure(); } });
  }
} catch { fixedFailure(); }
