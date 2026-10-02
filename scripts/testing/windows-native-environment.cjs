"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const fs = require("node:fs");
// Synthetic native tools only. Never inherit secrets, CI tokens, NODE_OPTIONS,
// application/DB settings, or a caller's executable search path.
const MINIMAL_SAFE_WINDOWS_NATIVE_ENV = Object.freeze(["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "PATHEXT"]);
// Node 22.19.0 deps/uv/src/win/process.c make_program_env automatically copies
// these "required" keys from the parent when absent. Explicit empty values
// prevent that implicit inheritance; callers always use absolute executables.
const WINDOWS_NATIVE_BLOCKED_DEFAULTS = Object.freeze(["PATH", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "USERPROFILE"]);
function minimalSafeWindowsNativeEnvironment(source = process.env) {
  // Reduced-profile PowerShell writes ModuleAnalysisCache relative to cwd
  // (observed). LOCALAPPDATA alone did not prevent it. Use the documented 5.1
  // explicit cache-file setting, bound to an owned ignored test directory.
  const cacheRoot = path.resolve(__dirname, "../../.playwright/native-bootstrap-env");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const result = { NODE_ENV: "test", PSModuleAnalysisCachePath: path.join(cacheRoot, `ModuleAnalysisCache-${process.pid}`),
    ...Object.fromEntries(WINDOWS_NATIVE_BLOCKED_DEFAULTS.map(key => [key, ""])) };
  for (const key of MINIMAL_SAFE_WINDOWS_NATIVE_ENV) {
    const actual = Object.keys(source).find(name => name.toUpperCase() === key.toUpperCase());
    if (actual && typeof source[actual] === "string" && source[actual].length) result[key] = source[actual];
  }
  return result;
}
module.exports = { MINIMAL_SAFE_WINDOWS_NATIVE_ENV, WINDOWS_NATIVE_BLOCKED_DEFAULTS, minimalSafeWindowsNativeEnvironment };
