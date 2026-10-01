import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Atomic application uses a wholly virtual filesystem; no test can write the
// project's real node_modules. Fresh-child functional cases only write GUIDs.
const virtual = vi.hoisted(() => ({ files: new Map<string, Buffer>(), redirects: new Map<string, string>(),
  symlinks: new Set<string>(), nlinkMap: new Map<string, number>(), operations: [] as { operation: string; path: string }[],
  renameError: false, unlinkError: false, writeError: false, syncError: false, closeError: false,
  renameFailure: null as Error | null, handleFailure: null as Error | null, target: "", targetReads: 0, driftAtRead: 0 }));
vi.mock("node:fs/promises", () => {
  const error = (code: string) => Object.assign(new Error(code), { code });
  return {
    realpath: async (file: string) => virtual.redirects.get(String(file)) ?? String(file),
    lstat: async (file: string) => ({ isFile: () => virtual.files.has(String(file)),
      isSymbolicLink: () => virtual.symlinks.has(String(file)), nlink: virtual.nlinkMap.get(String(file)) ?? 1, mode: 0o100644 }),
    mkdir: async () => undefined,
    readFile: async (file: string, encoding?: string) => {
      const name = String(file);
      if (name === virtual.target && ++virtual.targetReads === virtual.driftAtRead) virtual.files.set(name, Buffer.from("unknown-concurrent-source"));
      const bytes = virtual.files.get(name);
      if (!bytes) throw error("ENOENT");
      return encoding ? bytes.toString("utf8") : Buffer.from(bytes);
    },
    writeFile: async (file: string, bytes: Buffer | string, options: { flag?: string }) => {
      const name = String(file);
      if (options.flag === "wx" && virtual.files.has(name)) throw error("EEXIST");
      virtual.files.set(name, Buffer.from(bytes)); virtual.operations.push({ operation: "write", path: name });
    },
    open: async (file: string, flags: string) => {
      const name = String(file);
      if (flags !== "wx" || virtual.files.has(name)) throw error("EEXIST");
      virtual.files.set(name, Buffer.alloc(0)); virtual.operations.push({ operation: "open-wx", path: name });
      return { writeFile: async (bytes: Buffer) => {
        if (virtual.writeError) { virtual.handleFailure = error("ENOSPC"); throw virtual.handleFailure; }
        virtual.files.set(name, Buffer.from(bytes));
      }, sync: async () => {
        virtual.operations.push({ operation: "sync", path: name });
        if (virtual.syncError) { virtual.handleFailure = error("EIO"); throw virtual.handleFailure; }
      }, close: async () => {
        virtual.operations.push({ operation: "close", path: name });
        if (virtual.closeError) throw error("EBADF");
      } };
    },
    rename: async (from: string, to: string) => {
      if (virtual.renameError) { virtual.renameFailure = error("EBUSY"); throw virtual.renameFailure; }
      const bytes = virtual.files.get(from);
      if (!bytes) throw error("ENOENT");
      virtual.files.set(to, bytes); virtual.files.delete(from); virtual.operations.push({ operation: "rename", path: to });
    },
    unlink: async (file: string) => {
      virtual.operations.push({ operation: "unlink", path: String(file) });
      if (virtual.unlinkError) throw error("EACCES");
      virtual.files.delete(String(file));
    },
  };
});
import { NEXT_TRACE_SINGLE_FLIGHT_PATCH, applyNextTraceSingleFlight, assertNextTraceSingleFlight,
  readNextTraceSingleFlightStatus, transformNextTraceSingleFlight } from "../../scripts/testing/next-trace-single-flight.mjs";

const project = path.resolve(__dirname, "../..");
const fixture = fs.readFileSync(path.join(project, "tests/fixtures/next-trace-original.cjs"));
const target = path.join(project, "node_modules/next/dist/trace/report/to-json.js");
const packageFile = path.join(project, "node_modules/next/package.json");
const backup = path.join(project, ".playwright/next-trace-single-flight", NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, "original-to-json.js");
const patched = () => transformNextTraceSingleFlight({ version: "16.3.4", source: fixture });
const drainedBlock = "            while(queue.size > 0 || events.length > 0){\n                await Promise.all(queue);\n                if (events.length > 0) {\n                    const evts = events.slice();\n                    events.length = 0;\n                    await reportEvents(evts);\n                }\n            }";
const originalTail = "            if (events.length > 0) {\n                await reportEvents(events);\n                events.length = 0;\n            }";
const initializationOnly = () => Buffer.from(patched().source.toString("utf8").replace(
  drainedBlock, "            await Promise.all(queue);\n" + originalTail));
const queueSnapshotDrainOnly = () => Buffer.from(patched().source.toString("utf8").replace(
  drainedBlock, "            while(queue.size > 0){\n                await Promise.all(queue);\n            }\n" + originalTail));
beforeEach(() => {
  virtual.files.clear(); virtual.redirects.clear(); virtual.symlinks.clear(); virtual.nlinkMap.clear(); virtual.operations.length = 0;
  virtual.renameError = false; virtual.unlinkError = false; virtual.renameFailure = null;
  virtual.writeError = false; virtual.syncError = false; virtual.closeError = false; virtual.handleFailure = null;
  virtual.target = target; virtual.targetReads = 0; virtual.driftAtRead = 0;
  virtual.files.set(packageFile, Buffer.from(JSON.stringify({ name: "next", version: "16.3.4" })));
  virtual.files.set(target, Buffer.from(fixture));
});

describe("pinned Next trace single-flight transform", () => {
  it("matches exact original bytes, produces the pinned replacement, and is idempotent", () => {
    const result = patched();
    expect(result.inputSha256).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256);
    expect(result.outputSha256).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256);
    expect(result.changed).toBe(true);
    const repeat = transformNextTraceSingleFlight({ version: "16.3.4", source: result.source });
    expect(repeat.state).toBe("ALREADY_PATCHED"); expect(repeat.changed).toBe(false);
    expect(repeat.source.equals(result.source)).toBe(true);
  });
  it("upgrades only the known initialization-only bytes to the same exact drained reporter", () => {
    const previous = initializationOnly();
    expect(createHash("sha256").update(previous).digest("hex")).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.initializationOnlySha256);
    const result = transformNextTraceSingleFlight({ version: "16.3.4", source: previous });
    expect(result.inputSha256).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.initializationOnlySha256);
    expect(result.outputSha256).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256);
    expect(result.source.equals(patched().source)).toBe(true);
  });
  it("upgrades the known queue-only drain without trusting unknown partial patches", () => {
    const previous = queueSnapshotDrainOnly();
    expect(createHash("sha256").update(previous).digest("hex")).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.queueSnapshotDrainOnlySha256);
    const result = transformNextTraceSingleFlight({ version: "16.3.4", source: previous });
    expect(result.inputSha256).toBe(NEXT_TRACE_SINGLE_FLIGHT_PATCH.queueSnapshotDrainOnlySha256);
    expect(result.source.equals(patched().source)).toBe(true);
  });
  it.each(["16.3.3", "16.3.5", "", "16.3.4-canary"])("rejects unsupported version %s", (version) => {
    expect(() => transformNextTraceSingleFlight({ version, source: fixture })).toThrow("NEXT_TRACE_PATCH_UNSUPPORTED_VERSION");
  });
  it("rejects unknown original/patched bytes, partial patches and line-ending drift", () => {
    const altered = [Buffer.concat([fixture, Buffer.from("\n")]), Buffer.concat([patched().source, Buffer.from("\n")]),
      Buffer.from(fixture.toString().replace("    let writeStream;\n", "    let writeStream;\n    let writeStreamPromise;\n")),
      Buffer.from(fixture.toString().replaceAll("\n", "\r\n"))];
    for (const source of altered) expect(() => transformNextTraceSingleFlight({ version: "16.3.4", source })).toThrow("NEXT_TRACE_PATCH_UNEXPECTED_SOURCE_HASH");
  });
});

describe("verified target atomic application (virtual filesystem only)", () => {
  it("preserves the known earlier patch in its own immutable directory without replacing pristine history", async () => {
    const previous = initializationOnly();
    const previousBackup = path.join(project, ".playwright/next-trace-single-flight", NEXT_TRACE_SINGLE_FLIGHT_PATCH.initializationOnlySha256, "original-to-json.js");
    virtual.files.set(target, previous);
    virtual.files.set(backup, Buffer.from(fixture));
    const result = await applyNextTraceSingleFlight();
    expect(result.backupPath).toBe(previousBackup);
    expect(virtual.files.get(previousBackup)?.equals(previous)).toBe(true);
    expect(virtual.files.get(backup)?.equals(fixture)).toBe(true);
    expect(virtual.files.get(target)?.equals(patched().source)).toBe(true);
    expect(virtual.operations.filter(row => row.operation === "rename")).toHaveLength(1);
    expect((await applyNextTraceSingleFlight()).state).toBe("ALREADY_PATCHED");
  });
  it("preserves exact original bytes, fsyncs one owned sibling then atomically replaces; repeated apply does not write", async () => {
    await expect(assertNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_REQUIRED");
    const result = await applyNextTraceSingleFlight();
    expect(result.state).toBe("APPLIED"); expect(result.backupPath).toBe(backup);
    expect(result.sourceMapPolicy).toBe("UNMODIFIED_UPSTREAM_MAP_MAY_HAVE_STALE_LINE_MAPPINGS");
    expect(JSON.parse(virtual.files.get(result.auditPath!)!.toString()).sourceMapPolicy).toBe(result.sourceMapPolicy);
    expect(virtual.files.get(backup)?.equals(fixture)).toBe(true);
    expect(virtual.files.get(target)?.equals(patched().source)).toBe(true);
    const operations = [...virtual.operations];
    expect(operations.findIndex((row) => row.operation === "sync")).toBeLessThan(operations.findIndex((row) => row.operation === "rename"));
    expect(operations.filter((row) => row.operation === "rename")).toHaveLength(1);
    expect(operations.filter((row) => row.path === target)).toEqual([{ operation: "rename", path: target }]);
    expect([...virtual.files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
    expect((await applyNextTraceSingleFlight()).state).toBe("ALREADY_PATCHED");
    expect(virtual.operations).toEqual(operations);
    expect(await assertNextTraceSingleFlight()).toMatchObject({ state: "ALREADY_PATCHED", sourceMapPolicy: result.sourceMapPolicy });
  });
  it("reads status without writes and rejects unknown version/hash before writing", async () => {
    expect((await readNextTraceSingleFlightStatus()).state).toBe("PATCH_REQUIRED");
    expect(virtual.operations).toHaveLength(0);
    virtual.files.set(packageFile, Buffer.from(JSON.stringify({ name: "next", version: "16.3.5" })));
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_UNSUPPORTED_VERSION");
    virtual.files.set(packageFile, Buffer.from(JSON.stringify({ name: "next", version: "16.3.4" })));
    virtual.files.set(target, Buffer.from("unknown-source"));
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_UNEXPECTED_SOURCE_HASH");
    expect(virtual.operations).toHaveLength(0);
  });
  it("rejects resolved path escapes and target symlinks", async () => {
    virtual.redirects.set(target, path.join(project, "unrelated-file.js"));
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_TARGET_PATH_MISMATCH");
    virtual.redirects.clear(); virtual.symlinks.add(target);
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_TARGET_NOT_REGULAR_FILE");
    expect(virtual.operations).toHaveLength(0);
  });
  it.each(["hardlink", "symlink", "not-regular"] as const)("rejects package identity %s before writing", async kind => {
    if (kind === "hardlink") virtual.nlinkMap.set(packageFile, 2);
    else if (kind === "symlink") virtual.symlinks.add(packageFile);
    else virtual.files.delete(packageFile);
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_PACKAGE_NOT_OWNED_REGULAR_FILE");
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations).toHaveLength(0);
  });
  it("refuses corrupted backup evidence before target replacement", async () => {
    virtual.files.set(backup, Buffer.from("unknown-backup"));
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_BACKUP_HASH_MISMATCH");
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations).toHaveLength(0);
  });
  it("rejects a hardlinked target before any evidence or dependency write", async () => {
    virtual.nlinkMap.set(target, 2);
    await expect(readNextTraceSingleFlightStatus()).rejects.toThrow("NEXT_TRACE_PATCH_TARGET_HARDLINK_NOT_ALLOWED");
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_TARGET_HARDLINK_NOT_ALLOWED");
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations).toHaveLength(0);
  });
  it("rejects a hardlinked exact-byte backup before creating a sibling or replacing the target", async () => {
    virtual.files.set(backup, Buffer.from(fixture)); virtual.nlinkMap.set(backup, 2);
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_BACKUP_HARDLINK_NOT_ALLOWED");
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.files.get(backup)?.equals(fixture)).toBe(true);
    expect(virtual.operations).toHaveLength(0);
  });
  it("keeps unknown concurrently changed target and removes only its created sibling", async () => {
    virtual.driftAtRead = 2;
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("NEXT_TRACE_PATCH_UNEXPECTED_SOURCE_HASH");
    expect(virtual.files.get(target)?.toString()).toBe("unknown-concurrent-source");
    expect(virtual.operations.filter((row) => row.operation === "rename")).toHaveLength(0);
    expect([...virtual.files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(virtual.files.get(backup)?.equals(fixture)).toBe(true);
  });
  it("propagates atomic rename failure with no retry or original-target mutation", async () => {
    virtual.renameError = true;
    await expect(applyNextTraceSingleFlight()).rejects.toThrow("EBUSY");
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect([...virtual.files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(virtual.operations.filter((row) => row.operation === "open-wx")).toHaveLength(1);
  });
  it("retains the exact primary rename EBUSY when owned temporary cleanup also fails EACCES", async () => {
    virtual.renameError = true; virtual.unlinkError = true;
    const failure = await applyNextTraceSingleFlight().catch(error => error);
    expect(failure).toBe(virtual.renameFailure);
    expect(failure).toMatchObject({ code: "EBUSY", temporaryCleanupFailure: { code: "EACCES" } });
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations.filter((row) => row.operation === "open-wx")).toHaveLength(1);
    expect(virtual.operations.filter((row) => row.operation === "unlink")).toHaveLength(1);
    expect([...virtual.files.keys()].filter(file => file.endsWith(".tmp"))).toHaveLength(1);
  });
  it.each(["write", "sync"] as const)("retains exact %s failure when handle close also fails", async kind => {
    virtual.writeError = kind === "write"; virtual.syncError = kind === "sync"; virtual.closeError = true;
    virtual.unlinkError = kind === "write";
    const failure = await applyNextTraceSingleFlight().catch(error => error);
    expect(failure).toBe(virtual.handleFailure);
    expect(failure).toMatchObject({ code: kind === "write" ? "ENOSPC" : "EIO", temporaryCloseFailure: { code: "EBADF" } });
    if (kind === "write") expect(failure.temporaryCleanupFailure).toMatchObject({ code: "EACCES" });
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations.filter(row => row.operation === "open-wx")).toHaveLength(1);
    expect(virtual.operations.filter(row => row.operation === "close")).toHaveLength(1);
    expect(virtual.operations.filter(row => row.operation === "unlink")).toHaveLength(1);
    expect(virtual.operations.filter(row => row.operation === "rename")).toHaveLength(0);
  });
  it("a close failure without a primary write/sync failure is still fatal", async () => {
    virtual.closeError = true;
    await expect(applyNextTraceSingleFlight()).rejects.toMatchObject({ code: "EBADF" });
    expect(virtual.files.get(target)?.equals(fixture)).toBe(true);
    expect(virtual.operations.filter(row => row.operation === "rename")).toHaveLength(0);
    expect([...virtual.files.keys()].filter(file => file.endsWith(".tmp"))).toHaveLength(0);
  });
});

interface ChildEvidence {
  writerCount: number; mkdirCount: number; flushOpenCount: number;
  atFlush: { flags: string; closed: boolean; ended: boolean; finished: boolean; endCalls: number }[];
  outputs: { count: number; uniqueIds: number; ids: number[]; parseError: string | null }[];
  devFirstFlush?: { closed: boolean; ended: boolean }[];
  fatalErrorIsOriginal?: boolean; passed?: boolean; rejectedFlushes?: number; code?: string;
}
function child(variant: "original" | "patched" | "queue-only", scenario: string, expectedExit = 0): ChildEvidence {
  const scratch = path.join(project, ".playwright", "next-trace-single-flight-tests", randomUUID());
  const result = spawnSync(process.execPath, [path.join(project, "tests/fixtures/next-trace-single-flight-child.cjs"), variant, scenario, scratch],
    { cwd: project, windowsHide: true, timeout: 10000, encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch } });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(expectedExit);
  return JSON.parse(fs.readFileSync(path.join(scratch, "evidence.json"), "utf8")) as ChildEvidence;
}
describe("actual pinned reporter in fresh GUID children", () => {
  it("the earlier queue-only patch loses late tail events and duplicates the original tail", () => {
    const previous = child("queue-only", "tail-flush-drain");
    expect(previous.writerCount).toBe(1); expect(previous.flushOpenCount).toBe(0);
    expect(previous.outputs[0]).toEqual(expect.objectContaining({ count: 111, uniqueIds: 101, parseError: null }));
    expect(previous.outputs[0].ids.filter(id => id >= 101)).toHaveLength(0);
    expect(previous.outputs[0].ids.filter(id => id < 10)).toHaveLength(20);
  });
  it("detaches a tail snapshot and drains a complete batch published while that tail is waiting", () => {
    const fixed = child("patched", "tail-flush-drain");
    expect(fixed.writerCount).toBe(1); expect(fixed.mkdirCount).toBe(1); expect(fixed.flushOpenCount).toBe(0);
    expect(fixed.atFlush).toEqual([expect.objectContaining({ flags: "w", closed: true, ended: true, finished: true, endCalls: 2 })]);
    expect(fixed.outputs[0]).toEqual(expect.objectContaining({ count: 111, uniqueIds: 111, parseError: null }));
    expect([...fixed.outputs[0].ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 111 }, (_, id) => id));
  });
  it("drains batches added during an early flush before end and allows a later flush to settle", () => {
    const fixed = child("patched", "early-flush-drain");
    expect(fixed.writerCount).toBe(1); expect(fixed.mkdirCount).toBe(1); expect(fixed.flushOpenCount).toBe(0);
    expect(fixed.atFlush).toEqual([expect.objectContaining({ flags: "w", closed: true, ended: true, finished: true, endCalls: 2 })]);
    expect(fixed.outputs[0]).toEqual(expect.objectContaining({ count: 4040, uniqueIds: 4040, parseError: null }));
  });
  it.each([["natural-202", 202], ["natural-303", 303], ["natural-44batch", 4444]] as const)("%s closes one writer and retains all unique events", (scenario, count) => {
    const fixed = child("patched", scenario);
    expect(fixed.writerCount).toBe(1); expect(fixed.mkdirCount).toBe(1); expect(fixed.flushOpenCount).toBe(0);
    expect(fixed.atFlush).toEqual([expect.objectContaining({ flags: "w", closed: true, ended: true, finished: true, endCalls: 1 })]);
    expect(fixed.outputs[0]).toEqual(expect.objectContaining({ count, uniqueIds: count, parseError: null }));
  });
  it("the original 44-batch counterexample leaves43 stream owners and loses trace events", () => {
    const original = child("original", "natural-44batch");
    expect(original.writerCount).toBe(44); expect(original.mkdirCount).toBe(44); expect(original.flushOpenCount).toBe(43);
    expect(original.outputs[0].parseError !== null || original.outputs[0].uniqueIds < 4444).toBe(true);
  });
  it("keeps small-batch/filter output contracts", () => {
    const baseline = child("patched", "baseline-100"), filtered = child("patched", "filter");
    expect(baseline.writerCount).toBe(1); expect(baseline.outputs[0].count).toBe(100);
    expect(filtered.outputs[0].count).toBe(101); expect(filtered.outputs[0].ids.every((id) => id % 2 === 0)).toBe(true);
  });
  it("keeps dev append, default flush open, and explicit end closed", () => {
    const fixed = child("patched", "dev-append");
    expect(fixed.writerCount).toBe(1); expect(fixed.atFlush[0].flags).toBe("a");
    expect(fixed.devFirstFlush).toEqual([expect.objectContaining({ closed: false, ended: false })]);
    expect(fixed.flushOpenCount).toBe(0); expect(fixed.outputs[0]).toEqual(expect.objectContaining({ count: 320, uniqueIds: 320, parseError: null }));
  });
  it("preserves dev rotation against the original reporter", () => {
    const original = child("original", "rotation"), fixed = child("patched", "rotation");
    expect(fixed.writerCount).toBe(original.writerCount); expect(fixed.writerCount).toBe(2);
    expect(fixed.flushOpenCount).toBe(0); expect(fixed.atFlush.every((row) => row.flags === "a" && row.closed)).toBe(true);
    expect(fixed.outputs).toEqual(original.outputs); expect(fixed.outputs[0].count).toBe(101);
  });
  it("keeps each reporter's stream and file ownership independent", () => {
    const fixed = child("patched", "instances");
    expect(fixed.writerCount).toBe(2); expect(fixed.mkdirCount).toBe(2); expect(fixed.flushOpenCount).toBe(0);
    expect(fixed.outputs.map((output) => output.count)).toEqual([303, 303]);
    expect(fixed.outputs[0].ids.every((id) => id < 1000)).toBe(true);
    expect(fixed.outputs[1].ids.every((id) => id >= 1000)).toBe(true);
  });
  it.each(["mkdir-error", "open-error"])("%s preserves the original error/fatal outcome without retry", (scenario) => {
    const fixed = child("patched", scenario, 1);
    expect(fixed.fatalErrorIsOriginal).toBe(true); expect(fixed.passed).toBe(true); expect(fixed.mkdirCount).toBe(1);
    if (scenario === "mkdir-error") { expect(fixed.rejectedFlushes).toBe(2); expect(fixed.writerCount).toBe(0); }
    else { expect(fixed.code).toBe("EBUSY"); expect(fixed.writerCount).toBe(1); }
  });
});
