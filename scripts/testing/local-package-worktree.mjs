import fs from "node:fs";
import path from "node:path";
import { captureFile, restoreFile } from "./next-type-isolation.mjs";

export const LOCAL_PACKAGE_RESTORE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
  "tsconfig.json",
  "next-env.d.ts",
]);

export function captureLocalPackageFiles(root) {
  return new Map(
    LOCAL_PACKAGE_RESTORE_FILES.map((relativePath) => {
      const file = path.join(root, relativePath);
      return [file, captureFile(file)];
    }),
  );
}

export function restoreLocalPackageFiles(snapshots) {
  for (const [file, snapshot] of snapshots) {
    restoreFile(file, snapshot);
  }
}

export async function withLocalPackageFileRestore(root, action) {
  const snapshots = captureLocalPackageFiles(root);
  try {
    return await action();
  } finally {
    restoreLocalPackageFiles(snapshots);
  }
}

export function createLocalPackageAcceptance({
  version,
  acceptedAt,
  commitSha,
  sourceFingerprint,
  fullGate,
  artifacts,
}) {
  return {
    schemaVersion: 2,
    version,
    acceptedAt,
    commitSha,
    sourceFingerprint,
    fullGateSource: fullGate.source,
    ...(fullGate.source === "LOCAL_ATTESTATION"
      ? { fullGateAttestationGeneratedAt: fullGate.attestationGeneratedAt }
      : {
          mainCiRunId: fullGate.mainCiRunId,
          mainCiCommitSha: fullGate.mainCiCommitSha,
          mainCiConclusion: fullGate.mainCiConclusion,
          mainCiUrl: fullGate.mainCiUrl,
        }),
    packageChecks: {
      productionBuild: "PASSED",
      desktopPrepare: "PASSED",
      electronRuntime: "PASSED",
      nsis: "PASSED",
      installerVerify: "PASSED",
      hashManifestVerify: "PASSED",
      worktreeRestore: "PASSED",
    },
    artifacts: artifacts.map(({ name, size, sha256, sha512 }) => ({
      name,
      size,
      sha256,
      sha512,
    })),
  };
}

export function writeLocalPackageAcceptance({
  acceptancePath,
  acceptance,
  worktreeStatus,
}) {
  if (worktreeStatus) {
    throw new Error(
      "本地验收临时文件恢复后工作区不干净，已停止生成验收记录。",
    );
  }
  fs.mkdirSync(path.dirname(acceptancePath), { recursive: true });
  fs.writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2), "utf8");
}
