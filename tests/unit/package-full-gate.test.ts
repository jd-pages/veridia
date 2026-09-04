import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PACKAGE_FULL_GATE_SOURCES,
  PackageFullGateError,
  resolvePackageFullGate,
} from "../../scripts/package-full-gate.mjs";

const HEAD = "a".repeat(40);
const BASE_HEAD = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);

function gitStub({ branch = "main", status = "", head = HEAD, originMain = HEAD, diff = "tests/e2e/results-workbench.spec.ts" } = {}) {
  return vi.fn((_root: string, args: string[]) => {
    const command = args.join(" ");
    if (command === "branch --show-current") return branch;
    if (command === "status --porcelain --untracked-files=normal") return status;
    if (command === "rev-parse HEAD") return head;
    if (command === "rev-parse origin/main") return originMain;
    if (command === `-c core.quotepath=false diff --name-only ${BASE_HEAD} ${HEAD}`) return diff;
    throw new Error(`unexpected git command: ${command}`);
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return resolvePackageFullGate({
    root: "C:\\veridia",
    git: gitStub(),
    validateLocalAttestation: () => ({ valid: false, reasons: ["missing"] }),
    validateReusableAttestation: () => ({ valid: false, reasons: ["missing"] }),
    readLocalRecoveryEvidence: () => null,
    collectCurrentState: () => ({ sourceFingerprint: "source-fingerprint" }),
    listMainCiRuns: () => [releaseFullRun()],
    viewMainCiRun: () => releaseFullDetails(),
    ...overrides,
  });
}

function releaseFullRun(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 12345,
    headSha: HEAD,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    workflowName: "VERIDIA 代码检查",
    createdAt: "2026-09-04T10:00:00Z",
    url: "https://github.com/jd-pages/veridia/actions/runs/12345",
    ...overrides,
  };
}

function details(stepName = "RELEASE_FULL 门禁", overrides: Record<string, unknown> = {}) {
  return {
    ...releaseFullRun(),
    jobs: [{
      name: "分层验证门禁",
      status: "completed",
      conclusion: "success",
      steps: [{ name: stepName, status: "completed", conclusion: "success" }],
    }],
    ...overrides,
  };
}

function releaseFullDetails(overrides: Record<string, unknown> = {}) {
  return details("RELEASE_FULL 门禁", overrides);
}

function recoveryEvidence() {
  return {
    schemaVersion: 1,
    FINAL_CLASSIFICATION: "TEST_ONLY_RECOVERY_PASS",
    BASE_FULL_RUN: 33470209932,
    BASE_FULL_HEAD: BASE_HEAD,
    RECOVERY_COMMIT: HEAD,
    RECOVERY_SCOPE: ["tests/e2e/results-workbench.spec.ts"],
    RECOVERY_GROUP_RESULT: { group: "RESULTS_UI", total: 20, passed: 20, status: "PASSED" },
  };
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("expected PackageFullGateError");
  } catch (error) {
    expect(error).toBeInstanceOf(PackageFullGateError);
    expect((error as PackageFullGateError).code).toBe(code);
  }
}

describe("本地 Package 的发布级验证凭证", () => {
  it("exact HEAD 手动 RELEASE_FULL SUCCESS 时允许 Package", () => {
    expect(run()).toMatchObject({
      source: PACKAGE_FULL_GATE_SOURCES.GITHUB_RELEASE_FULL,
      commitSha: HEAD,
      releaseFullRunId: 12345,
      releaseFullCommitSha: HEAD,
      releaseFullConclusion: "success",
    });
  });

  it("普通 main affected SUCCESS 不得冒充 RELEASE_FULL", () => {
    expectCode(() => run({
      listMainCiRuns: () => [releaseFullRun({ event: "push" })],
      viewMainCiRun: () => details("affected 变更影响门禁", { event: "push" }),
    }), "RELEASE_FULL_REQUIRED");
  });

  it("exact HEAD affected Run 携带合法 Recovery artifact 时允许 Package", () => {
    expect(run({
      listMainCiRuns: () => [releaseFullRun({ event: "push" })],
      viewMainCiRun: () => details("生成 TEST_ONLY_RECOVERY 证据", { event: "push" }),
      readRecoveryEvidence: () => recoveryEvidence(),
    })).toMatchObject({
      source: PACKAGE_FULL_GATE_SOURCES.TEST_ONLY_RECOVERY,
      baseFullRunId: 33470209932,
      baseFullHead: BASE_HEAD,
      recoveryCommit: HEAD,
      recoveryCiRunId: 12345,
    });
  });

  it("Recovery scope 出现生产代码时阻断", () => {
    expectCode(() => run({
      git: gitStub({ diff: "tests/e2e/results-workbench.spec.ts\nlib/audit-service.ts" }),
      listMainCiRuns: () => [releaseFullRun({ event: "push" })],
      viewMainCiRun: () => details("生成 TEST_ONLY_RECOVERY 证据", { event: "push" }),
      readRecoveryEvidence: () => recoveryEvidence(),
    }), "RELEASE_FULL_REQUIRED");
  });

  it("旧 commit 的成功 Run 不能用于当前 exact HEAD", () => {
    expectCode(() => run({ listMainCiRuns: () => [releaseFullRun({ headSha: OLD_HEAD })] }), "MAIN_CI_SHA_MISMATCH");
  });

  it("GitHub 不可访问且没有本地凭证时阻断", () => {
    expectCode(() => run({ listMainCiRuns: () => { throw new Error("offline"); } }), "GITHUB_UNREACHABLE");
  });

  it("本地 exact-HEAD attestation 有效时不查询 GitHub", () => {
    const listMainCiRuns = vi.fn(() => { throw new Error("must not query"); });
    expect(run({
      validateLocalAttestation: () => ({ valid: true, attestation: { generatedAt: "2026-09-04T09:00:00Z" } }),
      listMainCiRuns,
    })).toMatchObject({ source: PACKAGE_FULL_GATE_SOURCES.LOCAL_ATTESTATION });
    expect(listMainCiRuns).not.toHaveBeenCalled();
  });

  it("可复用本地 FULL base 与相同 scope recovery evidence 组成合法 chain", () => {
    expect(run({
      validateReusableAttestation: () => ({
        valid: true,
        changedFiles: ["tests/e2e/results-workbench.spec.ts"],
        attestation: { gitHead: BASE_HEAD },
      }),
      readLocalRecoveryEvidence: () => recoveryEvidence(),
    })).toMatchObject({ source: PACKAGE_FULL_GATE_SOURCES.TEST_ONLY_RECOVERY, baseFullHead: BASE_HEAD });
  });

  it("dirty worktree 或 HEAD 未同步 origin/main 时先阻断", () => {
    expectCode(() => run({ git: gitStub({ status: " M lib/foo.ts" }) }), "WORKTREE_DIRTY");
    expectCode(() => run({ git: gitStub({ originMain: OLD_HEAD }) }), "ORIGIN_MAIN_MISMATCH");
  });

  it("fixed workflow 只调用 package stage，不执行 verify:full", () => {
    const workflow = fs.readFileSync(path.resolve("scripts/fixed-workflow.mjs"), "utf8");
    expect(workflow).toContain('"--stage=package"');
    expect(workflow).toContain("resolvePackageFullGate");
    expect(workflow).not.toContain('["run", "verify:full"]');
  });
});
