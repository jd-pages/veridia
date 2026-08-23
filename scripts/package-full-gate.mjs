import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  collectAttestationState,
  validateFullGateAttestation,
} from "./testing/full-gate-attestation.mjs";

export const PACKAGE_FULL_GATE_SOURCES = Object.freeze({
  LOCAL_ATTESTATION: "LOCAL_ATTESTATION",
  GITHUB_MAIN_CI: "GITHUB_MAIN_CI",
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
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function defaultGit(root, args) {
  return runCommand("git", args, root);
}

function defaultListMainCiRuns(root) {
  return JSON.parse(
    runCommand(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "veridia-ci.yml",
        "--branch",
        "main",
        "--event",
        "push",
        "--limit",
        "30",
        "--json",
        "databaseId,headSha,status,conclusion,event,workflowName,createdAt,url",
      ],
      root,
    ) || "[]",
  );
}

function defaultViewMainCiRun(root, runId) {
  return JSON.parse(
    runCommand(
      "gh",
      [
        "run",
        "view",
        String(runId),
        "--json",
        "databaseId,headSha,status,conclusion,event,workflowName,url,jobs",
      ],
      root,
    ),
  );
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
  if (state.branch !== "main") {
    throw new PackageFullGateError(
      "BRANCH_NOT_MAIN",
      `本地打包只能从 main 分支执行，当前为 ${state.branch || "detached HEAD"}。`,
    );
  }
  if (state.worktreeStatus) {
    throw new PackageFullGateError(
      "WORKTREE_DIRTY",
      `本地打包要求工作区干净：\n${state.worktreeStatus}`,
    );
  }
  if (!state.originMain || state.head !== state.originMain) {
    throw new PackageFullGateError(
      "ORIGIN_MAIN_MISMATCH",
      `当前 HEAD 与 origin/main 不一致（HEAD=${state.head || "缺失"}，origin/main=${state.originMain || "缺失"}）。`,
    );
  }
}

function newest(runs) {
  return [...runs].sort((left, right) =>
    String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
  )[0];
}

export function selectExactHeadMainCiRun(runs, head) {
  const mainPushRuns = runs.filter(
    (run) =>
      run.workflowName === "VERIDIA 代码检查" &&
      run.event === "push",
  );
  if (mainPushRuns.length === 0) {
    throw new PackageFullGateError(
      "MAIN_CI_NOT_FOUND",
      "未找到 VERIDIA 代码检查的 main push 正式 FULL 记录。",
    );
  }
  const exactRuns = mainPushRuns.filter((run) => run.headSha === head);
  if (exactRuns.length === 0) {
    throw new PackageFullGateError(
      "MAIN_CI_SHA_MISMATCH",
      `未找到 exact HEAD ${head} 对应的 Main CI；最近记录为 ${newest(mainPushRuns).headSha || "未知"}。`,
    );
  }
  const successful = newest(
    exactRuns.filter(
      (run) => run.status === "completed" && run.conclusion === "success",
    ),
  );
  if (successful) return successful;
  const pending = newest(exactRuns.filter((run) => run.status !== "completed"));
  if (pending) {
    throw new PackageFullGateError(
      "MAIN_CI_PENDING",
      `exact HEAD Main CI Run ${pending.databaseId} 尚未完成（${pending.status}）。`,
      { runId: pending.databaseId },
    );
  }
  const failed = newest(exactRuns);
  throw new PackageFullGateError(
    "MAIN_CI_FAILED",
    `exact HEAD Main CI Run ${failed.databaseId} 未成功（${failed.conclusion || "unknown"}）。`,
    { runId: failed.databaseId },
  );
}

export function validateExactHeadMainCiDetails(run, head) {
  if (run.headSha !== head) {
    throw new PackageFullGateError(
      "MAIN_CI_SHA_MISMATCH",
      `Main CI 详情 SHA ${run.headSha || "缺失"} 与当前 HEAD ${head} 不一致。`,
      { runId: run.databaseId },
    );
  }
  if (
    run.workflowName !== "VERIDIA 代码检查" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new PackageFullGateError(
      run.status === "completed" ? "MAIN_CI_FAILED" : "MAIN_CI_PENDING",
      `Main CI Run ${run.databaseId} 不是已成功完成的 main push 正式检查。`,
      { runId: run.databaseId },
    );
  }
  const gateJob = run.jobs?.find((job) => job.name === "分层验证门禁");
  const fullStep = gateJob?.steps?.find(
    (step) => step.name === "main 正式 FULL 门禁",
  );
  if (
    gateJob?.status !== "completed" ||
    gateJob?.conclusion !== "success" ||
    fullStep?.status !== "completed" ||
    fullStep?.conclusion !== "success"
  ) {
    throw new PackageFullGateError(
      "MAIN_CI_FAILED",
      `Main CI Run ${run.databaseId} 的“main 正式 FULL 门禁”未成功。`,
      { runId: run.databaseId },
    );
  }
  return run;
}

export function resolvePackageFullGate({
  root = process.cwd(),
  git = defaultGit,
  validateLocalAttestation = validateFullGateAttestation,
  collectCurrentState = collectAttestationState,
  listMainCiRuns = defaultListMainCiRuns,
  viewMainCiRun = defaultViewMainCiRun,
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

  let runs;
  try {
    runs = listMainCiRuns(root);
  } catch (error) {
    throw new PackageFullGateError(
      "GITHUB_UNREACHABLE",
      "GitHub Main CI 不可访问，且没有有效的本地 exact-HEAD FULL attestation。",
      {
        localAttestationReasons: local.reasons,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const selected = selectExactHeadMainCiRun(runs, repository.head);
  let details;
  try {
    details = viewMainCiRun(root, selected.databaseId);
  } catch (error) {
    throw new PackageFullGateError(
      "GITHUB_UNREACHABLE",
      `无法读取 exact HEAD Main CI Run ${selected.databaseId} 详情。`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  validateExactHeadMainCiDetails(details, repository.head);
  return {
    source: PACKAGE_FULL_GATE_SOURCES.GITHUB_MAIN_CI,
    commitSha: repository.head,
    sourceFingerprint: current.sourceFingerprint,
    mainCiRunId: details.databaseId,
    mainCiCommitSha: details.headSha,
    mainCiConclusion: details.conclusion,
    mainCiUrl: details.url,
  };
}
