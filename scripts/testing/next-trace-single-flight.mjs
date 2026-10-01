import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next 16.3.4's reporter can initialize multiple production `w` streams while
// concurrent batches await mkdir. A flush must also drain batches added while
// it awaits, before ending their shared stream. Native flags/errors stay intact.
export const NEXT_TRACE_SINGLE_FLIGHT_PATCH = Object.freeze({
  nextVersion: "16.3.4",
  originalSha256: "9711ac078d49e09a2ff690ba3ba2a7d93e24c482afb0567f2b1926de11bf2ead",
  initializationOnlySha256: "dabf751c65b1ac9a53bd1c2753256dfd75ae0a521bbf24e96d6854d0d8a72db2",
  queueSnapshotDrainOnlySha256: "b240b437b3148c7932b78f2f4049bd888eab200f28d0b1d37805604e25b1041b",
  patchedSha256: "a176132168aecbe3423f8f809cf00ea6fe2c0385cefad034e1ee5e0104c90170",
  relativeTarget: "node_modules/next/dist/trace/report/to-json.js",
  // The compiled-file digest/native stack is authoritative; the untouched
  // upstream map is not an exact mapping for the inserted patched lines.
  sourceMapPolicy: "UNMODIFIED_UPSTREAM_MAP_MAY_HAVE_STALE_LINE_MAPPINGS",
});

const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packageRoot = path.join(projectRoot, "node_modules", "next");
const packageFile = path.join(packageRoot, "package.json");
const target = path.join(packageRoot, "dist", "trace", "report", "to-json.js");
const evidenceRoot = path.join(projectRoot, ".playwright", "next-trace-single-flight");
const originalDeclaration = "function createJsonReporter(options) {\n    let writeStream;\n    let batch;";
const patchedDeclaration = "function createJsonReporter(options) {\n    let writeStream;\n    let writeStreamPromise;\n    let batch;";
const originalInitialization = `                if (!writeStream) {
                    await _fs.default.promises.mkdir(distDir, {
                        recursive: true
                    });
                    const file = _path.default.join(distDir, options.filename);
                    const limit = typeof options.sizeLimit === 'function' ? options.sizeLimit(phase) : options.sizeLimit;
                    writeStream = new RotatingWriteStream(file, limit);
                }`;
const patchedInitialization = `                if (!writeStreamPromise) {
                    writeStreamPromise = (async ()=>{
                        await _fs.default.promises.mkdir(distDir, {
                            recursive: true
                        });
                        const file = _path.default.join(distDir, options.filename);
                        const limit = typeof options.sizeLimit === 'function' ? options.sizeLimit(phase) : options.sizeLimit;
                        writeStream = new RotatingWriteStream(file, limit);
                    })();
                }
                await writeStreamPromise;`;
const originalQueueDrain = `            await Promise.all(queue);
            if (events.length > 0) {
                await reportEvents(events);
                events.length = 0;
            }`;
const queueSnapshotDrainOnly = `            while(queue.size > 0){
                await Promise.all(queue);
            }
            if (events.length > 0) {
                await reportEvents(events);
                events.length = 0;
            }`;
const patchedQueueDrain = `            while(queue.size > 0 || events.length > 0){
                await Promise.all(queue);
                if (events.length > 0) {
                    const evts = events.slice();
                    events.length = 0;
                    await reportEvents(evts);
                }
            }`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function reject(code) { throw new Error(code); }
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) reject("NEXT_TRACE_PATCH_ANCHOR_NOT_UNIQUE");
  return source.replace(before, after);
}
function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export function transformNextTraceSingleFlight({ version, source }) {
  if (version !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion) reject("NEXT_TRACE_PATCH_UNSUPPORTED_VERSION");
  const bytes = Buffer.from(source);
  const inputSha256 = sha256(bytes);
  if (inputSha256 === NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) {
    return { state: "ALREADY_PATCHED", changed: false, version, inputSha256, outputSha256: inputSha256, source: bytes };
  }
  if (![NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256, NEXT_TRACE_SINGLE_FLIGHT_PATCH.initializationOnlySha256,
    NEXT_TRACE_SINGLE_FLIGHT_PATCH.queueSnapshotDrainOnlySha256].includes(inputSha256)) {
    reject("NEXT_TRACE_PATCH_UNEXPECTED_SOURCE_HASH");
  }
  let text = bytes.toString("utf8");
  if (inputSha256 === NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256) {
    text = replaceOnce(text, originalDeclaration, patchedDeclaration);
    text = replaceOnce(text, originalInitialization, patchedInitialization);
  }
  text = replaceOnce(text, inputSha256 === NEXT_TRACE_SINGLE_FLIGHT_PATCH.queueSnapshotDrainOnlySha256 ?
    queueSnapshotDrainOnly : originalQueueDrain, patchedQueueDrain);
  const output = Buffer.from(text, "utf8");
  const outputSha256 = sha256(output);
  if (outputSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256) reject("NEXT_TRACE_PATCH_OUTPUT_HASH_MISMATCH");
  return { state: "PATCH_REQUIRED", changed: true, version, inputSha256, outputSha256, source: output };
}

async function readValidatedTarget() {
  const realProject = await realpath(projectRoot);
  const expectedPackage = path.join(realProject, "node_modules", "next");
  const expectedTarget = path.join(expectedPackage, "dist", "trace", "report", "to-json.js");
  if (!samePath(await realpath(packageRoot), expectedPackage) ||
      !samePath(await realpath(packageFile), path.join(expectedPackage, "package.json")) ||
      !samePath(await realpath(target), expectedTarget)) reject("NEXT_TRACE_PATCH_TARGET_PATH_MISMATCH");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) reject("NEXT_TRACE_PATCH_TARGET_NOT_REGULAR_FILE");
  if (stat.nlink !== 1) reject("NEXT_TRACE_PATCH_TARGET_HARDLINK_NOT_ALLOWED");
  const packageStat = await lstat(packageFile);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.nlink !== 1) reject("NEXT_TRACE_PATCH_PACKAGE_NOT_OWNED_REGULAR_FILE");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  if (packageJson.name !== "next") reject("NEXT_TRACE_PATCH_UNEXPECTED_PACKAGE");
  const originalBytes = await readFile(target);
  const transformed = transformNextTraceSingleFlight({ version: packageJson.version, source: originalBytes });
  return { ...transformed, originalBytes, mode: stat.mode, targetPath: target, realProject };
}

export async function readNextTraceSingleFlightStatus() {
  const result = await readValidatedTarget();
  return { state: result.state, version: result.version, targetPath: target, inputSha256: result.inputSha256,
    outputSha256: result.outputSha256, changed: result.changed, sourceMapPolicy: NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy };
}

export async function assertNextTraceSingleFlight() {
  const status = await readNextTraceSingleFlightStatus();
  if (status.state !== "ALREADY_PATCHED") reject("NEXT_TRACE_PATCH_REQUIRED");
  return status;
}

async function preserveOriginal(result) {
  // Each accepted exact input gets its own immutable backup. Never overwrite
  // the pristine upstream backup when upgrading the known initialization patch.
  const directory = path.join(evidenceRoot, result.inputSha256);
  await mkdir(directory, { recursive: true });
  if (!samePath(await realpath(directory), path.join(result.realProject, ".playwright", "next-trace-single-flight", result.inputSha256))) {
    reject("NEXT_TRACE_PATCH_EVIDENCE_PATH_MISMATCH");
  }
  const backupPath = path.join(directory, "original-to-json.js");
  try {
    await writeFile(backupPath, result.originalBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const backupStat = await lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink() || !samePath(await realpath(backupPath), path.join(directory, "original-to-json.js"))) {
    reject("NEXT_TRACE_PATCH_BACKUP_PATH_MISMATCH");
  }
  if (backupStat.nlink !== 1) reject("NEXT_TRACE_PATCH_BACKUP_HARDLINK_NOT_ALLOWED");
  if (sha256(await readFile(backupPath)) !== result.inputSha256) reject("NEXT_TRACE_PATCH_BACKUP_HASH_MISMATCH");
  return { directory, backupPath };
}

export async function applyNextTraceSingleFlight() {
  const initial = await readValidatedTarget();
  if (!initial.changed) return { ...await readNextTraceSingleFlightStatus(), state: "ALREADY_PATCHED", backupPath: null };
  // Preserve exact original bytes before any target replacement. The immutable
  // digest-named backup must itself match; unknown existing evidence fails closed.
  const evidence = await preserveOriginal(initial);
  const temporary = path.join(path.dirname(target), `to-json.js.veridia-single-flight-${randomUUID()}.tmp`);
  let temporaryOwned = false;
  let applicationFailure;
  try {
    const handle = await open(temporary, "wx", initial.mode);
    temporaryOwned = true;
    let writeFailure;
    try { await handle.writeFile(initial.source); await handle.sync(); }
    catch (error) { writeFailure = error; throw error; }
    finally {
      try { await handle.close(); }
      catch (closeFailure) {
        if (!writeFailure) throw closeFailure;
        writeFailure.temporaryCloseFailure = closeFailure;
      }
    }
    // Revalidate package version, resolved path and bytes immediately before
    // atomic replacement. Caller must run this before starting Next processes.
    const current = await readValidatedTarget();
    if (!current.changed) {
      return { state: "ALREADY_PATCHED", changed: false, version: current.version, targetPath: target,
        inputSha256: current.inputSha256, outputSha256: current.outputSha256, backupPath: evidence.backupPath,
        sourceMapPolicy: NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy };
    }
    if (current.inputSha256 !== initial.inputSha256) reject("NEXT_TRACE_PATCH_TARGET_CHANGED");
    await rename(temporary, target);
    temporaryOwned = false;
    const confirmed = await assertNextTraceSingleFlight();
    const auditPath = path.join(evidence.directory, `application-${randomUUID()}.json`);
    await writeFile(auditPath, JSON.stringify({ schemaVersion: 1, appliedAtUtc: new Date().toISOString(),
      version: initial.version, targetPath: target, originalSha256: initial.inputSha256,
      patchedSha256: confirmed.inputSha256, backupPath: evidence.backupPath,
      mechanism: "REPORTER_SINGLE_FLIGHT_INITIALIZATION_AND_PENDING_BATCH_DRAIN_BEFORE_END", retries: 0,
      sourceMapPolicy: NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { state: "APPLIED", changed: true, version: initial.version, targetPath: target,
      inputSha256: initial.inputSha256, outputSha256: confirmed.inputSha256, backupPath: evidence.backupPath, auditPath,
      sourceMapPolicy: NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy };
  } catch (error) {
    applicationFailure = error;
    throw error;
  } finally {
    // Only the explicitly created UUID sibling can be removed. Failure never
    // restores/overwrites an unknown target or starts a retry/build automatically.
    if (temporaryOwned) {
      try { await unlink(temporary); }
      catch (cleanupFailure) {
        if (!applicationFailure) throw cleanupFailure;
        applicationFailure.temporaryCleanupFailure = cleanupFailure;
      }
    }
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const argument = process.argv[2];
  if (process.argv.length > 3 || (argument && argument !== "--check" && argument !== "--apply")) {
    process.stderr.write("Usage: next-trace-single-flight.mjs [--apply|--check]\n");
    process.exitCode = 1;
  } else {
    const operation = argument === "--check" ? assertNextTraceSingleFlight : applyNextTraceSingleFlight;
    operation().then((result) => {
      process.stdout.write(`Next ${result.version} trace single-flight ${result.state}: ${result.outputSha256}\n`);
    }).catch((error) => {
      process.stderr.write(`Next trace single-flight failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
