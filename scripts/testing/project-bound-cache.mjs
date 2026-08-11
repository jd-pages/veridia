import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT_MARKER = ".veridia-project-root";

function normalizePath(value) {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

export function ensureProjectBoundDirectory(directory, projectRoot) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const markerPath = path.join(resolvedDirectory, PROJECT_ROOT_MARKER);
  let savedProjectRoot = "";
  try {
    savedProjectRoot = fs.readFileSync(markerPath, "utf8").trim();
  } catch {}

  const reset =
    fs.existsSync(resolvedDirectory) &&
    (!savedProjectRoot ||
      normalizePath(savedProjectRoot) !== normalizePath(resolvedProjectRoot));
  if (reset) {
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedDirectory, { recursive: true });
  fs.writeFileSync(markerPath, `${resolvedProjectRoot}\n`, "utf8");
  return { directory: resolvedDirectory, markerPath, reset };
}
