import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  e2eFilesForGroup,
  isTestOnlyChangePath,
} from "./test-matrix.mjs";

export const TEST_ONLY_RECOVERY_SCHEMA_VERSION = 1;
export const TEST_ONLY_RECOVERY_ARTIFACT =
  "artifacts/ci-logs/test-only-recovery.json";
export const TEST_ONLY_RECOVERY_RELATIVE_PATH =
  ".release-work/verification/test-only-recovery.json";
const RECOVERY_BASE_RELATIVE_PATH =
  ".release-work/verification/test-only-recovery-base.json";

function unique(values) {
  return [...new Set((values || []).map((value) => String(value).replaceAll("\\", "/")))].sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(String(value || ""))) {
    throw new Error(`${label} 必须是完整 40 位 commit SHA`);
  }
}

export function parseVerifyResult(text) {
  const matches = [...String(text || "").matchAll(/VERIDIA_VERIFY_RESULT=(\{[^\r\n]+\})/gu)];
  if (!matches.length) throw new Error("未找到 VERIDIA_VERIFY_RESULT");
  return JSON.parse(matches.at(-1)[1]);
}

export function validateBaseFullForRecovery(summary) {
  if (summary?.mode !== "FULL" || summary?.passed !== false) {
    throw new Error("Recovery base 必须是明确失败的 FULL 结果");
  }
  if (!Array.isArray(summary.failures) || summary.failures.length !== 1) {
    throw new Error("Recovery base 必须只有一个失败门禁");
  }
  const failure = summary.failures[0];
  if (!/^E2E [A-Z0-9_]+$/u.test(failure)) {
    throw new Error("Recovery base 的唯一失败必须是 E2E group");
  }
  const group = failure.slice("E2E ".length);
  if (e2eFilesForGroup(group).length === 0) {
    throw new Error(`Recovery base 包含未知 E2E group：${group}`);
  }
  const requiredPasses = [
    summary.lint === "PASSED",
    summary.typecheck === "PASSED",
    summary.protectedRegression === "PASSED",
    summary.unitTests?.total > 0 && summary.unitTests?.passed === summary.unitTests?.total,
    summary.productionBuild === "PASSED",
    summary.standaloneRuntime === "PASSED",
    summary.sqliteFreshMigration === "PASSED",
    summary.sqliteLegacyUpgrade === "PASSED",
    summary.postgresValidate === "PASSED",
    summary.sensitiveScan === "PASSED",
    summary.gitDiffCheck === "PASSED",
    summary.e2eTotal > summary.e2ePassed,
  ];
  if (!requiredPasses.every(Boolean)) {
    throw new Error("Recovery base 存在 E2E 失败组以外的未通过正式门禁");
  }
  const unexpectedTimingFailure = (summary.timings || []).find(
    (timing) => timing.passed === false && timing.name !== failure,
  );
  if (unexpectedTimingFailure) {
    throw new Error(`Recovery base 还有额外失败：${unexpectedTimingFailure.name}`);
  }
  return { group, files: e2eFilesForGroup(group) };
}

export function createTestOnlyRecoveryEvidence({
  baseFullRun,
  baseFullHead,
  baseFullSummary,
  recoveryCommit,
  changedFiles,
  recoverySummary,
  createdAt = new Date().toISOString(),
}) {
  if (!Number.isInteger(Number(baseFullRun)) || Number(baseFullRun) < 1) {
    throw new Error("BASE_FULL_RUN 必须是有效 GitHub Run ID");
  }
  assertSha(baseFullHead, "BASE_FULL_HEAD");
  assertSha(recoveryCommit, "RECOVERY_COMMIT");
  const scope = unique(changedFiles);
  if (!scope.length || !scope.every(isTestOnlyChangePath)) {
    throw new Error("TEST_ONLY_RECOVERY 只允许 tests/** 变化");
  }
  const base = validateBaseFullForRecovery(baseFullSummary);
  if (
    recoverySummary?.mode !== "AFFECTED" ||
    recoverySummary?.passed !== true ||
    recoverySummary?.lint !== "PASSED" ||
    recoverySummary?.typecheck !== "PASSED" ||
    recoverySummary?.gitDiffCheck !== "PASSED" ||
    recoverySummary?.recoveryGroup !== base.group
  ) {
    throw new Error("Recovery affected gate 未完整通过");
  }
  const selectedFiles = unique(recoverySummary.selectedE2eFiles);
  if (base.files.some((file) => !selectedFiles.includes(file))) {
    throw new Error(`Recovery 未完整重跑失败组 ${base.group}`);
  }
  const groupResult = (recoverySummary.e2eGroups || []).find(
    (candidate) => candidate.name === base.group,
  );
  if (
    !groupResult ||
    groupResult.status !== "PASSED" ||
    groupResult.total < 1 ||
    groupResult.passed !== groupResult.total
  ) {
    throw new Error(`Recovery group ${base.group} 未完整 PASS`);
  }
  return {
    schemaVersion: TEST_ONLY_RECOVERY_SCHEMA_VERSION,
    FINAL_CLASSIFICATION: "TEST_ONLY_RECOVERY_PASS",
    createdAt,
    BASE_FULL_RUN: Number(baseFullRun),
    BASE_FULL_HEAD: baseFullHead,
    BASE_FULL_FAILURE: `E2E ${base.group}`,
    BASE_FULL_SUMMARY_SHA256: sha256(JSON.stringify(baseFullSummary)),
    RECOVERY_COMMIT: recoveryCommit,
    RECOVERY_SCOPE: scope,
    RECOVERY_GROUP_RESULT: {
      group: base.group,
      total: groupResult.total,
      passed: groupResult.passed,
      status: groupResult.status,
    },
  };
}

export function validateTestOnlyRecoveryEvidence(
  evidence,
  { currentHead, changedFiles } = {},
) {
  const reasons = [];
  if (evidence?.schemaVersion !== TEST_ONLY_RECOVERY_SCHEMA_VERSION) {
    reasons.push("Recovery evidence schemaVersion 不兼容");
  }
  if (evidence?.FINAL_CLASSIFICATION !== "TEST_ONLY_RECOVERY_PASS") {
    reasons.push("Recovery evidence classification 无效");
  }
  if (!Number.isInteger(evidence?.BASE_FULL_RUN) || evidence.BASE_FULL_RUN < 1) {
    reasons.push("Recovery evidence 缺少有效 BASE_FULL_RUN");
  }
  if (!/^[0-9a-f]{40}$/u.test(evidence?.BASE_FULL_HEAD || "")) {
    reasons.push("Recovery evidence 缺少有效 BASE_FULL_HEAD");
  }
  if (evidence?.RECOVERY_COMMIT !== currentHead) {
    reasons.push("Recovery evidence 未绑定当前 exact HEAD");
  }
  const actualScope = unique(changedFiles);
  const savedScope = unique(evidence?.RECOVERY_SCOPE);
  if (!actualScope.length || !actualScope.every(isTestOnlyChangePath)) {
    reasons.push("Base FULL 后存在非 tests/** 变化");
  }
  if (JSON.stringify(actualScope) !== JSON.stringify(savedScope)) {
    reasons.push("Recovery scope 与 Git diff 不一致");
  }
  if (
    evidence?.RECOVERY_GROUP_RESULT?.status !== "PASSED" ||
    evidence?.RECOVERY_GROUP_RESULT?.total < 1 ||
    evidence?.RECOVERY_GROUP_RESULT?.passed !== evidence?.RECOVERY_GROUP_RESULT?.total
  ) {
    reasons.push("Recovery group 结果不是完整 PASS");
  }
  return { valid: reasons.length === 0, reasons, evidence };
}

function command(executable, args, root) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `${executable} failed`);
  }
  return result.stdout.trim();
}

function recursiveFind(directory, fileName) {
  if (!fs.existsSync(directory)) return null;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      const found = recursiveFind(absolute, fileName);
      if (found) return found;
    } else if (item.isFile() && item.name === fileName) {
      return absolute;
    }
  }
  return null;
}

function appendGithubEnvironment(values) {
  const environmentFile = process.env.GITHUB_ENV;
  if (!environmentFile) return;
  fs.appendFileSync(
    environmentFile,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""),
    "utf8",
  );
}

function changedFilesFromEnvironment() {
  return unique(
    (process.env.VERIDIA_TEST_CHANGED_FILES || "")
      .split(/[;,\r\n]+/u)
      .map((file) => file.trim())
      .filter(Boolean),
  );
}

function prepare(root) {
  fs.rmSync(path.join(root, RECOVERY_BASE_RELATIVE_PATH), { force: true });
  const changedFiles = changedFilesFromEnvironment();
  appendGithubEnvironment({ VERIDIA_TEST_ONLY_RECOVERY_CANDIDATE: "false" });
  if (!changedFiles.length || !changedFiles.every(isTestOnlyChangePath)) {
    process.stdout.write("TEST_ONLY_RECOVERY=NOT_APPLICABLE scope\n");
    return;
  }
  const runs = JSON.parse(command("gh", [
    "run", "list", "--workflow", "veridia-ci.yml", "--limit", "50",
    "--json", "databaseId,headSha,status,conclusion,createdAt,event",
  ], root) || "[]");
  const candidates = runs
    .filter((run) => run.status === "completed" && /^[0-9a-f]{40}$/u.test(run.headSha || ""))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  for (const run of candidates) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-recovery-base-"));
    try {
      const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", run.headSha, "HEAD"], {
        cwd: root,
        windowsHide: true,
      });
      if (ancestor.status !== 0) continue;
      const recoveryScope = unique(command("git", ["-c", "core.quotepath=false", "diff", "--name-only", run.headSha, "HEAD"], root).split(/\r?\n/u));
      if (!recoveryScope.length || !recoveryScope.every(isTestOnlyChangePath)) continue;
      command("gh", [
        "run", "download", String(run.databaseId), "--pattern", "veridia-ci-*", "--dir", temporary,
      ], root);
      const log = recursiveFind(temporary, "verify-full.log");
      if (!log) continue;
      const summary = parseVerifyResult(fs.readFileSync(log, "utf8"));
      const base = validateBaseFullForRecovery(summary);
      const candidate = {
        baseFullRun: run.databaseId,
        baseFullHead: run.headSha,
        baseFullSummary: summary,
        recoveryGroup: base.group,
        recoveryScope,
      };
      const output = path.join(root, RECOVERY_BASE_RELATIVE_PATH);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
      appendGithubEnvironment({
        VERIDIA_TEST_ONLY_RECOVERY_CANDIDATE: "true",
        VERIDIA_TEST_RECOVERY_GROUP: base.group,
        VERIDIA_TEST_CHANGED_FILES: recoveryScope.join(","),
      });
      process.stdout.write(`TEST_ONLY_RECOVERY=CANDIDATE baseRun=${run.databaseId} group=${base.group}\n`);
      return;
    } catch (error) {
      process.stdout.write(`Recovery base Run ${run.databaseId} 不可复用：${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  process.stdout.write("TEST_ONLY_RECOVERY=NOT_APPLICABLE no-valid-base\n");
}

function finalize(root) {
  const candidatePath = path.join(root, RECOVERY_BASE_RELATIVE_PATH);
  if (!fs.existsSync(candidatePath)) {
    process.stdout.write("TEST_ONLY_RECOVERY=NOT_APPLICABLE no-candidate\n");
    return;
  }
  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const recoverySummary = JSON.parse(
    fs.readFileSync(path.join(root, ".playwright", "verification-affected.json"), "utf8"),
  );
  const recoveryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const evidence = createTestOnlyRecoveryEvidence({
    ...candidate,
    recoveryCommit,
    changedFiles: candidate.recoveryScope,
    recoverySummary,
  });
  const output = path.join(root, TEST_ONLY_RECOVERY_ARTIFACT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const reusableOutput = path.join(root, TEST_ONLY_RECOVERY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(reusableOutput), { recursive: true });
  fs.writeFileSync(reusableOutput, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`TEST_ONLY_RECOVERY_PASS=${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2];
  if (operation === "prepare") {
    try {
      prepare(process.cwd());
    } catch (error) {
      appendGithubEnvironment({ VERIDIA_TEST_ONLY_RECOVERY_CANDIDATE: "false" });
      process.stdout.write(`TEST_ONLY_RECOVERY=NOT_APPLICABLE ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  else if (operation === "finalize") finalize(process.cwd());
  else throw new Error("test-only-recovery 操作必须是 prepare 或 finalize");
}
