import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { e2eFilesForGroup, selectTestScope } from "./test-matrix.mjs";

function changedFilesFromEnvironment() {
  return [...new Set((process.env.VERIDIA_TEST_CHANGED_FILES || "")
    .split(/[;,\r\n]+/u)
    .map((file) => file.trim())
    .filter(Boolean))].sort();
}

export function createAffectedCiPlan(changedFiles, recoveryGroup = "") {
  const selection = selectTestScope(changedFiles, "affected");
  const recoveryFiles = recoveryGroup ? e2eFilesForGroup(recoveryGroup) : [];
  const e2eFiles = [...new Set([...selection.e2eFiles, ...recoveryFiles])].sort();
  return {
    mode: "affected",
    risk: selection.risk,
    e2eFiles,
    needsBrowser: e2eFiles.length > 0,
  };
}

function main() {
  const plan = createAffectedCiPlan(
    changedFilesFromEnvironment(),
    process.env.VERIDIA_TEST_RECOVERY_GROUP?.trim() || "",
  );
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `VERIDIA_CI_NEEDS_BROWSER=${plan.needsBrowser}\n`, "utf8");
  }
  process.stdout.write(`VERIDIA_CI_PLAN=${JSON.stringify(plan)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
