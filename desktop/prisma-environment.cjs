/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

function createPrismaExecutionContext({
  userDataPath,
  baseEnvironment = process.env,
}) {
  if (!userDataPath || typeof userDataPath !== "string") {
    throw new Error("Prisma 运行缓存目录未配置。");
  }

  const resolvedUserData = path.resolve(userDataPath);
  const cacheRoot = path.join(resolvedUserData, "prisma-cache");
  const workingDirectory = path.join(cacheRoot, "working");
  fs.mkdirSync(workingDirectory, { recursive: true });

  return {
    cacheRoot,
    cwd: workingDirectory,
    env: {
      ...baseEnvironment,
      APPDATA: cacheRoot,
      LOCALAPPDATA: cacheRoot,
      XDG_CACHE_HOME: cacheRoot,
      PRISMA_HIDE_UPDATE_MESSAGE: "true",
    },
  };
}

function isPrismaCachePermissionError(value) {
  const details = String(value || "");
  const permissionFailure =
    /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/iu.test(
      details,
    );
  const prismaCachePath =
    /(?:Program Files|node_modules[\\/]\.cache[\\/]prisma|prisma-cache)/iu.test(
      details,
    );
  return permissionFailure && prismaCachePath;
}

function prismaMigrationFailureMessage({ details, logPath, restored }) {
  const recovery = restored
    ? "原数据库已恢复。"
    : "未保留未完成的数据库。";
  if (isPrismaCachePermissionError(details)) {
    return `权限/缓存目录写入失败，${recovery}请确认数据目录可写后重试。详情：${logPath}`;
  }
  return `数据库迁移失败，${recovery}详情：${logPath}`;
}

module.exports = {
  createPrismaExecutionContext,
  isPrismaCachePermissionError,
  prismaMigrationFailureMessage,
};
