import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectSourceFingerprint } from "../source-fingerprint.mjs";
import { captureWindowsRuntime, captureWindowsScopedResiduals, waitForOwnedProcessQuiescence } from "./e2e-server-infrastructure.mjs";

// A same-invocation receipt is a precondition, not a replacement for a fresh
// native process/port/profile observation immediately before the next phase.
export const E2E_OWNERSHIP_SCOPE = "CAPTURED_NATIVE_BIRTH_LINEAGES_WITH_LIVE_PARENT_PERIODIC_OBSERVATION";
const safeCounter = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const birth = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(value) && date(value);
const inside = (parent, target) => {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function validatePostE2eReceipts({ root, receipts, groups, head, sourceFingerprint, startedAt, now }) {
  if (!/^[0-9a-f]{40}$/u.test(head || "") || !/^[0-9a-f]{64}$/u.test(sourceFingerprint || "") ||
      !date(startedAt) || !date(now) || Date.parse(now) < Date.parse(startedAt) ||
      !Array.isArray(groups) || groups.length === 0 || new Set(groups).size !== groups.length ||
      !Array.isArray(receipts) || receipts.length !== groups.length) throw new Error("E2E_QUIESCENCE_CONTEXT_UNAVAILABLE");
  const expectedRoot = path.resolve(root, ".playwright", "e2e-runs");
  const seen = new Set();
  const identities = new Map();
  const ports = [];
  const runDirectories = [];
  for (const receipt of receipts) {
    if (!receipt || receipt.schemaVersion !== 1 || receipt.status !== "PASSED" ||
        receipt.head !== head || receipt.sourceFingerprint !== sourceFingerprint ||
        !groups.includes(receipt.group) || seen.has(receipt.group) || typeof receipt.runId !== "string" ||
        !/^[A-Za-z0-9_-]+$/u.test(receipt.runId) || typeof receipt.runDirectory !== "string" ||
        path.basename(receipt.runDirectory) !== receipt.runId || !inside(expectedRoot, path.resolve(receipt.runDirectory)) ||
        !date(receipt.observedAt) || Date.parse(receipt.observedAt) < Date.parse(startedAt) || Date.parse(receipt.observedAt) > Date.parse(now)) {
      throw new Error("E2E_QUIESCENCE_RECEIPT_IDENTITY_OR_WINDOW_MISMATCH");
    }
    if (receipt.ownershipScope !== E2E_OWNERSHIP_SCOPE || receipt.observation?.status !== "PASSED" ||
        receipt.observation.coverage !== "SAMPLED_NOT_EXHAUSTIVE" ||
        !safeCounter(receipt.observation.sampleCount) || receipt.observation.sampleCount === 0 ||
        !safeCounter(receipt.observation.intervalMs) || receipt.observation.intervalMs === 0 ||
        typeof receipt.observation.maxGapMs !== "number" || !Number.isFinite(receipt.observation.maxGapMs) || receipt.observation.maxGapMs < 0 ||
        receipt.logicalIdleStatus !== "PASSED" || receipt.capturedBeforePhysicalTeardown !== true ||
        receipt.finalOwnedProcessCount !== 0 || receipt.portCount !== 0 || receipt.unknownResidualCount !== 0 ||
        receipt.profilesRemoved !== true || receipt.nextEnvRestored !== true || receipt.typeCleanupPass !== true ||
        !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0 || !Number.isFinite(receipt.deadlineMs) ||
        receipt.deadlineMs <= 0 || receipt.elapsedMs > receipt.deadlineMs) throw new Error("E2E_QUIESCENCE_RECEIPT_CONDITION_FAILED_OR_UNMEASURED");
    if (!Number.isSafeInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535 ||
        !Array.isArray(receipt.allCapturedIdentities) || receipt.allCapturedIdentities.length === 0 ||
        !Array.isArray(receipt.retiredProcessTrees) || receipt.retiredProcessTrees.length === 0) throw new Error("E2E_QUIESCENCE_OWNERSHIP_HISTORY_UNAVAILABLE");
    for (const item of receipt.allCapturedIdentities) {
      if (!item || !Number.isSafeInteger(item.pid) || item.pid <= 0 || !Number.isSafeInteger(item.parentPid) ||
          item.parentPid <= 0 || !birth(item.createdAt) || typeof item.name !== "string" || item.name.length === 0) {
        throw new Error("E2E_QUIESCENCE_NATIVE_BIRTH_IDENTITY_INVALID");
      }
      identities.set(`${item.pid}:${item.createdAt}`, item);
    }
    const captured = new Set(receipt.allCapturedIdentities.map(item => `${item.pid}:${item.createdAt}`));
    for (const tree of receipt.retiredProcessTrees) {
      if (!tree || !Number.isSafeInteger(tree.rootPid) || tree.rootPid <= 0 || tree.ownedProcessCount !== 0 ||
          !date(tree.retiredAt) || Date.parse(tree.retiredAt) < Date.parse(startedAt) || Date.parse(tree.retiredAt) > Date.parse(receipt.observedAt) ||
          !Array.isArray(tree.identities) || !tree.identities.some(item => item.pid === tree.rootPid) ||
          tree.identities.some(item => !captured.has(`${item.pid}:${item.createdAt}`))) throw new Error("E2E_QUIESCENCE_RETIRED_TREE_UNBOUND");
    }
    seen.add(receipt.group); ports.push(receipt.port); runDirectories.push(receipt.runDirectory);
  }
  return { status: "RECEIPTS_VALIDATED_REQUIRES_FRESH_NATIVE_FENCE", ownershipScope: E2E_OWNERSHIP_SCOPE,
    coverage: "SAMPLED_NOT_EXHAUSTIVE", head, sourceFingerprint, groups, runDirectories,
    identities: [...identities.values()], ports: [...new Set(ports)] };
}

export function validateStoredQuiescenceReceipts(input) {
  const validated = validatePostE2eReceipts(input);
  for (const receipt of input.receipts) {
    const file = path.resolve(receipt.runDirectory, "run.json");
    let component = path.resolve(input.root);
    for (const part of path.relative(component, file).split(path.sep)) {
      component = path.join(component, part);
      if (fs.lstatSync(component).isSymbolicLink()) throw new Error("E2E_QUIESCENCE_REPORT_LINK_NOT_ALLOWED");
    }
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.nlink !== 1) throw new Error("E2E_QUIESCENCE_REPORT_NOT_OWNED_REGULAR_FILE");
    const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    if (metadata.runId !== receipt.runId || metadata.isolationGroup !== receipt.group || metadata.cleaned !== true ||
        metadata.cleanupReason !== "completed" || JSON.stringify(metadata.postE2eQuiescence) !== JSON.stringify(receipt)) {
      throw new Error("E2E_QUIESCENCE_STORED_RECEIPT_MISMATCH");
    }
  }
  return validated;
}

// A receipt cannot prove that an orphan has not appeared since cleanup. This
// read-only fence rechecks every retired identity, the actual run ports and
// scoped unknown project/profile processes. It never kills an unknown owner.
export async function enforcePostE2eProcessQuiescence(input, adapters = {}) {
  const platform = adapters.platform ?? process.platform;
  if (platform !== "win32") return { status: "NOT_APPLICABLE", reason: "WINDOWS_NATIVE_FENCE_UNAVAILABLE", ownedProcessCount: null, portCount: null, unknownProcessCount: null };
  const now = adapters.now ?? Date.now;
  const capture = adapters.capture ?? captureWindowsRuntime;
  const scoped = adapters.scoped ?? captureWindowsScopedResiduals;
  const exists = adapters.exists ?? fs.existsSync;
  const wait = adapters.wait ?? waitForOwnedProcessQuiescence;
  const readIdentity = adapters.readIdentity ?? (() => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: input.root, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("E2E_QUIESCENCE_SOURCE_IDENTITY_UNAVAILABLE");
    return { head: result.stdout.trim(), sourceFingerprint: collectSourceFingerprint(input.root) };
  });
  const deadlineMs = input.deadlineMs ?? 30_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new Error("E2E_QUIESCENCE_FENCE_DEADLINE_INVALID");
  const started = now();
  const remaining = () => {
    const budget = deadlineMs - (now() - started);
    if (budget <= 0) throw new Error("E2E_QUIESCENCE_FENCE_DEADLINE_EXHAUSTED");
    return budget;
  };
  const validated = validatePostE2eReceipts(input);
  const assertIdentity = stage => {
    const actual = readIdentity();
    if (actual?.head !== input.head || actual?.sourceFingerprint !== input.sourceFingerprint) throw new Error(`SOURCE_CHANGED_${stage}_BUILD_HANDOFF_FENCE`);
  };
  assertIdentity("BEFORE");
  const ports = [...new Set([3100, ...validated.ports])];
  const profilePaths = validated.runDirectories.flatMap(directory => ["xhs-profile", "douyin-profile"].map(name => path.join(directory, name)));
  const fence = await wait({ identities: validated.identities, requirePortClosed: true, deadlineMs: remaining(),
    capture: () => {
      let processes, wrapperIdentity;
      const listeners = [];
      for (const port of ports) {
        const runtime = capture(port, undefined, Math.min(15_000, remaining()));
        if (!Array.isArray(runtime?.processes) || !Array.isArray(runtime?.ports)) throw new Error("E2E_QUIESCENCE_NATIVE_SNAPSHOT_UNAVAILABLE");
        processes = runtime.processes;
        wrapperIdentity = processes.find(item => item.pid === process.pid);
        if (!wrapperIdentity || !birth(wrapperIdentity.createdAt)) throw new Error("E2E_QUIESCENCE_CURRENT_WRAPPER_UNAVAILABLE");
        listeners.push(...runtime.ports);
      }
      const residuals = scoped({ projectRoot: input.root, profilePaths, identities: validated.identities,
        wrapperIdentity, timeoutMs: Math.min(15_000, remaining()), ports, portListeners: listeners });
      if (residuals?.wrapperIdentityVerified !== true || !Array.isArray(residuals.ownedProcesses) || !Array.isArray(residuals.unknownProcesses)) {
        throw new Error("E2E_QUIESCENCE_SCOPED_SNAPSHOT_UNAVAILABLE");
      }
      if (residuals.unknownProcesses.length) throw new Error("E2E_QUIESCENCE_UNKNOWN_PROJECT_OR_PROFILE_RESIDUAL");
      if (profilePaths.some(profile => exists(profile))) throw new Error("E2E_QUIESCENCE_PROFILE_REAPPEARED_AFTER_CLEANUP");
      remaining();
      return { processes: [...processes, ...residuals.ownedProcesses], ports: listeners };
    } });
  assertIdentity("DURING");
  remaining();
  return { status: "PASSED", ownershipScope: validated.ownershipScope, coverage: validated.coverage,
    head: validated.head, sourceFingerprint: validated.sourceFingerprint, groups: validated.groups,
    observedAt: new Date(now()).toISOString(), capturedIdentityCount: validated.identities.length,
    portsChecked: ports, profileCount: profilePaths.length, ownedProcessCount: 0, portCount: 0, unknownProcessCount: 0,
    observations: fence.observations, elapsedMs: now() - started, deadlineMs };
}
