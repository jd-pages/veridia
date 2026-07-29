import type { LocalUsageSyncDraft } from "./contracts";

export const CENTRAL_SYNC_FIELD_ALLOWLIST = {
  usageSummary: [
    "date",
    "localUserId",
    "deviceId",
    "softwareVersion",
    "ruleVersion",
    "taskCount",
    "auditCount",
    "passedCount",
    "failedCount",
    "reviewCount",
    "nonSensitiveErrorCount",
  ],
  deviceHeartbeat: [
    "localUserId",
    "deviceId",
    "softwareVersion",
    "ruleVersion",
    "lastSeenAt",
    "syncStatus",
  ],
  clientError: [
    "localUserId",
    "deviceId",
    "softwareVersion",
    "date",
    "errorCode",
    "count",
  ],
} as const;

export const CENTRAL_SYNC_DENIED_DATA = [
  "笔记链接、笔记ID、标题和正文",
  "话题证据和页面提取证据",
  "产品和活动业务明细",
  "Excel文件、文件名及文件内容",
  "Cookie、Token和浏览器会话",
  "SQLite数据库和数据库备份",
  "完整日志、错误堆栈和本机路径",
] as const;

const DENIED_FIELD_NAMES = new Set([
  "url",
  "normalizedUrl",
  "finalUrl",
  "noteId",
  "platformNoteId",
  "title",
  "body",
  "content",
  "topicEvidence",
  "ruleEvidence",
  "product",
  "campaign",
  "excel",
  "file",
  "fileName",
  "cookie",
  "token",
  "session",
  "database",
  "databasePath",
  "log",
  "stack",
  "path",
]);

export function pickUsageSyncDraft(
  source: LocalUsageSyncDraft & Record<string, unknown>,
): LocalUsageSyncDraft {
  return {
    date: source.date,
    localUserId: source.localUserId,
    deviceId: source.deviceId,
    softwareVersion: source.softwareVersion,
    ruleVersion: source.ruleVersion,
    taskCount: source.taskCount,
    auditCount: source.auditCount,
    passedCount: source.passedCount,
    failedCount: source.failedCount,
    reviewCount: source.reviewCount,
    nonSensitiveErrorCount: source.nonSensitiveErrorCount,
  };
}

export function findDeniedSyncFields(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const denied: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (DENIED_FIELD_NAMES.has(key)) denied.push(fieldPath);
    if (child && typeof child === "object") {
      denied.push(...findDeniedSyncFields(child, fieldPath));
    }
  }
  return denied;
}
