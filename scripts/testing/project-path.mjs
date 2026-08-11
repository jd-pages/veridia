import fs from "node:fs";
import path from "node:path";

function stripWindowsNamespace(value) {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function trimTrailingSeparators(value, pathApi) {
  const root = pathApi.parse(value).root;
  let output = value;
  while (output.length > root.length && /[\\/]$/u.test(output)) {
    output = output.slice(0, -1);
  }
  return output;
}

export function canonicalizeProjectPath(value, options = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Project path must be a non-empty string");
  }

  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolve = options.resolve || ((input) => path.resolve(input));
  const realpath = options.realpath || fs.realpathSync.native;
  let canonical = resolve(value);

  try {
    canonical = realpath(canonical);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }

  if (platform === "win32") canonical = stripWindowsNamespace(canonical);
  canonical = trimTrailingSeparators(pathApi.normalize(canonical), pathApi);
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sameProjectPath(left, right, options = {}) {
  if (canonicalizeProjectPath(left, options) === canonicalizeProjectPath(right, options)) {
    return true;
  }
  if (options.stat === null) return false;
  const stat = options.stat || fs.statSync;
  try {
    const leftStat = stat(left);
    const rightStat = stat(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}
