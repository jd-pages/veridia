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
