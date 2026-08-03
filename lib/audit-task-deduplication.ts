import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";

export type AuditTaskDuplicateReason = "TODAY_DUPLICATE";

export const auditTaskDuplicateMessages: Record<
  AuditTaskDuplicateReason,
  string
> = {
  TODAY_DUPLICATE: "该笔记今天已创建过审核任务，请勿重复创建。",
};

export const importedAuditTaskDuplicateMessage =
  "今日已存在相同笔记链接，已跳过。";

export function localNaturalDayRange(now = new Date()) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return { start, end };
}

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
      {
        auditResults: {
          some: { note: { platformNoteId: identityValue } },
        },
      },
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
  now?: Date;
}) {
  const { start, end } = localNaturalDayRange(input.now);
  const candidates = await prisma.auditTask.findMany({
    where: {
      AND: [
        { OR: candidateWhere(input.url) },
        {
          OR: [
            { createdAt: { gte: start, lt: end } },
            {
              auditResults: {
                some: { auditedAt: { gte: start, lt: end } },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      url: true,
      normalizedUrl: true,
      finalUrl: true,
      auditResults: {
        select: {
          note: {
            select: { platformNoteId: true, url: true, finalUrl: true },
          },
        },
        orderBy: { auditedAt: "desc" },
        take: 5,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const inputIdentity = auditNoteIdentity(input.url);
  const matching = candidates.find(
    (task) =>
      auditTaskLinksMatch(input.url, task) ||
      task.auditResults.some(({ note }) => {
        const platformIdentity = note.platformNoteId
          ? `xhs-note:${note.platformNoteId.toLocaleLowerCase()}`
          : "";
        return (
          inputIdentity === platformIdentity ||
          auditTaskLinksMatch(input.url, {
            url: note.url,
            normalizedUrl: note.url,
            finalUrl: note.finalUrl,
          })
        );
      }),
  );
  if (matching) {
    return {
      taskId: matching.id,
      reason: "TODAY_DUPLICATE" as const,
      message: auditTaskDuplicateMessages.TODAY_DUPLICATE,
    };
  }
  return null;
}
