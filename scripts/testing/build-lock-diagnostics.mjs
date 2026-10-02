import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readNextTraceSingleFlightStatus, NEXT_TRACE_SINGLE_FLIGHT_PATCH } from "./next-trace-single-flight.mjs";
// Observability only: a stdout stage notice is never native ownership authority
// and cannot satisfy READY. Unparsed/free-text output is never retained.
export const BUILD_LOCK_READY_STAGES = Object.freeze([
  "CONFIG_VALIDATED", "ADD_TYPE_START", "ADD_TYPE_END", "SELF_BOUND",
  "SUPERVISOR_ENROLLED", "WORKER_SPAWN_START", "WORKER_SPAWN_RETURN", "WORKER_ENROLLED",
  "WAIT_WORKER_CREATED", "WORKER_CREATED_OBSERVED", "GUARDIAN_ENROLLED",
  "FIRST_RM_START", "FIRST_RM_END", "FIRST_METADATA_START", "FIRST_PUBLICATION_END", "WORKER_READY_START"
]);
const prefix = "VERIDIA_NATIVE_READY_STAGE=";
export function createBuildLockReadyObservation({ invocationId, nonce, supportIdentity, role, pid, now }) {
  let buffer = "", exhausted = false;
  const records = [];
  return {
    push(chunk) {
      if (exhausted) return;
      buffer += String(chunk);
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).replace(/\r$/u, ""); buffer = buffer.slice(end + 1);
        if (!line.startsWith(prefix) || line.length > 2048) continue;
        let value; try { value = JSON.parse(line.slice(prefix.length)); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value) ||
          value.invocationId !== invocationId || value.nonce !== nonce || value.supportIdentity !== supportIdentity ||
          !BUILD_LOCK_READY_STAGES.includes(value.stage) || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
          !((value.role === role && value.pid === pid) || (role === "Supervisor" && value.role === "Worker")) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(value.utc ?? "") || !Number.isFinite(Date.parse(value.utc)) ||
          !/^[0-9]+$/u.test(value.qpcTicks ?? "") || !/^[1-9][0-9]*$/u.test(value.qpcFrequency ?? "")) continue;
        if (records.length >= 32) { exhausted = true; buffer = ""; return; }
        let observedMonoMs; try { observedMonoMs = now(); } catch { exhausted = true; buffer = ""; return; }
        if (typeof observedMonoMs !== "number" || !Number.isFinite(observedMonoMs) || observedMonoMs < 0) { exhausted = true; buffer = ""; return; }
        records.push({ role: value.role, pid: value.pid, stage: value.stage, utc: value.utc,
          qpcTicks: value.qpcTicks, qpcFrequency: value.qpcFrequency, observedMonoMs,
          authority: "OWNED_STDOUT_NOTICE_NOT_NATIVE_IDENTITY_OR_READY_PROOF" });
      }
      if (buffer.length > 4096) { exhausted = true; buffer = ""; }
    },
    snapshot() { return { measurement: "OWNED_STDOUT_STAGE_NOTICES", truncated: exhausted, records: records.map(value => ({ ...value })) }; }
  };
}
export function projectBuildLockReadyStartupFailure(value) {
  if (value === null || value === undefined) return null;
  const unavailable = { measurement: "NOT_MEASURED", observedAt: null, elapsedMs: null, readyBudgetMs: null,
    members: null, supervisor: null, guardian: null };
  if (value.measurement !== "PRE_TEARDOWN_OBSERVATION_NOT_CAUSAL_ATTRIBUTION" || !utc(value.observedAt) ||
    !finite(value.elapsedMs) || !positive(value.readyBudgetMs) || !Array.isArray(value.members) || value.members.length !== 4) return unavailable;
  const names = ["supervisor-created.json", "worker-created.json", "guardian-armed.json", "worker-ready.json"];
  if (value.members.some((item, i) => !item || item.name !== names[i] || typeof item.present !== "boolean")) return unavailable;
  const stages = (input, role) => {
    if (input === null) return null;
    if (!input || input.measurement !== "OWNED_STDOUT_STAGE_NOTICES" || typeof input.truncated !== "boolean" ||
      !Array.isArray(input.records) || input.records.length > 32 || input.records.some(item => !item ||
      !([role, ...(role === "Supervisor" ? ["Worker"] : [])].includes(item.role)) || !positive(item.pid) ||
      !BUILD_LOCK_READY_STAGES.includes(item.stage) || !utc(item.utc) || !finite(item.observedMonoMs) ||
      !/^[0-9]+$/u.test(item.qpcTicks ?? "") || !/^[1-9][0-9]*$/u.test(item.qpcFrequency ?? ""))) return { measurement: "NOT_MEASURED", truncated: null, records: null };
    return { measurement: "OWNED_STDOUT_STAGE_NOTICES", truncated: input.truncated,
      records: input.records.map(item => ({ role: item.role, pid: item.pid, stage: item.stage, utc: item.utc,
        qpcTicks: item.qpcTicks, qpcFrequency: item.qpcFrequency, observedMonoMs: item.observedMonoMs,
        authority: "OWNED_STDOUT_NOTICE_NOT_NATIVE_IDENTITY_OR_READY_PROOF" })) };
  };
  return { measurement: "PRE_TEARDOWN_OBSERVATION_NOT_CAUSAL_ATTRIBUTION", observedAt: value.observedAt,
    elapsedMs: value.elapsedMs, readyBudgetMs: value.readyBudgetMs, members: value.members.map(item => ({ name: item.name, present: item.present })),
    supervisor: stages(value.supervisor, "Supervisor"), guardian: stages(value.guardian, "Guardian") };
}

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = data => createHash("sha256").update(data).digest("hex");
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const hash = (value, length = 64) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
const utc = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{4})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessions = new WeakMap();
const nativeNames = ["supervisor-created.json", "worker-created.json", "guardian-armed.json", "worker-ready.json",
  "worker-summary.json", "worker-exit-proof.json", "supervisor-end.json", "guardian-end.json", "worker-end.json", "stop.json", "owners.jsonl"];
export const BUILD_LOCK_DIAGNOSTICS_POLICY = Object.freeze({ leaseMs: 660000, readyMs: 15000, graceMs: 3000,
  finalMs: 1000, intervalMs: 75, maxObservationBytes: 4 * 1024 * 1024, maxMonitorFiles: 128,
  coverage: "RM_RESOURCE_USERS_NOT_ALL_NATIVE_HANDLES_OR_SHARE_ACCESS_OR_CAUSE_PROOF",
  releaseRemoteExport: "NOT_IMPLEMENTED" });

export function redactBuildLockDiagnosticText(value) {
  if (typeof value !== "string") return null;
  return value.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/giu, "[REDACTED]")
    .replace(/(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gu, "[REDACTED]")
    .replace(/(bearer\s+)\S+/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, "$1[REDACTED]@")
    .replace(/((?:api[_-]?key|secret|password|passwd|pwd|token|authorization|credential|database[_-]?url)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:--?(?:encodedcommand|encodedarguments|eval|command|e|c)|\/(?:c|k))["']?(?:\s+|=|:)).*/giu, "$1[REDACTED_INLINE_PROGRAM]")
    .slice(0, 8192);
}
function errorProjection(error) {
  return { name: redactBuildLockDiagnosticText(error?.name) ?? "DiagnosticError",
    code: typeof error?.code === "string" ? redactBuildLockDiagnosticText(error.code) : null,
    message: redactBuildLockDiagnosticText(error?.message ?? String(error)) };
}
function regular(io, filename, limit = 8 * 1024 * 1024) {
  const stat = io.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("DIAGNOSTIC_FILE_IDENTITY_OR_CAP");
  return stat;
}
function bound(io, root, relative, missing = false) {
  if (typeof relative !== "string" || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("DIAGNOSTIC_PATH_INVALID");
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("DIAGNOSTIC_PATH_ESCAPE");
  let cursor = path.resolve(root);
  const rootStat = io.lstatSync(cursor);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || io.realpathSync(cursor) !== cursor) throw new Error("DIAGNOSTIC_ROOT_IDENTITY");
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    if (!io.existsSync(cursor)) { if (missing) continue; throw new Error("DIAGNOSTIC_PATH_MISSING"); }
    const stat = io.lstatSync(cursor);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error("DIAGNOSTIC_PATH_ALIAS");
  }
  return filename;
}
function readJson(io, filename, limit) { regular(io, filename, limit); return JSON.parse(io.readFileSync(filename, "utf8")); }
function memberRecord(io, state, filename) {
  const record = readJson(io, path.join(state.directory, filename));
  if (record.invocationId !== state.invocationId || record.nonce !== state.nonce || record.target !== state.target ||
    record.supportIdentity !== state.supportIdentity || record.label !== state.label || !utc(record.utc) ||
    !/^[0-9]+$/u.test(record.qpcTicks ?? "") || !/^[1-9][0-9]*$/u.test(record.qpcFrequency ?? "")) throw new Error("NATIVE_RECORD_BINDING_INVALID");
  return record;
}
function track(child, now, state, role) {
  const tracker = { child, spawnedAt: new Date().toISOString(), spawnedMono: now(), scriptEntered: false,
    closed: false, closedMono: null, exitCode: null, signal: null, spawnError: null, safeStartupDiagnostic: "" };
  child.once("error", error => { tracker.spawnError = error; });
  child.once("close", (code, signal) => { tracker.closed = true; tracker.closedMono = now(); tracker.exitCode = code; tracker.signal = signal; });
  // Native scripts never forward provider errors/raw commands via normal stdout.
  tracker.stages = createBuildLockReadyObservation({ invocationId: state.invocationId, nonce: state.nonce,
    supportIdentity: state.supportIdentity, role, pid: child.pid, now: () => now() - state.startedMono });
  let entryBuffer = "";
  child.stdout?.on("data", chunk => {
    tracker.stages.push(chunk);
    entryBuffer += String(chunk);
    for (let end = entryBuffer.indexOf("\n"); end >= 0; end = entryBuffer.indexOf("\n")) {
      if (entryBuffer.slice(0, end).replace(/\r$/u, "") === `VERIDIA_NATIVE_SCRIPT_ENTERED=${role}:${child.pid}`) tracker.scriptEntered = true;
      entryBuffer = entryBuffer.slice(end + 1);
    }
    if (entryBuffer.length > 4096) entryBuffer = "";
  });
  child.stdout?.resume();
  child.stderr?.on("data", chunk => { tracker.safeStartupDiagnostic = redactBuildLockDiagnosticText(`${tracker.safeStartupDiagnostic}${String(chunk)}`); });
  return tracker;
}
async function until(predicate, ms, now) {
  const deadline = now() + ms;
  while (now() <= deadline) {
    const matched = predicate(), observed = now();
    if (matched) return observed <= deadline;
    if (observed >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - observed)));
  }
  return false;
}
function compactChild(tracker) { return { pid: tracker.child.pid ?? null, actualCloseObserved: tracker.closed,
  spawnedAt: tracker.spawnedAt, scriptEntered: tracker.scriptEntered,
  configValidatedReceived: tracker.stages.snapshot().records.some(record => record.role !== "Worker" && record.stage === "CONFIG_VALIDATED"),
  exitCode: tracker.exitCode, signal: tracker.signal, spawnError: tracker.spawnError ? errorProjection(tracker.spawnError) : null,
  safeStartupDiagnostic: tracker.safeStartupDiagnostic || null }; }
function validBirth(value) { return typeof value === "string" && /^[1-9][0-9]{15,20}$/u.test(value); }
function assertReady(io, state) {
  const s = memberRecord(io, state, "supervisor-created.json"), w = memberRecord(io, state, "worker-created.json"),
    g = memberRecord(io, state, "guardian-armed.json"), r = memberRecord(io, state, "worker-ready.json");
  if (s.pid !== state.supervisor.child.pid || g.pid !== state.guardian.child.pid || s.parentPid !== process.pid || g.parentPid !== process.pid ||
    w.parentPid !== s.pid || w.supervisorNativeStartFileTime !== s.nativeStartFileTime || w.creatorNativeStartFileTime !== s.creatorNativeStartFileTime ||
    g.supervisorNativeStartFileTime !== s.nativeStartFileTime || g.workerPid !== w.pid || g.workerNativeStartFileTime !== w.nativeStartFileTime ||
    r.pid !== w.pid || r.nativeStartFileTime !== w.nativeStartFileTime || r.parentPid !== s.pid ||
    ![s.nativeStartFileTime, w.nativeStartFileTime, g.nativeStartFileTime, s.creatorNativeStartFileTime].every(validBirth) ||
    g.workerHandleHeld !== true || r.firstQueryValid !== true || r.rmEndResult !== 0 || r.targetFileOpen !== "NEVER" ||
    state.supervisor.closed || state.guardian.closed || state.supervisor.spawnError || state.guardian.spawnError) throw new Error("NATIVE_READINESS_IDENTITY_INCOMPLETE");
  return { supervisor: { pid: s.pid, nativeStartFileTime: s.nativeStartFileTime },
    guardian: { pid: g.pid, nativeStartFileTime: g.nativeStartFileTime }, worker: { pid: w.pid, nativeStartFileTime: w.nativeStartFileTime },
    creatorNode: { pid: process.pid, nativeStartFileTime: s.creatorNativeStartFileTime },
    readyAt: r.utc, targetExistsAtReady: r.targetExistsMetadataOnly, firstQueryValid: true };
}

function createController({ root = moduleRoot, platform = process.platform, io = fs, spawnChild = spawn,
  monotonic = () => Number(process.hrtime.bigint() / 1000000n), fixture = null } = {}) {
  const canonicalRoot = path.resolve(root);
  if (fixture && (!uuid(fixture.id) || canonicalRoot !== moduleRoot)) throw new Error("OWNED_FIXTURE_SCOPE_REQUIRED");
  if (fixture?.bootstrapDeadlineMs !== undefined && (!positive(fixture.bootstrapDeadlineMs) || fixture.bootstrapDeadlineMs > 5000)) throw new Error("FIXTURE_BOOTSTRAP_DIAGNOSTIC_BUDGET_INVALID");
  const policy = fixture ? { ...BUILD_LOCK_DIAGNOSTICS_POLICY, ...fixture.policy } : BUILD_LOCK_DIAGNOSTICS_POLICY;
  if (fixture && (!["NORMAL", "IGNORE_STOP", "STALL_GUARDIAN_AFTER_PROOF", "INVALID_QUERY_SESSION"].includes(fixture.mode ?? "NORMAL") ||
    ![policy.leaseMs, policy.readyMs, policy.graceMs, policy.finalMs].every(value => Number.isSafeInteger(value) && value > 0))) throw new Error("FIXTURE_POLICY_INVALID");
  return {
    async begin({ head, sourceFingerprint, wrapperPath = path.join(canonicalRoot, "scripts/testing/verify.mjs"), environment = process.env } = {}) {
      if (!hash(head, 40) || !hash(sourceFingerprint)) throw new Error("BUILD_DIAGNOSTIC_SOURCE_IDENTITY_INVALID");
      if (!fixture && canonicalRoot !== moduleRoot) throw new Error("BUILD_DIAGNOSTIC_PROJECT_ROOT_INVALID");
      const invocationId = randomUUID(), nonce = randomUUID(), startedAt = new Date().toISOString(), startedMono = monotonic();
      const prefix = fixture ? `.playwright/build-lock-diagnostics-fixtures/lab-${fixture.id}` : ".playwright/build-lock-diagnostics";
      const relativeDirectory = `${prefix}/run-${invocationId}`, receiptRelativePath = `${relativeDirectory}/receipt.json`;
      const directory = bound(io, canonicalRoot, relativeDirectory, true);
      io.mkdirSync(directory, { recursive: true });
      bound(io, canonicalRoot, relativeDirectory);
      const target = fixture ? path.join(canonicalRoot, prefix, "trace") : path.join(canonicalRoot, ".next", "trace");
      const supportPaths = { controller: fileURLToPath(import.meta.url), declaration: path.join(moduleRoot, "scripts/testing/build-lock-diagnostics.d.mts"),
        watcher: path.join(moduleRoot, "scripts/testing/windows-trace-rm-watcher.ps1"), monitor: path.join(moduleRoot, "scripts/testing/build-trace-failure-monitor.cjs"), wrapper: path.resolve(wrapperPath) };
      if (!fixture && supportPaths.wrapper !== path.join(canonicalRoot, "scripts/testing/verify.mjs")) throw new Error("BUILD_WRAPPER_IDENTITY_INVALID");
      const support = Object.fromEntries(Object.entries(supportPaths).map(([key, filename]) => { regular(io, filename); return [key, { relativePath: path.relative(canonicalRoot, filename).replaceAll("\\", "/"), sha256: sha(io.readFileSync(filename)) }]; }));
      const reporter = fixture ? { version: NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion, beginSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256,
        measurement: "SYNTHETIC_PINNED_INPUT_NOT_ACTUAL_DEPENDENCY_PROOF" } : await readNextTraceSingleFlightStatus().then(status => ({ version: status.version, sha256: status.inputSha256, measurement: "ACTUAL_INSTALLED_COMPILED_REPORTER" }));
      if (!fixture) { reporter.beginSha256 = reporter.sha256; delete reporter.sha256; }
      if (!fixture && (reporter.version !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion || ![NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256].includes(reporter.beginSha256))) throw new Error("BUILD_REPORTER_IDENTITY_INVALID");
      const supportIdentity = sha(JSON.stringify({ support, reporter }));
      const state = { root: canonicalRoot, directory, relativeDirectory, receiptRelativePath, invocationId, nonce, head, sourceFingerprint,
        startedAt, startedMono, support, supportIdentity, reporter, target, platform, policy, label: fixture ? "SYNTHETIC_TOOL_VALIDATION" : "FORMAL_VERIFY_TRACE",
        io, monotonic, failures: [], finished: false, ready: null, supervisor: null, guardian: null, forced: false, fixture };
      const session = { status: platform === "win32" ? "READY" : "NOT_APPLICABLE", invocationId, receiptRelativePath, environment: { ...environment } };
      sessions.set(session, state);
      io.writeFileSync(path.join(directory, "configuration.json"), `${JSON.stringify({ schemaVersion: 1, root: canonicalRoot, directory, target, invocationId, nonce, supportIdentity,
        creatorPid: process.pid, creatorParentPid: process.ppid, label: state.label, leaseMs: policy.leaseMs,
        leaseDeadlineUtc: new Date(Date.parse(startedAt) + policy.leaseMs).toISOString(), readyMs: policy.readyMs, graceMs: policy.graceMs, finalMs: policy.finalMs,
        intervalMs: policy.intervalMs, maxObservationBytes: policy.maxObservationBytes, fixtureMode: fixture?.mode ?? "NORMAL" })}\n`, { flag: "wx" });
      if (platform !== "win32") return session;
      try {
        const args = role => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supportPaths.watcher, "-Configuration", path.join(directory, "configuration.json"), "-Role", role];
        const executable = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
        state.supervisor = track(spawnChild(executable, args("Supervisor"), { cwd: canonicalRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }), monotonic, state, "Supervisor");
        state.guardian = track(spawnChild(executable, args("Guardian"), { cwd: canonicalRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }), monotonic, state, "Guardian");
        const ready = await until(() => {
          if (state.supervisor.spawnError || state.guardian.spawnError || state.supervisor.closed || state.guardian.closed) {
            let diagnostic = state.supervisor.safeStartupDiagnostic || state.guardian.safeStartupDiagnostic;
            for (const name of ["worker-summary.json", "supervisor-end.json", "guardian-end.json"]) if (io.existsSync(path.join(directory, name))) {
              const record = memberRecord(io, state, name); diagnostic ||= redactBuildLockDiagnosticText(record.failure);
            }
            throw new Error(`NATIVE_COLLECTOR_EXITED_BEFORE_READY${diagnostic ? `: ${diagnostic}` : ""}`);
          }
          // Synthetic diagnosis only, measured after actual spawn (not the
          // fixture's deliberate pre-spawn fault). Never native READY authority.
          if (fixture?.bootstrapDeadlineMs) for (const tracker of [state.supervisor, state.guardian]) {
            if (monotonic() - tracker.spawnedMono >= fixture.bootstrapDeadlineMs && !compactChild(tracker).configValidatedReceived) {
              throw new Error("NATIVE_BOOTSTRAP_STAGE_TIMEOUT");
            }
          }
          return ["supervisor-created.json", "worker-created.json", "guardian-armed.json", "worker-ready.json"].every(name => io.existsSync(path.join(directory, name)));
        }, Math.max(0, policy.readyMs - (monotonic() - startedMono)), monotonic);
        if (!ready) throw new Error("NATIVE_READY_DEADLINE");
        state.ready = assertReady(io, state);
        if (monotonic() - startedMono > policy.readyMs) throw new Error("NATIVE_ACTUAL_READY_EXCEEDED_DEADLINE");
        const preload = `--require=${JSON.stringify(supportPaths.monitor)}`;
        session.environment = { ...environment, NODE_OPTIONS: [environment.NODE_OPTIONS, preload].filter(Boolean).join(" "),
          VERIDIA_BUILD_LOCK_TOKEN: invocationId, VERIDIA_BUILD_LOCK_NONCE: nonce, VERIDIA_BUILD_LOCK_DIRECTORY: directory,
          VERIDIA_BUILD_LOCK_TARGET: target, VERIDIA_BUILD_LOCK_ENTRY: path.join(canonicalRoot, "node_modules/next/dist/bin/next") };
        return session;
      } catch (error) {
        // Capture before end writes STOP or closes children. Presence alone is
        // not a valid bound native record and is never substituted for READY.
        try { state.startupFailure = { observedAt: new Date().toISOString(), elapsedMs: monotonic() - startedMono,
          readyBudgetMs: policy.readyMs, measurement: "PRE_TEARDOWN_OBSERVATION_NOT_CAUSAL_ATTRIBUTION",
          members: ["supervisor-created.json", "worker-created.json", "guardian-armed.json", "worker-ready.json"].map(name => ({ name, present: io.existsSync(path.join(directory, name)) })),
          supervisor: state.supervisor?.stages.snapshot() ?? null, guardian: state.guardian?.stages.snapshot() ?? null }; }
        catch { state.startupFailure = { measurement: "NOT_MEASURED" }; }
        state.failures.push(errorProjection(error));
        const diagnostics = await this.end(session, { buildStatus: null, buildStartedAt: null, buildEndedAt: null });
        error.diagnostics = diagnostics;
        throw error;
      }
    },
    async end(session, { buildStatus = null, buildStartedAt = null, buildEndedAt = null, buildError = null, monitorIncomplete = false } = {}) {
      const state = sessions.get(session);
      if (!state || state.finished) return { status: "DIAGNOSTICS_INCOMPLETE", invocationId: session?.invocationId ?? null, diagnosticsFailures: [{ name: "DiagnosticError", code: null, message: "UNKNOWN_OR_FINISHED_SESSION" }] };
      state.finished = true;
      const { io: files, monotonic: clock } = state;
      const add = error => state.failures.push(errorProjection(error));
      let summary = null, proof = null, supervisorEnd = null, guardianEnd = null;
      if (state.platform === "win32") {
        try {
          const filename = path.join(state.directory, "stop.json");
          if (!files.existsSync(filename)) files.writeFileSync(filename, `${JSON.stringify({ invocationId: state.invocationId, nonce: state.nonce, target: state.target,
            supportIdentity: state.supportIdentity, label: state.label, event: "stop", reason: "STOP_SIGNAL", utc: new Date().toISOString(),
            qpcTicks: null, qpcFrequency: null, clock: "NODE_CONTROLLER_UTC_NOT_NATIVE_QPC", emitterRole: "Node", emitterPid: process.pid,
            emitterNativeStartFileTime: state.ready?.creatorNode.nativeStartFileTime ?? null })}\n`, { flag: "wx" });
          else memberRecord(files, state, "stop.json");
        } catch (error) { add(error); state.supervisor?.child.stdin?.end(); state.guardian?.child.stdin?.end(); }
        const endDeadline = clock() + state.policy.graceMs + state.policy.finalMs;
        try { await until(() => files.existsSync(path.join(state.directory, "worker-exit-proof.json")), state.policy.graceMs, clock); }
        catch (error) { add(error); }
        const readHeldProof = () => {
          const candidate = memberRecord(files, state, "worker-exit-proof.json"), identity = state.ready?.worker;
          if (!identity || candidate.pid !== identity.pid || candidate.nativeStartFileTime !== identity.nativeStartFileTime ||
            candidate.guardianPid !== state.ready.guardian.pid || candidate.guardianNativeStartFileTime !== state.ready.guardian.nativeStartFileTime ||
            candidate.workerExited !== true || candidate.proof !== "SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED") throw new Error("HELD_WORKER_EXIT_PROOF_INVALID_OR_UNAVAILABLE");
          return candidate;
        };
        if (files.existsSync(path.join(state.directory, "worker-exit-proof.json"))) try { proof = readHeldProof(); } catch (error) { add(error); }
        try { await until(() => (!state.supervisor || state.supervisor.closed) && (!state.guardian || state.guardian.closed), Math.max(0, endDeadline - clock() - Math.min(200, state.policy.finalMs / 2)), clock); }
        catch (error) { add(error); }
        for (const tracker of [state.supervisor, state.guardian].filter(Boolean)) {
          if (!tracker.closed) {
            state.forced = true;
            if (!proof) add(new Error("WORKER_EXIT_UNRESOLVED_BEFORE_BOUNDED_CREATOR_CLOSE"));
            add(new Error("CREATOR_CHILD_CLOSE_DEADLINE_FORCED"));
            try { if (!tracker.child.kill()) add(new Error("CREATOR_HANDLE_TERMINATION_UNCONFIRMED")); } catch (error) { add(error); }
          }
        }
        try { await until(() => (!state.supervisor || state.supervisor.closed) && (!state.guardian || state.guardian.closed), Math.max(0, endDeadline - clock()), clock); }
        catch (error) { add(error); }
        // A failed native close is never green and must not leave a referenced
        // child keeping verify alive for the full independent lease.
        for (const tracker of [state.supervisor, state.guardian].filter(Boolean)) if (!tracker.closed) {
          add(new Error("CREATOR_CHILD_ACTUAL_CLOSE_UNCONFIRMED")); tracker.child.unref();
          tracker.child.stdin?.destroy(); tracker.child.stdout?.destroy(); tracker.child.stderr?.destroy();
        }
        for (const tracker of [state.supervisor, state.guardian].filter(Boolean)) if (tracker.closed && tracker.closedMono > endDeadline) add(new Error("ACTUAL_CREATOR_CLOSE_OBSERVED_AFTER_STOP_DEADLINE"));
        if (!proof && files.existsSync(path.join(state.directory, "worker-exit-proof.json"))) try { proof = readHeldProof(); } catch (error) { add(error); }
        try {
          summary = memberRecord(files, state, "worker-summary.json");
          supervisorEnd = memberRecord(files, state, "supervisor-end.json"); guardianEnd = memberRecord(files, state, "guardian-end.json");
          const identity = state.ready?.worker;
          if (!identity || summary.pid !== identity.pid || summary.nativeStartFileTime !== identity.nativeStartFileTime ||
            proof.pid !== identity.pid || proof.nativeStartFileTime !== identity.nativeStartFileTime || proof.workerExited !== true ||
            proof.guardianPid !== state.ready.guardian.pid || proof.guardianNativeStartFileTime !== state.ready.guardian.nativeStartFileTime ||
            supervisorEnd.pid !== state.ready.supervisor.pid || supervisorEnd.nativeStartFileTime !== state.ready.supervisor.nativeStartFileTime ||
            guardianEnd.pid !== state.ready.guardian.pid || guardianEnd.nativeStartFileTime !== state.ready.guardian.nativeStartFileTime ||
            proof.proof !== "SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED" || proof.forced || proof.reason !== "STOP_SIGNAL" ||
            summary.failure || summary.rmEndResult !== 0 || summary.samples < 1 || summary.rmQueryErrors !== 0 || summary.reason !== "STOP_SIGNAL" ||
            supervisorEnd.failure || supervisorEnd.forced || supervisorEnd.reason !== "STOP_SIGNAL" || guardianEnd.failure || guardianEnd.forced || guardianEnd.reason !== "STOP_SIGNAL" ||
            !state.supervisor.closed || !state.guardian.closed || state.supervisor.exitCode !== 0 || state.guardian.exitCode !== 0) throw new Error("NATIVE_END_OWNERSHIP_OR_CLEANUP_INCOMPLETE");
          if (buildStartedAt !== null && (Date.parse(state.ready.readyAt) > Date.parse(buildStartedAt) || Date.parse(summary.startedAt) > Date.parse(buildStartedAt) || Date.parse(summary.endedAt) < Date.parse(buildEndedAt))) throw new Error("BUILD_WINDOW_NOT_COVERED");
        } catch (error) { add(error); }
        if (clock() - state.startedMono >= state.policy.leaseMs) add(new Error("INDEPENDENT_COLLECTOR_LEASE_EXCEEDED_NOT_BUILD_TIMEOUT"));
      }
      if ((buildStartedAt === null) !== (buildEndedAt === null) || (buildStartedAt !== null && (!utc(buildStartedAt) || !utc(buildEndedAt) || Date.parse(buildStartedAt) < Date.parse(state.startedAt) || Date.parse(buildEndedAt) < Date.parse(buildStartedAt))) ||
        (buildStatus !== null && !Number.isInteger(buildStatus))) add(new Error("BUILD_RESULT_WINDOW_INVALID"));
      const nativeBuild = { status: buildStartedAt === null ? "NOT_RUN" : buildStatus === 0 && !buildError ? "EXIT0" : "FAILED",
        exitStatus: buildStatus, startedAt: buildStartedAt, endedAt: buildEndedAt,
        primaryError: buildError ? { name: redactBuildLockDiagnosticText(buildError.name) ?? null, code: redactBuildLockDiagnosticText(buildError.code) ?? null } : null };
      const failedBuild = nativeBuild.status !== "EXIT0";
      if (!state.fixture && state.platform === "win32" && nativeBuild.status === "NOT_RUN") add(new Error("FORMAL_BUILD_NOT_RUN"));
      if (monitorIncomplete) add(new Error("MONITOR_REPORTED_DIAGNOSTIC_FAILURE"));
      let endReporterSha256 = state.reporter.beginSha256;
      if (!state.fixture) {
        try {
          const current = await readNextTraceSingleFlightStatus(); endReporterSha256 = current.inputSha256;
          if (current.version !== state.reporter.version || ![NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256].includes(endReporterSha256) ||
            (state.reporter.beginSha256 === NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 && endReporterSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) ||
            (!failedBuild && endReporterSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256)) throw new Error("REPORTER_TRANSITION_INVALID");
        } catch (error) { add(error); }
      }
      const base = { schemaVersion: 1, purpose: "FORMAL_BUILD_FAILURE_ONLY_RM_DIAGNOSTICS", invocationId: state.invocationId, nonce: state.nonce,
        head: state.head, sourceFingerprint: state.sourceFingerprint, label: state.label, platform: state.platform, target: state.target,
        status: state.platform !== "win32" ? "NOT_APPLICABLE" : state.failures.length ? "DIAGNOSTICS_INCOMPLETE" : "PASSED",
        startedAt: state.startedAt, endedAt: new Date().toISOString(), ready: state.ready, startupFailure: state.startupFailure ?? null,
        policy: state.policy, support: state.support, supportIdentity: state.supportIdentity, reporter: { ...state.reporter, endSha256: endReporterSha256 }, nativeBuild,
        native: state.platform !== "win32" ? null : { samples: summary?.samples ?? null, ownerStateChanges: summary?.ownerStateChanges ?? null,
          workerStartedAt: summary?.startedAt ?? null, workerEndedAt: summary?.endedAt ?? null, lastQueryEndedAt: summary?.lastQueryEndedAt ?? null,
          rmQueryErrors: summary?.rmQueryErrors ?? null, workerStopReason: summary?.reason ?? null,
          maxGapMs: summary?.maxGapMs ?? null, maxQueryMs: summary?.maxQueryMs ?? null, meanQueryMs: summary?.meanQueryMs ?? null,
          rmEndResult: summary?.rmEndResult ?? null, workerExitConfirmed: proof?.workerExited === true && proof?.proof === "SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED",
          workerForced: proof?.forced ?? null, creatorForceStopped: state.forced,
          supervisor: state.supervisor ? compactChild(state.supervisor) : null, guardian: state.guardian ? compactChild(state.guardian) : null },
        diagnosticsFailures: state.failures, coverage: BUILD_LOCK_DIAGNOSTICS_POLICY.coverage,
        originalIncidentHolder: "NOT_OBSERVED_NO_ATTRIBUTION", releaseRemoteExport: "NOT_IMPLEMENTED", failureMembers: [] };
      try {
        const names = files.readdirSync(state.directory);
        const monitorFiles = names.filter(name => /^(?:monitor-ready|monitor-exit|trace-ebusy)-[1-9][0-9]*-[0-9a-f-]{36}\.json$/u.test(name));
        if (monitorFiles.length > state.policy.maxMonitorFiles) throw new Error("MONITOR_STORAGE_CAP_INCOMPLETE");
        const exactErrors = monitorFiles.filter(name => name.startsWith("trace-ebusy-"));
        if (!state.fixture && state.platform === "win32" && !failedBuild) {
          const ready = monitorFiles.filter(name => name.startsWith("monitor-ready-")), exits = monitorFiles.filter(name => name.startsWith("monitor-exit-"));
          if (ready.length < 1 || ready.length !== exits.length || exactErrors.length > 0) throw new Error("ACTUAL_NEXT_MONITOR_COVERAGE_INCOMPLETE");
          const pids = new Set();
          for (const name of ready) {
            const record = readJson(files, path.join(state.directory, name)); validateMember(record, base, name);
            if (pids.has(record.pid) || record.monitorSha256 !== state.support.monitor.sha256 || record.entry !== path.join(state.root, "node_modules/next/dist/bin/next")) throw new Error("MONITOR_PROCESS_IDENTITY_INVALID");
            pids.add(record.pid);
          }
          for (const name of exits) { const record = readJson(files, path.join(state.directory, name)); validateMember(record, base, name); if (!pids.delete(record.pid) || record.exitCode !== 0) throw new Error("MONITOR_EXIT_INCOMPLETE"); }
          if (pids.size) throw new Error("MONITOR_EXIT_MISSING");
        }
        const retained = failedBuild || state.failures.length > 0 || exactErrors.length > 0;
        if (retained) {
          for (const name of [...nativeNames, ...monitorFiles]) {
            const filename = path.join(state.directory, name);
            if (!files.existsSync(filename)) continue;
            regular(files, filename);
            const bytes = files.readFileSync(filename);
            const records = name.endsWith("jsonl") ? bytes.toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(bytes)];
            for (const record of records) validateMember(record, base, name);
            base.failureMembers.push({ relativePath: `${state.relativeDirectory}/${name}`, sha256: sha(bytes), bytes: bytes.length, kind: name === "owners.jsonl" ? "RM_OWNER_CHANGES" : name.startsWith("trace-ebusy-") ? "EXACT_TRACE_FATAL_OBSERVATION" : "OWNED_LIFECYCLE" });
          }
        }
        base.retention = retained ? "FAILED_EVIDENCE_RETAINED" : "COMPACT_SUCCESS";
        base.status = state.platform !== "win32" ? "NOT_APPLICABLE" : state.failures.length ? "DIAGNOSTICS_INCOMPLETE" : "PASSED";
        const finalLeaseGuard = () => { if (state.platform === "win32" && clock() - state.startedMono >= state.policy.leaseMs) throw new Error("FINALIZATION_EXCEEDED_INDEPENDENT_COLLECTOR_LEASE"); };
        finalLeaseGuard();
        base.endedAt = new Date().toISOString();
        const receipt = path.join(state.directory, "receipt.json"), pending = path.join(state.directory, "compact-pending.json");
        // Durability before any owned cleanup; final admission file is created
        // only afterwards so a cleanup error cannot leave an apparently green
        // final receipt. No prior receipt is overwritten.
        if (!retained) files.writeFileSync(pending, `${JSON.stringify(base)}\n`, { flag: "wx", flush: true });
        if (!retained) for (const name of [...nativeNames, ...monitorFiles, "configuration.json"]) {
          const filename = path.join(state.directory, name);
          if (files.existsSync(filename)) { regular(files, filename); files.unlinkSync(filename); }
        }
        if (!retained) {
          regular(files, pending); if (files.existsSync(receipt)) throw new Error("FINAL_RECEIPT_ALREADY_EXISTS");
          finalLeaseGuard();
          files.renameSync(pending, receipt);
        } else { finalLeaseGuard(); files.writeFileSync(receipt, `${JSON.stringify(base, null, 2)}\n`, { flag: "wx", flush: true }); }
        const receiptSha256 = sha(files.readFileSync(receipt));
        finalLeaseGuard();
        return { ...projectReceipt(base), receiptRelativePath: state.receiptRelativePath, receiptSha256 };
      } catch (error) {
        add(error);
        // No cleanup/retry: preserve all owned evidence and the original Build
        // status even when receipt serialization/storage itself fails.
        return { ...projectReceipt({ ...base, status: "DIAGNOSTICS_INCOMPLETE", diagnosticsFailures: state.failures, retention: "FAILED_EVIDENCE_RETAINED" }),
          receiptRelativePath: state.receiptRelativePath, receiptSha256: null };
      }
    },
    terminateOwnedSupervisor(session) {
      const state = sessions.get(session);
      if (!fixture || !state || state.finished) throw new Error("FIXTURE_OWNERSHIP_REQUIRED");
      state.forced = true; return state.supervisor.child.kill();
    },
    closeOwnedControl(session) {
      const state = sessions.get(session);
      if (!fixture || !state || state.finished) throw new Error("FIXTURE_OWNERSHIP_REQUIRED");
      state.supervisor.child.stdin.end(); state.guardian.child.stdin.end();
    }
  };
}

function validateMember(record, receipt, name) {
  if (!record || record.invocationId !== receipt.invocationId || record.nonce !== receipt.nonce || record.target !== receipt.target ||
    !utc(record.utc ?? record.observedAt)) throw new Error("FAILURE_MEMBER_IDENTITY_INVALID");
  if (!name.startsWith("monitor-") && !name.startsWith("trace-ebusy-") && (record.supportIdentity !== receipt.supportIdentity || record.label !== receipt.label)) throw new Error("FAILURE_MEMBER_SUPPORT_INVALID");
  const timestamp = Date.parse(record.utc ?? record.observedAt);
  if (timestamp < Date.parse(receipt.startedAt) || timestamp > Date.parse(receipt.endedAt)) throw new Error("FAILURE_MEMBER_WINDOW_INVALID");
  if (receipt.ready && !name.startsWith("monitor-") && !name.startsWith("trace-ebusy-")) {
    const expectedRole = name === "owners.jsonl" || ["worker-ready.json", "worker-summary.json", "worker-end.json"].includes(name) ? "Worker" :
      ["guardian-armed.json", "guardian-end.json", "worker-exit-proof.json"].includes(name) ? "Guardian" :
      ["supervisor-created.json", "supervisor-end.json", "worker-created.json"].includes(name) ? "Supervisor" : record.emitterRole;
    const expected = expectedRole === "Node" ? receipt.ready.creatorNode : receipt.ready[expectedRole?.toLowerCase()];
    if (!["Worker", "Guardian", "Supervisor", "Node"].includes(expectedRole) || record.emitterRole !== expectedRole ||
      !expected || record.emitterPid !== expected.pid || record.emitterNativeStartFileTime !== expected.nativeStartFileTime) throw new Error("NATIVE_MEMBER_EMITTER_IDENTITY_INVALID");
    const identity = ["worker-created.json", "worker-ready.json", "worker-summary.json", "worker-end.json", "worker-exit-proof.json"].includes(name) ? receipt.ready.worker :
      name.startsWith("supervisor-") ? receipt.ready.supervisor : name.startsWith("guardian-") ? receipt.ready.guardian : null;
    if (identity && (record.pid !== identity.pid || record.nativeStartFileTime !== identity.nativeStartFileTime)) throw new Error("NATIVE_MEMBER_PROCESS_IDENTITY_INVALID");
    if (name === "worker-exit-proof.json" && (record.guardianPid !== receipt.ready.guardian.pid || record.guardianNativeStartFileTime !== receipt.ready.guardian.nativeStartFileTime)) throw new Error("NATIVE_MEMBER_GUARDIAN_PROOF_INVALID");
  }
  const monitorName = /^(monitor-ready|monitor-exit|trace-ebusy)-([1-9][0-9]*)-[0-9a-f-]{36}\.json$/u.exec(name);
  if (monitorName && (record.kind !== monitorName[1] || record.pid !== Number(monitorName[2]) || !positive(record.parentPid) ||
    record.monitorSha256 !== receipt.support.monitor.sha256 || record.entry !== path.join(path.dirname(path.dirname(receipt.target)), "node_modules/next/dist/bin/next") ||
    record.clock !== "NODE_HRTIME_EXCEPTION_OBSERVATION_NOT_KERNEL_SYSCALL_TIME" || !/^[0-9]+$/u.test(record.hrtimeTicks ?? "") ||
    !utc(receipt.nativeBuild.startedAt) || !utc(receipt.nativeBuild.endedAt) || timestamp < Date.parse(receipt.nativeBuild.startedAt) || timestamp > Date.parse(receipt.nativeBuild.endedAt))) throw new Error("MONITOR_MEMBER_SOURCE_OR_WINDOW_INVALID");
  if (name.startsWith("trace-ebusy-") && (record.code !== "EBUSY" || !positive(record.pid) || record.kind !== "trace-ebusy")) throw new Error("EXACT_TRACE_ERROR_INVALID");
  if (name === "owners.jsonl" && (record.event !== "state-owner-change" || !positive(record.sample) || !Array.isArray(record.holders) ||
    !utc(record.queryStartUtc) || !utc(record.queryEndUtc) || Date.parse(record.queryStartUtc) > Date.parse(record.queryEndUtc) || Date.parse(record.queryEndUtc) > timestamp ||
    !finite(record.queryElapsedMs) || record.rmEndResult !== 0 || !/^[0-9]+$/u.test(record.queryStartQpcTicks ?? "") || !/^[0-9]+$/u.test(record.queryEndQpcTicks ?? ""))) throw new Error("RM_OWNER_SAMPLE_INVALID");
}
function projectIdentity(value) { return value && positive(value.pid) && validBirth(value.nativeStartFileTime) ? { pid: value.pid, nativeStartFileTime: value.nativeStartFileTime } : null; }
function projectReceipt(value) {
  const child = input => input ? { pid: positive(input.pid) ? input.pid : null, actualCloseObserved: input.actualCloseObserved === true,
    spawnedAt: utc(input.spawnedAt) ? input.spawnedAt : null, scriptEntered: input.scriptEntered === true,
    configValidatedReceived: input.configValidatedReceived === true,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null, signal: redactBuildLockDiagnosticText(input.signal), spawnError: input.spawnError ? errorProjection(input.spawnError) : null,
    safeStartupDiagnostic: redactBuildLockDiagnosticText(input.safeStartupDiagnostic) } : null;
  const support = Object.fromEntries(["controller", "declaration", "watcher", "monitor", "wrapper"].map(key => [key, { relativePath: value.support?.[key]?.relativePath, sha256: value.support?.[key]?.sha256 }]));
  return { schemaVersion: 1, status: value.status, invocationId: value.invocationId, head: value.head, sourceFingerprint: value.sourceFingerprint,
    startedAt: value.startedAt, endedAt: value.endedAt, target: value.target, platform: value.platform, label: value.label,
    retention: value.retention, nativeBuild: { status: value.nativeBuild.status, exitStatus: Number.isInteger(value.nativeBuild.exitStatus) ? value.nativeBuild.exitStatus : null,
      startedAt: value.nativeBuild.startedAt, endedAt: value.nativeBuild.endedAt, primaryError: value.nativeBuild.primaryError ? { name: redactBuildLockDiagnosticText(value.nativeBuild.primaryError.name), code: redactBuildLockDiagnosticText(value.nativeBuild.primaryError.code) } : null },
    startupFailure: projectBuildLockReadyStartupFailure(value.startupFailure),
    support, supportIdentity: value.supportIdentity, reporter: { version: value.reporter.version, beginSha256: value.reporter.beginSha256, endSha256: value.reporter.endSha256, measurement: value.reporter.measurement },
    readiness: value.ready ? { worker: projectIdentity(value.ready.worker), supervisor: projectIdentity(value.ready.supervisor), guardian: projectIdentity(value.ready.guardian),
      creatorNode: projectIdentity(value.ready.creatorNode),
      readyAt: value.ready.readyAt, firstQueryValid: value.ready.firstQueryValid, targetExistsAtReady: value.ready.targetExistsAtReady } : null,
    native: value.native ? { samples: count(value.native.samples) ? value.native.samples : null, ownerStateChanges: count(value.native.ownerStateChanges) ? value.native.ownerStateChanges : null,
      workerStartedAt: utc(value.native.workerStartedAt) ? value.native.workerStartedAt : null, workerEndedAt: utc(value.native.workerEndedAt) ? value.native.workerEndedAt : null,
      lastQueryEndedAt: utc(value.native.lastQueryEndedAt) ? value.native.lastQueryEndedAt : null, rmQueryErrors: count(value.native.rmQueryErrors) ? value.native.rmQueryErrors : null,
      workerStopReason: redactBuildLockDiagnosticText(value.native.workerStopReason),
      maxGapMs: finite(value.native.maxGapMs) ? value.native.maxGapMs : null, maxQueryMs: finite(value.native.maxQueryMs) ? value.native.maxQueryMs : null, meanQueryMs: finite(value.native.meanQueryMs) ? value.native.meanQueryMs : null,
      rmEndResult: Number.isInteger(value.native.rmEndResult) ? value.native.rmEndResult : null, workerExitConfirmed: value.native.workerExitConfirmed === true,
      workerForced: typeof value.native.workerForced === "boolean" ? value.native.workerForced : null, creatorForceStopped: value.native.creatorForceStopped === true,
      supervisor: child(value.native.supervisor), guardian: child(value.native.guardian) } : null,
    diagnosticsFailures: value.diagnosticsFailures.map(errorProjection), coverage: BUILD_LOCK_DIAGNOSTICS_POLICY.coverage,
    originalIncidentHolder: "NOT_OBSERVED_NO_ATTRIBUTION", releaseRemoteExport: "NOT_IMPLEMENTED",
    failureMembers: value.failureMembers.map(member => ({ relativePath: member.relativePath, sha256: member.sha256, bytes: member.bytes, kind: member.kind })) };
}
function projectMember(record) {
  const safe = key => redactBuildLockDiagnosticText(record[key]);
  const holder = value => ({ pid: positive(value.pid) ? value.pid : null, nativeStartFileTime: validBirth(value.nativeStartFileTime) ? value.nativeStartFileTime : null,
    nativeFileTimeHigh: count(value.nativeFileTimeHigh) ? value.nativeFileTimeHigh : null, nativeFileTimeLow: count(value.nativeFileTimeLow) ? value.nativeFileTimeLow : null,
    rmName: redactBuildLockDiagnosticText(value.rmName), rmSessionId: count(value.rmSessionId) ? value.rmSessionId : null,
    association: "RM_RESOURCE_USER_NOT_SHARE_ACCESS_OR_CAUSE_PROOF", metadata: { identity: redactBuildLockDiagnosticText(value.metadata?.identity),
      processName: redactBuildLockDiagnosticText(value.metadata?.processName), executablePath: redactBuildLockDiagnosticText(value.metadata?.executablePath),
      sanitizedCommandLine: redactBuildLockDiagnosticText(value.metadata?.sanitizedCommandLine), parentPid: positive(value.metadata?.parentPid) ? value.metadata.parentPid : null,
      sessionId: count(value.metadata?.sessionId) ? value.metadata.sessionId : null, error: redactBuildLockDiagnosticText(value.metadata?.error) } });
  return { event: safe("event"), kind: safe("kind"), utc: record.utc ?? record.observedAt, pid: positive(record.pid) ? record.pid : null,
    nativeStartFileTime: validBirth(record.nativeStartFileTime) ? record.nativeStartFileTime : null,
    parentPid: positive(record.parentPid) ? record.parentPid : null, guardianPid: positive(record.guardianPid) ? record.guardianPid : null,
    emitterRole: safe("emitterRole"), emitterPid: positive(record.emitterPid) ? record.emitterPid : null,
    emitterNativeStartFileTime: validBirth(record.emitterNativeStartFileTime) ? record.emitterNativeStartFileTime : null,
    guardianNativeStartFileTime: validBirth(record.guardianNativeStartFileTime) ? record.guardianNativeStartFileTime : null,
    workerPid: positive(record.workerPid) ? record.workerPid : null, workerNativeStartFileTime: validBirth(record.workerNativeStartFileTime) ? record.workerNativeStartFileTime : null,
    qpcTicks: safe("qpcTicks"), qpcFrequency: safe("qpcFrequency"), hrtimeTicks: safe("hrtimeTicks"),
    queryStartUtc: utc(record.queryStartUtc) ? record.queryStartUtc : null, queryEndUtc: utc(record.queryEndUtc) ? record.queryEndUtc : null,
    queryElapsedMs: finite(record.queryElapsedMs) ? record.queryElapsedMs : null,
    queryStartQpcTicks: safe("queryStartQpcTicks"), queryEndQpcTicks: safe("queryEndQpcTicks"),
    actualPreviousStartIntervalMs: finite(record.actualPreviousStartIntervalMs) ? record.actualPreviousStartIntervalMs : null,
    state: safe("state"), reason: safe("reason"), failure: safe("failure"), forced: typeof record.forced === "boolean" ? record.forced : null,
    workerExited: typeof record.workerExited === "boolean" ? record.workerExited : null,
    code: record.code === "EBUSY" ? "EBUSY" : null, errno: typeof record.errno === "number" ? record.errno : null,
    syscall: safe("syscall"), message: safe("message"), physicalStack: safe("physicalStack"),
    observationTimeMeaning: "CALLBACK_OR_QUERY_OBSERVATION_NOT_KERNEL_SYSCALL_TIME", holders: Array.isArray(record.holders) ? record.holders.map(holder) : [] };
}

const defaultController = createController();
export async function beginBuildLockDiagnostics(options) {
  if (options?.root && path.resolve(options.root) !== moduleRoot) throw new Error("BUILD_DIAGNOSTIC_PROJECT_ROOT_INVALID");
  return defaultController.begin(options);
}
export async function endBuildLockDiagnostics(session, outcome) { return defaultController.end(session, outcome); }
// Only owned lab-GUID paths/explicit synthetic labels may use shorter budgets
// or fault fixtures. This factory cannot redirect a formal target.
export function createBuildLockDiagnosticsFixtureController(options) { return createController({ ...options, root: moduleRoot }); }

export function readBuildLockDiagnosticsEvidence(relativeReceiptPath, { root = moduleRoot, head, sourceFingerprint, startedAt, now } = {}) {
  if (!hash(head, 40) || !hash(sourceFingerprint) || !utc(startedAt) || !utc(now) || Date.parse(now) < Date.parse(startedAt) ||
    !/^\.playwright\/build-lock-diagnostics\/run-[0-9a-f-]{36}\/receipt\.json$/u.test(relativeReceiptPath)) throw new Error("BUILD_DIAGNOSTIC_EVIDENCE_CONTEXT_INVALID");
  const filename = bound(fs, root, relativeReceiptPath); regular(fs, filename);
  const bytes = fs.readFileSync(filename), receipt = JSON.parse(bytes);
  if (receipt.schemaVersion !== 1 || receipt.purpose !== "FORMAL_BUILD_FAILURE_ONLY_RM_DIAGNOSTICS" || !uuid(receipt.invocationId) || !uuid(receipt.nonce) ||
    path.basename(path.dirname(filename)) !== `run-${receipt.invocationId}` || receipt.head !== head || receipt.sourceFingerprint !== sourceFingerprint || receipt.label !== "FORMAL_VERIFY_TRACE" ||
    receipt.target !== path.join(path.resolve(root), ".next", "trace") || !utc(receipt.startedAt) || !utc(receipt.endedAt) || Date.parse(receipt.startedAt) < Date.parse(startedAt) || Date.parse(receipt.endedAt) > Date.parse(now) ||
    !["PASSED", "DIAGNOSTICS_INCOMPLETE", "NOT_APPLICABLE"].includes(receipt.status) || !Array.isArray(receipt.failureMembers) || !Array.isArray(receipt.diagnosticsFailures)) throw new Error("BUILD_DIAGNOSTIC_RECEIPT_IDENTITY_INVALID");
  const keys = ["controller", "declaration", "watcher", "monitor", "wrapper"];
  if (Object.keys(receipt.support ?? {}).sort().join() !== keys.sort().join()) throw new Error("DIAGNOSTIC_SUPPORT_SET_INVALID");
  const expectedPaths = { controller: "scripts/testing/build-lock-diagnostics.mjs", declaration: "scripts/testing/build-lock-diagnostics.d.mts",
    watcher: "scripts/testing/windows-trace-rm-watcher.ps1", monitor: "scripts/testing/build-trace-failure-monitor.cjs", wrapper: "scripts/testing/verify.mjs" };
  for (const key of keys) { const item = receipt.support[key]; if (item?.relativePath !== expectedPaths[key]) throw new Error("DIAGNOSTIC_SUPPORT_PATH_NOT_ALLOWED"); const source = bound(fs, root, item.relativePath); regular(fs, source); if (!hash(item.sha256) || sha(fs.readFileSync(source)) !== item.sha256) throw new Error("DIAGNOSTIC_SUPPORT_SOURCE_CHANGED"); }
  const beginReporter = { version: receipt.reporter?.version, beginSha256: receipt.reporter?.beginSha256, measurement: receipt.reporter?.measurement };
  if (sha(JSON.stringify({ support: receipt.support, reporter: beginReporter })) !== receipt.supportIdentity || receipt.reporter?.version !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion ||
    ![NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256].includes(receipt.reporter?.beginSha256) ||
    ![NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256].includes(receipt.reporter?.endSha256) ||
    (receipt.reporter?.beginSha256 === NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 && receipt.reporter?.endSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) ||
    (receipt.nativeBuild?.status === "EXIT0" && receipt.reporter?.endSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) ||
    receipt.reporter?.measurement !== "ACTUAL_INSTALLED_COMPILED_REPORTER") throw new Error("DIAGNOSTIC_SUPPORT_OR_REPORTER_IDENTITY_INVALID");
  const validPolicy = Object.keys(BUILD_LOCK_DIAGNOSTICS_POLICY).every(key => receipt.policy?.[key] === BUILD_LOCK_DIAGNOSTICS_POLICY[key]) && Object.keys(receipt.policy ?? {}).length === Object.keys(BUILD_LOCK_DIAGNOSTICS_POLICY).length;
  const nativeBuildOutcomeValid = (receipt.nativeBuild?.status === "EXIT0" && receipt.nativeBuild.exitStatus === 0 && receipt.nativeBuild.primaryError === null) ||
    (receipt.nativeBuild?.status === "FAILED" && receipt.retention === "FAILED_EVIDENCE_RETAINED" && (receipt.nativeBuild.exitStatus !== 0 || receipt.nativeBuild.primaryError !== null));
  const validBuildWindow = nativeBuildOutcomeValid &&
    utc(receipt.nativeBuild.startedAt) && utc(receipt.nativeBuild.endedAt) && utc(receipt.ready?.readyAt) &&
    utc(receipt.native?.workerStartedAt) && utc(receipt.native?.workerEndedAt) && utc(receipt.native?.lastQueryEndedAt) &&
    Date.parse(receipt.startedAt) <= Date.parse(receipt.ready.readyAt) && Date.parse(receipt.ready.readyAt) <= Date.parse(receipt.nativeBuild.startedAt) &&
    Date.parse(receipt.native.workerStartedAt) <= Date.parse(receipt.nativeBuild.startedAt) && Date.parse(receipt.nativeBuild.startedAt) <= Date.parse(receipt.nativeBuild.endedAt) &&
    Date.parse(receipt.nativeBuild.endedAt) <= Date.parse(receipt.native.workerEndedAt) && Date.parse(receipt.native.workerEndedAt) <= Date.parse(receipt.endedAt) &&
    Date.parse(receipt.native.workerStartedAt) <= Date.parse(receipt.native.lastQueryEndedAt) && Date.parse(receipt.native.lastQueryEndedAt) <= Date.parse(receipt.native.workerEndedAt) &&
    Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt) < BUILD_LOCK_DIAGNOSTICS_POLICY.leaseMs &&
    Date.parse(receipt.ready.readyAt) - Date.parse(receipt.startedAt) <= BUILD_LOCK_DIAGNOSTICS_POLICY.readyMs;
  if (!validPolicy) throw new Error("DIAGNOSTIC_POLICY_IDENTITY_INVALID");
  if (receipt.status === "PASSED" && (receipt.platform !== "win32" || receipt.diagnosticsFailures.length !== 0 || !receipt.ready?.firstQueryValid || !validBuildWindow ||
    !projectIdentity(receipt.ready.worker) || !projectIdentity(receipt.ready.guardian) || !projectIdentity(receipt.ready.supervisor) || !projectIdentity(receipt.ready.creatorNode) ||
    receipt.native?.workerExitConfirmed !== true || receipt.native?.workerForced !== false || receipt.native?.creatorForceStopped !== false ||
    receipt.native?.rmEndResult !== 0 || receipt.native?.rmQueryErrors !== 0 || receipt.native?.workerStopReason !== "STOP_SIGNAL" || !positive(receipt.native.samples) || !receipt.native.supervisor?.actualCloseObserved || !receipt.native.guardian?.actualCloseObserved ||
    receipt.native.supervisor.exitCode !== 0 || receipt.native.guardian.exitCode !== 0 ||
    receipt.native.supervisor.pid !== receipt.ready.supervisor.pid || receipt.native.guardian.pid !== receipt.ready.guardian.pid)) throw new Error("DIAGNOSTIC_SEMANTIC_PASS_INVALID");
  if (receipt.status === "NOT_APPLICABLE" && (receipt.platform === "win32" || receipt.native !== null || receipt.ready !== null)) throw new Error("DIAGNOSTIC_NOT_APPLICABLE_INVALID");
  const seen = new Set(), failureMembers = [];
  for (const member of receipt.failureMembers) {
    if (seen.has(member.relativePath) || path.posix.dirname(member.relativePath) !== path.posix.dirname(relativeReceiptPath) ||
      !hash(member.sha256) || !count(member.bytes) || !["RM_OWNER_CHANGES", "EXACT_TRACE_FATAL_OBSERVATION", "OWNED_LIFECYCLE"].includes(member.kind)) throw new Error("DIAGNOSTIC_MEMBER_MANIFEST_INVALID");
    seen.add(member.relativePath); const source = bound(fs, root, member.relativePath); regular(fs, source);
    const data = fs.readFileSync(source); if (sha(data) !== member.sha256 || data.length !== member.bytes) throw new Error("DIAGNOSTIC_MEMBER_CONTENT_CHANGED");
    const name = path.basename(source); if (!nativeNames.includes(name) && !/^(?:monitor-ready|monitor-exit|trace-ebusy)-[1-9][0-9]*-[0-9a-f-]{36}\.json$/u.test(name)) throw new Error("DIAGNOSTIC_MEMBER_NAME_INVALID");
    const expectedKind = name === "owners.jsonl" ? "RM_OWNER_CHANGES" : name.startsWith("trace-ebusy-") ? "EXACT_TRACE_FATAL_OBSERVATION" : "OWNED_LIFECYCLE";
    if (member.kind !== expectedKind) throw new Error("DIAGNOSTIC_MEMBER_KIND_MISMATCH");
    const records = name.endsWith("jsonl") ? data.toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(data)];
    records.forEach(record => validateMember(record, receipt, name));
    failureMembers.push({ source: { relativePath: member.relativePath, sha256: member.sha256, bytes: member.bytes }, kind: member.kind, records: records.map(projectMember) });
  }
  return { evidence: projectReceipt(receipt), failureMembers, source: { relativePath: relativeReceiptPath, sha256: sha(bytes), bytes: bytes.length } };
}
