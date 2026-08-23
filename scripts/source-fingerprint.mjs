import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function collectSourceFingerprint(root = process.cwd()) {
  const files = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "-co", "--exclude-standard"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}
