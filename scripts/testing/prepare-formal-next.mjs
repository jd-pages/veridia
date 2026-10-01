import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { collectSourceFingerprint } from "../source-fingerprint.mjs";
import { cleanupKnownTestNextGeneratedTypes, formalNextTypesNeedGeneration } from "./next-type-isolation.mjs";
import { applyNextTraceSingleFlight } from "./next-trace-single-flight.mjs";
import { runOwnedNodeTypegenCommand, skippedNextTypegenReceipt } from "./next-typegen-lifecycle.mjs";

function readHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40}$/u.test(result.stdout.trim())) {
    throw new Error("FORMAL_NEXT_PREPARE_HEAD_UNAVAILABLE");
  }
  return result.stdout.trim();
}

function safeReceiptDirectory(root, id) {
  const rootInfo = fs.lstatSync(root);
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || normalize(fs.realpathSync(root)) !== normalize(root)) {
    throw new Error("FORMAL_NEXT_RECEIPT_ROOT_UNSAFE");
  }
  const directory = path.join(root, ".playwright", "typegen-lifecycle", id);
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, component);
    if (current === directory || !fs.existsSync(current)) fs.mkdirSync(current);
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("FORMAL_NEXT_RECEIPT_DIRECTORY_UNSAFE");
    }
  }
  return directory;
}

function saveCheckpoint(directory, receipt) {
  // Progress is diagnostic, not an acceptance credential. Never replace an
  // earlier snapshot: a Windows reader may legitimately omit DELETE sharing.
  fs.writeFileSync(path.join(directory, `checkpoint-${randomUUID()}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

function saveReceipt(directory, receipt) {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const unique = path.join(directory, "receipt.json");
  if (fs.existsSync(unique)) {
    throw new Error("FORMAL_NEXT_UNIQUE_RECEIPT_ALREADY_EXISTS");
  }
  // Publish once, synchronously close before emitting the invocation marker.
  // Exclusive creation also rejects a target appearing after the precheck.
  fs.writeFileSync(unique, bytes, { flag: "wx" });
  // latest is a convenience copy only. Formal readers reject its path and use
  // the exact unique invocation; failure to refresh it remains fail-closed.
  const latest = path.join(path.dirname(directory), "latest-receipt.json");
  if (fs.existsSync(latest)) {
    const info = fs.lstatSync(latest);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("FORMAL_NEXT_LATEST_RECEIPT_UNSAFE");
  }
  const latestTemporary = path.join(path.dirname(directory), `latest-${randomUUID()}.tmp`);
  fs.writeFileSync(latestTemporary, bytes, { flag: "wx" });
  fs.renameSync(latestTemporary, latest);
}

export function formalNextPrepareExitCode(error) {
  return Number.isSafeInteger(error?.exitCode) && error.exitCode !== 0 ? error.exitCode : 1;
}

// Dependency arguments make preparation testable without real Next, Prisma,
// tracked next-env mutation or applying a patch to the installed dependency.
export async function prepareFormalNext({ root = process.cwd(), environment = process.env,
  patcher = applyNextTraceSingleFlight, cleanup = cleanupKnownTestNextGeneratedTypes,
  needsGeneration = formalNextTypesNeedGeneration, runTypegen = runOwnedNodeTypegenCommand,
  fingerprint = collectSourceFingerprint, head = readHead, log = value => process.stdout.write(value) } = {}) {
  root = path.resolve(root);
  const id = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const directory = safeReceiptDirectory(root, id);
  const started = performance.now();
  const receipt = { schemaVersion: 1, purpose: "FORMAL_NEXT_PREPARE_LIFECYCLE", invocationId: id,
    receiptPath: path.join(directory, "receipt.json"), status: "RUNNING", execution: "NOT_RUN",
    startedAt: new Date().toISOString(), creatorPid: process.pid, nodeVersion: process.version,
    formalDistDir: ".next", removedOverrideNames: ["VERIDIA_NEXT_DIST_DIR", "VERIDIA_NEXT_TSCONFIG_PATH", "E2E_NEXT_DIST_DIR"] };
  let failure;
  try {
    receipt.head = head(root);
    receipt.sourceFingerprint = fingerprint(root);
    saveCheckpoint(directory, receipt);
    // Every supported npm Build/Typecheck path prepares first, including the
    // no-typegen branch. Idempotent exact-hash apply precedes any Next CLI.
    receipt.nextTracePatch = await patcher();
    if (!["APPLIED", "ALREADY_PATCHED"].includes(receipt.nextTracePatch?.state)) {
      throw new Error("FORMAL_NEXT_TRACE_PATCH_UNCONFIRMED");
    }
    receipt.removedTestTypes = cleanup(root);
    if (receipt.removedTestTypes.length > 0) log(`已隔离 E2E generated types：${receipt.removedTestTypes.join("、")}\n`);
    if (needsGeneration(root)) {
      receipt.execution = "EXECUTED";
      log("正式 Next route types 需要恢复，正在执行 next typegen。\n");
      receipt.typegen = await runTypegen({ root, entry: path.join(root, "node_modules", "next", "dist", "bin", "next"),
        args: ["typegen"], environment,
        onPhase: phase => { receipt.lastPhase = phase; saveCheckpoint(directory, receipt); } });
      if (receipt.typegen.status !== "PASSED" || receipt.typegen.executed !== true ||
        receipt.typegen.nativeCapturedBeforeCliRelease !== true || !receipt.typegen.nativeRoot ||
        !/^[1-9][0-9]+$/u.test(receipt.typegen.nativeRoot.nativeStartFileTime) ||
        receipt.typegen.processQuiescence?.measurement !== "AVAILABLE" || receipt.typegen.processQuiescence?.status !== "PASSED" ||
        !(receipt.typegen.processQuiescence.capturedIdentityCount >= 1) || receipt.typegen.processQuiescence.remainingCapturedIdentityCount !== 0) {
        throw new Error("FORMAL_NEXT_TYPEGEN_RECEIPT_NOT_PASSED");
      }
      if (needsGeneration(root)) throw new Error("next typegen 完成后正式 route types 仍不可用");
    } else {
      receipt.execution = "SKIPPED_NOT_NEEDED";
      receipt.typegen = skippedNextTypegenReceipt();
    }
    receipt.processQuiescence = receipt.typegen.processQuiescence;
    receipt.sourceFingerprintAfter = fingerprint(root);
    if (receipt.sourceFingerprintAfter !== receipt.sourceFingerprint) throw new Error("FORMAL_NEXT_PREPARE_SOURCE_CHANGED");
    receipt.status = "PASSED";
  } catch (error) {
    failure = error;
    receipt.status = "FAILED";
    receipt.failure = error.message;
    if (error.receipt) receipt.typegen = error.receipt;
    error.prepareReceipt = receipt;
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    receipt.elapsedMs = performance.now() - started;
    try { saveReceipt(directory, receipt); }
    catch (error) {
      receipt.status = "FAILED";
      receipt.receiptPersistenceFailure = error.message;
      if (failure) failure.receiptPersistenceFailure = error;
      else { error.prepareReceipt = receipt; throw error; }
    }
    try { log(`VERIDIA_FORMAL_NEXT_PREPARE=${JSON.stringify({ invocationId: id, status: receipt.status,
      execution: receipt.execution, receiptPath: receipt.receiptPath })}\n`); }
    catch (error) {
      if (failure) failure.receiptLogFailure = error;
      else { error.prepareReceipt = receipt; throw error; }
    }
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareFormalNext(); }
  catch (error) {
    // Preserve the original CLI's nonzero status; receipt/cleanup failures do
    // not turn an actual exit 7 into an unrelated top-level Node exit 1.
    process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
    process.exitCode = formalNextPrepareExitCode(error);
  }
}
