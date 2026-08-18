import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  canonicalizeProjectPath,
  sameProjectPath,
} from "./testing/project-path.mjs";
import {
  classifyReleaseFailure,
  parseReleaseResult,
  redactReleaseText,
} from "./release-failure.mjs";
import {
  retryReadOnlyNetworkOperation,
  retryReadOnlyNetworkOperationSync,
} from "./release-network.mjs";
import {
  advanceReleaseCheckpoint,
  checkpointLabel,
  classifyReleaseTagHistory,
  isCheckpointAtLeast,
  validateResumeSession,
} from "./release-state.mjs";
import {
  bindArtifactManifestToReleaseCommit,
  collectReleaseSourceFingerprint,
  validateReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from "./software-release-artifacts.mjs";

const scriptProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function discoverGitProjectRoot(candidateRoot) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: candidateRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const gitRoot = result.status === 0 ? result.stdout.trim() : "";
  return gitRoot ? path.resolve(gitRoot) : candidateRoot;
}

const projectRoot = discoverGitProjectRoot(scriptProjectRoot);
const releaseWorkflow = "veridia-release.yml";
const dryRun = process.argv.includes("--dry-run");

export class SoftwarePublishError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{
   *   cause?: unknown,
   *   stage?: string,
   *   classification?: string,
   *   command?: string,
   *   detailLog?: string,
   *   target?: string,
   *   failedItem?: string,
   *   attempt?: number,
   *   maxAttempts?: number,
   *   elapsedMs?: number,
   *   cacheStatus?: string,
   *   checkpoint?: string,
   *   recoveryPoint?: string,
   *   sideEffects?: boolean,
   *   versionConsumed?: boolean,
   *   recovery?: string
   * }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SoftwarePublishError";
    this.code = code;
    this.stage = options.stage;
    this.classification = options.classification;
    this.command = options.command;
    this.detailLog = options.detailLog;
    this.target = options.target;
    this.failedItem = options.failedItem;
    this.attempt = options.attempt;
    this.maxAttempts = options.maxAttempts;
    this.elapsedMs = options.elapsedMs;
    this.cacheStatus = options.cacheStatus;
    this.checkpoint = options.checkpoint;
    this.recoveryPoint = options.recoveryPoint;
    this.sideEffects = options.sideEffects;
    this.versionConsumed = options.versionConsumed;
    this.recovery = options.recovery;
  }
}

export function formatSoftwarePublishFailure(error, logPath) {
  const message = redactReleaseText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1_200);
  const stage = error instanceof SoftwarePublishError && error.stage
    ? error.stage
    : "RELEASE_ORCHESTRATION";
  const classification =
    error instanceof SoftwarePublishError && error.classification
      ? error.classification
      : classifyReleaseFailure(message);
  const lines = [
    "========================================",
    "VERIDIA 正式发布未完成",
    "========================================",
    `失败阶段：${stage}`,
    `错误类型：${classification}`,
    ...(error instanceof SoftwarePublishError && error.failedItem
      ? [`失败项目：${error.failedItem}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.target
      ? [`目标：${error.target}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.attempt
      ? [`请求次数：${error.attempt}/${error.maxAttempts || error.attempt}`]
      : []),
    ...(error instanceof SoftwarePublishError && Number.isFinite(error.elapsedMs)
      ? [`耗时：${error.elapsedMs}ms`]
      : []),
    ...(error instanceof SoftwarePublishError && error.cacheStatus
      ? [`缓存状态：${error.cacheStatus}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.checkpoint
      ? [`当前 Checkpoint：${checkpointLabel(error.checkpoint)}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.recoveryPoint
      ? [`恢复点：${error.recoveryPoint}`]
      : []),
    ...(error instanceof SoftwarePublishError && typeof error.sideEffects === "boolean"
      ? [`是否产生发布副作用：${error.sideEffects ? "是" : "否"}`]
      : []),
    ...(error instanceof SoftwarePublishError && typeof error.versionConsumed === "boolean"
      ? [`当前 Version：${error.versionConsumed ? "已消费" : "尚未消费"}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.recovery
      ? [`恢复建议：${error.recovery}`]
      : []),
    `错误摘要：${message}`,
    `详细日志：${
      error instanceof SoftwarePublishError && error.detailLog
        ? error.detailLog
        : logPath
    }`,
  ];
  const noRemoteMutationStages = new Set([
    "PREFLIGHT",
    "PREREQUISITE_WARMUP",
    "FULL",
    "LINT",
    "TYPECHECK",
    "UNIT_TEST",
    "E2E",
    "PRODUCTION_BUILD",
    "STANDALONE",
    "DATABASE",
    "SENSITIVE_SCAN",
    "DESKTOP_PREPARE",
    "PACKAGE",
    "INSTALLER_VERIFY",
    "VERSION_UPDATE",
    "RELEASE_COMMIT",
  ]);
  if (noRemoteMutationStages.has(stage)) {
    lines.push(
      "本次未执行：",
      "- Push main",
      "- 创建 / Push Tag",
      "- GitHub Release",
      "- 执行rules:publish",
    );
  } else if (stage === "PUSH_MAIN") {
    lines.push("本次未执行：", "- 创建 / Push Tag", "- GitHub Release");
  } else if (stage === "TAG" || stage === "PUSH_TAG") {
    lines.push("本次未宣告 GitHub Release 成功。");
  } else {
    lines.push("远端状态请以上方执行阶段和日志为准；脚本不会自动覆盖或回滚远端状态。");
  }
  return lines;
}

export function parseReleaseVersion(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    throw new SoftwarePublishError(
      "INVALID_VERSION",
      `版本号不是有效的语义化版本：${value || "空"}`,
    );
  }
  return match.slice(1).map(Number);
}

export function compareReleaseVersions(left, right) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function nextPatchVersion(value) {
  const [major, minor, patch] = parseReleaseVersion(value);
  return `${major}.${minor}.${patch + 1}`;
}

export function classifyReleaseHistory(input) {
  try {
    const history = classifyReleaseTagHistory({
      ...input,
      compareVersions: compareReleaseVersions,
    });
    if (history.inProgressReleaseTags.length > 0) {
      const active = history.inProgressReleaseTags[0];
      throw Object.assign(new Error(
        `v${active.version} 的正式发布 Workflow 仍处于 ${active.workflowStatus}。`,
      ), { code: "IN_PROGRESS_RELEASE", classification: "STATE_CONFLICT" });
    }
    if (history.unknownOrphanTags.length > 0) {
      throw Object.assign(new Error(
        `v${history.unknownOrphanTags[0].version} 缺少同提交、终态失败的 Workflow 证据，是 UNKNOWN_ORPHAN_TAG。`,
      ), { code: "UNKNOWN_ORPHAN_TAG", classification: "STATE_CONFLICT" });
    }
    return {
      latestPublishedReleaseVersion: history.latestPublished.version,
      latestPublishedRelease: history.latestPublished,
      latestHistoricalTagVersion:
        history.historicalTags.at(-1)?.version || history.latestPublished.version,
      historicalReleaseStates: history.historicalTags,
      failedReleaseTags: history.failedReleaseTags,
      inProgressReleaseTags: history.inProgressReleaseTags,
      unknownOrphanTags: history.unknownOrphanTags,
    };
  } catch (error) {
    if (error instanceof SoftwarePublishError) throw error;
    const legacyMessages = {
      HISTORICAL_TAG_NOT_MAIN_ANCESTOR: `失败历史 Tag v${error?.version || ""} 不是当前 main 的祖先。`,
      HISTORICAL_TAG_NOT_BELOW_TARGET: `失败历史 Tag 必须严格低于目标版本 v${input.targetVersion}。`,
      PUBLISHED_RELEASE_TAG_MISSING: `GitHub Release v${input.latestPublishedRelease?.version} 存在，但对应 Tag 缺失。`,
      PUBLISHED_RELEASE_COMMIT_MISMATCH: "Tag、远程引用、Release/Workflow 提交不一致。",
      HISTORICAL_TAG_COMMIT_MISMATCH: "Tag、远程引用、Release/Workflow 提交不一致。",
      UNEXPECTED_PUBLISHED_RELEASE: "中间版本已有 Release，不能分类为 FAILED_RELEASE_TAG。",
    };
    throw new SoftwarePublishError(
      error?.code || "INVALID_RELEASE_STATE",
      legacyMessages[error?.code] || (error instanceof Error ? error.message : String(error)),
      { cause: error, classification: "STATE_CONFLICT", stage: "PREFLIGHT" },
    );
  }
}

export function createSoftwarePublishPlan(input) {
  if (input.dirty) {
    throw new SoftwarePublishError(
      "DIRTY_WORKTREE",
      "检测到未提交修改，请先完成开发提交后再发布。",
    );
  }
  if (input.branch !== "main") {
    throw new SoftwarePublishError(
      "INVALID_BRANCH",
      "软件正式发布只能从 main 分支执行。",
    );
  }
  if (input.behind > 0) {
    throw new SoftwarePublishError(
      "BEHIND_REMOTE",
      "远程main存在本地尚未同步的提交，请先处理分支同步。",
    );
  }
  if (input.sourceVersion !== input.lockVersion) {
    throw new SoftwarePublishError(
      "VERSION_MISMATCH",
      `package.json（${input.sourceVersion}）与 package-lock.json（${input.lockVersion}）版本不一致。`,
    );
  }
  if (input.latestPublishedRelease?.version !== input.latestReleaseVersion) {
    throw new SoftwarePublishError(
      "LATEST_RELEASE_STATE_MISMATCH",
      "Latest Release 查询结果与 PUBLISHED_RELEASE 状态版本不一致，发布已停止。",
    );
  }
  const sourceComparedWithRelease = compareReleaseVersions(
    input.sourceVersion,
    input.latestReleaseVersion,
  );
  if (sourceComparedWithRelease < 0) {
    throw new SoftwarePublishError(
      "SOURCE_VERSION_BEHIND",
      `源码版本 ${input.sourceVersion} 低于已发布版本 ${input.latestReleaseVersion}，发布已停止。`,
    );
  }
  const sourceIsPublished = sourceComparedWithRelease === 0;
  const versionChangeRequired = sourceIsPublished && !input.targetVersionOverride;
  const targetVersion = input.targetVersionOverride || (sourceIsPublished
    ? nextPatchVersion(input.latestReleaseVersion)
    : input.sourceVersion);
  if ((input.targetTagExists || input.targetLocalTagExists || input.targetRemoteTagExists) && !input.resume) {
    throw new SoftwarePublishError(
      "TARGET_TAG_EXISTS",
      `目标 Tag v${targetVersion} 已存在，拒绝覆盖。`,
      { classification: "STATE_CONFLICT" },
    );
  }
  if (input.targetReleaseExists && !input.resume) {
    throw new SoftwarePublishError(
      "TARGET_RELEASE_EXISTS",
      `GitHub Release v${targetVersion} 已存在，拒绝重复发布。`,
      { classification: "STATE_CONFLICT" },
    );
  }
  const history = classifyReleaseHistory({
    latestPublishedRelease: input.latestPublishedRelease,
    historicalTags: input.historicalTags,
    targetVersion,
  });

  if (input.commitsSinceRelease.length === 0 && !input.resume) {
    return {
      kind: "none",
      currentVersion: input.latestReleaseVersion,
      sourceVersion: input.sourceVersion,
      ...history,
      ahead: input.ahead,
      behind: input.behind,
      commitsToPush: input.commitsToPush,
      commitsSinceRelease: input.commitsSinceRelease,
      checkpoint: input.checkpoint || "PLAN_READY",
    };
  }

  return {
    kind: "release",
    currentVersion: input.latestReleaseVersion,
    sourceVersion: input.sourceVersion,
    targetVersion,
    versionChangeRequired,
    ...history,
    ahead: input.ahead,
    behind: input.behind,
    commitsToPush: input.commitsToPush,
    commitsSinceRelease: input.commitsSinceRelease,
    targetLocalTagExists: Boolean(input.targetLocalTagExists),
    targetRemoteTagExists: Boolean(input.targetRemoteTagExists),
    targetReleaseExists: Boolean(input.targetReleaseExists),
    targetTagCommit: input.targetTagCommit || null,
    releaseWorkflowState: input.releaseWorkflowState || {
      status: "not_started",
      conclusion: null,
    },
    checkpoint: input.checkpoint || "PLAN_READY",
    buildTimestamp: input.buildTimestamp || new Date().toISOString(),
  };
}

export async function executeSoftwarePublishPlan(plan, options) {
  if (options.dryRun || plan.kind === "none") {
    return { dryRun: options.dryRun, released: false };
  }
  let session = options.session || {
    checkpoint: plan.checkpoint || "PLAN_READY",
    targetVersion: plan.targetVersion,
  };
  let versionTouched = false;
  let versionCommitted = false;
  const persist = async (checkpoint, patch = {}) => {
    session = advanceReleaseCheckpoint(session, checkpoint, patch);
    const persisted = await options.onCheckpoint?.(session);
    if (persisted) session = persisted;
    return session;
  };
  const recoveryFor = (checkpoint) => {
    if (isCheckpointAtLeast(checkpoint, "REMOTE_TAG_PUSHED")) {
      return {
        recoveryPoint: "GITHUB_ACTIONS",
        sideEffects: true,
        versionConsumed: true,
        recovery: "重新运行 发布新版.bat；发布器将审计 Actions/Release 状态。若 Actions 已确定失败，必须使用下一版本。",
      };
    }
    if (isCheckpointAtLeast(checkpoint, "MAIN_PUSHED")) {
      return {
        recoveryPoint: "TAG",
        sideEffects: true,
        versionConsumed: false,
        recovery: "重新运行 发布新版.bat；核验 HEAD、origin/main、Main CI 和产物后从 Tag 阶段继续。",
      };
    }
    if (isCheckpointAtLeast(checkpoint, "FULL_PASS")) {
      return {
        recoveryPoint: isCheckpointAtLeast(checkpoint, "LOCAL_PACKAGE_VERIFIED")
          ? "RELEASE_COMMIT"
          : "LOCAL_PACKAGE",
        sideEffects: false,
        versionConsumed: false,
        recovery: "源码和指纹未变化时，重新运行 发布新版.bat 从安全检查点继续。",
      };
    }
    return {
      recoveryPoint: "PREFLIGHT",
      sideEffects: false,
      versionConsumed: false,
      recovery: "网络或环境恢复后重新运行 发布新版.bat。",
    };
  };
  const executeStage = async (stage, operation) => {
    try {
      return await operation();
    } catch (error) {
      const recovery = recoveryFor(session.checkpoint);
      if (error instanceof SoftwarePublishError && error.stage) {
        error.checkpoint ||= session.checkpoint;
        error.recoveryPoint ||= recovery.recoveryPoint;
        error.sideEffects ??= recovery.sideEffects;
        error.versionConsumed ??= recovery.versionConsumed;
        error.recovery ||= recovery.recovery;
        throw error;
      }
      throw new SoftwarePublishError(
        "RELEASE_STAGE_FAILED",
        error instanceof Error ? error.message : String(error),
        {
          cause: error,
          stage,
          classification: classifyReleaseFailure(error),
          attempt: error?.attempt,
          maxAttempts: error?.maxAttempts,
          checkpoint: session.checkpoint,
          ...recovery,
        },
      );
    }
  };
  try {
    if (!isCheckpointAtLeast(session.checkpoint, "PREFLIGHT_PASS") && options.operations.preflight) {
      await executeStage("PREFLIGHT", () => options.operations.preflight(plan));
      await persist("PREFLIGHT_PASS");
    }
    if (!isCheckpointAtLeast(session.checkpoint, "FULL_PASS")) {
      versionTouched = true;
      await executeStage("VERSION_UPDATE", () => options.operations.updateVersion(plan));
      await executeStage("FULL", () => options.operations.validate(plan));
      await persist("FULL_PASS");
    }
    if (!isCheckpointAtLeast(session.checkpoint, "LOCAL_PACKAGE_VERIFIED")) {
      if (options.operations.package) {
        await executeStage("PACKAGE", () => options.operations.package(plan));
      }
      const artifact = await executeStage("INSTALLER_VERIFY", () =>
        options.operations.verifyLocalArtifact?.(plan),
      );
      await persist("LOCAL_PACKAGE_VERIFIED", { localArtifact: artifact || null });
    }
    if (!isCheckpointAtLeast(session.checkpoint, "RELEASE_COMMIT_CREATED")) {
      await executeStage("RELEASE_COMMIT", () => options.operations.commitVersion(plan));
      versionCommitted = true;
      const releaseCommit = await executeStage("RELEASE_COMMIT", () =>
        options.operations.releaseCommit?.(plan),
      );
      await options.operations.bindArtifact?.(plan, releaseCommit);
      await persist("RELEASE_COMMIT_CREATED", { releaseCommit });
    }
    if (!isCheckpointAtLeast(session.checkpoint, "MAIN_PUSHED")) {
      await executeStage("PUSH_MAIN", () => options.operations.pushMain(plan));
      await executeStage("PUSH_MAIN", () => options.operations.assertMainSynchronized(plan));
      await persist("MAIN_PUSHED");
    }
    if (!isCheckpointAtLeast(session.checkpoint, "LOCAL_TAG_CREATED")) {
      await executeStage("MAIN_CI", () => options.operations.waitForMainCi?.(plan));
      await executeStage("TAG", () => options.operations.assertTargetAvailable(plan));
      await executeStage("TAG", () => options.operations.createTag(plan));
      await persist("LOCAL_TAG_CREATED");
    }
    if (!isCheckpointAtLeast(session.checkpoint, "REMOTE_TAG_PUSHED")) {
      await executeStage("PUSH_TAG", () => options.operations.pushTag(plan));
      await persist("REMOTE_TAG_PUSHED");
    }
    let actions = session.actions;
    if (!isCheckpointAtLeast(session.checkpoint, "GITHUB_ACTIONS_SUCCESS")) {
      actions = await executeStage("GITHUB_ACTIONS", () =>
        options.operations.waitForActions(plan),
      );
      if (!actions.success) {
        throw new SoftwarePublishError(
          "ACTIONS_FAILED",
          `GitHub Actions 发布失败：${actions.url || "未提供运行地址"}`,
          {
            stage: "GITHUB_ACTIONS",
            classification: "DETERMINISTIC",
            checkpoint: session.checkpoint,
            recoveryPoint: "NEXT_VERSION_REQUIRED",
            sideEffects: true,
            versionConsumed: true,
            recovery: "保留失败 Tag，不得移动或补建 Release；修复后准备下一软件版本。",
          },
        );
      }
      await persist("GITHUB_ACTIONS_SUCCESS", { actions });
    }
    let release = session.release;
    if (!isCheckpointAtLeast(session.checkpoint, "REMOTE_ASSETS_VERIFIED")) {
      release = await executeStage("REMOTE_ASSETS_VERIFY", () =>
        options.operations.verifyRelease(plan, actions),
      );
      await persist("GITHUB_RELEASE_CREATED", { release });
      await persist("REMOTE_ASSETS_VERIFIED", { release });
    }
    await persist("RELEASE_COMPLETE");
    return { dryRun: false, released: true, actions, release, session };
  } catch (error) {
    if (
      versionTouched
      && !versionCommitted
      && !isCheckpointAtLeast(session.checkpoint, "FULL_PASS")
    ) {
      await options.operations.restoreVersion(plan);
    }
    throw error;
  }
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function createLogger() {
  const logDirectory = path.join(projectRoot, ".release-work", "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(
    logDirectory,
    `software-release-${timestamp()}.log`,
  );
  function write(value = "") {
    const text = String(value);
    process.stdout.write(text);
    fs.appendFileSync(logPath, text, "utf8");
  }
  function line(value = "") {
    write(`${String(value)}\n`);
  }
  return { line, write, logPath };
}

export function softwareReleaseSessionPath(root, version) {
  return path.join(
    root,
    ".release-work",
    "checkpoints",
    `software-release-${version}.json`,
  );
}

export function readSoftwareReleaseSession(root, version) {
  const file = softwareReleaseSessionPath(root, version);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SoftwarePublishError(
      "INVALID_RELEASE_SESSION",
      `发布恢复记录无法解析：${file}`,
      { cause: error, stage: "PREFLIGHT", classification: "STATE_CONFLICT" },
    );
  }
}

export function findActiveSoftwareReleaseSession(root) {
  const directory = path.join(root, ".release-work", "checkpoints");
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory)
    .filter((name) => /^software-release-\d+\.\d+\.\d+\.json$/u.test(name))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((value) => value && value.checkpoint !== "RELEASE_COMPLETE")
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
    || null;
}

export function writeSoftwareReleaseSession(root, version, session) {
  const file = softwareReleaseSessionPath(root, version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return session;
}

export function resolveSoftwareReleaseSession(root, plan, observed = {}) {
  const fingerprint = collectReleaseSourceFingerprint(root);
  const existing = readSoftwareReleaseSession(root, plan.targetVersion);
  const state = {
    targetVersion: plan.targetVersion,
    sourceVersion: plan.sourceVersion,
    localHead: observed.localHead,
    behind: plan.behind,
  };
  if (existing) {
    const validity = validateResumeSession(existing, state, fingerprint);
    if (!validity.valid) {
      if (!isCheckpointAtLeast(existing.checkpoint, "LOCAL_TAG_CREATED")) {
        return {
          schemaVersion: 1,
          targetVersion: plan.targetVersion,
          sourceVersion: plan.sourceVersion,
          sourceHead: observed.localHead,
          sourceFingerprint: fingerprint,
          buildTimestamp: new Date().toISOString(),
          checkpoint: "PLAN_READY",
          releaseCommit: null,
          actions: null,
          release: null,
          supersedesReleaseCommit: existing.releaseCommit || null,
          restartReasons: validity.reasons,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new SoftwarePublishError(
        "STALE_RELEASE_SESSION",
        `发布恢复记录已失效：${validity.reasons.join(", ")}`,
        {
          stage: "PREFLIGHT",
          classification: "STATE_CONFLICT",
          checkpoint: existing.checkpoint,
          recoveryPoint: "BLOCK",
          sideEffects: isCheckpointAtLeast(existing.checkpoint, "MAIN_PUSHED"),
          versionConsumed: isCheckpointAtLeast(existing.checkpoint, "REMOTE_TAG_PUSHED"),
          recovery: "不要手工修改 Tag 或 Release；先审计源码、HEAD 与远端状态。",
        },
      );
    }
    let inferred = existing;
    if (existing.checkpoint === "FULL_PASS") {
      const artifact = validateReleaseArtifactManifest({
        projectRoot: root,
        version: plan.targetVersion,
        currentHead: observed.localHead,
      });
      if (artifact.valid) {
        inferred = advanceReleaseCheckpoint(existing, "LOCAL_PACKAGE_VERIFIED", {
          localArtifact: artifact,
        });
      }
    }
    if (
      inferred.checkpoint === "LOCAL_PACKAGE_VERIFIED"
      && observed.localHead !== existing.sourceHead
    ) {
      const subject = spawnSync("git", ["log", "-1", "--format=%s", observed.localHead], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).stdout?.trim();
      const parent = spawnSync("git", ["rev-parse", `${observed.localHead}^`], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).stdout?.trim();
      if (
        subject === `chore: release ${plan.targetVersion}`
        && parent === existing.sourceHead
      ) {
        bindArtifactManifestToReleaseCommit(root, plan.targetVersion, observed.localHead);
        inferred = advanceReleaseCheckpoint(inferred, "RELEASE_COMMIT_CREATED", {
          releaseCommit: observed.localHead,
        });
      }
    }
    const checkpoint = isCheckpointAtLeast(plan.checkpoint, inferred.checkpoint)
      ? plan.checkpoint
      : inferred.checkpoint;
    if (
      isCheckpointAtLeast(checkpoint, "LOCAL_TAG_CREATED")
      && plan.targetTagCommit
      && plan.targetTagCommit !== inferred.releaseCommit
    ) {
      throw new SoftwarePublishError(
        "TARGET_TAG_SESSION_MISMATCH",
        `目标 Tag v${plan.targetVersion} 不属于当前发布恢复记录。`,
        {
          stage: "PREFLIGHT",
          classification: "STATE_CONFLICT",
          checkpoint,
          recoveryPoint: "BLOCK",
          sideEffects: true,
          versionConsumed: isCheckpointAtLeast(checkpoint, "REMOTE_TAG_PUSHED"),
        },
      );
    }
    if (["MAIN_PUSHED", "LOCAL_TAG_CREATED"].includes(checkpoint)) {
      const artifact = validateReleaseArtifactManifest({
        projectRoot: root,
        version: plan.targetVersion,
        currentHead: observed.localHead,
      });
      if (!artifact.valid) {
        throw new SoftwarePublishError(
          "STALE_LOCAL_ARTIFACT",
          `Tag 前本地产物已失效：${artifact.reasons.join(", ")}`,
          {
            stage: "PREFLIGHT",
            classification: "DETERMINISTIC_INTEGRITY",
            checkpoint,
            recoveryPoint: "BLOCK",
            sideEffects: checkpoint === "LOCAL_TAG_CREATED",
            versionConsumed: false,
          },
        );
      }
    }
    return {
      ...inferred,
      checkpoint,
      actions: observed.actions || existing.actions,
      release: observed.release || existing.release,
    };
  }
  if (["MAIN_PUSHED", "LOCAL_TAG_CREATED"].includes(plan.checkpoint)) {
    const artifact = validateReleaseArtifactManifest({
      projectRoot: root,
      version: plan.targetVersion,
      currentHead: observed.localHead,
    });
    if (!artifact.valid) {
      throw new SoftwarePublishError(
        "UNRECOVERABLE_RELEASE_STATE",
        `检测到发布副作用，但没有可验证的恢复记录/本地产物：${artifact.reasons.join(", ")}`,
        {
          stage: "PREFLIGHT",
          classification: "STATE_CONFLICT",
          checkpoint: plan.checkpoint,
          recoveryPoint: "BLOCK",
          sideEffects: true,
          versionConsumed: isCheckpointAtLeast(plan.checkpoint, "REMOTE_TAG_PUSHED"),
        },
      );
    }
  }
  return {
    schemaVersion: 1,
    targetVersion: plan.targetVersion,
    sourceVersion: plan.sourceVersion,
    sourceHead: observed.localHead,
    sourceFingerprint: fingerprint,
    buildTimestamp: plan.buildTimestamp,
    checkpoint: plan.checkpoint || "PLAN_READY",
    releaseCommit: plan.targetTagCommit || null,
    actions: observed.actions || null,
    release: observed.release || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function windowsCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return { executable, args };
  }
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/u.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", ["call", executable, ...args].map(quote).join(" ")],
  };
}

function command(executable, args, options = {}) {
  const normalized = windowsCommand(executable, args);
  const execute = () => {
    const result = spawnSync(normalized.executable, normalized.args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 100 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: { ...process.env, ...options.env },
      stdio: options.inherit ? "inherit" : "pipe",
    });
    if (result.error) throw result.error;
    const stdoutRaw = result.stdout || "";
    const stderrRaw = result.stderr || "";
    const stdout = stdoutRaw.trim();
    const stderr = stderrRaw.trim();
    if (result.status !== 0 && !options.allowFailure) {
      throw new SoftwarePublishError(
        "COMMAND_FAILED",
        `${executable} ${args.join(" ")} 执行失败（退出码 ${result.status ?? "未知"}）${stderr ? `：${stderr}` : ""}`,
        {
          stage: options.stage,
          classification: classifyReleaseFailure(`${result.error?.message || ""}\n${stderr}`),
        },
      );
    }
    return { status: result.status, stdout, stderr, stdoutRaw, stderrRaw };
  };
  if (!options.readOnlyNetwork) return execute();
  return retryReadOnlyNetworkOperationSync(
    `${executable} ${args.join(" ")}`,
    execute,
    { onAttempt: options.onAttempt },
  );
}

function git(args, options) {
  return command("git", args, options);
}

function gh(args, options) {
  return command("gh", args, options);
}

export function assertProjectRootConsistency({
  scriptRoot,
  resolvedProjectRoot,
  gitRoot,
  workingDirectory,
}) {
  const mismatches = [
    ["发布脚本目录", scriptRoot],
    ["解析后的项目根", resolvedProjectRoot],
    ["当前工作目录", workingDirectory],
  ].filter(([, value]) => !sameProjectPath(value, gitRoot));
  if (mismatches.length === 0) return canonicalizeProjectPath(gitRoot);

  throw new SoftwarePublishError(
    "INVALID_PROJECT_ROOT",
    [
      `发布入口、当前目录与 Git 顶层根目录不一致。Git 根：${path.resolve(gitRoot)}`,
      ...mismatches.map(([label, value]) => `${label}：${path.resolve(value)}`),
      "请从当前 Git 仓库根目录运行发布入口。",
    ].join("\n"),
  );
}

function assertRequiredProjectRoot() {
  const actual = git(["rev-parse", "--show-toplevel"]).stdout;
  assertProjectRootConsistency({
    scriptRoot: scriptProjectRoot,
    resolvedProjectRoot: projectRoot,
    gitRoot: actual,
    workingDirectory: process.cwd(),
  });
}

function assertCommandAvailable(name, friendlyName) {
  const result = command("where.exe", [name], { allowFailure: true });
  if (result.status !== 0) {
    throw new SoftwarePublishError(
      "MISSING_COMMAND",
      `未找到 ${friendlyName}（${name}），发布已停止。`,
    );
  }
}

function repositoryFromOrigin() {
  const origin = git(["remote", "get-url", "origin"]).stdout;
  const match = origin.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/iu);
  if (!match) {
    throw new SoftwarePublishError(
      "INVALID_ORIGIN",
      `origin 不是可识别的 GitHub 仓库：${origin}`,
    );
  }
  return match[1];
}

function strictTagVersion(value) {
  const version = String(value || "").replace(/^v/u, "");
  try {
    parseReleaseVersion(version);
    return version;
  } catch {
    return null;
  }
}

function releaseExists(repository, version) {
  return retryReadOnlyNetworkOperationSync(`GitHub Release v${version}`, () => {
    const result = gh(
      ["api", `repos/${repository}/releases/tags/v${version}`, "--jq", ".draft"],
      { allowFailure: true },
    );
    if (result.status === 0) return result.stdout.trim() !== "true";
    if (/HTTP 404|Not Found|release not found/iu.test(result.stderr)) return false;
    throw new SoftwarePublishError(
      "GITHUB_LOOKUP_FAILED",
      `无法确认 GitHub Release v${version} 是否存在：${result.stderr || "未知网络错误"}`,
      { classification: classifyReleaseFailure(result.stderr) },
    );
  });
}

function latestRelease(repository) {
  const value = JSON.parse(
    gh([
      "release",
      "view",
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url",
    ], { readOnlyNetwork: true }).stdout,
  );
  const version = strictTagVersion(value.tagName);
  if (!version || value.isDraft || value.isPrerelease) {
    throw new SoftwarePublishError(
      "INVALID_LATEST_RELEASE",
      "GitHub Latest Release 不是有效的正式语义化版本。",
    );
  }
  return { ...value, version };
}

function readVersions() {
  const packageValue = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const lockValue = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
  );
  return {
    sourceVersion: packageValue.version,
    lockVersion: lockValue.version,
    lockRootVersion: lockValue.packages?.[""]?.version,
  };
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function localTagCommit(version) {
  const result = git(["rev-parse", `v${version}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout : null;
}

function remoteTagCommit(version) {
  const result = git([
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/v${version}`,
    `refs/tags/v${version}^{}`,
  ], { readOnlyNetwork: true });
  const references = lines(result.stdout).map((line) => line.split(/\s+/u));
  return references.find(([, reference]) => reference.endsWith("^{}"))?.[0]
    || references[0]?.[0]
    || null;
}

function releaseWorkflowRuns(repository, version) {
  return JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      releaseWorkflow,
      "--branch",
      `v${version}`,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,headBranch,status,conclusion,event,createdAt,url,displayTitle",
    ], { readOnlyNetwork: true }).stdout || "[]",
  );
}

function targetTagExists(version) {
  if (git(["tag", "-l", `v${version}`]).stdout) return true;
  return retryReadOnlyNetworkOperationSync(`Remote Tag v${version}`, () => {
    const result = git(
      ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`],
      { allowFailure: true },
    );
    if (result.status === 0) return true;
    if (result.status === 2) return false;
    throw new SoftwarePublishError(
      "TAG_LOOKUP_FAILED",
      `无法确认远程 Tag v${version} 状态：${result.stderr || "未知网络错误"}`,
      { classification: classifyReleaseFailure(result.stderr) },
    );
  });
}

function collectPublishState(repository, resumeSession = null) {
  git(["fetch", "--quiet", "origin", "main", "--tags"], {
    readOnlyNetwork: true,
  });
  const branch = git(["branch", "--show-current"]).stdout;
  const dirty = Boolean(
    git(["-c", "core.quotepath=false", "status", "--short"]).stdout,
  );
  const [aheadText, behindText] = git([
    "rev-list",
    "--left-right",
    "--count",
    "main...origin/main",
  ]).stdout.split(/\s+/u);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  const release = latestRelease(repository);
  const tags = lines(git(["tag", "--list", "v*", "--sort=-v:refname"]).stdout)
    .map(strictTagVersion)
    .filter(Boolean);
  if (tags.length === 0) {
    throw new SoftwarePublishError("MISSING_TAG", "未找到任何正式 v* Git Tag。");
  }
  const versions = readVersions();
  if (versions.lockVersion !== versions.lockRootVersion) {
    throw new SoftwarePublishError(
      "LOCK_VERSION_MISMATCH",
      "package-lock.json 顶层版本与根包版本不一致。",
    );
  }
  const releaseTag = `v${release.version}`;
  const releaseAncestor = git(
    ["merge-base", "--is-ancestor", releaseTag, "HEAD"],
    { allowFailure: true },
  );
  if (releaseAncestor.status !== 0) {
    throw new SoftwarePublishError(
      "RELEASE_NOT_ANCESTOR",
      `${releaseTag} 不是当前 HEAD 的祖先，发布已停止。`,
    );
  }
  const commitsSinceRelease = lines(
    git(["log", `${releaseTag}..HEAD`, "--format=%h %s"]).stdout,
  );
  const commitsToPush = lines(
    git(["log", "origin/main..HEAD", "--format=%h %s"]).stdout,
  );
  const targetVersion = resumeSession?.targetVersion || (compareReleaseVersions(
    versions.sourceVersion,
    release.version,
  ) === 0
    ? nextPatchVersion(release.version)
    : versions.sourceVersion);
  const publishedTagCommit = localTagCommit(release.version);
  const publishedRemoteTagCommit = remoteTagCommit(release.version);
  const publishedRun = releaseWorkflowRuns(repository, release.version).find((run) =>
    run.status === "completed"
    && run.conclusion === "success"
    && run.event === "push"
    && run.headBranch === releaseTag
    && run.headSha === publishedTagCommit,
  );
  const historicalTags = tags
    .filter((version) =>
      compareReleaseVersions(version, release.version) > 0
      && version !== targetVersion,
    )
    .map((version) => {
      const tagCommit = localTagCommit(version);
      const ancestor = tagCommit
        ? git(["merge-base", "--is-ancestor", tagCommit, "main"], {
            allowFailure: true,
          })
        : { status: 1 };
      return {
        version,
        tagCommit,
        remoteTagCommit: remoteTagCommit(version),
        releaseExists: releaseExists(repository, version),
        isMainAncestor: ancestor.status === 0,
        workflowRuns: releaseWorkflowRuns(repository, version),
      };
    });
  const targetLocalTagCommit = localTagCommit(targetVersion);
  const targetRemoteTagCommit = remoteTagCommit(targetVersion);
  const targetReleaseExists = releaseExists(repository, targetVersion);
  const targetRuns = targetLocalTagCommit || targetRemoteTagCommit
    ? releaseWorkflowRuns(repository, targetVersion)
    : [];
  const targetCommit = targetRemoteTagCommit || targetLocalTagCommit;
  if (
    targetLocalTagCommit
    && targetRemoteTagCommit
    && targetLocalTagCommit !== targetRemoteTagCommit
  ) {
    throw new SoftwarePublishError(
      "TARGET_TAG_COMMIT_MISMATCH",
      `目标 v${targetVersion} 的本地与远程 Tag 提交不一致。`,
      { stage: "PREFLIGHT", classification: "STATE_CONFLICT" },
    );
  }
  if (targetCommit) {
    const targetAncestor = git(
      ["merge-base", "--is-ancestor", targetCommit, "main"],
      { allowFailure: true },
    );
    if (targetAncestor.status !== 0) {
      throw new SoftwarePublishError(
        "TARGET_TAG_NOT_MAIN_ANCESTOR",
        `目标 v${targetVersion} 的 Tag 提交不是 main 祖先。`,
        { stage: "PREFLIGHT", classification: "STATE_CONFLICT" },
      );
    }
  }
  const targetRun = targetRuns.find((run) =>
    run.event === "push"
    && run.headBranch === `v${targetVersion}`
    && run.headSha === targetCommit,
  );
  let checkpoint = "PLAN_READY";
  if (targetLocalTagCommit) checkpoint = "LOCAL_TAG_CREATED";
  if (targetRemoteTagCommit) checkpoint = "REMOTE_TAG_PUSHED";
  if (targetRun?.status === "completed" && targetRun.conclusion === "success") {
    checkpoint = "GITHUB_ACTIONS_SUCCESS";
    if (targetReleaseExists) checkpoint = "GITHUB_RELEASE_CREATED";
  }
  const localHead = git(["rev-parse", "HEAD"]).stdout;
  const remoteMainHead = git(["rev-parse", "origin/main"]).stdout;
  if (!targetLocalTagCommit && resumeSession?.releaseCommit === localHead) {
    checkpoint = "RELEASE_COMMIT_CREATED";
    if (remoteMainHead === localHead) checkpoint = "MAIN_PUSHED";
  }
  if (
    resumeSession?.checkpoint
    && isCheckpointAtLeast(resumeSession.checkpoint, checkpoint)
  ) {
    checkpoint = resumeSession.checkpoint;
  }
  const publishPlan = createSoftwarePublishPlan({
      dirty,
      branch,
      ahead,
      behind,
      commitsToPush,
      commitsSinceRelease,
      sourceVersion: versions.sourceVersion,
      lockVersion: versions.lockVersion,
      latestReleaseVersion: release.version,
      latestPublishedRelease: {
        version: release.version,
        releaseExists: true,
        tagExists: Boolean(publishedTagCommit && publishedRemoteTagCommit),
        tagCommit: publishedTagCommit,
        remoteTagCommit: publishedRemoteTagCommit,
        releaseCommit: publishedRun?.headSha,
      },
      historicalTags,
      targetLocalTagExists: Boolean(targetLocalTagCommit),
      targetRemoteTagExists: Boolean(targetRemoteTagCommit),
      targetTagCommit: targetCommit,
      targetReleaseExists,
      releaseWorkflowState: targetRun || {
        status: targetRemoteTagCommit ? "queued" : "not_started",
        conclusion: null,
      },
      checkpoint,
      targetVersionOverride: resumeSession?.targetVersion,
      resume: Boolean(resumeSession),
    });
  const localArtifactState = validateReleaseArtifactManifest({
    projectRoot,
    version: targetVersion,
    currentHead: localHead,
  });
  return {
    ...publishPlan,
    release,
    localHead,
    remoteMainHead,
    targetRun,
    releaseState: {
      schemaVersion: 1,
      stateType: targetRemoteTagCommit
        ? targetReleaseExists
          ? "PUBLISHED_RELEASE"
          : targetRun?.status === "completed" && targetRun?.conclusion !== "success"
            ? "FAILED_RELEASE_TAG"
            : "IN_PROGRESS_RELEASE"
        : "TARGET_VERSION",
      sourceVersion: versions.sourceVersion,
      sourceType: "UNPUBLISHED_SOURCE",
      workingTreeClean: !dirty,
      localHead,
      remoteMainHead,
      ahead,
      behind,
      latestPublishedVersion: release.version,
      latestPublishedTag: releaseTag,
      latestPublishedCommit: publishedTagCommit,
      historicalTags: publishPlan.historicalReleaseStates,
      failedReleaseTags: publishPlan.failedReleaseTags,
      inProgressReleaseTags: publishPlan.inProgressReleaseTags,
      unknownOrphanTags: publishPlan.unknownOrphanTags,
      targetVersion,
      targetLocalTagExists: Boolean(targetLocalTagCommit),
      targetRemoteTagExists: Boolean(targetRemoteTagCommit),
      targetReleaseExists,
      targetTagCommit: targetCommit,
      mainCiState: { status: "unknown", conclusion: null },
      releaseWorkflowState: publishPlan.releaseWorkflowState,
      localArtifactState,
      remoteArtifactState: targetReleaseExists
        ? { status: "PENDING_VERIFY" }
        : { status: "MISSING" },
      checkpoint,
      recoveryPoint: checkpoint === "PLAN_READY" ? "PREFLIGHT" : "RESUME",
      versionConsumed: Boolean(targetRemoteTagCommit),
    },
  };
}

function collectPublishStateForPreflight(repository, resumeSession = null) {
  try {
    return collectPublishState(repository, resumeSession);
  } catch (error) {
    if (error instanceof SoftwarePublishError) {
      error.stage ||= "PREFLIGHT";
      error.checkpoint ||= resumeSession?.checkpoint || "PLAN_READY";
      error.recoveryPoint ||= "PREFLIGHT";
      error.sideEffects ??= isCheckpointAtLeast(
        resumeSession?.checkpoint || "PLAN_READY",
        "MAIN_PUSHED",
      );
      error.versionConsumed ??= isCheckpointAtLeast(
        resumeSession?.checkpoint || "PLAN_READY",
        "REMOTE_TAG_PUSHED",
      );
      error.recovery ||= "网络或状态恢复后重新运行 发布新版.bat。";
      throw error;
    }
    throw new SoftwarePublishError(
      "PREFLIGHT_STATE_FAILED",
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
        stage: "PREFLIGHT",
        classification: classifyReleaseFailure(error),
        checkpoint: resumeSession?.checkpoint || "PLAN_READY",
        recoveryPoint: "PREFLIGHT",
        sideEffects: false,
        versionConsumed: false,
        recovery: "网络或环境恢复后重新运行 发布新版.bat。",
      },
    );
  }
}

function printPlan(plan, logger) {
  logger.line("========================================");
  logger.line("VERIDIA 正式软件发布");
  logger.line("========================================");
  logger.line(`Latest Published Release：v${plan.latestPublishedReleaseVersion}`);
  logger.line(`Latest Historical Tag：v${plan.latestHistoricalTagVersion}`);
  logger.line("Failed Release Tags：");
  if (plan.failedReleaseTags.length === 0) logger.line("- 无");
  for (const tag of plan.failedReleaseTags) {
    logger.line(
      `- v${tag.version}（Historical Failed Attempt；Run ${tag.workflowRunId}，${tag.workflowConclusion}）`,
    );
  }
  logger.line(`Target：${plan.targetVersion}`);
  logger.line(`HEAD：${plan.localHead || "待确认"}`);
  logger.line(`Resume：${checkpointLabel(plan.checkpoint || "PLAN_READY")}`);
  logger.line("");
  logger.line(`待 Push 提交：${plan.commitsToPush.length} 个`);
  for (const commit of plan.commitsToPush) logger.line(`- ${commit}`);
  if (plan.commitsToPush.length === 0) logger.line("- 无（提交已在 origin/main）");
  logger.line("");
  logger.line("本次版本包含的 Release 后提交：");
  for (const commit of plan.commitsSinceRelease) logger.line(`- ${commit}`);
  logger.line("");
  logger.line("工作区：干净");
  logger.line(`main ahead：${plan.ahead}`);
  logger.line(`main behind：${plan.behind}`);
  logger.line("");
  logger.line("发布阶段：");
  for (const [index, name, checkpoint] of [
    [1, "Preflight", "PREFLIGHT_PASS"],
    [2, "FULL + Build", "FULL_PASS"],
    [3, "Package", "LOCAL_PACKAGE_VERIFIED"],
    [4, "Release Commit", "RELEASE_COMMIT_CREATED"],
    [5, "Push main + Main CI", "MAIN_PUSHED"],
    [6, "Local Tag", "LOCAL_TAG_CREATED"],
    [7, "Push Tag", "REMOTE_TAG_PUSHED"],
    [8, "GitHub Actions", "GITHUB_ACTIONS_SUCCESS"],
    [9, "GitHub Release", "GITHUB_RELEASE_CREATED"],
    [10, "Remote Verify", "RELEASE_COMPLETE"],
  ]) {
    const status = isCheckpointAtLeast(plan.checkpoint || "PLAN_READY", checkpoint)
      ? "PASS"
      : "WAITING";
    logger.line(`[${index}/10] ${name.padEnd(20)} ${status}`);
  }
  logger.line("");
}

export function parseGitPorcelainPaths(value) {
  const output = String(value || "");
  if (!output) return [];
  if (output.includes("\0")) {
    const records = output.split("\0");
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== " ") {
        throw new SoftwarePublishError(
          "INVALID_GIT_STATUS",
          `无法解析 Git porcelain 记录：${JSON.stringify(record)}`,
        );
      }
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (/[RC]/u.test(status)) index += 1;
    }
    return paths;
  }

  return output
    .split("\n")
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.length < 4 || line[2] !== " ") {
        throw new SoftwarePublishError(
          "INVALID_GIT_STATUS",
          `无法解析 Git porcelain 行：${JSON.stringify(line)}`,
        );
      }
      const status = line.slice(0, 2);
      const payload = line.slice(3);
      if (!/[RC]/u.test(status)) return payload;
      const separator = payload.lastIndexOf(" -> ");
      return separator >= 0 ? payload.slice(separator + 4) : payload;
    });
}

export function assertOnlyVersionFiles(changed) {
  const allowed = new Set(["package.json", "package-lock.json"]);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new SoftwarePublishError(
      "UNEXPECTED_RELEASE_CHANGES",
      `发布验证产生了非版本文件修改：\n${unexpected.join("\n")}`,
    );
  }
}

function assertOnlyVersionFilesChanged() {
  const result = git([
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  assertOnlyVersionFiles(parseGitPorcelainPaths(result.stdoutRaw));
}

function assertNoGoogleFontBuildDependency() {
  const tracked = lines(git(["ls-files"]).stdout).filter(
    (file) =>
      !file.startsWith("tests/") &&
      !file.startsWith("assets/fonts/") &&
      !file.startsWith("scripts/software-publish-orchestrator"),
  );
  const forbidden = /next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/iu;
  const matches = [];
  for (const relative of tracked) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    if (forbidden.test(buffer.toString("utf8"))) matches.push(relative);
  }
  if (matches.length > 0) {
    throw new SoftwarePublishError(
      "GOOGLE_FONTS_DEPENDENCY",
      `正式源码重新出现 Google Fonts 外网依赖：\n${matches.join("\n")}`,
    );
  }
}

function updateVersionFiles(plan, state) {
  const packagePath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  state.originals = new Map([
    [packagePath, fs.readFileSync(packagePath)],
    [lockPath, fs.readFileSync(lockPath)],
  ]);
  if (plan.versionChangeRequired) {
    command("npm.cmd", [
      "version",
      plan.targetVersion,
      "--no-git-tag-version",
    ], { inherit: true });
  }
  const versions = readVersions();
  if (
    versions.sourceVersion !== plan.targetVersion ||
    versions.lockVersion !== plan.targetVersion ||
    versions.lockRootVersion !== plan.targetVersion
  ) {
    throw new SoftwarePublishError(
      "VERSION_UPDATE_FAILED",
      `版本字段未统一更新为 ${plan.targetVersion}。`,
    );
  }
}

function restoreVersionFiles(state) {
  for (const [file, content] of state.originals || []) {
    fs.writeFileSync(file, content);
  }
  command("git", ["add", "package.json", "package-lock.json"], {
    allowFailure: true,
  });
}

function structuredSoftwareError(result, fallback) {
  return new SoftwarePublishError(
    "RELEASE_STAGE_FAILED",
    redactReleaseText(result?.summary || fallback.message).slice(0, 1_200),
    {
      stage: result?.stage || fallback.stage,
      classification:
        result?.classification ||
        classifyReleaseFailure(fallback.message, fallback.classification),
      command: redactReleaseText(result?.command || fallback.command || "") || undefined,
      detailLog: result?.detailLog || fallback.detailLog,
      target: redactReleaseText(result?.target || "") || undefined,
      failedItem: redactReleaseText(result?.failedItem || "") || undefined,
      attempt: result?.attempt,
      maxAttempts: result?.maxAttempts,
      elapsedMs: result?.elapsedMs,
      cacheStatus: redactReleaseText(result?.cacheStatus || "") || undefined,
      checkpoint: result?.checkpoint || fallback.checkpoint,
      recoveryPoint: result?.recoveryPoint || fallback.recoveryPoint,
      sideEffects: result?.sideEffects ?? fallback.sideEffects,
      versionConsumed: result?.versionConsumed ?? fallback.versionConsumed,
      recovery: redactReleaseText(result?.recovery || fallback.recovery || "") || undefined,
    },
  );
}

function readStructuredResult(file, combinedOutput = "") {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Fall back to the child process marker.
    }
  }
  return parseReleaseResult(combinedOutput);
}

function runReleasePreflight(plan, logger) {
  logger.line("开始 Release Preflight 与发布依赖预热（正式 FULL 之前）。");
  const stateFile = path.join(
    projectRoot,
    ".release-work",
    "checkpoints",
    `release-state-${plan.targetVersion}.json`,
  );
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(plan.releaseState, null, 2)}\n`, "utf8");
  const result = command(
    "node",
    [
      path.join(projectRoot, "scripts", "release-preflight.mjs"),
      `--target-version=${plan.targetVersion}`,
      `--release-state=${stateFile}`,
    ],
    { allowFailure: true, timeoutMs: 120_000 },
  );
  logger.write(result.stdoutRaw);
  logger.write(result.stderrRaw);
  if (result.status !== 0) {
    const structured = parseReleaseResult(`${result.stdoutRaw}\n${result.stderrRaw}`);
    throw structuredSoftwareError(structured, {
      stage: "PREFLIGHT",
      classification: "ENVIRONMENT",
      command: `node scripts/release-preflight.mjs --target-version=${plan.targetVersion}`,
      message: `Release Preflight 失败，退出码 ${result.status ?? "未知"}`,
      detailLog: logger.logPath,
    });
  }
  logger.line("Release Preflight 与依赖预热通过，即将进入正式 FULL。");
}

function runFullValidation(plan, logger) {
  logger.line("开始完整正式发布门禁（FULL 内含唯一一次正式 Next.js Build）。");
  assertNoGoogleFontBuildDependency();
  git(["diff", "--check"]);
  try {
    fs.rmSync(path.join(projectRoot, ".release-work", "release-result.json"), {
      force: true,
    });
    command("node", [
      path.join(projectRoot, "scripts", "release.mjs"),
      "current",
      "--stage=full",
    ], {
      inherit: true,
      env: {
        VERIDIA_APP_VERSION: plan.targetVersion,
        VERIDIA_BUILD_DATE: plan.buildTimestamp,
      },
    });
  } catch (error) {
    const resultFile = path.join(
      projectRoot,
      ".release-work",
      "release-result.json",
    );
    const structured = readStructuredResult(resultFile);
    throw structuredSoftwareError(structured, {
      stage: "FULL",
      classification: "DETERMINISTIC",
      command: "node scripts/release.mjs current --stage=full",
      message: error instanceof Error ? error.message : String(error),
      detailLog: path.join(projectRoot, ".release-work", "logs"),
    });
  }
  assertOnlyVersionFilesChanged();
  assertNoGoogleFontBuildDependency();
  git(["diff", "--check"]);
  logger.line("完整门禁与 Google Fonts 检查通过；FULL 构建将由 Package 直接复用。");
}

function runLocalPackage(plan, logger) {
  logger.line("开始本地 electron-builder Package；不重复 FULL 或 Next.js Build。");
  try {
    command("node", [
      path.join(projectRoot, "scripts", "release.mjs"),
      "current",
      "--stage=package",
    ], {
      inherit: true,
      env: {
        VERIDIA_APP_VERSION: plan.targetVersion,
        VERIDIA_BUILD_DATE: plan.buildTimestamp,
      },
    });
    command("node", [path.join(projectRoot, "scripts", "validate-software-release.mjs")], {
      inherit: true,
    });
  } catch (error) {
    const resultFile = path.join(projectRoot, ".release-work", "release-result.json");
    const structured = readStructuredResult(resultFile);
    throw structuredSoftwareError(structured, {
      stage: "PACKAGE",
      classification: "DETERMINISTIC",
      command: "node scripts/release.mjs current --stage=package",
      message: error instanceof Error ? error.message : String(error),
      detailLog: path.join(projectRoot, ".release-work", "logs"),
    });
  }
  const manifest = writeReleaseArtifactManifest({
    projectRoot,
    version: plan.targetVersion,
    buildTimestamp: plan.buildTimestamp,
  });
  logger.line(`本地三件套与源码指纹已绑定：${manifest.sourceFingerprint}`);
  return manifest;
}

function commitVersion(plan) {
  git(["add", "package.json", "package-lock.json"]);
  git(["diff", "--cached", "--check"]);
  const staged = git(["diff", "--cached", "--quiet"], { allowFailure: true });
  const args = ["commit"];
  if (staged.status === 0) args.push("--allow-empty");
  args.push("-m", `chore: release ${plan.targetVersion}`);
  git(args);
}

function assertMainSynchronized() {
  git(["fetch", "--quiet", "origin", "main"], { readOnlyNetwork: true });
  const [ahead, behind] = git([
    "rev-list",
    "--left-right",
    "--count",
    "main...origin/main",
  ]).stdout.split(/\s+/u);
  if (ahead !== "0" || behind !== "0") {
    throw new SoftwarePublishError(
      "MAIN_NOT_SYNCHRONIZED",
      `Push 后 main 未与 origin/main 同步（ahead ${ahead} / behind ${behind}）。`,
    );
  }
}

function assertTargetAvailable(repository, plan) {
  if (targetTagExists(plan.targetVersion)) {
    throw new SoftwarePublishError(
      "TARGET_TAG_EXISTS",
      `目标 Tag v${plan.targetVersion} 已存在，拒绝覆盖。`,
    );
  }
  if (releaseExists(repository, plan.targetVersion)) {
    throw new SoftwarePublishError(
      "TARGET_RELEASE_EXISTS",
      `GitHub Release v${plan.targetVersion} 已存在，拒绝重复发布。`,
    );
  }
}

function actionsRun(repository, tag, headSha) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      releaseWorkflow,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,headBranch,headSha,status,conclusion,url,createdAt",
    ], { readOnlyNetwork: true }).stdout,
  );
  return runs.find(
    (run) => run.headBranch === tag && run.headSha === headSha,
  );
}

function mainCiRun(repository, headSha) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      "veridia-ci.yml",
      "--event",
      "push",
      "--branch",
      "main",
      "--limit",
      "20",
      "--json",
      "databaseId,headBranch,headSha,status,conclusion,url,createdAt",
    ], { readOnlyNetwork: true }).stdout || "[]",
  );
  return runs.find((run) => run.headBranch === "main" && run.headSha === headSha);
}

async function waitForMainCi(repository, plan, logger) {
  const headSha = git(["rev-parse", "HEAD"]).stdout;
  const discoveryDeadline = Date.now() + 5 * 60_000;
  let run;
  while (!run && Date.now() < discoveryDeadline) {
    run = mainCiRun(repository, headSha);
    if (!run) await sleep(10_000);
  }
  if (!run) {
    throw new SoftwarePublishError(
      "MAIN_CI_NOT_FOUND",
      `Push main 后 5 分钟内未找到 HEAD ${headSha} 的 Main CI。`,
      { stage: "MAIN_CI", classification: "STATE_CONFLICT" },
    );
  }
  logger.line(`Main CI 已启动，Run ID：${run.databaseId}`);
  const deadline = Date.now() + 70 * 60_000;
  while (Date.now() < deadline) {
    run = JSON.parse(
      gh([
        "run",
        "view",
        String(run.databaseId),
        "--repo",
        repository,
        "--json",
        "databaseId,status,conclusion,url,jobs",
      ], { readOnlyNetwork: true }).stdout,
    );
    if (run.status === "completed") break;
    await sleep(30_000);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new SoftwarePublishError(
      "MAIN_CI_FAILED",
      `Main CI 未成功：${run.status}/${run.conclusion || ""} ${run.url || ""}`,
      { stage: "MAIN_CI", classification: "DETERMINISTIC" },
    );
  }
  logger.line(`Main CI：SUCCESS（${run.url}）`);
  return { success: true, id: run.databaseId, url: run.url, headSha };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForActions(repository, plan, logger) {
  const tag = `v${plan.targetVersion}`;
  const headSha = git(["rev-parse", "HEAD"]).stdout;
  const discoveryDeadline = Date.now() + 5 * 60_000;
  let run;
  while (!run && Date.now() < discoveryDeadline) {
    run = actionsRun(repository, tag, headSha);
    if (!run) await sleep(10_000);
  }
  if (!run) {
    throw new SoftwarePublishError(
      "ACTIONS_NOT_FOUND",
      `推送 ${tag} 后 5 分钟内未找到 GitHub Actions 运行记录。`,
    );
  }
  logger.line(`GitHub Actions 已启动，Run ID：${run.databaseId}`);
  logger.line(`Actions：${run.url}`);
  const deadline = Date.now() + 90 * 60_000;
  let previousStatus;
  while (Date.now() < deadline) {
    run = JSON.parse(
      gh([
        "run",
        "view",
        String(run.databaseId),
        "--repo",
        repository,
        "--json",
        "databaseId,status,conclusion,url,jobs",
      ], { readOnlyNetwork: true }).stdout,
    );
    const status = `${run.status}/${run.conclusion || ""}`;
    if (status !== previousStatus) {
      logger.line(`GitHub Actions：${status}`);
      previousStatus = status;
    }
    if (run.status === "completed") break;
    await sleep(30_000);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    const failed = [];
    for (const job of run.jobs || []) {
      if (job.conclusion === "failure") failed.push(`Job：${job.name}`);
      for (const step of job.steps || []) {
        if (step.conclusion === "failure") failed.push(`Step：${step.name}`);
      }
    }
    const failedLog = path.join(
      projectRoot,
      ".release-work",
      "logs",
      `github-actions-${run.databaseId}-failed.log`,
    );
    const details = gh(
      ["run", "view", String(run.databaseId), "--repo", repository, "--log-failed"],
      { allowFailure: true },
    );
    fs.writeFileSync(failedLog, `${details.stdout}\n${details.stderr}`, "utf8");
    logger.line(failed.join("\n") || "GitHub Actions 未成功完成。");
    logger.line(`失败日志：${failedLog}`);
    return { success: false, url: run.url, id: run.databaseId };
  }
  return { success: true, url: run.url, id: run.databaseId };
}

async function fetchAndHash(url, collect = false) {
  return retryReadOnlyNetworkOperation(`Release asset GET ${url}`, async () => {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) {
    throw new SoftwarePublishError(
      "ASSET_HTTP_FAILED",
      `发布资源无法访问（HTTP ${response.status}）：${url}`,
    );
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    sha256.update(buffer);
    sha512.update(buffer);
    if (collect) chunks.push(buffer);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
    buffer: collect ? Buffer.concat(chunks) : null,
  };
  }, { attempts: 2, backoffMs: 500 });
}

function yamlValue(text, expression) {
  return String(text.match(expression)?.[1] || "")
    .trim()
    .replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
}

async function verifyRemoteRelease(repository, plan, actions, logger) {
  const tag = `v${plan.targetVersion}`;
  const release = JSON.parse(
    gh([
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url,assets",
    ], { readOnlyNetwork: true }).stdout,
  );
  if (
    release.tagName !== tag ||
    release.name !== `VERIDIA ${plan.targetVersion}` ||
    release.isDraft ||
    release.isPrerelease
  ) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_RELEASE",
      `GitHub Release ${tag} 的标题或发布状态不正确。`,
    );
  }
  const latest = JSON.parse(
    gh([
      "release",
      "view",
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url",
    ], { readOnlyNetwork: true }).stdout,
  );
  if (latest.tagName !== tag) {
    throw new SoftwarePublishError(
      "NOT_LATEST_RELEASE",
      `GitHub Latest Release 未指向 ${tag}。`,
    );
  }
  const installerName = `VERIDIA-Setup-${plan.targetVersion}.exe`;
  const requiredAssets = [installerName, `${installerName}.blockmap`, "latest.yml"];
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const name of requiredAssets) {
    if (!assets.has(name)) {
      throw new SoftwarePublishError(
        "MISSING_REMOTE_ASSET",
        `GitHub Release 缺少 ${name}。`,
      );
    }
  }
  const latestAsset = assets.get("latest.yml");
  const latestDownload = await fetchAndHash(latestAsset.url, true);
  const latestText = latestDownload.buffer.toString("utf8");
  const latestVersion = yamlValue(latestText, /^version:\s*(.+)$/mu);
  const latestPath = yamlValue(latestText, /^path:\s*(.+)$/mu);
  const latestUrl = yamlValue(latestText, /^\s*-\s*url:\s*(.+)$/mu);
  const latestSize = Number(latestText.match(/^\s+size:\s*(\d+)$/mu)?.[1]);
  const latestSha512 = yamlValue(latestText, /^\s+sha512:\s*(.+)$/mu);
  const blockmapAsset = assets.get(`${installerName}.blockmap`);
  const blockmap = await fetchAndHash(blockmapAsset.url, true);
  let blockmapValue;
  try {
    blockmapValue = JSON.parse(gunzipSync(blockmap.buffer).toString("utf8"));
  } catch (error) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_BLOCKMAP",
      `远程 blockmap 无法解析：${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(blockmapValue.files) || blockmapValue.files.length === 0) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_BLOCKMAP",
      "远程 blockmap 不包含有效文件块。",
    );
  }
  const installerAsset = assets.get(installerName);
  logger.line("正在流式校验远程 EXE 的大小、SHA-256 和 SHA-512...");
  const installer = await fetchAndHash(installerAsset.url);
  if (
    latestVersion !== plan.targetVersion ||
    latestPath !== installerName ||
    latestUrl !== installerName ||
    latestSize !== installer.size ||
    latestSha512 !== installer.sha512 ||
    installerAsset.size !== installer.size ||
    (installerAsset.digest && installerAsset.digest !== `sha256:${installer.sha256}`)
  ) {
    throw new SoftwarePublishError(
      "REMOTE_METADATA_MISMATCH",
      "远程 latest.yml 与 EXE 的版本、文件名、大小或摘要不一致。",
    );
  }
  for (const [asset, downloaded] of [
    [latestAsset, latestDownload],
    [blockmapAsset, blockmap],
  ]) {
    if (
      asset.size !== downloaded.size ||
      (asset.digest && asset.digest !== `sha256:${downloaded.sha256}`)
    ) {
      throw new SoftwarePublishError(
        "REMOTE_ASSET_MISMATCH",
        `远程资源大小或摘要不一致：${asset.name}`,
      );
    }
  }
  return {
    url: release.url,
    actionsUrl: actions?.url,
    installerName,
    installerSize: installer.size,
    installerSha256: installer.sha256,
  };
}

async function confirmPublish() {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question("是否继续正式发布？ [Y/N] ")).trim();
    return /^y(?:es)?$/iu.test(answer);
  } finally {
    input.close();
  }
}

async function main() {
  const logger = createLogger();
  logger.line("========================================");
  logger.line("VERIDIA 正式发布");
  logger.line("========================================");
  logger.line("正在执行发布前检查...");
  logger.line(`开始时间：${new Date().toISOString()}`);
  logger.line(`当前目录：${projectRoot}`);
  logger.line(`模式：${dryRun ? "DRY RUN" : "正式发布"}`);
  logger.line(`日志：${logger.logPath}`);
  try {
    assertRequiredProjectRoot();
    for (const [name, friendly] of [
      ["git.exe", "Git"],
      ["gh.exe", "GitHub CLI"],
      ["npm.cmd", "npm"],
    ]) {
      assertCommandAvailable(name, friendly);
    }
    gh(["auth", "status"], { stage: "PREFLIGHT" });
    const repository = repositoryFromOrigin();
    gh(["api", `repos/${repository}`, "--silent"], {
      readOnlyNetwork: true,
      stage: "PREFLIGHT",
    });
    let activeSession = findActiveSoftwareReleaseSession(projectRoot);
    const currentSourceVersion = readVersions().sourceVersion;
    if (
      activeSession
      && isCheckpointAtLeast(activeSession.checkpoint, "REMOTE_TAG_PUSHED")
      && compareReleaseVersions(currentSourceVersion, activeSession.targetVersion) > 0
    ) {
      activeSession = null;
    }
    const plan = collectPublishStateForPreflight(repository, activeSession);
    logger.line(`当前 HEAD：${git(["rev-parse", "HEAD"]).stdout}`);
    if (plan.kind === "none") {
      logger.line("当前没有待发布的新提交。");
      logger.line("没有修改版本、Push、创建 Tag 或 Release。");
      logger.line("本次未发布远程规则。");
      return;
    }
    printPlan(plan, logger);
    if (dryRun) {
      logger.line("DRY RUN 完成：未修改版本、未提交、未 Push、未创建 Tag 或 Release。");
      logger.line("本次未发布远程规则。");
      return;
    }
    if (!(await confirmPublish())) {
      logger.line("用户已取消，未修改本地或远程状态。");
      return;
    }
    const current = collectPublishStateForPreflight(repository, activeSession);
    if (
      current.kind !== "release" ||
      current.targetVersion !== plan.targetVersion ||
      current.ahead !== plan.ahead ||
      current.behind !== plan.behind
    ) {
      throw new SoftwarePublishError(
        "PLAN_CHANGED",
        "确认后 Git 或 Release 状态发生变化，请重新运行发布脚本。",
      );
    }
    const state = { originals: null };
    const session = resolveSoftwareReleaseSession(projectRoot, current, {
      localHead: current.localHead,
      actions: current.targetRun?.conclusion === "success"
        ? {
            success: true,
            id: current.targetRun.databaseId,
            url: current.targetRun.url,
          }
        : null,
      release: current.targetReleaseExists ? { url: current.release.url } : null,
    });
    current.checkpoint = session.checkpoint;
    current.buildTimestamp = session.buildTimestamp;
    current.releaseState.checkpoint = session.checkpoint;
    writeSoftwareReleaseSession(projectRoot, current.targetVersion, session);
    const result = await executeSoftwarePublishPlan(current, {
      dryRun: false,
      session,
      onCheckpoint: async (value) => {
        const updated = {
          ...value,
          sourceVersion: readVersions().sourceVersion,
          sourceFingerprint: collectReleaseSourceFingerprint(projectRoot),
        };
        writeSoftwareReleaseSession(projectRoot, current.targetVersion, updated);
        return updated;
      },
      operations: {
        preflight: async () => runReleasePreflight(current, logger),
        updateVersion: async () => updateVersionFiles(current, state),
        validate: async () => runFullValidation(current, logger),
        package: async () => runLocalPackage(current, logger),
        verifyLocalArtifact: async () => {
          const artifact = validateReleaseArtifactManifest({
            projectRoot,
            version: current.targetVersion,
          });
          if (!artifact.valid) {
            throw new SoftwarePublishError(
              "STALE_LOCAL_ARTIFACT",
              `本地产物未绑定当前源码：${artifact.reasons.join(", ")}`,
              { stage: "INSTALLER_VERIFY", classification: "DETERMINISTIC_INTEGRITY" },
            );
          }
          return artifact;
        },
        commitVersion: async () => commitVersion(current),
        releaseCommit: async () => git(["rev-parse", "HEAD"]).stdout,
        bindArtifact: async (_value, releaseCommit) =>
          bindArtifactManifestToReleaseCommit(
            projectRoot,
            current.targetVersion,
            releaseCommit,
          ),
        restoreVersion: async () => restoreVersionFiles(state),
        pushMain: async () => {
          logger.line("正在一次性 Push 开发提交和版本提交到 origin/main...");
          git(["push", "origin", "main"]);
        },
        assertMainSynchronized: async () => assertMainSynchronized(),
        waitForMainCi: async () => waitForMainCi(repository, current, logger),
        assertTargetAvailable: async () => assertTargetAvailable(repository, current),
        createTag: async () =>
          git(["tag", "-a", `v${current.targetVersion}`, "-m", `VERIDIA ${current.targetVersion}`]),
        pushTag: async () => git(["push", "origin", `v${current.targetVersion}`]),
        waitForActions: async () => waitForActions(repository, current, logger),
        verifyRelease: async (_value, actions) =>
          verifyRemoteRelease(repository, current, actions, logger),
      },
    });
    assertMainSynchronized();
    const status = git(["status", "--short"]).stdout;
    if (status) {
      throw new SoftwarePublishError(
        "DIRTY_AFTER_RELEASE",
        `发布完成后工作区不干净：\n${status}`,
      );
    }
    logger.line("========================================");
    logger.line(`VERIDIA ${plan.targetVersion} 正式发布成功`);
    logger.line("========================================");
    logger.line(`软件版本：${plan.targetVersion}`);
    logger.line(`Commit：${git(["rev-parse", "HEAD"]).stdout}`);
    logger.line("Git main：ahead 0 / behind 0");
    logger.line(`Tag：v${plan.targetVersion}`);
    logger.line("GitHub Actions：SUCCESS");
    logger.line(`GitHub Release：${result.release.url}`);
    logger.line("三件套：✓ EXE / ✓ blockmap / ✓ latest.yml");
    logger.line(
      `安装包大小：${(result.release.installerSize / 1024 / 1024).toFixed(2)} MB`,
    );
    logger.line(`SHA-256：${result.release.installerSha256}`);
    logger.line("Auto Update：READY");
    logger.line("Git：CLEAN");
    logger.line("本次未执行 rules:publish，本次未发布远程规则。");
    logger.line("RELEASE = PASS");
  } catch (error) {
    logger.line("");
    for (const line of formatSoftwarePublishFailure(error, logger.logPath)) {
      logger.line(line);
    }
    logger.line("不会自动 reset、rebase、覆盖 Tag 或重试发布。");
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();
