import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFormalNextPrepareEvidence, validateFormalNextPrepareReceipt } from "../../scripts/testing/formal-next-prepare-evidence.mjs";
import { NEXT_TRACE_SINGLE_FLIGHT_PATCH } from "../../scripts/testing/next-trace-single-flight.mjs";

function fixture() {
  const context = { root: process.cwd(), head: "a".repeat(40), sourceFingerprint: "b".repeat(64), startedAt: "2026-10-01T00:00:00.000Z", now: "2026-10-01T00:00:03.000Z" };
  const q = { measurement: "NOT_RUN", reason: "NO_CHILD_LAUNCHED", scope: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null };
  const receipt = { schemaVersion: 1, purpose: "FORMAL_NEXT_PREPARE_LIFECYCLE", status: "PASSED", invocationId: "fixture-owned-prepare",
    head: context.head, sourceFingerprint: context.sourceFingerprint, sourceFingerprintAfter: context.sourceFingerprint,
    startedAt: "2026-10-01T00:00:01.000Z", finishedAt: "2026-10-01T00:00:02.000Z", elapsedMs: 1000, formalDistDir: ".next",
    nextTracePatch: { state: "ALREADY_PATCHED", version: NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion, outputSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 },
    execution: "SKIPPED_NOT_NEEDED", processQuiescence: q,
    typegen: { status: "PASSED", execution: "SKIPPED_NOT_NEEDED", executed: false, nativeRoot: null, exitCode: null, processQuiescence: q } };
  return { context, receipt };
}

describe("same-command formal Next prepare evidence", () => {
  it("keeps explicit skipped measurement NOT_RUN with null counts", () => {
    const { context, receipt } = fixture();
    expect(validateFormalNextPrepareReceipt(receipt, context)).toMatchObject({ status: "PASSED", execution: "SKIPPED_NOT_NEEDED", nativeMeasurement: "NOT_RUN", capturedIdentityCount: null });
  });
  it.each(["head", "sourceFingerprint", "sourceFingerprintAfter", "formalDistDir"])("rejects foreign %s", key => {
    const { context, receipt } = fixture(); Object.assign(receipt, { [key]: "foreign" });
    expect(() => validateFormalNextPrepareReceipt(receipt, context)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it("rejects stale windows and an unverified reporter hash", () => {
    const { context, receipt } = fixture();
    expect(() => validateFormalNextPrepareReceipt(receipt, { ...context, startedAt: context.now })).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
    receipt.nextTracePatch.outputSha256 = "c".repeat(64);
    expect(() => validateFormalNextPrepareReceipt(receipt, context)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it("a skipped typegen cannot invent a zero native process count", () => {
    const { context, receipt } = fixture(); Object.assign(receipt.processQuiescence, { remainingCapturedIdentityCount: 0 });
    expect(() => validateFormalNextPrepareReceipt(receipt, context)).toThrow("SKIP_MUST_NOT_FABRICATE_NATIVE_ZERO");
  });
  it("a skipped typegen requires an explicit no-child reason and measurement scope", () => {
    for (const field of ["reason", "scope"]) {
      const { context, receipt } = fixture(); Reflect.deleteProperty(receipt.processQuiescence, field);
      expect(() => validateFormalNextPrepareReceipt(receipt, context)).toThrow("SKIP_MUST_NOT_FABRICATE_NATIVE_ZERO");
    }
  });
  it("an executed receipt must prove capture before release and real native quiescence", () => {
    const { context, receipt } = fixture();
    const q = { measurement: "AVAILABLE", status: "PASSED", scope: "NATIVE_HANDLE_BIRTH_FENCED_SAMPLED_DESCENDANTS_NOT_EXHAUSTIVE",
      capturedIdentityCount: 1, remainingCapturedIdentityCount: 0, exhaustiveProcessTreeClaim: false };
    const typegen = { status: "PASSED", execution: "EXECUTED", executed: true, exitCode: 0, exitSignal: null,
      startedAt: "2026-10-01T00:00:01.050Z", finishedAt: "2026-10-01T00:00:01.900Z",
      entry: "node_modules/next/dist/bin/next", entrySha256: "c".repeat(64), args: ["typegen"],
      argsSha256: createHash("sha256").update('["typegen"]').digest("hex"), nativeCapturedBeforeCliRelease: true,
      nativeRoot: { pid: 200, parentPid: 100, nativeStartFileTime: "134352894793735696", createdAt: "2026-10-01T00:00:01.0700000Z", capturedAt: "2026-10-01T00:00:01.100Z" },
      cliReleasedAt: "2026-10-01T00:00:01.200Z", processQuiescence: q };
    const executed = { ...receipt, creatorPid: 100, execution: "EXECUTED", typegen, processQuiescence: q };
    expect(validateFormalNextPrepareReceipt(executed, context)).toMatchObject({ status: "PASSED", nativeMeasurement: "AVAILABLE", remainingCapturedIdentityCount: 0 });
    for (const change of [{ nativeCapturedBeforeCliRelease: false }, { exitCode: 7 }, { args: ["build"] }, { argsSha256: "c".repeat(64) }, { startedAt: context.startedAt }, { finishedAt: context.now }]) {
      expect(() => validateFormalNextPrepareReceipt({ ...executed, typegen: { ...typegen, ...change } }, context)).toThrow("EXECUTED_NATIVE_FENCE_INVALID");
    }
    expect(() => validateFormalNextPrepareReceipt({ ...executed, creatorPid: 101 }, context)).toThrow("EXECUTED_NATIVE_FENCE_INVALID");
    typegen.nativeRoot.capturedAt = context.now;
    expect(() => validateFormalNextPrepareReceipt(executed, context)).toThrow("EXECUTED_NATIVE_FENCE_INVALID");
  });
});

function storedFixture() {
  const { context, receipt } = fixture();
  const invocationId = `synthetic-reader-${randomUUID()}`;
  const receiptPath = path.join(context.root, ".playwright", "typegen-lifecycle", invocationId, "receipt.json");
  const stored = { ...receipt, invocationId, receiptPath };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(stored));
  fs.writeFileSync(receiptPath, bytes, { flag: "wx" });
  const marker = `VERIDIA_FORMAL_NEXT_PREPARE=${JSON.stringify({ invocationId, receiptPath, status: stored.status, execution: stored.execution })}`;
  return { context, stored, bytes, marker, receiptPath };
}

describe("formal prepare receipt reader provenance", () => {
  it("reads the exact emitted invocation and hashes its actual bytes", () => {
    const { context, bytes, marker, receiptPath } = storedFixture();
    expect(readFormalNextPrepareEvidence(`normal build output\n${marker}\n`, context)).toMatchObject({
      status: "PASSED", receiptPath, receiptSize: bytes.length,
      receiptSha256: createHash("sha256").update(bytes).digest("hex"), nativeMeasurement: "NOT_RUN"
    });
  });
  it("does not substitute a latest receipt when this command has no unique marker", () => {
    const { context, marker } = storedFixture();
    expect(() => readFormalNextPrepareEvidence("build succeeded\n", context)).toThrow("EXACT_INVOCATION_UNAVAILABLE");
    expect(() => readFormalNextPrepareEvidence(`${marker}\n${marker}`, context)).toThrow("EXACT_INVOCATION_UNAVAILABLE");
  });
  it("rejects a marker pointing outside its exact invocation directory", () => {
    const { context, stored } = storedFixture();
    const output = `VERIDIA_FORMAL_NEXT_PREPARE=${JSON.stringify({ ...stored, receiptPath: path.join(context.root, ".playwright", "typegen-lifecycle", "latest-receipt.json") })}`;
    expect(() => readFormalNextPrepareEvidence(output, context)).toThrow("RECEIPT_PATH_MISMATCH");
  });
  it("rejects receipt bytes that disagree with the emitted execution", () => {
    const { context, marker, stored, receiptPath } = storedFixture();
    fs.writeFileSync(receiptPath, JSON.stringify({ ...stored, execution: "EXECUTED" }));
    expect(() => readFormalNextPrepareEvidence(marker, context)).toThrow("MARKER_RECEIPT_MISMATCH");
  });
  it("rejects a multiply-linked receipt instead of accepting an aliased evidence file", () => {
    const { context, marker, receiptPath } = storedFixture();
    fs.linkSync(receiptPath, path.join(path.dirname(receiptPath), "owned-hardlink.json"));
    expect(() => readFormalNextPrepareEvidence(marker, context)).toThrow("NOT_SINGLE_REGULAR_FILE");
  });
  it("rejects an otherwise valid receipt from a previous command window", () => {
    const { context, marker } = storedFixture();
    expect(() => readFormalNextPrepareEvidence(marker, { ...context, startedAt: context.now })).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
});
