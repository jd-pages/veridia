import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";

export const ACTIVE_AUDIT_TASK_STATUSES = [
  "PENDING",
  "PROCESSING",
  "LOGIN_EXPIRED",
] as const;

export type AuditTaskDuplicateReason = "ACTIVE_TASK" | "EXISTING_RESULT";

export const auditTaskDuplicateMessages: Record<
  AuditTaskDuplicateReason,
  string
> = {
  ACTIVE_TASK: "该链接已有审核任务正在进行中",
  EXISTING_RESULT: "该链接已有审核结果，可前往查看或重新审核",
};

function safeNormalizedUrl(value: string | null | undefined) {
  if (!value?.trim()) return "";
  try {
    return normalizeUrl(value);
  } catch {
    return value.trim();
  }
}

export function auditNoteIdentity(value: string | null | undefined) {
  const normalized = safeNormalizedUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLocaleLowerCase();
    const noteMatch = /^\/(?:explore|discovery\/item)\/([^/?#]+)/iu.exec(
      url.pathname,
    );
    if (
      noteMatch &&
      (hostname === "xiaohongshu.com" ||
        hostname.endsWith(".xiaohongshu.com"))
    ) {
      return `xhs-note:${noteMatch[1].toLocaleLowerCase()}`;
    }
    if (
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com") ||
      hostname === "xhslink.cn" ||
      hostname.endsWith(".xhslink.cn")
    ) {
      return `xhs-short:${hostname}${url.pathname.replace(/\/$/u, "")}`;
    }
  } catch {
    // 非标准 URL 仍可通过规范化后的原值比较。
  }
  return `url:${normalized}`;
}

export function auditTaskLinksMatch(
  inputUrl: string,
  task: {
    url: string;
    normalizedUrl: string;
    finalUrl: string | null;
  },
) {
  const inputKeys = new Set([
    safeNormalizedUrl(inputUrl),
    auditNoteIdentity(inputUrl),
  ]);
  return [task.url, task.normalizedUrl, task.finalUrl].some((value) => {
    if (!value) return false;
    return (
      inputKeys.has(safeNormalizedUrl(value)) ||
      inputKeys.has(auditNoteIdentity(value))
    );
  });
}

function candidateWhere(url: string): Prisma.AuditTaskWhereInput[] {
  const normalizedUrl = safeNormalizedUrl(url);
  const identity = auditNoteIdentity(url);
  const conditions: Prisma.AuditTaskWhereInput[] = [
    { normalizedUrl },
    { url },
    { finalUrl: url },
    { finalUrl: normalizedUrl },
  ];
  const identityValue = identity.replace(/^xhs-(?:note|short):/u, "");
  if (identity.startsWith("xhs-note:") && identityValue) {
    conditions.push(
      { url: { contains: identityValue } },
      { normalizedUrl: { contains: identityValue } },
      { finalUrl: { contains: identityValue } },
    );
  } else if (identity.startsWith("xhs-short:") && identityValue) {
    const path = new URL(normalizedUrl).pathname;
    conditions.push(
      { url: { contains: path } },
      { normalizedUrl: { contains: path } },
    );
  }
  return conditions;
}

export async function findBlockingAuditTask(input: {
  url: string;
  campaignId: string;
}) {
  const candidates = await prisma.auditTask.findMany({
    where: {
      campaignId: input.campaignId,
      OR: candidateWhere(input.url),
    },
    select: {
      id: true,
      status: true,
      url: true,
      normalizedUrl: true,
      finalUrl: true,
      auditResults: { select: { id: true }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
  const matching = candidates.filter((task) =>
    auditTaskLinksMatch(input.url, task),
  );
  const active = matching.find((task) =>
    ACTIVE_AUDIT_TASK_STATUSES.includes(
      task.status as (typeof ACTIVE_AUDIT_TASK_STATUSES)[number],
    ),
  );
  if (active) {
    return {
      taskId: active.id,
      reason: "ACTIVE_TASK" as const,
      message: auditTaskDuplicateMessages.ACTIVE_TASK,
    };
  }
  const completedWithResult = matching.find(
    (task) => task.auditResults.length > 0,
  );
  if (completedWithResult) {
    return {
      taskId: completedWithResult.id,
      reason: "EXISTING_RESULT" as const,
      message: auditTaskDuplicateMessages.EXISTING_RESULT,
    };
  }
  return null;
}
