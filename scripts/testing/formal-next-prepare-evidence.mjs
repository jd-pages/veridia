import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { NEXT_TRACE_SINGLE_FLIGHT_PATCH } from "./next-trace-single-flight.mjs";

const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const nativeScope = "NATIVE_HANDLE_BIRTH_FENCED_SAMPLED_DESCENDANTS_NOT_EXHAUSTIVE";

export function validateFormalNextPrepareReceipt(receipt, context) {
  const { head, sourceFingerprint, startedAt, now } = context;
  if (!/^[0-9a-f]{40}$/u.test(head || "") || !/^[0-9a-f]{64}$/u.test(sourceFingerprint || "") ||
      !receipt || receipt.schemaVersion !== 1 || receipt.purpose !== "FORMAL_NEXT_PREPARE_LIFECYCLE" || receipt.status !== "PASSED" ||
      receipt.head !== head || receipt.sourceFingerprint !== sourceFingerprint || receipt.sourceFingerprintAfter !== sourceFingerprint ||
      !stamp(startedAt) || !stamp(now) || !stamp(receipt.startedAt) || !stamp(receipt.finishedAt) ||
      Date.parse(receipt.startedAt) < Date.parse(startedAt) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt) ||
      Date.parse(receipt.finishedAt) > Date.parse(now) || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0 ||
      receipt.formalDistDir !== ".next" || !["APPLIED", "ALREADY_PATCHED"].includes(receipt.nextTracePatch?.state) ||
      receipt.nextTracePatch.version !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion || receipt.nextTracePatch.outputSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) {
    throw new Error("FORMAL_NEXT_PREPARE_RECEIPT_IDENTITY_OR_WINDOW_MISMATCH");
  }
  const typegen = receipt.typegen, q = receipt.processQuiescence;
  if (!typegen || typegen.status !== "PASSED" || JSON.stringify(q) !== JSON.stringify(typegen.processQuiescence)) {
    throw new Error("FORMAL_NEXT_PREPARE_TYPEGEN_RECEIPT_UNAVAILABLE");
  }
  if (receipt.execution === "SKIPPED_NOT_NEEDED") {
    if (typegen.execution !== "SKIPPED_NOT_NEEDED" || typegen.executed !== false || typegen.nativeRoot !== null ||
        typegen.exitCode !== null || q?.measurement !== "NOT_RUN" || q.scope !== "NOT_RUN" || q.reason !== "NO_CHILD_LAUNCHED" ||
        q.capturedIdentityCount !== null || q.remainingCapturedIdentityCount !== null) {
      throw new Error("FORMAL_NEXT_PREPARE_SKIP_MUST_NOT_FABRICATE_NATIVE_ZERO");
    }
  } else if (receipt.execution === "EXECUTED") {
    const root = typegen.nativeRoot;
    if (typegen.execution !== "EXECUTED" || typegen.executed !== true || typegen.exitCode !== 0 || typegen.exitSignal !== null ||
        typegen.entry !== "node_modules/next/dist/bin/next" || JSON.stringify(typegen.args) !== '["typegen"]' ||
        typegen.argsSha256 !== sha256('["typegen"]') || !/^[0-9a-f]{64}$/u.test(typegen.entrySha256 || "") ||
        typegen.nativeCapturedBeforeCliRelease !== true || !positive(root?.pid) || !positive(root.parentPid) || root.parentPid !== receipt.creatorPid ||
        !/^[1-9][0-9]+$/u.test(root.nativeStartFileTime || "") || !stamp(root.capturedAt) || !stamp(typegen.cliReleasedAt) ||
        !stamp(typegen.startedAt) || !stamp(typegen.finishedAt) || !stamp(root.createdAt) ||
        Date.parse(typegen.startedAt) < Date.parse(receipt.startedAt) || Date.parse(root.createdAt) < Date.parse(typegen.startedAt) ||
        Date.parse(root.capturedAt) < Date.parse(root.createdAt) || Date.parse(typegen.cliReleasedAt) > Date.parse(typegen.finishedAt) ||
        Date.parse(typegen.finishedAt) > Date.parse(receipt.finishedAt) ||
        Date.parse(root.capturedAt) > Date.parse(typegen.cliReleasedAt) || q?.measurement !== "AVAILABLE" || q.status !== "PASSED" ||
        q.scope !== nativeScope || !positive(q.capturedIdentityCount) || q.remainingCapturedIdentityCount !== 0 || q.exhaustiveProcessTreeClaim !== false) {
      throw new Error("FORMAL_NEXT_PREPARE_EXECUTED_NATIVE_FENCE_INVALID");
    }
  } else throw new Error("FORMAL_NEXT_PREPARE_EXECUTION_UNMEASURED");
  return { status: "PASSED", invocationId: receipt.invocationId, head, sourceFingerprint,
    execution: receipt.execution, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, elapsedMs: receipt.elapsedMs,
    formalDistDir: ".next", nextVersion: receipt.nextTracePatch.version, patchedReporterSha256: receipt.nextTracePatch.outputSha256,
    nativeMeasurement: q.measurement, nativeScope: q.scope, capturedIdentityCount: q.capturedIdentityCount,
    remainingCapturedIdentityCount: q.remainingCapturedIdentityCount };
}

export function readFormalNextPrepareEvidence(output, context) {
  const markers = [...output.matchAll(/^VERIDIA_FORMAL_NEXT_PREPARE=(\{[^\r\n]+\})$/gmu)];
  if (markers.length !== 1) throw new Error("FORMAL_NEXT_PREPARE_EXACT_INVOCATION_UNAVAILABLE");
  const marker = JSON.parse(markers[0][1]);
  if (typeof marker.invocationId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(marker.invocationId) || typeof marker.receiptPath !== "string") {
    throw new Error("FORMAL_NEXT_PREPARE_MARKER_INVALID");
  }
  const expected = path.resolve(context.root, ".playwright", "typegen-lifecycle", marker.invocationId, "receipt.json");
  if (path.resolve(marker.receiptPath) !== expected) throw new Error("FORMAL_NEXT_PREPARE_RECEIPT_PATH_MISMATCH");
  let current = path.resolve(context.root);
  for (const component of path.relative(current, expected).split(path.sep)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("FORMAL_NEXT_PREPARE_RECEIPT_LINK_NOT_ALLOWED");
  }
  const info = fs.lstatSync(expected);
  if (!info.isFile() || info.nlink !== 1) throw new Error("FORMAL_NEXT_PREPARE_RECEIPT_NOT_SINGLE_REGULAR_FILE");
  const bytes = fs.readFileSync(expected), receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt.invocationId !== marker.invocationId || receipt.receiptPath !== expected || receipt.status !== marker.status || receipt.execution !== marker.execution) {
    throw new Error("FORMAL_NEXT_PREPARE_MARKER_RECEIPT_MISMATCH");
  }
  if (receipt.execution === "EXECUTED" && receipt.typegen.entrySha256 !== sha256(fs.readFileSync(path.join(context.root, "node_modules/next/dist/bin/next")))) {
    throw new Error("FORMAL_NEXT_PREPARE_CLI_CHANGED_AFTER_EXECUTION");
  }
  return { ...validateFormalNextPrepareReceipt(receipt, context), receiptPath: expected, receiptSha256: sha256(bytes), receiptSize: bytes.length };
}
