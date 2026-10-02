"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
// Executes the current watcher, stopping BEFORE native/lease/RM work. No DB,
// build or application process. stdout is a fixed safe diagnostic projection.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { minimalSafeWindowsNativeEnvironment } = require("../../scripts/testing/windows-native-environment.cjs");
async function main() {
const { redactBuildLockDiagnosticText } = await import("../../scripts/testing/build-lock-diagnostics.mjs");
const root = path.resolve(__dirname, "../.."), id = randomUUID(), invocationId = randomUUID(), nonce = randomUUID();
const directory = path.join(root, ".playwright/build-lock-diagnostics-fixtures", `lab-${id}`, `run-${invocationId}`);
fs.mkdirSync(directory, { recursive: true });
const configuration = path.join(directory, "configuration.json"), supportIdentity = "b".repeat(64);
const configurationValue = { schemaVersion: 1, root, directory, target: path.join(path.dirname(directory), "trace"), invocationId, nonce,
  supportIdentity, creatorPid: process.pid, creatorParentPid: process.ppid, label: "SYNTHETIC_TOOL_VALIDATION", leaseMs: 21000,
  leaseDeadlineUtc: new Date(Date.now() + 21000).toISOString(), readyMs: 15000, graceMs: 300, finalMs: 700,
  intervalMs: 25, maxObservationBytes: 1048576, fixtureMode: "NORMAL" };
const configurationCase = process.argv.find(arg => arg.startsWith("--configuration-case="))?.slice("--configuration-case=".length);
if (configurationCase === "missing-field") delete configurationValue.readyMs;
if (configurationCase === "identity") configurationValue.schemaVersion = 2;
if (configurationCase === "directory") configurationValue.directory = root;
if (configurationCase === "formal") { configurationValue.label = "FORMAL_VERIFY_TRACE"; configurationValue.fixtureMode = "IGNORE_STOP"; }
if (configurationCase === "fixture") configurationValue.target = path.join(root, "unrelated-trace");
if (configurationCase === "label") configurationValue.label = "UNKNOWN_LABEL";
const configurationText = configurationCase === "malformed-json" ? "{invalid" : configurationCase === "object-array" ? "[]" :
  configurationCase === "duplicate-case" ? JSON.stringify(configurationValue).replace('"schemaVersion":1', '"schemaVersion":1,"SchemaVersion":1') : JSON.stringify(configurationValue);
fs.writeFileSync(configuration, configurationText, { flag: "wx" });
const env = process.argv.includes("--legacy") ? { NODE_ENV: "test", SystemRoot: process.env.SystemRoot } : minimalSafeWindowsNativeEnvironment();
const omitted = process.argv.find(arg => arg.startsWith("--omit="))?.slice(7);
// Empty explicitly, otherwise libuv silently re-injects some omitted keys.
if (omitted) env[omitted] = "";
const started = performance.now(), spawnTimestamp = new Date().toISOString();
const child = spawn(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/testing/windows-trace-rm-watcher.ps1"),
    "-Configuration", configuration, "-Role", "Supervisor", "-BootstrapProbe"],
  { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const stages = [], bootstrapStages = [], prefix = "VERIDIA_NATIVE_READY_STAGE=";
let buffer = "", safeStderr = "", errorCode = null, timedOut = false, bootstrapTiming = null;
child.once("spawn", () => stages.push("POWERSHELL_SPAWNED"));
child.once("error", error => { errorCode = error.code ?? "SPAWN_ERROR"; });
child.stderr.on("data", chunk => { safeStderr = redactBuildLockDiagnosticText(safeStderr + String(chunk)); });
child.stdout.on("data", chunk => {
  buffer += String(chunk);
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (line === `VERIDIA_NATIVE_SCRIPT_ENTERED=Supervisor:${child.pid}`) stages.push("SCRIPT_ENTERED");
    const bootstrapPrefix = `VERIDIA_NATIVE_BOOTSTRAP_STAGE=Supervisor:${child.pid}:`;
    const bootstrapStage = line.startsWith(bootstrapPrefix) ? line.slice(bootstrapPrefix.length) : null;
    if (["UTF8_ENCODING_START", "UTF8_ENCODING_READY", "CONFIG_READ_START", "CONFIG_READ_READY", "CONFIG_PARSE_START", "CONFIG_PARSE_READY", "CONFIG_VALIDATE_START", "CONFIG_VALIDATE_READY"].includes(bootstrapStage) && bootstrapStages.length < 8) bootstrapStages.push(bootstrapStage);
    if (line.startsWith(prefix)) {
      let record; try { record = JSON.parse(line.slice(prefix.length)); } catch { continue; }
      if (record.invocationId === invocationId && record.nonce === nonce && record.supportIdentity === supportIdentity &&
        record.pid === child.pid && record.role === "Supervisor" && record.stage === "CONFIG_VALIDATED") {
        stages.push("CONFIG_VALIDATED_RECEIVED");
        bootstrapTiming = record.bootstrapTiming ?? null;
      }
    }
  }
  if (buffer.length > 4096) { buffer = ""; errorCode = "STDOUT_CAP"; }
});
const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 4900);
child.once("close", (code, signal) => {
  clearTimeout(deadline);
  const elapsedMs = performance.now() - started;
  const passed = code === 0 && !errorCode && !timedOut && elapsedMs < 5000 && stages.includes("CONFIG_VALIDATED_RECEIVED");
  process.stdout.write(`${JSON.stringify({ label: "CI_NATIVE_BOOTSTRAP_PROBE", node: process.version, status: passed ? "PASS" : "FAILED",
    environmentKeys: Object.keys(env), omitted: omitted ?? null, stages, bootstrapStages, pid: child.pid ?? null, spawnTimestamp,
    closeObserved: true, code, signal, errorCode, safeStderr: safeStderr || null, elapsedMs,
    bootstrapTiming, failureStage: passed ? null : bootstrapStages.at(-1) ?? stages.at(-1) ?? "POWERSHELL_SPAWN" })}\n`);
  process.exitCode = passed ? 0 : 1;
});
}
main().catch(error => { console.error(JSON.stringify({ label: "CI_NATIVE_BOOTSTRAP_PROBE", status: "FAILED", errorCode: error.code ?? error.name })); process.exitCode = 1; });
