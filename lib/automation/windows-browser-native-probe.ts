import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  NATIVE_PROFILE_PROBE_BINARY_BASE64,
  NATIVE_PROFILE_PROBE_BINARY_BYTES,
  NATIVE_PROFILE_PROBE_BINARY_SHA256,
} from "./windows-browser-native-probe-asset";

// The child independently rechecks the same approved ABI. Unsupported OSes
// retain the strict compatibility implementation; a native failure never falls back.
export function isNativeWindowsProfileProbeSupported(
  platform: string = process.platform,
  architecture: string = process.arch,
  release: string = os.release(),
) {
  return platform === "win32" && architecture === "x64" && /^10\.0\.(?:26100|26200)$/u.test(release);
}

type Asset = { directory: string; file: string; ownerPid: number };
let cached: Asset | undefined;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function invalid(cause?: unknown) {
  const error = new Error("NATIVE_PROFILE_PROBE_ASSET_INVALID") as Error & { code: string };
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  error.code = code && /^(?:EACCES|EPERM|ENOSPC|EIO|ENOENT)$/u.test(code) ? code : "NATIVE_PROFILE_PROBE_ASSET_INVALID";
  return error;
}
function verify(asset: Asset) {
  if (asset.ownerPid !== process.pid || path.dirname(asset.file) !== asset.directory ||
      !path.basename(asset.directory).startsWith(`veridia-native-profile-${process.pid}-`)) throw invalid();
  const directory = lstatSync(asset.directory), file = lstatSync(asset.file);
  const entries = readdirSync(asset.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
      entries.length !== 1 || entries[0] !== path.basename(asset.file) ||
      file.size !== NATIVE_PROFILE_PROBE_BINARY_BYTES || hash(readFileSync(asset.file)) !== NATIVE_PROFILE_PROBE_BINARY_SHA256) throw invalid();
}

// Cache only immutable, hash-verified code bytes, never a process, handle,
// result, profile census or readiness observation. First materialization is
// inside the caller's existing 2000ms absolute budget; there is no prewarm.
export function prepareNativeWindowsProfileProbe() {
  if (!isNativeWindowsProfileProbeSupported()) throw invalid();
  try {
    if (!cached) {
      const bytes = Buffer.from(NATIVE_PROFILE_PROBE_BINARY_BASE64, "base64");
      if (bytes.length !== NATIVE_PROFILE_PROBE_BINARY_BYTES || bytes.subarray(0, 2).toString("ascii") !== "MZ" ||
          hash(bytes) !== NATIVE_PROFILE_PROBE_BINARY_SHA256) throw invalid();
      const directory = mkdtempSync(path.join(os.tmpdir(), `veridia-native-profile-${process.pid}-`));
      const asset = { directory, file: path.join(directory, "veridia-profile-probe.exe"), ownerPid: process.pid };
      writeFileSync(asset.file, bytes, { flag: "wx" }); verify(asset); cached = Object.freeze(asset);
      process.once("exit", () => {
        // No recursive cleanup or unknown path. A changed, linked, busy or
        // unproved file is retained, not deleted or force-replaced.
        try { verify(asset); unlinkSync(asset.file); rmdirSync(asset.directory); } catch { /* retain bounded private asset */ }
      });
    }
    verify(cached);
    return cached.file;
  } catch (cause) { throw invalid(cause); }
}
