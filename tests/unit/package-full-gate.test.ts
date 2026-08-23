import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PACKAGE_FULL_GATE_SOURCES,
  PackageFullGateError,
  resolvePackageFullGate,
} from "../../scripts/package-full-gate.mjs";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

function gitStub({
  branch = "main",
  status = "",
  head = HEAD,
  originMain = HEAD,
} = {}) {
  return vi.fn((_root: string, args: string[]) => {
    const command = args.join(" ");
    if (command === "branch --show-current") return branch;
    if (command === "status --porcelain --untracked-files=normal") return status;
    if (command === "rev-parse HEAD") return head;
    if (command === "rev-parse origin/main") return originMain;
    throw new Error(`unexpected git command: ${command}`);
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return resolvePackageFullGate({
    root: "C:\\veridia",
    git: gitStub(),
    validateLocalAttestation: () => ({
      valid: false,
      reasons: ["未找到 FULL 验收凭证"],
    }),
    collectCurrentState: () => ({ sourceFingerprint: "source-fingerprint" }),
    listMainCiRuns: () => [successfulRun()],
    viewMainCiRun: () => successfulRunDetails(),
    ...overrides,
  });
}

function successfulRun(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 12345,
    headSha: HEAD,
    status: "completed",
    conclusion: "success",
    event: "push",
    workflowName: "VERIDIA 代码检查",
    createdAt: "2026-08-23T10:00:00Z",
    url: "https://github.com/jd-pages/veridia/actions/runs/12345",
    ...overrides,
  };
}

function successfulRunDetails(overrides: Record<string, unknown> = {}) {
  return {
    ...successfulRun(),
    jobs: [
      {
        name: "分层验证门禁",
        status: "completed",
        conclusion: "success",
        steps: [
          {
            name: "main 正式 FULL 门禁",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    ...overrides,
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

describe("本地 Package 的可信 FULL 凭证", () => {
  it("exact HEAD Main CI SUCCESS 且正式 FULL step 成功时返回 GitHub 凭证", () => {
    expect(run()).toMatchObject({
      source: PACKAGE_FULL_GATE_SOURCES.GITHUB_MAIN_CI,
      commitSha: HEAD,
      sourceFingerprint: "source-fingerprint",
      mainCiRunId: 12345,
      mainCiCommitSha: HEAD,
      mainCiConclusion: "success",
    });
  });

  it("Main CI SUCCESS 属于旧 commit 时以 MAIN_CI_SHA_MISMATCH 阻断", () => {
    expectCode(
      () => run({ listMainCiRuns: () => [successfulRun({ headSha: OLD_HEAD })] }),
      "MAIN_CI_SHA_MISMATCH",
    );
  });

  it("没有 Main push 正式检查记录时以 MAIN_CI_NOT_FOUND 阻断", () => {
    expectCode(
      () => run({ listMainCiRuns: () => [] }),
      "MAIN_CI_NOT_FOUND",
    );
  });

  it("exact HEAD Main CI pending 时阻断", () => {
    expectCode(
      () =>
        run({
          listMainCiRuns: () => [
            successfulRun({ status: "in_progress", conclusion: "" }),
          ],
        }),
      "MAIN_CI_PENDING",
    );
  });

  it("exact HEAD Main CI failed 时阻断", () => {
    expectCode(
      () =>
        run({
          listMainCiRuns: () => [successfulRun({ conclusion: "failure" })],
        }),
      "MAIN_CI_FAILED",
    );
  });

  it("workflow 成功但 main 正式 FULL step 未成功时仍阻断", () => {
    expectCode(
      () =>
        run({
          viewMainCiRun: () =>
            successfulRunDetails({
              jobs: [
                {
                  name: "分层验证门禁",
                  status: "completed",
                  conclusion: "success",
                  steps: [],
                },
              ],
            }),
        }),
      "MAIN_CI_FAILED",
    );
  });

  it("GitHub 不可访问且没有有效 local attestation 时阻断", () => {
    expectCode(
      () =>
        run({
          listMainCiRuns: () => {
            throw new Error("network unavailable");
          },
        }),
      "GITHUB_UNREACHABLE",
    );
  });

  it("GitHub 不可访问但 local exact-HEAD attestation 有效时允许 Package", () => {
    const listMainCiRuns = vi.fn(() => {
      throw new Error("must not query GitHub");
    });
    expect(
      run({
        validateLocalAttestation: () => ({
          valid: true,
          attestation: { generatedAt: "2026-08-23T09:00:00Z" },
        }),
        listMainCiRuns,
      }),
    ).toMatchObject({
      source: PACKAGE_FULL_GATE_SOURCES.LOCAL_ATTESTATION,
      commitSha: HEAD,
      attestationGeneratedAt: "2026-08-23T09:00:00Z",
    });
    expect(listMainCiRuns).not.toHaveBeenCalled();
  });

  it("worktree dirty 时在查询凭证前阻断", () => {
    expectCode(
      () => run({ git: gitStub({ status: " M lib/foo.ts" }) }),
      "WORKTREE_DIRTY",
    );
  });

  it("HEAD 与 origin/main 不一致时阻断", () => {
    expectCode(
      () => run({ git: gitStub({ originMain: OLD_HEAD }) }),
      "ORIGIN_MAIN_MISMATCH",
    );
  });

  it("fixed workflow 只调用 package stage，不执行 verify:full", () => {
    const workflow = fs.readFileSync(
      path.resolve("scripts/fixed-workflow.mjs"),
      "utf8",
    );
    expect(workflow).toContain('"--stage=package"');
    expect(workflow).toContain("resolvePackageFullGate");
    expect(workflow).not.toContain('["run", "verify:full"]');
    expect(workflow).not.toContain("VERIDIA_ALLOW_FULL_ATTESTATION_REUSE");
  });
});
