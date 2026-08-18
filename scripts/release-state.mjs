export const RELEASE_STATE_SCHEMA_VERSION = 1;

export const RELEASE_STATUS_TYPES = Object.freeze([
  "PUBLISHED_RELEASE",
  "FAILED_RELEASE_TAG",
  "IN_PROGRESS_RELEASE",
  "TARGET_VERSION",
  "UNPUBLISHED_SOURCE",
  "UNKNOWN_ORPHAN_TAG",
  "INVALID_RELEASE_STATE",
]);

export const RELEASE_CHECKPOINTS = Object.freeze([
  "PLAN_READY",
  "PREFLIGHT_PASS",
  "FULL_PASS",
  "LOCAL_PACKAGE_VERIFIED",
  "RELEASE_COMMIT_CREATED",
  "MAIN_PUSHED",
  "LOCAL_TAG_CREATED",
  "REMOTE_TAG_PUSHED",
  "GITHUB_ACTIONS_SUCCESS",
  "GITHUB_RELEASE_CREATED",
  "REMOTE_ASSETS_VERIFIED",
  "RELEASE_COMPLETE",
]);

const failedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);
const activeStatuses = new Set(["in_progress", "queued", "requested", "waiting"]);

function checkpointIndex(checkpoint) {
  return RELEASE_CHECKPOINTS.indexOf(checkpoint);
}

export function checkpointLabel(checkpoint) {
  const index = checkpointIndex(checkpoint);
  if (index < 0) return `UNKNOWN / ${checkpoint || "empty"}`;
  return `CHECKPOINT_${index} / ${checkpoint}`;
}

export function isCheckpointAtLeast(checkpoint, expected) {
  return checkpointIndex(checkpoint) >= checkpointIndex(expected);
}

export function advanceReleaseCheckpoint(session, checkpoint, patch = {}) {
  const currentIndex = checkpointIndex(session?.checkpoint || "PLAN_READY");
  const nextIndex = checkpointIndex(checkpoint);
  if (nextIndex < 0) throw new Error(`Unknown release checkpoint: ${checkpoint}`);
  if (nextIndex < currentIndex) {
    throw new Error(
      `Release checkpoint cannot move backwards: ${session.checkpoint} -> ${checkpoint}`,
    );
  }
  return {
    ...session,
    ...patch,
    schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    checkpoint,
    updatedAt: new Date().toISOString(),
  };
}

function sameCommit(values) {
  const commits = values.filter(Boolean);
  return commits.length === values.length && new Set(commits).size === 1
    ? commits[0]
    : null;
}

function stateConflict(code, message, details = {}) {
  const error = new Error(message);
  error.name = "ReleaseStateError";
  error.code = code;
  error.classification = "STATE_CONFLICT";
  Object.assign(error, details);
  return error;
}

export function classifyReleaseTagHistory(input) {
  const published = input.latestPublishedRelease;
  if (!published?.releaseExists) {
    throw stateConflict(
      "MISSING_PUBLISHED_RELEASE",
      `Latest Published Release v${published?.version || "unknown"} is missing.`,
    );
  }
  if (!published.tagExists) {
    throw stateConflict(
      "PUBLISHED_RELEASE_TAG_MISSING",
      `GitHub Release v${published.version} exists but its Tag is missing.`,
    );
  }
  const publishedCommit = sameCommit([
    published.tagCommit,
    published.remoteTagCommit,
    published.releaseCommit,
  ]);
  if (!publishedCommit) {
    throw stateConflict(
      "PUBLISHED_RELEASE_COMMIT_MISMATCH",
      `PUBLISHED_RELEASE v${published.version} Tag/Release commits do not match.`,
    );
  }

  const failedReleaseTags = [];
  const inProgressReleaseTags = [];
  const unknownOrphanTags = [];
  const historicalTags = [];
  const sorted = [...(input.historicalTags || [])].sort((left, right) =>
    input.compareVersions(left.version, right.version),
  );
  for (const tag of sorted) {
    if (input.compareVersions(tag.version, published.version) <= 0) {
      throw stateConflict(
        "INVALID_HISTORICAL_TAG_ORDER",
        `Historical Tag v${tag.version} is not newer than v${published.version}.`,
      );
    }
    if (input.compareVersions(tag.version, input.targetVersion) >= 0) {
      throw stateConflict(
        "HISTORICAL_TAG_NOT_BELOW_TARGET",
        `Historical Tag v${tag.version} must be lower than target v${input.targetVersion}.`,
      );
    }
    if (tag.releaseExists) {
      throw stateConflict(
        "UNEXPECTED_PUBLISHED_RELEASE",
        `v${tag.version} has a Release but is newer than Latest Published Release.`,
      );
    }
    const tagCommit = sameCommit([tag.tagCommit, tag.remoteTagCommit]);
    if (!tagCommit) {
      throw stateConflict(
        "HISTORICAL_TAG_COMMIT_MISMATCH",
        `Historical Tag v${tag.version} was moved, overwritten, or forged.`,
      );
    }
    if (!tag.isMainAncestor) {
      throw stateConflict(
        "HISTORICAL_TAG_NOT_MAIN_ANCESTOR",
        `Historical Tag v${tag.version} is not in current main history.`,
      );
    }
    const runs = tag.workflowRuns || [];
    const activeRun = runs.find((run) =>
      run.event === "push"
      && run.headBranch === `v${tag.version}`
      && run.headSha === tagCommit
      && activeStatuses.has(run.status),
    );
    if (activeRun) {
      const value = {
        type: "IN_PROGRESS_RELEASE",
        version: tag.version,
        tagCommit,
        workflowRunId: activeRun.databaseId,
        workflowStatus: activeRun.status,
        workflowUrl: activeRun.url,
      };
      historicalTags.push(value);
      inProgressReleaseTags.push(value);
      continue;
    }
    const matchingRuns = runs.filter((run) =>
      run.event === "push"
      && run.headBranch === `v${tag.version}`
      && run.headSha === tagCommit,
    );
    const failedRun = matchingRuns.find((run) =>
      run.status === "completed" && failedConclusions.has(run.conclusion),
    );
    if (failedRun) {
      const value = {
        type: "FAILED_RELEASE_TAG",
        version: tag.version,
        tagCommit,
        workflowRunId: failedRun.databaseId,
        workflowStatus: failedRun.status,
        workflowConclusion: failedRun.conclusion,
        workflowUrl: failedRun.url,
      };
      historicalTags.push(value);
      failedReleaseTags.push(value);
      continue;
    }
    const value = {
      type: "UNKNOWN_ORPHAN_TAG",
      version: tag.version,
      tagCommit,
    };
    historicalTags.push(value);
    unknownOrphanTags.push(value);
  }

  return {
    latestPublished: {
      type: "PUBLISHED_RELEASE",
      version: published.version,
      tag: `v${published.version}`,
      commit: publishedCommit,
    },
    historicalTags,
    failedReleaseTags,
    inProgressReleaseTags,
    unknownOrphanTags,
  };
}

export function createReleaseState(input) {
  const history = classifyReleaseTagHistory(input);
  const invalidReasons = [];
  if (!input.workingTreeClean) invalidReasons.push("WORKING_TREE_DIRTY");
  if (input.behind > 0 || input.ahead > 0 || input.localHead !== input.remoteMainHead) {
    invalidReasons.push("MAIN_DIVERGED");
  }
  if (history.unknownOrphanTags.length > 0) invalidReasons.push("UNKNOWN_ORPHAN_TAG");
  const releaseState = {
    schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    sourceVersion: input.sourceVersion,
    sourceType: input.compareVersions(input.sourceVersion, history.latestPublished.version) > 0
      ? "UNPUBLISHED_SOURCE"
      : "TARGET_VERSION",
    workingTreeClean: input.workingTreeClean,
    localHead: input.localHead,
    remoteMainHead: input.remoteMainHead,
    ahead: input.ahead,
    behind: input.behind,
    latestPublishedVersion: history.latestPublished.version,
    latestPublishedTag: history.latestPublished.tag,
    latestPublishedCommit: history.latestPublished.commit,
    historicalTags: history.historicalTags,
    failedReleaseTags: history.failedReleaseTags,
    inProgressReleaseTags: history.inProgressReleaseTags,
    unknownOrphanTags: history.unknownOrphanTags,
    targetVersion: input.targetVersion,
    targetLocalTagExists: Boolean(input.targetLocalTagExists),
    targetRemoteTagExists: Boolean(input.targetRemoteTagExists),
    targetReleaseExists: Boolean(input.targetReleaseExists),
    targetTagCommit: input.targetTagCommit || null,
    mainCiState: input.mainCiState || { status: "unknown", conclusion: null },
    releaseWorkflowState:
      input.releaseWorkflowState || { status: "not_started", conclusion: null },
    localArtifactState: input.localArtifactState || { status: "MISSING" },
    remoteArtifactState: input.remoteArtifactState || { status: "UNKNOWN" },
    checkpoint: input.checkpoint || "PLAN_READY",
    recoveryPoint: "PREFLIGHT",
    versionConsumed: Boolean(input.targetRemoteTagExists),
    invalidReasons,
    stateType: history.unknownOrphanTags.length > 0
      ? "UNKNOWN_ORPHAN_TAG"
      : invalidReasons.length > 0
        ? "INVALID_RELEASE_STATE"
      : input.targetRemoteTagExists
        ? input.targetReleaseExists
          ? "PUBLISHED_RELEASE"
          : input.releaseWorkflowState?.status === "completed"
            && failedConclusions.has(input.releaseWorkflowState?.conclusion)
            ? "FAILED_RELEASE_TAG"
            : "IN_PROGRESS_RELEASE"
        : "TARGET_VERSION",
  };
  const recovery = determineReleaseRecovery(releaseState, releaseState.checkpoint);
  return { ...releaseState, ...recovery };
}

export function determineReleaseRecovery(state, checkpoint = state.checkpoint) {
  if (state.invalidReasons?.length || state.unknownOrphanTags?.length) {
    return { recoveryPoint: "BLOCK", versionConsumed: Boolean(state.targetRemoteTagExists) };
  }
  if (state.targetReleaseExists) {
    return state.remoteArtifactState?.status === "VERIFIED"
      ? { recoveryPoint: "COMPLETE", versionConsumed: true }
      : { recoveryPoint: "REMOTE_ASSETS_VERIFY", versionConsumed: true };
  }
  if (state.targetRemoteTagExists) {
    if (
      state.releaseWorkflowState?.status === "completed"
      && failedConclusions.has(state.releaseWorkflowState?.conclusion)
    ) {
      return { recoveryPoint: "NEXT_VERSION_REQUIRED", versionConsumed: true };
    }
    return { recoveryPoint: "GITHUB_ACTIONS", versionConsumed: true };
  }
  if (state.targetLocalTagExists) {
    return { recoveryPoint: "PUSH_TAG", versionConsumed: false };
  }
  if (isCheckpointAtLeast(checkpoint, "MAIN_PUSHED")) {
    return { recoveryPoint: "TAG", versionConsumed: false };
  }
  if (isCheckpointAtLeast(checkpoint, "RELEASE_COMMIT_CREATED")) {
    return { recoveryPoint: "PUSH_MAIN", versionConsumed: false };
  }
  if (isCheckpointAtLeast(checkpoint, "LOCAL_PACKAGE_VERIFIED")) {
    return { recoveryPoint: "RELEASE_COMMIT", versionConsumed: false };
  }
  if (isCheckpointAtLeast(checkpoint, "FULL_PASS")) {
    return { recoveryPoint: "LOCAL_PACKAGE", versionConsumed: false };
  }
  if (isCheckpointAtLeast(checkpoint, "PREFLIGHT_PASS")) {
    return { recoveryPoint: "FULL", versionConsumed: false };
  }
  return { recoveryPoint: "PREFLIGHT", versionConsumed: false };
}

export function validateResumeSession(session, state, sourceFingerprint) {
  if (!session || session.schemaVersion !== RELEASE_STATE_SCHEMA_VERSION) {
    return { valid: false, reasons: ["MISSING_OR_INCOMPATIBLE_SESSION"] };
  }
  const reasons = [];
  if (session.targetVersion !== state.targetVersion) reasons.push("TARGET_VERSION_CHANGED");
  if (session.sourceVersion !== state.sourceVersion) reasons.push("SOURCE_VERSION_CHANGED");
  if (session.sourceFingerprint !== sourceFingerprint) reasons.push("SOURCE_FINGERPRINT_CHANGED");
  if (
    session.releaseCommit
    && ![session.releaseCommit, session.sourceHead].includes(state.localHead)
  ) {
    reasons.push("HEAD_CHANGED");
  }
  if (state.behind > 0) reasons.push("REMOTE_MAIN_AHEAD");
  return { valid: reasons.length === 0, reasons };
}
