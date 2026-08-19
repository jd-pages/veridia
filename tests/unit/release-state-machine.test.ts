import { describe, expect, it, vi } from "vitest";

import {
  advanceReleaseCheckpoint,
  classifyReleaseTagHistory,
  createReleaseState,
  determineReleaseRecovery,
  RELEASE_CHECKPOINTS,
  RELEASE_STATUS_TYPES,
} from "../../scripts/release-state.mjs";
import {
  retryReadOnlyNetworkOperation,
} from "../../scripts/release-network.mjs";
import {
  classifyReleaseFailure,
} from "../../scripts/release-failure.mjs";
import {
  executeSoftwarePublishPlan,
} from "../../scripts/software-publish-orchestrator.mjs";

const compareVersions = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true });

function published() {
  return {
    version: "1.1.13",
    releaseExists: true,
    tagExists: true,
    tagCommit: "published-commit",
    remoteTagCommit: "published-commit",
    releaseCommit: "published-commit",
  };
}

function failedTag(version = "1.1.14") {
  return {
    version,
    releaseExists: false,
    tagCommit: `commit-${version}`,
    remoteTagCommit: `commit-${version}`,
    isMainAncestor: true,
    workflowRuns: [{
      databaseId: 32125757755,
      event: "push",
      headBranch: `v${version}`,
      headSha: `commit-${version}`,
      status: "completed",
      conclusion: "failure",
      url: "https://example.invalid/run",
    }],
  };
}

function stateInput(overrides: Record<string, unknown> = {}) {
  return {
    compareVersions,
    sourceVersion: "1.1.15",
    targetVersion: "1.1.15",
    latestPublishedRelease: published(),
    historicalTags: [failedTag()],
    workingTreeClean: true,
    localHead: "head-115",
    remoteMainHead: "head-115",
    ahead: 0,
    behind: 0,
    targetLocalTagExists: false,
    targetRemoteTagExists: false,
    targetReleaseExists: false,
    ...overrides,
  };
}

describe("ReleaseState canonical types", () => {
  it("defines every permanent status and every monotonic checkpoint", () => {
    expect(RELEASE_STATUS_TYPES).toEqual([
      "PUBLISHED_RELEASE",
      "FAILED_RELEASE_TAG",
      "BINARY_PUBLISH_RECOVERABLE",
      "IN_PROGRESS_RELEASE",
      "TARGET_VERSION",
      "UNPUBLISHED_SOURCE",
      "UNKNOWN_ORPHAN_TAG",
      "INVALID_RELEASE_STATE",
    ]);
    expect(RELEASE_CHECKPOINTS).toHaveLength(12);
  });

  it("classifies published, failed, in-progress, target, source, orphan, and invalid states", () => {
    const target = createReleaseState(stateInput());
    expect(target).toMatchObject({
      stateType: "TARGET_VERSION",
      sourceType: "UNPUBLISHED_SOURCE",
    });
    const publishedTarget = createReleaseState(stateInput({
      targetRemoteTagExists: true,
      targetReleaseExists: true,
    }));
    expect(publishedTarget.stateType).toBe("PUBLISHED_RELEASE");
    const failedTarget = createReleaseState(stateInput({
      targetRemoteTagExists: true,
      releaseWorkflowState: { status: "completed", conclusion: "failure" },
    }));
    expect(failedTarget.stateType).toBe("FAILED_RELEASE_TAG");
    const recoverableTarget = createReleaseState(stateInput({
      targetRemoteTagExists: true,
      releaseWorkflowState: { status: "completed", conclusion: "failure" },
      binaryPublishState: { status: "VERIFIED" },
    }));
    expect(recoverableTarget).toMatchObject({
      stateType: "BINARY_PUBLISH_RECOVERABLE",
      recoveryPoint: "BINARY_PUBLISH",
      versionConsumed: true,
    });
    const activeTarget = createReleaseState(stateInput({
      targetRemoteTagExists: true,
      releaseWorkflowState: { status: "in_progress", conclusion: null },
    }));
    expect(activeTarget.stateType).toBe("IN_PROGRESS_RELEASE");
    const invalid = createReleaseState(stateInput({ workingTreeClean: false }));
    expect(invalid.stateType).toBe("INVALID_RELEASE_STATE");
    const orphan = createReleaseState(stateInput({
      historicalTags: [{ ...failedTag(), workflowRuns: [] }],
    }));
    expect(orphan.stateType).toBe("UNKNOWN_ORPHAN_TAG");
    expect(orphan.recoveryPoint).toBe("BLOCK");
    expect((target.failedReleaseTags as Array<{ type: string }>)[0].type).toBe(
      "FAILED_RELEASE_TAG",
    );
  });
});

const recoveryTable: Array<[string, Record<string, unknown>, string, string, boolean]> = [
  ["01 plan", {}, "PLAN_READY", "PREFLIGHT", false],
  ["02 preflight", {}, "PREFLIGHT_PASS", "FULL", false],
  ["03 full", {}, "FULL_PASS", "LOCAL_PACKAGE", false],
  ["04 package", {}, "LOCAL_PACKAGE_VERIFIED", "RELEASE_COMMIT", false],
  ["05 commit", {}, "RELEASE_COMMIT_CREATED", "PUSH_MAIN", false],
  ["06 main", {}, "MAIN_PUSHED", "TAG", false],
  ["07 local tag", { targetLocalTagExists: true }, "LOCAL_TAG_CREATED", "PUSH_TAG", false],
  ["08 remote tag", { targetRemoteTagExists: true }, "REMOTE_TAG_PUSHED", "GITHUB_ACTIONS", true],
  ["09 actions success", { targetRemoteTagExists: true }, "GITHUB_ACTIONS_SUCCESS", "GITHUB_ACTIONS", true],
  ["10 release created", { targetRemoteTagExists: true, targetReleaseExists: true }, "GITHUB_RELEASE_CREATED", "REMOTE_ASSETS_VERIFY", true],
  ["11 assets verified", { targetRemoteTagExists: true, targetReleaseExists: true }, "REMOTE_ASSETS_VERIFIED", "REMOTE_ASSETS_VERIFY", true],
  ["12 complete", { targetRemoteTagExists: true, targetReleaseExists: true, remoteArtifactState: { status: "VERIFIED" } }, "RELEASE_COMPLETE", "COMPLETE", true],
  ["13 dirty", { invalidReasons: ["WORKING_TREE_DIRTY"] }, "PLAN_READY", "BLOCK", false],
  ["14 diverged", { invalidReasons: ["MAIN_DIVERGED"] }, "PLAN_READY", "BLOCK", false],
  ["15 orphan", { unknownOrphanTags: [{ version: "1.1.14" }] }, "PLAN_READY", "BLOCK", false],
  ["16 failed actions", { targetRemoteTagExists: true, releaseWorkflowState: { status: "completed", conclusion: "failure" } }, "REMOTE_TAG_PUSHED", "NEXT_VERSION_REQUIRED", true],
  ["17 cancelled actions", { targetRemoteTagExists: true, releaseWorkflowState: { status: "completed", conclusion: "cancelled" } }, "REMOTE_TAG_PUSHED", "NEXT_VERSION_REQUIRED", true],
  ["18 timed out actions", { targetRemoteTagExists: true, releaseWorkflowState: { status: "completed", conclusion: "timed_out" } }, "REMOTE_TAG_PUSHED", "NEXT_VERSION_REQUIRED", true],
  ["19 queued actions", { targetRemoteTagExists: true, releaseWorkflowState: { status: "queued", conclusion: null } }, "REMOTE_TAG_PUSHED", "GITHUB_ACTIONS", true],
  ["20 active actions", { targetRemoteTagExists: true, releaseWorkflowState: { status: "in_progress", conclusion: null } }, "REMOTE_TAG_PUSHED", "GITHUB_ACTIONS", true],
  ["21 release pending verify", { targetRemoteTagExists: true, targetReleaseExists: true, remoteArtifactState: { status: "PENDING_VERIFY" } }, "GITHUB_RELEASE_CREATED", "REMOTE_ASSETS_VERIFY", true],
  ["22 release stale verify", { targetRemoteTagExists: true, targetReleaseExists: true, remoteArtifactState: { status: "STALE" } }, "GITHUB_RELEASE_CREATED", "REMOTE_ASSETS_VERIFY", true],
  ["23 release missing verify", { targetRemoteTagExists: true, targetReleaseExists: true, remoteArtifactState: { status: "MISSING" } }, "GITHUB_RELEASE_CREATED", "REMOTE_ASSETS_VERIFY", true],
  ["24 two failed tags", { failedReleaseTags: [failedTag("1.1.13"), failedTag()] }, "PLAN_READY", "PREFLIGHT", false],
  ["25 no failed tags", { failedReleaseTags: [] }, "PLAN_READY", "PREFLIGHT", false],
  ["26 package no remote", { localArtifactState: { status: "VERIFIED" } }, "LOCAL_PACKAGE_VERIFIED", "RELEASE_COMMIT", false],
  ["27 commit no remote", { localArtifactState: { status: "VERIFIED" } }, "RELEASE_COMMIT_CREATED", "PUSH_MAIN", false],
  ["28 main CI pending", { mainCiState: { status: "in_progress", conclusion: null } }, "MAIN_PUSHED", "TAG", false],
  ["29 local tag only", { targetLocalTagExists: true, targetRemoteTagExists: false }, "LOCAL_TAG_CREATED", "PUSH_TAG", false],
  ["30 remote assets retry", { targetRemoteTagExists: true, targetReleaseExists: true }, "GITHUB_ACTIONS_SUCCESS", "REMOTE_ASSETS_VERIFY", true],
];

describe("ReleaseState 30-combination recovery table", () => {
  it.each(recoveryTable)("%s", (_label, override, checkpoint, recoveryPoint, consumed) => {
    const state = {
      invalidReasons: [],
      unknownOrphanTags: [],
      targetRemoteTagExists: false,
      targetLocalTagExists: false,
      targetReleaseExists: false,
      releaseWorkflowState: { status: "not_started", conclusion: null },
      remoteArtifactState: { status: "MISSING" },
      ...override,
      checkpoint,
    };
    expect(determineReleaseRecovery(state, checkpoint as never)).toEqual({
      recoveryPoint,
      versionConsumed: consumed,
    });
  });
});

describe("bounded read-only retry", () => {
  it("Case A: Schannel failure then success passes with one retry", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("schannel: failed to receive handshake; SSL/TLS connection failed"))
      .mockResolvedValueOnce("PASS");
    await expect(retryReadOnlyNetworkOperation("git fetch", operation, {
      sleep: async () => undefined,
    })).resolves.toBe("PASS");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("Case B: two TLS failures block as TRANSIENT_NETWORK", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("SSL/TLS connection failed"));
    await expect(retryReadOnlyNetworkOperation("git fetch", operation, {
      sleep: async () => undefined,
    })).rejects.toSatisfy((error: Error) =>
      classifyReleaseFailure(error) === "TRANSIENT_NETWORK",
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("Case C: first success never executes a second request", async () => {
    const operation = vi.fn().mockResolvedValue("PASS");
    await retryReadOnlyNetworkOperation("git fetch", operation, {
      sleep: async () => undefined,
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("Case D: Tag conflict is STATE_CONFLICT and never retries", async () => {
    const operation = vi.fn().mockRejectedValue(
      Object.assign(new Error("Tag v1.1.15 exists"), { classification: "STATE_CONFLICT" }),
    );
    await expect(retryReadOnlyNetworkOperation("tag lookup", operation, {
      sleep: async () => undefined,
    })).rejects.toMatchObject({ classification: "STATE_CONFLICT" });
    expect(operation).toHaveBeenCalledOnce();
  });
});

const historicalFailures: Array<[string, string, string]> = [
  ["01 Electron SHASUMS CDN timeout", "Release CDN timeout", "TRANSIENT_NETWORK"],
  ["02 GitHub 443 connect failure", "Failed to connect to github.com port 443", "TRANSIENT_NETWORK"],
  ["03 Git Schannel", "schannel: failed to receive handshake", "TRANSIENT_NETWORK"],
  ["04 Chromium filesystem timing", "Chromium filesystem timing", "FLAKY_CANDIDATE"],
  ["05 missing bundled Node", "missing bundled Node", "ENVIRONMENT"],
  ["06 missing file logger", "standalone missing file-logger", "DETERMINISTIC"],
  ["07 wrong system Node", "wrong system Node not executable", "ENVIRONMENT"],
  ["08 browser restart deadlock", "browser restart deadlock", "FLAKY_CANDIDATE"],
  ["09 runner cascade", "Runner RUNNING/QUEUED cascade", "FLAKY_CANDIDATE"],
  ["10 post-main network", "Tag lookup EHOSTUNREACH", "TRANSIENT_NETWORK"],
  ["11 actions fail", "GitHub Actions failure", "DETERMINISTIC"],
  ["12 failed tag", "FAILED_RELEASE_TAG", "STATE_CONFLICT"],
  ["13 latest behind historical", "Latest Release < Latest Historical Tag", "STATE_CONFLICT"],
  ["14 stale package", "Artifact STALE after HEAD change", "DETERMINISTIC_INTEGRITY"],
  ["15 BAT interruption", "BAT process interrupted", "UNKNOWN"],
  ["16 actions long running", "Actions long in_progress", "STATE_CONFLICT"],
  ["17 migration fail", "Migration failed", "DETERMINISTIC"],
  ["18 build fail", "Production build failed", "DETERMINISTIC"],
  ["19 sensitive scan", "Sensitive Scan failed", "DETERMINISTIC"],
  ["20 incomplete asset", "missing Release asset", "DETERMINISTIC"],
  ["21 latest metadata", "invalid latest.yml metadata", "DETERMINISTIC"],
  ["22 main divergence", "main/origin divergence", "STATE_CONFLICT"],
  ["23 Git auth", "authentication failed for git push", "AUTHENTICATION"],
  ["24 remote verify network", "Remote Verify ECONNRESET", "TRANSIENT_NETWORK"],
];

describe("24 historical release failures", () => {
  it.each(historicalFailures)("%s", (_label, message, classification) => {
    expect(classifyReleaseFailure(message)).toBe(classification);
  });
});

function fakePlan(version: string) {
  return {
    kind: "release",
    targetVersion: version,
    checkpoint: "PLAN_READY",
  } as never;
}

function fakeOperations(overrides: Record<string, unknown> = {}) {
  return {
    preflight: vi.fn(),
    updateVersion: vi.fn(),
    validate: vi.fn(),
    package: vi.fn(),
    verifyLocalArtifact: vi.fn().mockReturnValue({ status: "VERIFIED" }),
    commitVersion: vi.fn(),
    releaseCommit: vi.fn().mockReturnValue("release-commit"),
    bindArtifact: vi.fn(),
    restoreVersion: vi.fn(),
    pushMain: vi.fn(),
    assertMainSynchronized: vi.fn(),
    waitForMainCi: vi.fn().mockReturnValue({ success: true }),
    assertTargetAvailable: vi.fn(),
    createTag: vi.fn(),
    pushTag: vi.fn(),
    waitForActions: vi.fn().mockReturnValue({ success: true, id: 1, url: "run" }),
    verifyRelease: vi.fn().mockReturnValue({ url: "release" }),
    ...overrides,
  };
}

describe("sandbox continuous versions N through N+5", () => {
  it("normal, retry, resume, consumed failure, failed history, and verify resume are monotonic", async () => {
    const versions = ["2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5"];

    const n = fakeOperations();
    await expect(executeSoftwarePublishPlan(fakePlan(versions[0]), {
      dryRun: false,
      operations: n,
    })).resolves.toMatchObject({ released: true });

    const tlsPreflight = vi.fn()
      .mockRejectedValueOnce(new Error("schannel SSL/TLS connection failed"))
      .mockResolvedValueOnce(undefined);
    const n1 = fakeOperations({
      preflight: () => retryReadOnlyNetworkOperation("git fetch", tlsPreflight, {
        sleep: async () => undefined,
      }),
    });
    await executeSoftwarePublishPlan(fakePlan(versions[1]), { dryRun: false, operations: n1 });
    expect(tlsPreflight).toHaveBeenCalledTimes(2);

    const n2 = fakeOperations();
    await executeSoftwarePublishPlan(fakePlan(versions[2]), {
      dryRun: false,
      session: { checkpoint: "MAIN_PUSHED", targetVersion: versions[2] },
      operations: n2,
    });
    expect(n2.validate).not.toHaveBeenCalled();
    expect(n2.commitVersion).not.toHaveBeenCalled();
    expect(n2.pushMain).not.toHaveBeenCalled();

    const n3 = fakeOperations({
      waitForActions: vi.fn().mockReturnValue({ success: false, url: "failed-run" }),
    });
    await expect(executeSoftwarePublishPlan(fakePlan(versions[3]), {
      dryRun: false,
      session: { checkpoint: "REMOTE_TAG_PUSHED", targetVersion: versions[3] },
      operations: n3,
    })).rejects.toMatchObject({ versionConsumed: true, recoveryPoint: "NEXT_VERSION_REQUIRED" });

    const failedHistory = classifyReleaseTagHistory({
      latestPublishedRelease: published(),
      historicalTags: [failedTag("1.1.14"), failedTag("1.1.15")],
      targetVersion: "1.1.16",
      compareVersions,
    });
    expect(failedHistory.failedReleaseTags).toHaveLength(2);
    const n4 = fakeOperations();
    await expect(executeSoftwarePublishPlan(fakePlan(versions[4]), {
      dryRun: false,
      operations: n4,
    })).resolves.toMatchObject({ released: true });

    let session: Record<string, unknown> = {
      checkpoint: "GITHUB_ACTIONS_SUCCESS",
      targetVersion: versions[5],
      actions: { success: true, id: 5, url: "run-5" },
    };
    const remoteVerify = vi.fn()
      .mockRejectedValueOnce(new Error("Remote Verify ECONNRESET"))
      .mockReturnValueOnce({ url: "release-5" });
    const n5 = fakeOperations({ verifyRelease: remoteVerify });
    await expect(executeSoftwarePublishPlan(fakePlan(versions[5]), {
      dryRun: false,
      session,
      onCheckpoint: (value) => { session = value; },
      operations: n5,
    })).rejects.toMatchObject({ classification: "TRANSIENT_NETWORK" });
    await expect(executeSoftwarePublishPlan(fakePlan(versions[5]), {
      dryRun: false,
      session,
      onCheckpoint: (value) => { session = value; },
      operations: n5,
    })).resolves.toMatchObject({ released: true });
    expect(remoteVerify).toHaveBeenCalledTimes(2);
  });

  it("resume and completed re-entry never duplicate commit, Tag, or Release writes", async () => {
    let session: Record<string, unknown> = {
      checkpoint: "MAIN_PUSHED",
      targetVersion: "3.0.0",
    };
    const operations = fakeOperations();
    await executeSoftwarePublishPlan(fakePlan("3.0.0"), {
      dryRun: false,
      session,
      onCheckpoint: (value) => { session = value; },
      operations,
    });
    await executeSoftwarePublishPlan(fakePlan("3.0.0"), {
      dryRun: false,
      session,
      operations,
    });
    expect(operations.commitVersion).not.toHaveBeenCalled();
    expect(operations.createTag).toHaveBeenCalledOnce();
    expect(operations.pushTag).toHaveBeenCalledOnce();
    expect(operations.verifyRelease).toHaveBeenCalledOnce();
  });

  it("checkpoint persistence is monotonic and rejects backwards movement", () => {
    const full = advanceReleaseCheckpoint({ checkpoint: "PREFLIGHT_PASS" }, "FULL_PASS");
    expect(full.checkpoint).toBe("FULL_PASS");
    expect(() => advanceReleaseCheckpoint(full, "PREFLIGHT_PASS")).toThrow("cannot move backwards");
  });
});
