import { describe, expect, it } from "vitest";

import {
  classifyBinaryResumeRun,
  planBinaryResumeAssets,
  verifyReleaseAssetDigests,
} from "../../scripts/software-binary-publish.mjs";

const tagCommit = "528f598eeaa072841dcf0bda74536d0cb6c41ae0";

function run(overrides: Record<string, unknown> = {}) {
  const steps = [
    ["正式 FULL 门禁（不读取开发机凭证）", "success"],
    ["构建 NSIS 安装包和更新元数据", "success"],
    ["检查自动更新发布三件套", "success"],
    ["创建 Draft GitHub Release 并上传更新文件", "success"],
    ["校验 Draft Release 自动更新文件", "failure"],
    ["发布为正式 Latest Release", "skipped"],
  ].map(([name, conclusion]) => ({ name, conclusion }));
  return {
    version: "1.1.15",
    headSha: tagCommit,
    headBranch: "v1.1.15",
    conclusion: "failure",
    jobs: [{ steps }],
    ...overrides,
  };
}

const manifest = {
  files: [
    { name: "VERIDIA-Setup-1.1.15.exe", size: 10, sha256: "a".repeat(64) },
    { name: "VERIDIA-Setup-1.1.15.exe.blockmap", size: 20, sha256: "b".repeat(64) },
    { name: "latest.yml", size: 30, sha256: "c".repeat(64) },
  ],
};

function release(overrides: Record<string, unknown> = {}) {
  return {
    draft: true,
    prerelease: false,
    assets: manifest.files.map((file, index) => ({
      id: index + 1,
      name: file.name,
      size: file.size,
      digest: `sha256:${file.sha256}`,
      state: "uploaded",
    })),
    ...overrides,
  };
}

describe("Binary Publish Resume", () => {
  it("classifies the v1.1.15 mtime-only validator failure as recoverable", () => {
    expect(classifyBinaryResumeRun(run(), tagCommit)).toBe(
      "BINARY_PUBLISH_RECOVERABLE",
    );
  });

  it("does not wash a FULL, Build, or unrelated Workflow failure", () => {
    const fullFailure = run();
    (fullFailure.jobs[0].steps[0] as { conclusion: string }).conclusion = "failure";
    expect(() => classifyBinaryResumeRun(fullFailure, tagCommit)).toThrow(
      "evidence is incomplete",
    );
    expect(() => classifyBinaryResumeRun(run({ headSha: "other" }), tagCommit)).toThrow(
      "immutable target Tag",
    );
  });

  it("reuses matching Draft assets and uploads only missing names", () => {
    expect(planBinaryResumeAssets(release(), manifest)).toEqual({
      reuse: manifest.files.map((file) => file.name),
      upload: [],
    });
    expect(planBinaryResumeAssets(release({
      assets: release().assets.slice(0, 2),
    }), manifest)).toEqual({
      reuse: manifest.files.slice(0, 2).map((file) => file.name),
      upload: ["latest.yml"],
    });
  });

  it("blocks mismatched existing assets and non-Draft releases", () => {
    const mismatched = release();
    mismatched.assets[0].size += 1;
    expect(() => planBinaryResumeAssets(mismatched, manifest)).toThrow(
      "refusing overwrite",
    );
    expect(() => planBinaryResumeAssets(release({ draft: false }), manifest)).toThrow(
      "requires a non-prerelease Draft",
    );
  });

  it("verifies GitHub Asset API size and SHA-256 identity", () => {
    const validation = { files: manifest.files };
    expect(verifyReleaseAssetDigests(release(), validation)).toBe(true);
    const mismatched = release();
    mismatched.assets[2].digest = `sha256:${"d".repeat(64)}`;
    expect(() => verifyReleaseAssetDigests(mismatched, validation)).toThrow(
      "GitHub Asset API identity mismatch: latest.yml",
    );
  });
});
