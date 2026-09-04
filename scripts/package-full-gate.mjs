import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  collectAttestationState,
  validateFullGateAttestation,
  validateReusableFullBaseAttestation,
} from "./testing/full-gate-attestation.mjs";
import {
  TEST_ONLY_RECOVERY_RELATIVE_PATH,
  validateTestOnlyRecoveryEvidence,
} from "./testing/test-only-recovery.mjs";

export const PACKAGE_FULL_GATE_SOURCES = Object.freeze({
  LOCAL_ATTESTATION: "LOCAL_ATTESTATION",
  GITHUB_RELEASE_FULL: "GITHUB_RELEASE_FULL",
  TEST_ONLY_RECOVERY: "TEST_ONLY_RECOVERY",
});

export class PackageFullGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PackageFullGateError";
    this.code = code;
    this.details = details;
  }
}

function runCommand(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return result.stdout.trim();
}

function defaultGit(root, args) {
  return runCommand("git", args, root);
}

function defaultListMainCiRuns(root) {
  return JSON.parse(runCommand("gh", [
    "run", "list", "--workflow", "veridia-ci.yml", "--branch", "main", "--limit", "50",
    "--json", "databaseId,headSha,status,conclusion,event,workflowName,createdAt,url",
  ], root) || "[]");
}

function defaultViewMainCiRun(root, runId) {
  return JSON.parse(runCommand("gh", [
    "run", "view", String(runId),
    "--json", "databaseId,headSha,status,conclusion,event,workflowName,url,jobs",
  ], root));
}

function recursiveFind(directory, fileName) {
  if (!fs.existsSync(directory)) return null;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      const found = recursiveFind(absolute, fileName);
      if (found) return found;
    } else if (item.isFile() && item.name === fileName) return absolute;
  }
  return null;
}

function defaultReadRecoveryEvidence(root, runId) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-package-recovery-"));
  try {
    runCommand("gh", ["run", "download", String(runId), "--pattern", "veridia-ci-*", "--dir", temporary], root);
    const file = recursiveFind(temporary, "test-only-recovery.json");
    if (!file) throw new Error("Run artifact 不包含 test-only-recovery.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function defaultReadLocalRecoveryEvidence(root) {
  const file = path.join(root, ...TEST_ONLY_RECOVERY_RELATIVE_PATH.split("/"));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function collectPackageRepositoryState(root, git = defaultGit) {
  const head = git(root, ["rev-parse", "HEAD"]);
  let originMain = "";
  try {
    originMain = git(root, ["rev-parse", "origin/main"]);
  } catch {
    originMain = "";
  }
  return {
    branch: git(root, ["branch", "--show-current"]),
    worktreeStatus: git(root, ["status", "--porcelain", "--untracked-files=normal"]),
    head,
    originMain,
  };
}

export function assertPackageRepositoryState(state) {
  if (state.branch !== "main") throw new PackageFullGateError("BRANCH_NOT_MAIN", `本地打包只能从 main 分支执行，当前为 ${state.branch || "detached HEAD"}。`);
  if (state.worktreeStatus) throw new PackageFullGateError("WORKTREE_DIRTY", `本地打包要求工作区干净：\n${state.worktreeStatus}`);
  if (!state.originMain || state.head !== state.originMain) {
    throw new PackageFullGateError("ORIGIN_MAIN_MISMATCH", `当前 HEAD 与 origin/main 不一致（HEAD=${state.head || "缺失"}，origin/main=${state.originMain || "缺失"}）。`);
  }
}

function newest(runs) {
  return [...runs].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
}

export function selectExactHeadMainCiRun(runs, head) {
  const workflowRuns = runs.filter((run) => run.workflowName === "VERIDIA 代码检查");
  if (!workflowRuns.length) throw new PackageFullGateError("MAIN_CI_NOT_FOUND", "未找到 VERIDIA 代码检查记录。");
  const exactRuns = workflowRuns.filter((run) => run.headSha === head);
  if (!exactRuns.length) {
    throw new PackageFullGateError("MAIN_CI_SHA_MISMATCH", `未找到 exact HEAD ${head} 对应的 CI；最近记录为 ${newest(workflowRuns).headSha || "未知"}。`);
  }
  return newest(exactRuns);
}

function successfulStep(run, stepName) {
  const job = run.jobs?.find((candidate) => candidate.name === "分层验证门禁");
  const step = job?.steps?.find((candidate) => candidate.name === stepName);
  return job?.status === "completed" && job?.conclusion === "success" && step?.status === "completed" && step?.conclusion === "success";
}

export function validateExactHeadReleaseFullDetails(run, head) {
  if (run.headSha !== head) throw new PackageFullGateError("MAIN_CI_SHA_MISMATCH", `CI 详情 SHA ${run.headSha || "缺失"} 与当前 HEAD ${head} 不一致。`, { runId: run.databaseId });
  if (run.workflowName !== "VERIDIA 代码检查" || run.event !== "workflow_dispatch" || run.status !== "completed" || run.conclusion !== "success" || !successfulStep(run, "RELEASE_FULL 门禁")) {
    throw new PackageFullGateError("RELEASE_FULL_REQUIRED", `CI Run ${run.databaseId} 不是成功的手动 RELEASE_FULL。`, { runId: run.databaseId });
  }
  return run;
}

function recoveryCredential(evidence, repository, current, run = null) {
  return {
    source: PACKAGE_FULL_GATE_SOURCES.TEST_ONLY_RECOVERY,
    commitSha: repository.head,
    sourceFingerprint: current.sourceFingerprint,
    baseFullRunId: evidence.BASE_FULL_RUN,
    baseFullHead: evidence.BASE_FULL_HEAD,
    recoveryCommit: evidence.RECOVERY_COMMIT,
    recoveryScope: evidence.RECOVERY_SCOPE,
    recoveryGroupResult: evidence.RECOVERY_GROUP_RESULT,
    ...(run ? { recoveryCiRunId: run.databaseId, recoveryCiUrl: run.url } : {}),
  };
}

export function resolvePackageFullGate({
  root = process.cwd(),
  git = defaultGit,
  validateLocalAttestation = validateFullGateAttestation,
  validateReusableAttestation = validateReusableFullBaseAttestation,
  collectCurrentState = collectAttestationState,
  readLocalRecoveryEvidence = defaultReadLocalRecoveryEvidence,
  listMainCiRuns = defaultListMainCiRuns,
  viewMainCiRun = defaultViewMainCiRun,
  readRecoveryEvidence = defaultReadRecoveryEvidence,
} = {}) {
  const repository = collectPackageRepositoryState(root, git);
  assertPackageRepositoryState(repository);
  const current = collectCurrentState(root);
  const local = validateLocalAttestation(root);
  if (local.valid) {
    return {
      source: PACKAGE_FULL_GATE_SOURCES.LOCAL_ATTESTATION,
      commitSha: repository.head,
      sourceFingerprint: current.sourceFingerprint,
      attestationGeneratedAt: local.attestation.generatedAt,
    };
  }

  const reusable = validateReusableAttestation(root);
  let localRecovery = null;
  try {
    localRecovery = readLocalRecoveryEvidence(root);
  } catch {
    localRecovery = null;
  }
  if (reusable.valid && localRecovery) {
    const validation = validateTestOnlyRecoveryEvidence(localRecovery, {
      currentHead: repository.head,
      changedFiles: reusable.changedFiles,
    });
    if (validation.valid && localRecovery.BASE_FULL_HEAD === reusable.attestation.gitHead) {
      return recoveryCredential(localRecovery, repository, current);
    }
  }

  let runs;
  try {
    runs = listMainCiRuns(root);
  } catch (error) {
    throw new PackageFullGateError("GITHUB_UNREACHABLE", "GitHub CI 不可访问，且没有有效的本地 exact-HEAD FULL 或 Recovery chain。", {
      localAttestationReasons: local.reasons,
      reusableAttestationReasons: reusable.reasons,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  selectExactHeadMainCiRun(runs, repository.head);
  const exactRuns = runs
    .filter((run) => run.workflowName === "VERIDIA 代码检查" && run.headSha === repository.head)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const successful = exactRuns.filter((run) => run.status === "completed" && run.conclusion === "success");
  for (const selected of successful) {
    let details;
    try {
      details = viewMainCiRun(root, selected.databaseId);
    } catch {
      continue;
    }
    try {
      validateExactHeadReleaseFullDetails(details, repository.head);
      return {
        source: PACKAGE_FULL_GATE_SOURCES.GITHUB_RELEASE_FULL,
        commitSha: repository.head,
        sourceFingerprint: current.sourceFingerprint,
        releaseFullRunId: details.databaseId,
        releaseFullCommitSha: details.headSha,
        releaseFullConclusion: details.conclusion,
        releaseFullUrl: details.url,
      };
    } catch (error) {
      if (!(error instanceof PackageFullGateError) || error.code !== "RELEASE_FULL_REQUIRED") throw error;
    }
    if (!successfulStep(details, "生成 TEST_ONLY_RECOVERY 证据")) continue;
    try {
      const evidence = readRecoveryEvidence(root, selected.databaseId);
      const changedFiles = git(root, ["-c", "core.quotepath=false", "diff", "--name-only", evidence.BASE_FULL_HEAD, repository.head])
        .split(/\r?\n/u).map((file) => file.trim()).filter(Boolean);
      const validation = validateTestOnlyRecoveryEvidence(evidence, { currentHead: repository.head, changedFiles });
      if (validation.valid) return recoveryCredential(evidence, repository, current, details);
    } catch {
      // Try another successful exact-HEAD run; affected success alone is never a FULL credential.
    }
  }
  const pending = newest(exactRuns.filter((run) => run.status !== "completed"));
  if (pending) throw new PackageFullGateError("MAIN_CI_PENDING", `exact HEAD CI Run ${pending.databaseId} 尚未完成（${pending.status}）。`, { runId: pending.databaseId });
  throw new PackageFullGateError("RELEASE_FULL_REQUIRED", `exact HEAD ${repository.head} 没有 RELEASE_FULL PASS 或有效 TEST_ONLY_RECOVERY chain。`);
}
